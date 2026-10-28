use fantasyxi_escrow::{
    EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, LeagueStatus, WinnerPayout,
};
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, EnvTestConfig, IssuerFlags, Ledger};
use soroban_sdk::{contract, contractimpl, contracttype, token, vec, Address, Env};

// Fuzz tests for critical state-changing flows: create_league, deposit, settle, refund
proptest! {
    #[test]
    fn fuzz_create_deposit_settle_refund(entry_fee in any::<i128>(), participant_count in 0u32..5u32, platform_fee_perc in 0u32..100u32) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let contract_id = env.register(fantasyxi_escrow::FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_id);

        client.initialize(&admin);

        let creator = Address::generate(&env);
        // clamp entry_fee to non-negative and reasonably small to avoid overflow in test env
        let entry_fee = if entry_fee < 0 { 0 } else { (entry_fee % 1_000_000_000).abs() };

        client.create_league(&creator, &42u64, &entry_fee, &token_contract.address());

        let mut participants = Vec::new();
        let mut winners: soroban_sdk::Vec<WinnerPayout> = vec![&env];
        let mut total_deposited: i128 = 0;
        for _ in 0..participant_count {
            let p = Address::generate(&env);
            participants.push(p.clone());
            // mint tokens and deposit
            let token_admin_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_contract.address());
            token_admin_client.mint(&p, &entry_fee);
            client.deposit(&p, &42u64);
            total_deposited += entry_fee;
        }

        // construct winners based on participant_count: 1..=3 covering branches
        if participant_count == 0 {
            // nothing to settle; refund should be no-op
            let participants_vec: soroban_sdk::Vec<Address> = vec![&env];
            let res = client.try_refund(&admin, &42u64, &participants_vec);
            prop_assert!(res.is_ok());
            return Ok(());
        }

        // compute platform fee as percentage of total_deposited
        let platform_fee = (total_deposited * (platform_fee_perc as i128)) / 100;
        // ensure fee doesn't exceed max cap artificially, but allow tests to hit edge

        // winners: if participants >=1 create 1 winner, else multiple
        if participant_count == 1 {
            winners.push_back(WinnerPayout { winner: participants[0].clone(), amount: total_deposited - platform_fee });
        } else if participant_count == 2 {
            // split 70/30
            let p1 = ((total_deposited - platform_fee) * 70) / 100;
            let p2 = (total_deposited - platform_fee) - p1;
            winners.push_back(WinnerPayout { winner: participants[0].clone(), amount: p1 });
            winners.push_back(WinnerPayout { winner: participants[1].clone(), amount: p2 });
        } else {
            // 3+ -> 60/30/10
            let p1 = ((total_deposited - platform_fee) * 60) / 100;
            let p2 = ((total_deposited - platform_fee) * 30) / 100;
            let p3 = (total_deposited - platform_fee) - p1 - p2;
            winners.push_back(WinnerPayout { winner: participants[0].clone(), amount: p1 });
            winners.push_back(WinnerPayout { winner: participants[1].clone(), amount: p2 });
            winners.push_back(WinnerPayout { winner: participants[2.min((participant_count - 1) as usize)].clone(), amount: p3 });
        }

        // try settle; capture result but don't assert success (we want to ensure no panics and correct error handling)
        let treasury = Address::generate(&env);
        let _ = client.try_settle(&admin, &42u64, &winners, &treasury, &platform_fee);

        // attempt refund which should either be Ok or return AlreadySettled
        let mut participants_vec: soroban_sdk::Vec<Address> = vec![&env];
        for p in participants.iter() {
            participants_vec.push_back(p.clone());
        }
        let _ = client.try_refund(&admin, &42u64, &participants_vec);

        // No assertion - proptest detects panics/UB/overflows
    }
}

