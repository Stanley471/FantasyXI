#![allow(clippy::needless_range_loop)]
use fantasyxi_escrow::{
    EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, LeagueStatus, WinnerPayout,
};
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, vec, Address, Env};

const EMERGENCY_REFUND_TIMELOCK_SECONDS: u64 = 14 * 24 * 60 * 60; // 1,209,600 seconds

/// Pure model of the emergency refund timelock and solvency state machine
/// used to run 10,000+ high-velocity property iterations alongside full Soroban Env tests.
#[derive(Debug, Clone)]
struct RefundStateMachineModel {
    paused: bool,
    paused_at: u64,
    status: LeagueStatus,
    deposits: std::vec::Vec<i128>,
    refunded: std::vec::Vec<bool>,
    total_deposited: i128,
    total_refunded: i128,
    total_settled: i128,
}

impl RefundStateMachineModel {
    fn new(paused: bool, paused_at: u64, deposits: std::vec::Vec<i128>) -> Self {
        let total_deposited = deposits
            .iter()
            .copied()
            .fold(0i128, |acc, x| acc.saturating_add(x));
        let count = deposits.len();
        Self {
            paused,
            paused_at,
            status: LeagueStatus::Upcoming,
            deposits,
            refunded: std::vec![false; count],
            total_deposited,
            total_refunded: 0,
            total_settled: 0,
        }
    }

    fn settle(&mut self) -> Result<(), EscrowError> {
        if self.paused {
            return Err(EscrowError::ContractPaused);
        }
        if self.status == LeagueStatus::Settled || self.status == LeagueStatus::Cancelled {
            return Err(EscrowError::AlreadySettled);
        }
        self.status = LeagueStatus::Settled;
        self.total_settled = self.total_deposited - self.total_refunded;
        Ok(())
    }

    fn try_emergency_refund(
        &mut self,
        participant_idx: usize,
        ledger_timestamp: u64,
    ) -> Result<i128, EscrowError> {
        if !self.paused {
            return Err(EscrowError::NotPaused);
        }
        let unlock_at = self
            .paused_at
            .checked_add(EMERGENCY_REFUND_TIMELOCK_SECONDS)
            .ok_or(EscrowError::TimelockNotElapsed)?;
        if ledger_timestamp < unlock_at {
            return Err(EscrowError::TimelockNotElapsed);
        }
        if self.status == LeagueStatus::Settled || self.status == LeagueStatus::Cancelled {
            return Err(EscrowError::AlreadySettled);
        }
        if participant_idx >= self.deposits.len() || self.refunded[participant_idx] {
            return Err(EscrowError::NoDeposit);
        }
        let amount = self.deposits[participant_idx];
        self.refunded[participant_idx] = true;
        self.total_refunded += amount;
        Ok(amount)
    }
}

// 10,000-iteration high-speed property suite verifying core timelock and conservation invariants
proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn fuzz_10000_iterations_timelock_and_solvency_invariants(
        paused_at in any::<u64>(),
        ledger_timestamp in any::<u64>(),
        is_settled in any::<bool>(),
        is_paused in any::<bool>(),
        deposits in prop::collection::vec(0i128..1_000_000_000_000i128, 1..6),
    ) {
        let mut model = RefundStateMachineModel::new(false, paused_at, deposits.clone());
        let initial_total = model.total_deposited;

        if is_settled {
            let _ = model.settle();
        }
        model.paused = is_paused;

        for idx in 0..deposits.len() {
            let res = model.try_emergency_refund(idx, ledger_timestamp);
            let unlock_at = paused_at.checked_add(EMERGENCY_REFUND_TIMELOCK_SECONDS);

            if !is_paused {
                prop_assert_eq!(res, Err(EscrowError::NotPaused));
            } else if unlock_at.is_none() || ledger_timestamp < unlock_at.unwrap() {
                // Invariant 1: Deposits can NEVER be refunded before the 14-day timelock
                prop_assert_eq!(res, Err(EscrowError::TimelockNotElapsed));
            } else if is_settled {
                // Invariant 2: Settled leagues can NEVER trigger refunds
                prop_assert_eq!(res, Err(EscrowError::AlreadySettled));
            } else {
                prop_assert_eq!(res, Ok(deposits[idx]));
                // Reentrant / duplicate refund attempt must fail with NoDeposit
                let second_attempt = model.try_emergency_refund(idx, ledger_timestamp);
                prop_assert_eq!(second_attempt, Err(EscrowError::NoDeposit));
            }
        }

        // Invariant 3: Total refunded + settled amounts never exceed total deposited
        prop_assert!(
            model.total_refunded + model.total_settled <= initial_total,
            "Conservation violated: refunded ({}) + settled ({}) > deposited ({})",
            model.total_refunded,
            model.total_settled,
            initial_total
        );
    }
}

