//! Stateful property-based invariant suite for the league escrow contract (issue #551).
//!
//! Each proptest case generates a random sequence of contract operations
//! (deposits, settlements, prize claims, cancellations, refund claims) and
//! replays it against a real `FantasyXIEscrow` instance alongside a simple
//! reference model. After every operation the following invariants must hold:
//!
//! 1. Contract token balance == sum(active deposits) - claimed prizes - fees paid out
//!    (and the contract's own `total_deposited` accounting agrees with the model).
//! 2. Platform fee + winner payouts never exceed 100% of the pool.
//! 3. A participant can never deposit more than once per league.
//! 4. Accounts that are not winners can never claim funds, and winners cannot
//!    claim twice.
//!
//! Edge cases (zero entry fee, single participant, tied first place) are pinned
//! by deterministic tests at the bottom of the file.

use fantasyxi_escrow::{EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, WinnerPayout};
use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, Env, Vec as SorobanVec};
use std::collections::HashMap;

const LEAGUE_ID: u64 = 1;
const POOL_SIZE: usize = 6;
const MAX_FEE_BPS: i128 = 500;

#[derive(Clone, Debug)]
enum Op {
    /// Participant `idx` attempts to deposit.
    Deposit(usize),
    /// Admin settles with `winners` depositors (clamped), optional tied first, fee in bps.
    Settle {
        winners: usize,
        tied: bool,
        fee_bps: i128,
    },
    /// Admin settles with a tampered (non-curve) payout split.
    SettleTampered { winners: usize, delta: i128 },
    /// Participant `idx` attempts to claim a prize.
    ClaimPrize(usize),
    /// Admin cancels the league.
    Cancel,
    /// Participant `idx` attempts to claim a refund.
    ClaimRefund(usize),
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (0..POOL_SIZE).prop_map(Op::Deposit),
        2 => (1usize..=4, any::<bool>(), 0i128..=MAX_FEE_BPS)
            .prop_map(|(winners, tied, fee_bps)| Op::Settle { winners, tied, fee_bps }),
        1 => (1usize..=4, 1i128..1_000)
            .prop_map(|(winners, delta)| Op::SettleTampered { winners, delta }),
        4 => (0..POOL_SIZE).prop_map(Op::ClaimPrize),
        1 => Just(Op::Cancel),
        3 => (0..POOL_SIZE).prop_map(Op::ClaimRefund),
    ]
}

#[derive(PartialEq, Clone, Copy, Debug)]
enum Phase {
    Open,
    Settled,
    Cancelled,
}

/// Reference model of the escrow bookkeeping.
struct Model {
    phase: Phase,
    entry_fee: i128,
    /// Outstanding (un-refunded) deposits per participant index.
    deposits: HashMap<usize, i128>,
    /// Everyone who ever deposited, in deposit order.
    depositors: std::vec::Vec<usize>,
    /// Unclaimed prizes per participant index.
    claimable: HashMap<usize, i128>,
    /// Fees already transferred out to the treasury.
    fees_paid: i128,
    prizes_claimed: i128,
    refunds_paid: i128,
    /// Gross sum of all deposits ever accepted.
    gross_deposited: i128,
}

impl Model {
    fn new(entry_fee: i128) -> Self {
        Self {
            phase: Phase::Open,
            entry_fee,
            deposits: HashMap::new(),
            depositors: std::vec::Vec::new(),
            claimable: HashMap::new(),
            fees_paid: 0,
            prizes_claimed: 0,
            refunds_paid: 0,
            gross_deposited: 0,
        }
    }

    fn active_deposits(&self) -> i128 {
        self.deposits.values().sum()
    }

    /// Balance the escrow must hold under the reference model.
    fn expected_balance(&self) -> i128 {
        self.gross_deposited - self.fees_paid - self.prizes_claimed - self.refunds_paid
    }
}