// ---------------------------------------------------------------------------
// Stateful fuzzing: arbitrary interleavings of deposits, settlements, claims,
// cancellations, refunds, emergency pauses, allowance changes and trustline
// revocations.
// 100 cases x >= 100 operations = 10,000+ fuzzed operations per run.
// ---------------------------------------------------------------------------

const FUZZ_LEAGUES: usize = 3;
const FUZZ_USERS: usize = 4;
const FUZZ_CASES: u32 = 100;
const MIN_OPS_PER_CASE: usize = 100;

#[derive(Clone, Debug)]
enum Op {
    Deposit(usize, usize),
    Settle(usize),
    ClaimPrize(usize, usize),
    Cancel(usize),
    ClaimRefund(usize, usize),
    AdminRefund(usize),
    Approve(usize, i128),
    RevokeAllowance(usize),
    Deauthorize(usize),
    Reauthorize(usize),
    Pause,
    Unpause,
    WarpPastEmergencyTimelock,
    EmergencyRefund(usize, usize),
}

// Kept out of the module scope so `prop_oneof!` resolves std's `vec!` rather
// than `soroban_sdk::vec!`.
mod strategies {
    use super::{Op, FUZZ_LEAGUES, FUZZ_USERS};
    use proptest::prelude::*;

    pub fn op_strategy() -> impl Strategy<Value = Op> {
        let league = 0..FUZZ_LEAGUES;
        let user = 0..FUZZ_USERS;
        prop_oneof![
            4 => (league.clone(), user.clone()).prop_map(|(l, u)| Op::Deposit(l, u)),
            2 => league.clone().prop_map(Op::Settle),
            3 => (league.clone(), user.clone()).prop_map(|(l, u)| Op::ClaimPrize(l, u)),
            1 => league.clone().prop_map(Op::Cancel),
            2 => (league.clone(), user.clone()).prop_map(|(l, u)| Op::ClaimRefund(l, u)),
            1 => league.clone().prop_map(Op::AdminRefund),
            1 => (user.clone(), 0i128..1_000_000_000).prop_map(|(u, a)| Op::Approve(u, a)),
            1 => user.clone().prop_map(Op::RevokeAllowance),
            1 => user.clone().prop_map(Op::Deauthorize),
            1 => user.clone().prop_map(Op::Reauthorize),
            1 => Just(Op::Pause),
            1 => Just(Op::Unpause),
            1 => Just(Op::WarpPastEmergencyTimelock),
            2 => (league, user).prop_map(|(l, u)| Op::EmergencyRefund(l, u)),
        ]
    }
}
use strategies::op_strategy;

/// Reference model of the escrow's outstanding liabilities.
#[derive(Clone, Default)]
struct LeagueModel {
    status: Option<LeagueStatus>,
    /// Deposits still held for the participant, in deposit order.
    deposits: std::vec::Vec<(usize, i128)>,
    claimable: std::vec::Vec<(usize, i128)>,
}

impl LeagueModel {
    fn liabilities(&self) -> i128 {
        self.deposits.iter().map(|(_, a)| a).sum::<i128>()
            + self.claimable.iter().map(|(_, a)| a).sum::<i128>()
    }
}