// Full Soroban TestEnv property-based fuzz suite executing on-chain WASM contract logic
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn prop_soroban_emergency_refund_timelock_and_settlement_invariants(
        paused_at in 1_000u64..1_000_000_000u64,
        time_delta in 0u64..(EMERGENCY_REFUND_TIMELOCK_SECONDS * 2),
        entry_fee in 0i128..500_000_000_000i128,
        participant_count in 1u32..=4u32,
        settle_before_pause in any::<bool>(),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(paused_at);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_address = token_contract.address();
        let token_client = token::Client::new(&env, &token_address);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let contract_address = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_address);
        client.initialize(&admin);

        let league_id = 777u64;
        let creator = Address::generate(&env);
        client.create_league(&creator, &league_id, &entry_fee, &token_address);

        let mut participants = std::vec::Vec::new();
        for _ in 0..participant_count {
            let p = Address::generate(&env);
            if entry_fee > 0 {
                token_admin_client.mint(&p, &entry_fee);
            }
            client.deposit(&p, &league_id);
            participants.push(p);
        }

        let total_deposited = entry_fee * (participant_count as i128);
        let mut total_settled: i128 = 0;

        if settle_before_pause {
            let platform_fee = (total_deposited * 500) / 10_000;
            let prize_pool = total_deposited - platform_fee;
            let mut winners: soroban_sdk::Vec<WinnerPayout> = vec![&env];
            if participant_count == 1 {
                winners.push_back(WinnerPayout {
                    winner: participants[0].clone(),
                    amount: prize_pool,
                });
            } else if participant_count == 2 {
                let p1 = (prize_pool * 70) / 100;
                let p2 = prize_pool - p1;
                winners.push_back(WinnerPayout {
                    winner: participants[0].clone(),
                    amount: p1,
                });
                winners.push_back(WinnerPayout {
                    winner: participants[1].clone(),
                    amount: p2,
                });
            } else {
                let p1 = (prize_pool * 60) / 100;
                let p2 = (prize_pool * 30) / 100;
                let p3 = prize_pool - p1 - p2;
                winners.push_back(WinnerPayout {
                    winner: participants[0].clone(),
                    amount: p1,
                });
                winners.push_back(WinnerPayout {
                    winner: participants[1].clone(),
                    amount: p2,
                });
                winners.push_back(WinnerPayout {
                    winner: participants[2].clone(),
                    amount: p3,
                });
            }
            let treasury = Address::generate(&env);
            client.settle(&admin, &league_id, &winners, &treasury, &platform_fee);
            total_settled = total_deposited;
        }

        // Pause contract at `paused_at`
        env.ledger().set_timestamp(paused_at);
        client.pause(&admin);

        // Advance ledger to `paused_at + time_delta`
        let current_ts = paused_at + time_delta;
        env.ledger().set_timestamp(current_ts);

        let mut total_refunded: i128 = 0;
        for p in &participants {
            let res = client.try_emergency_refund_league(p, &league_id);
            if time_delta < EMERGENCY_REFUND_TIMELOCK_SECONDS {
                prop_assert_eq!(
                    res,
                    Err(Ok(EscrowError::TimelockNotElapsed)),
                    "Must reject refund before 14-day timelock"
                );
            } else if settle_before_pause {
                prop_assert_eq!(
                    res,
                    Err(Ok(EscrowError::AlreadySettled)),
                    "Settled league must never allow emergency refund"
                );
            } else {
                prop_assert_eq!(res, Ok(Ok(())));
                total_refunded += entry_fee;
                prop_assert_eq!(token_client.balance(p), entry_fee);

                // Duplicate / reentrant invocation must fail with NoDeposit
                let dup_res = client.try_emergency_refund_league(p, &league_id);
                prop_assert_eq!(dup_res, Err(Ok(EscrowError::NoDeposit)));
            }
        }

        prop_assert!(
            total_refunded + total_settled <= total_deposited,
            "Total refunded ({}) + total settled ({}) must not exceed total deposited ({})",
            total_refunded,
            total_settled,
            total_deposited
        );
    }
}