/// Mirrors the contract's standard prize curve for `n` winners.
fn expected_payouts(prize_pool: i128, n: usize, tied: bool) -> std::vec::Vec<i128> {
    match n {
        1 => vec![prize_pool],
        2 => {
            if tied {
                let a = prize_pool / 2;
                vec![a, prize_pool - a]
            } else {
                let p1 = prize_pool * 70 / 100;
                vec![p1, prize_pool - p1]
            }
        }
        _ => {
            let p1 = prize_pool * 60 / 100;
            let p2 = prize_pool * 30 / 100;
            let p3 = prize_pool - p1 - p2;
            let mut v = if tied {
                let a = (p1 + p2) / 2;
                vec![a, p1 + p2 - a, p3]
            } else {
                vec![p1, p2, p3]
            };
            v.resize(n, 0);
            v
        }
    }
}

struct Harness<'a> {
    env: &'a Env,
    client: FantasyXIEscrowClient<'a>,
    token: token::Client<'a>,
    contract: Address,
    admin: Address,
    treasury: Address,
    people: std::vec::Vec<Address>,
    outsider: Address,
}

fn check_invariants(h: &Harness, m: &Model) -> Result<(), TestCaseError> {
    let balance = h.token.balance(&h.contract);

    // Invariant 1: balance == active deposits - claimed prizes - fees (modelled exactly).
    prop_assert_eq!(
        balance,
        m.expected_balance(),
        "escrow balance diverged from model"
    );
    prop_assert!(balance >= 0);

    let league = h.client.get_league(&LEAGUE_ID).expect("league exists");
    match m.phase {
        Phase::Open => {
            prop_assert_eq!(balance, m.active_deposits());
            prop_assert_eq!(league.total_deposited, m.active_deposits());
        }
        Phase::Cancelled => {
            // Remaining balance is exactly the refunds not yet claimed.
            prop_assert_eq!(balance, m.active_deposits());
            prop_assert_eq!(league.total_deposited, m.active_deposits());
        }
        Phase::Settled => {
            // After settlement the escrow only holds unclaimed prizes.
            let unclaimed: i128 = m.claimable.values().sum();
            prop_assert_eq!(balance, unclaimed);
            // Invariant 2: fee + payouts == pool, never more.
            prop_assert_eq!(
                m.fees_paid + m.prizes_claimed + unclaimed,
                m.gross_deposited
            );
        }
    }

    // On-chain prize bookkeeping matches the model for every known participant.
    for (idx, person) in h.people.iter().enumerate() {
        let on_chain_claimed = h.client.is_prize_claimed(&LEAGUE_ID, person);
        let modelled_open = m.claimable.get(&idx).copied().unwrap_or(0) > 0;
        if modelled_open {
            prop_assert!(!on_chain_claimed);
        }
    }
    Ok(())
}