fn standard_payouts(prize_pool: i128, winners: usize) -> std::vec::Vec<i128> {
    match winners {
        1 => std::vec![prize_pool],
        2 => {
            let p1 = prize_pool * 70 / 100;
            std::vec![p1, prize_pool - p1]
        }
        _ => {
            let p1 = prize_pool * 60 / 100;
            let p2 = prize_pool * 30 / 100;
            std::vec![p1, p2, prize_pool - p1 - p2]
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(FUZZ_CASES))]

    #[test]
    fn fuzz_interleaved_operations_preserve_balance_invariants(
        fees in prop::collection::vec(0i128..1_000_000_000, FUZZ_LEAGUES),
        ops in prop::collection::vec(op_strategy(), MIN_OPS_PER_CASE..=MIN_OPS_PER_CASE + 20),
    ) {
        let env = Env::new_with_config(EnvTestConfig { capture_snapshot_at_drop: false });
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        let token_address = sac.address();
        let token_admin = token::StellarAssetClient::new(&env, &token_address);
        let token_client = token::Client::new(&env, &token_address);
        let client = FantasyXIEscrowClient::new(&env, &env.register(FantasyXIEscrow, ()));
        client.initialize(&admin);

        let users: std::vec::Vec<Address> = (0..FUZZ_USERS).map(|_| Address::generate(&env)).collect();
        let minted_per_user: i128 = fees.iter().sum();
        for user in &users {
            token_admin.mint(user, &minted_per_user);
        }
        let total_supply = minted_per_user * FUZZ_USERS as i128;
        for (l, fee) in fees.iter().enumerate() {
            client.create_league(&admin, &(l as u64), fee, &token_address);
        }

        let mut model = std::vec![LeagueModel { status: Some(LeagueStatus::Upcoming), ..Default::default() }; FUZZ_LEAGUES];

        for op in ops {
            let escrow_before = token_client.balance(&client.address);
            let leagues_before: std::vec::Vec<_> =
                (0..FUZZ_LEAGUES).map(|l| client.get_league(&(l as u64))).collect();

            let ok = match op.clone() {
                Op::Deposit(l, u) => {
                    let ok = client.try_deposit(&users[u], &(l as u64)).is_ok();
                    if ok {
                        model[l].deposits.push((u, fees[l]));
                    }
                    ok
                }
                Op::Settle(l) => {
                    let m = &model[l];
                    let total: i128 = m.deposits.iter().map(|(_, a)| a).sum();
                    let fee = total * 500 / 10_000;
                    let payees: std::vec::Vec<usize> =
                        m.deposits.iter().take(3).map(|(u, _)| *u).collect();
                    let mut winners = vec![&env];
                    if !payees.is_empty() {
                        for (u, amount) in payees.iter().zip(standard_payouts(total - fee, payees.len())) {
                            winners.push_back(WinnerPayout { winner: users[*u].clone(), amount });
                        }
                    }
                    let ok = client.try_settle(&admin, &(l as u64), &winners, &treasury, &fee).is_ok();
                    if ok {
                        let m = &mut model[l];
                        m.claimable = winners
                            .iter()
                            .zip(payees.iter())
                            .filter(|(w, _)| w.amount > 0)
                            .map(|(w, u)| (*u, w.amount))
                            .collect();
                        m.deposits.clear();
                        m.status = Some(LeagueStatus::Settled);
                    }
                    ok
                }
                Op::ClaimPrize(l, u) => {
                    let ok = client.try_claim_prize(&users[u], &(l as u64)).is_ok();
                    if ok {
                        model[l].claimable.retain(|(w, _)| *w != u);
                    }
                    ok
                }
                Op::Cancel(l) => {
                    let ok = client.try_cancel_league(&admin, &(l as u64)).is_ok();
                    if ok {
                        model[l].status = Some(LeagueStatus::Cancelled);
                    }
                    ok
                }
                Op::ClaimRefund(l, u) => {
                    let ok = client.try_claim_refund(&users[u], &(l as u64)).is_ok();
                    if ok {
                        model[l].deposits.retain(|(d, _)| *d != u);
                    }
                    ok
                }
                Op::AdminRefund(l) => {
                    let mut participants = vec![&env];
                    for user in &users {
                        participants.push_back(user.clone());
                    }
                    let ok = client.try_refund(&admin, &(l as u64), &participants).is_ok();
                    if ok {
                        model[l].deposits.clear();
                        model[l].status = Some(LeagueStatus::Cancelled);
                    }
                    ok
                }
                Op::Approve(u, amount) => {
                    let expiry = env.ledger().sequence() + 1_000;
                    token_client.approve(&users[u], &client.address, &amount, &expiry);
                    true
                }
                Op::RevokeAllowance(u) => {
                    token_client.approve(&users[u], &client.address, &0, &0);
                    true
                }
                Op::Deauthorize(u) => {
                    token_admin.set_authorized(&users[u], &false);
                    true
                }
                Op::Reauthorize(u) => {
                    token_admin.set_authorized(&users[u], &true);
                    true
                }
                Op::Pause => client.try_pause(&admin).is_ok(),
                Op::Unpause => client.try_unpause(&admin).is_ok(),
                Op::WarpPastEmergencyTimelock => {
                    env.ledger().with_mut(|li| li.timestamp += 15 * 24 * 60 * 60);
                    true
                }
                Op::EmergencyRefund(l, u) => {
                    let ok = client.try_emergency_refund_league(&users[u], &(l as u64)).is_ok();
                    if ok {
                        model[l].deposits.retain(|(d, _)| *d != u);
                    }
                    ok
                }
            };

            // A rejected operation must leave escrow funds and league state untouched.
            if !ok {
                prop_assert_eq!(token_client.balance(&client.address), escrow_before, "{:?}", op);
                for (l, before) in leagues_before.iter().enumerate() {
                    prop_assert_eq!(&client.get_league(&(l as u64)), before, "{:?}", op);
                }
            }

            // Global invariant: escrow balance == sum of outstanding deposits and prizes.
            let liabilities: i128 = model.iter().map(LeagueModel::liabilities).sum();
            prop_assert_eq!(token_client.balance(&client.address), liabilities, "{:?}", op);

            // Conservation: no tokens are created or destroyed across all holders.
            let held: i128 = users.iter().map(|u| token_client.balance(u)).sum::<i128>()
                + token_client.balance(&client.address)
                + token_client.balance(&treasury);
            prop_assert_eq!(held, total_supply, "{:?}", op);

            for (l, m) in model.iter().enumerate() {
                let league = client.get_league(&(l as u64)).unwrap();
                prop_assert_eq!(Some(league.status), m.status, "{:?}", op);
                if league.status == LeagueStatus::Settled {
                    // Settled deposits are retained as a historical record only.
                    continue;
                }
                for (u, user) in users.iter().enumerate() {
                    let held: i128 = m.deposits.iter().filter(|(d, _)| *d == u).map(|(_, a)| a).sum();
                    prop_assert_eq!(client.get_deposit(&(l as u64), user), held, "{:?}", op);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Rogue token: a malicious asset whose transfer hook re-enters the escrow.
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum RogueKey {
    Target,
    Attack,
    ReentrySucceeded,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Debug)]
#[repr(u32)]
pub enum Attack {
    Inert = 0,
    /// Re-enter and let the failure propagate.
    Deposit = 1,
    ClaimPrize = 2,
    /// Re-enter but swallow the error so the outer call continues.
    SwallowedDeposit = 3,
}

#[contract]
pub struct RogueToken;

#[contractimpl]
impl RogueToken {
    pub fn arm(env: Env, target: Address, attack: Attack) {
        env.storage().instance().set(&RogueKey::Target, &target);
        env.storage().instance().set(&RogueKey::Attack, &attack);
    }

    pub fn reentry_succeeded(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&RogueKey::ReentrySucceeded)
            .unwrap_or(false)
    }

    pub fn balance(_env: Env, _id: Address) -> i128 {
        0
    }

    pub fn transfer(env: Env, from: Address, to: Address, _amount: i128) {
        let attack: Attack = env
            .storage()
            .instance()
            .get(&RogueKey::Attack)
            .unwrap_or(Attack::Inert);
        let Some(target) = env
            .storage()
            .instance()
            .get::<_, Address>(&RogueKey::Target)
        else {
            return;
        };
        let escrow = FantasyXIEscrowClient::new(&env, &target);
        match attack {
            Attack::Inert => {}
            Attack::Deposit => escrow.deposit(&from, &ROGUE_LEAGUE),
            Attack::ClaimPrize => escrow.claim_prize(&to, &ROGUE_LEAGUE),
            Attack::SwallowedDeposit => {
                let reentered = escrow.try_deposit(&from, &ROGUE_LEAGUE).is_ok();
                env.storage()
                    .instance()
                    .set(&RogueKey::ReentrySucceeded, &reentered);
            }
        }
    }
}

const ROGUE_LEAGUE: u64 = 13;
const ROGUE_FEE: i128 = 1_000_000;

fn setup_rogue<'a>() -> (
    Env,
    Address,
    FantasyXIEscrowClient<'a>,
    RogueTokenClient<'a>,
) {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let escrow = FantasyXIEscrowClient::new(&env, &env.register(FantasyXIEscrow, ()));
    let rogue = RogueTokenClient::new(&env, &env.register(RogueToken, ()));
    escrow.initialize(&admin);
    escrow.create_league(&admin, &ROGUE_LEAGUE, &ROGUE_FEE, &rogue.address);
    (env, admin, escrow, rogue)
}

#[test]
fn rogue_token_deposit_reentrancy_reverts_without_corrupting_storage() {
    let (env, _admin, escrow, rogue) = setup_rogue();
    let victim = Address::generate(&env);
    let before = escrow.get_league(&ROGUE_LEAGUE);

    rogue.arm(&escrow.address, &Attack::Deposit);
    assert!(escrow.try_deposit(&victim, &ROGUE_LEAGUE).is_err());

    assert_eq!(escrow.get_league(&ROGUE_LEAGUE), before);
    assert_eq!(escrow.get_deposit(&ROGUE_LEAGUE, &victim), 0);
    assert_eq!(escrow.get_participants_page(&ROGUE_LEAGUE, &0).len(), 0);
}

#[test]
fn rogue_token_swallowed_reentrancy_cannot_double_deposit() {
    let (env, _admin, escrow, rogue) = setup_rogue();
    let victim = Address::generate(&env);

    rogue.arm(&escrow.address, &Attack::SwallowedDeposit);
    escrow.deposit(&victim, &ROGUE_LEAGUE);

    assert!(!rogue.reentry_succeeded());
    let league = escrow.get_league(&ROGUE_LEAGUE).unwrap();
    assert_eq!(league.participant_count, 1);
    assert_eq!(league.total_deposited, ROGUE_FEE);
    assert_eq!(escrow.get_deposit(&ROGUE_LEAGUE, &victim), ROGUE_FEE);
    assert_eq!(
        escrow.try_deposit(&victim, &ROGUE_LEAGUE),
        Err(Ok(EscrowError::AlreadyDeposited))
    );
}

#[test]
fn rogue_token_claim_reentrancy_cannot_drain_prize_twice() {
    let (env, admin, escrow, rogue) = setup_rogue();
    let winner = Address::generate(&env);
    escrow.deposit(&winner, &ROGUE_LEAGUE);
    let fee = ROGUE_FEE * 500 / 10_000;
    let winners = vec![
        &env,
        WinnerPayout {
            winner: winner.clone(),
            amount: ROGUE_FEE - fee,
        },
    ];
    escrow.settle(&admin, &ROGUE_LEAGUE, &winners, &admin, &fee);

    rogue.arm(&escrow.address, &Attack::ClaimPrize);
    assert!(escrow.try_claim_prize(&winner, &ROGUE_LEAGUE).is_err());

    // The prize entitlement survives the reverted attack intact and is
    // claimable exactly once afterwards.
    rogue.arm(&escrow.address, &Attack::Inert);
    escrow.claim_prize(&winner, &ROGUE_LEAGUE);
    assert_eq!(
        escrow.try_claim_prize(&winner, &ROGUE_LEAGUE),
        Err(Ok(EscrowError::NoClaimablePrize))
    );
    assert_eq!(
        escrow.get_league(&ROGUE_LEAGUE).unwrap().status,
        LeagueStatus::Settled
    );
}