#[test]
fn test_boundary_conditions_minus_one_exact_and_plus_one_second() {
    let env = Env::default();
    env.mock_all_auths();

    let start_ts = 1_700_000_000u64;
    env.ledger().set_timestamp(start_ts);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_addr = token_contract.address();
    let token_client = token::Client::new(&env, &token_addr);
    let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

    let contract_id = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract_id);
    client.initialize(&admin);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let fee = 100_000_000i128;
    token_admin_client.mint(&p1, &fee);
    token_admin_client.mint(&p2, &fee);

    client.create_league(&admin, &1, &fee, &token_addr);
    client.deposit(&p1, &1);
    client.deposit(&p2, &1);

    client.pause(&admin);
    let unlock_at = start_ts + EMERGENCY_REFUND_TIMELOCK_SECONDS;

    // 1. Boundary: unlock_at - 1 second -> TimelockNotElapsed
    env.ledger().set_timestamp(unlock_at - 1);
    assert_eq!(
        client.try_emergency_refund_league(&p1, &1),
        Err(Ok(EscrowError::TimelockNotElapsed))
    );

    // 2. Boundary: exact unlock_at -> succeeds for p1
    env.ledger().set_timestamp(unlock_at);
    assert_eq!(client.try_emergency_refund_league(&p1, &1), Ok(Ok(())));
    assert_eq!(token_client.balance(&p1), fee);

    // 3. Boundary: unlock_at + 1 second -> succeeds for p2
    env.ledger().set_timestamp(unlock_at + 1);
    assert_eq!(client.try_emergency_refund_league(&p2, &1), Ok(Ok(())));
    assert_eq!(token_client.balance(&p2), fee);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_edge_cases_zero_deposit_large_i128_and_timestamp_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_addr = token_contract.address();
    let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

    let contract_id = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract_id);
    client.initialize(&admin);

    // Edge case 1: 0 deposit league
    let zero_user = Address::generate(&env);
    client.create_league(&admin, &10, &0, &token_addr);
    client.deposit(&zero_user, &10);

    // Edge case 2: Large i128 deposit (i64::MAX stroops)
    let whale_user = Address::generate(&env);
    let large_fee = i64::MAX as i128;
    token_admin_client.mint(&whale_user, &large_fee);
    client.create_league(&admin, &11, &large_fee, &token_addr);
    client.deposit(&whale_user, &11);

    // Edge case 3: Pause near u64::MAX causes checked_add overflow -> TimelockNotElapsed
    env.ledger().set_timestamp(u64::MAX - 100);
    client.pause(&admin);
    env.ledger().set_timestamp(u64::MAX);
    assert_eq!(
        client.try_emergency_refund_league(&zero_user, &10),
        Err(Ok(EscrowError::TimelockNotElapsed))
    );

    // Unpause and re-pause at normal timestamp
    client.unpause(&admin);
    env.ledger().set_timestamp(1_000);
    client.pause(&admin);
    env.ledger()
        .set_timestamp(1_000 + EMERGENCY_REFUND_TIMELOCK_SECONDS);

    assert_eq!(
        client.try_emergency_refund_league(&zero_user, &10),
        Ok(Ok(()))
    );
    assert_eq!(
        client.try_emergency_refund_league(&whale_user, &11),
        Ok(Ok(()))
    );
}