fn run_sequence(entry_fee: i128, ops: std::vec::Vec<Op>) -> Result<(), TestCaseError> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let outsider = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = sac.address();
    let token_client = token::Client::new(&env, &token_address);
    let minter = token::StellarAssetClient::new(&env, &token_address);

    let contract = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract);
    client.initialize(&admin);
    client.create_league(&admin, &LEAGUE_ID, &entry_fee, &token_address);

    let mut people = std::vec::Vec::new();
    for _ in 0..POOL_SIZE {
        let p = Address::generate(&env);
        minter.mint(&p, &(entry_fee * 4 + 1_000));
        people.push(p);
    }
    minter.mint(&outsider, &1_000);

    let h = Harness {
        env: &env,
        client,
        token: token_client,
        contract,
        admin,
        treasury,
        people,
        outsider,
    };
    let mut m = Model::new(entry_fee);

    for op in ops {
        match op {
            Op::Deposit(idx) => {
                let res = h.client.try_deposit(&h.people[idx], &LEAGUE_ID);
                if m.phase != Phase::Open {
                    prop_assert_eq!(res, Err(Ok(EscrowError::LeagueNotAcceptingDeposits)));
                } else if m.deposits.contains_key(&idx) || m.depositors.contains(&idx) {
                    // Invariant 3: never more than one deposit per participant per league.
                    prop_assert_eq!(res, Err(Ok(EscrowError::AlreadyDeposited)));
                } else {
                    prop_assert!(res.is_ok(), "deposit should succeed: {:?}", res);
                    m.deposits.insert(idx, m.entry_fee);
                    m.depositors.push(idx);
                    m.gross_deposited += m.entry_fee;
                }
            }
            Op::Settle {
                winners,
                tied,
                fee_bps,
            } => {
                let total = m.active_deposits();
                let n = winners.min(m.depositors.len());
                let payload_ok = m.phase == Phase::Open && n >= 1;
                if n == 0 {
                    let empty: SorobanVec<WinnerPayout> = SorobanVec::new(h.env);
                    let res = h
                        .client
                        .try_settle(&h.admin, &LEAGUE_ID, &empty, &h.treasury, &0);
                    prop_assert!(res.is_err());
                } else {
                    let fee = total * fee_bps / 10_000;
                    let payouts = expected_payouts(total - fee, n, tied);
                    let mut vec: SorobanVec<WinnerPayout> = SorobanVec::new(h.env);
                    for (i, amount) in payouts.iter().enumerate() {
                        vec.push_back(WinnerPayout {
                            winner: h.people[m.depositors[i]].clone(),
                            amount: *amount,
                        });
                    }
                    let res = h
                        .client
                        .try_settle(&h.admin, &LEAGUE_ID, &vec, &h.treasury, &fee);
                    if payload_ok {
                        prop_assert!(res.is_ok(), "valid settlement rejected: {:?}", res);
                        // Invariant 2: fee within 5% and total distribution == 100%.
                        prop_assert!(fee * 10_000 <= total * MAX_FEE_BPS);
                        prop_assert_eq!(fee + payouts.iter().sum::<i128>(), total);
                        m.phase = Phase::Settled;
                        m.fees_paid += fee;
                        for (i, amount) in payouts.iter().enumerate() {
                            if *amount > 0 {
                                m.claimable.insert(m.depositors[i], *amount);
                            }
                        }
                        m.deposits.clear();
                    } else {
                        prop_assert!(res.is_err(), "settlement accepted in phase {:?}", m.phase);
                    }
                }
            }
            Op::SettleTampered { winners, delta } => {
                let total = m.active_deposits();
                let n = winners.clamp(2, 4).min(m.depositors.len());
                if n >= 2 && total > 0 {
                    let mut payouts = expected_payouts(total, n, false);
                    // Shift value from the last winner to the first; never matches the curve
                    // unless it collides with the tied variant, so skip that case.
                    let shift = delta.min(payouts[n - 1].max(1));
                    payouts[0] += shift;
                    payouts[n - 1] -= shift;
                    let tied_variant = expected_payouts(total, n, true);
                    if payouts != expected_payouts(total, n, false) && payouts != tied_variant {
                        let mut vec: SorobanVec<WinnerPayout> = SorobanVec::new(h.env);
                        for (i, amount) in payouts.iter().enumerate() {
                            vec.push_back(WinnerPayout {
                                winner: h.people[m.depositors[i]].clone(),
                                amount: *amount,
                            });
                        }
                        let res = h
                            .client
                            .try_settle(&h.admin, &LEAGUE_ID, &vec, &h.treasury, &0);
                        prop_assert!(res.is_err(), "tampered distribution must never settle");
                    }
                }
            }
            Op::ClaimPrize(idx) => {
                let res = h.client.try_claim_prize(&h.people[idx], &LEAGUE_ID);
                match m.claimable.remove(&idx) {
                    Some(amount) => {
                        prop_assert!(res.is_ok(), "winner claim failed: {:?}", res);
                        m.prizes_claimed += amount;
                    }
                    None => {
                        // Invariant 4: non-winners (and already-paid winners) cannot claim.
                        prop_assert_eq!(res, Err(Ok(EscrowError::NoClaimablePrize)));
                    }
                }
                // An address that never took part can never claim either.
                let out = h.client.try_claim_prize(&h.outsider, &LEAGUE_ID);
                prop_assert_eq!(out, Err(Ok(EscrowError::NoClaimablePrize)));
            }
            Op::Cancel => {
                let res = h.client.try_cancel_league(&h.admin, &LEAGUE_ID);
                if m.phase == Phase::Settled {
                    prop_assert_eq!(res, Err(Ok(EscrowError::AlreadySettled)));
                } else {
                    prop_assert!(res.is_ok());
                    m.phase = Phase::Cancelled;
                }
            }
            Op::ClaimRefund(idx) => {
                let res = h.client.try_claim_refund(&h.people[idx], &LEAGUE_ID);
                if m.phase != Phase::Cancelled {
                    prop_assert_eq!(res, Err(Ok(EscrowError::LeagueNotCancelled)));
                } else if !m.depositors.contains(&idx) {
                    prop_assert_eq!(res, Err(Ok(EscrowError::NoDeposit)));
                } else if m.deposits.get(&idx).copied().unwrap_or(0) > 0 {
                    prop_assert!(res.is_ok(), "refund failed: {:?}", res);
                    let amt = m.deposits.remove(&idx).unwrap();
                    m.refunds_paid += amt;
                } else {
                    // Zero-fee leagues and repeat claims are rejected as AlreadyClaimed.
                    prop_assert_eq!(res, Err(Ok(EscrowError::AlreadyClaimed)));
                }
            }
        }
        check_invariants(&h, &m)?;
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1024))]

    /// 1,024 random operation sequences, each up to 40 transitions long.
    #[test]
    fn prop_escrow_state_machine_preserves_invariants(
        entry_fee in 1i128..5_000_000i128,
        ops in proptest::collection::vec(op_strategy(), 1..40),
    ) {
        run_sequence(entry_fee, ops)?;
    }

    /// Zero entry-fee leagues: nothing is ever held or paid out, whatever the ops.
    #[test]
    fn prop_zero_fee_league_never_holds_balance(
        ops in proptest::collection::vec(op_strategy(), 1..25),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(token_admin);
        let token_client = token::Client::new(&env, &sac.address());
        let contract = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract);
        client.initialize(&admin);
        client.create_league(&admin, &LEAGUE_ID, &0, &sac.address());
        let people: std::vec::Vec<Address> = (0..POOL_SIZE).map(|_| Address::generate(&env)).collect();
        for op in ops {
            match op {
                Op::Deposit(i) => { let _ = client.try_deposit(&people[i], &LEAGUE_ID); }
                Op::ClaimPrize(i) => {
                    prop_assert!(client.try_claim_prize(&people[i], &LEAGUE_ID).is_err());
                }
                Op::ClaimRefund(i) => { let _ = client.try_claim_refund(&people[i], &LEAGUE_ID); }
                Op::Cancel => { let _ = client.try_cancel_league(&admin, &LEAGUE_ID); }
                _ => {}
            }
            prop_assert_eq!(token_client.balance(&contract), 0);
        }
    }
}

// ---- Deterministic edge cases -------------------------------------------------

#[test]
fn edge_single_participant_settle_and_claim() {
    let ops = vec![
        Op::Deposit(0),
        Op::Deposit(0), // duplicate must be rejected
        Op::Settle {
            winners: 1,
            tied: false,
            fee_bps: 500,
        },
        Op::ClaimPrize(1), // non-winner
        Op::ClaimPrize(0),
        Op::ClaimPrize(0), // double claim
    ];
    run_sequence(10_000_000, ops).unwrap();
}

#[test]
fn edge_tied_first_place_pays_out_exactly_the_pool() {
    let ops = vec![
        Op::Deposit(0),
        Op::Deposit(1),
        Op::Deposit(2),
        Op::Settle {
            winners: 3,
            tied: true,
            fee_bps: 500,
        },
        Op::ClaimPrize(0),
        Op::ClaimPrize(1),
        Op::ClaimPrize(2),
    ];
    run_sequence(1_000_003, ops).unwrap();
}

#[test]
fn edge_cancel_with_no_deposits_and_zero_balance() {
    let ops = vec![
        Op::Cancel,
        Op::ClaimRefund(0),
        Op::Deposit(0),
        Op::Settle {
            winners: 1,
            tied: false,
            fee_bps: 0,
        },
    ];
    run_sequence(1, ops).unwrap();
}

#[test]
fn edge_cancel_then_refund_all_and_no_double_refund() {
    let ops = vec![
        Op::Deposit(0),
        Op::Deposit(1),
        Op::Cancel,
        Op::ClaimRefund(0),
        Op::ClaimRefund(0),
        Op::ClaimRefund(1),
        Op::ClaimRefund(2),
        Op::Settle {
            winners: 1,
            tied: false,
            fee_bps: 0,
        },
    ];
    run_sequence(777, ops).unwrap();
}
