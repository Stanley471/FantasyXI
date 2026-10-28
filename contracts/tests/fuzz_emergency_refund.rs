//! Property-based fuzz test suite for escrow contract emergency refund timelocks
//! Targets: contracts/src/lib.rs (Issue #259)
//!
//! Invariants modeled:
//! 1. Deposits cannot be refunded before the 14-day timelock (EMERGENCY_REFUND_TIMELOCK_SECONDS).
//! 2. Settled leagues can never trigger refunds (EscrowError::AlreadySettled).
//! 3. Total refunded plus settled amounts cannot exceed total deposited (Conservation of Funds).
//! 4. Strict boundary conditions tested at unlock_at - 1, exact unlock_at, and unlock_at + 1.

use fantasyxi_escrow::{
    EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, LeagueStatus, WinnerPayout,
};
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, vec, Address, BytesN, Env};

const TIMELOCK_SECONDS: u64 = 14 * 24 * 60 * 60; // 14 days = 1,209,600s

fn setup_fuzz_env() -> (Env, Address, Address, FantasyXIEscrowClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let contract_id = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract_id);

    client.initialize(&admin);

    (env, admin, token_contract.address(), client)
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(256),
        max_shrink_iters: 1000,
        ..ProptestConfig::default()
    })]

    /// Tests boundary conditions around the 14-day timelock:
    /// - timestamp = unlock_at - 1 => Err(TimelockNotElapsed)
    /// - timestamp = unlock_at => Ok(())
    /// - timestamp = unlock_at + offset => Ok(())
    #[test]
    fn prop_emergency_refund_timelock_boundaries(
        start_time in 1_000_000u64..100_000_000u64,
        entry_fee in 1_000i128..1_000_000_000i128,
        post_unlock_offset in 1u64..1_000_000u64,
    ) {
        let (env, admin, token_addr, client) = setup_fuzz_env();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        env.ledger().set_timestamp(start_time);

        let creator = Address::generate(&env);
        let participant1 = Address::generate(&env);
        let participant2 = Address::generate(&env);
        let league_id = 901u64;

        token_admin_client.mint(&participant1, &entry_fee);
        token_admin_client.mint(&participant2, &entry_fee);

        client.create_league(&creator, &league_id, &entry_fee, &token_addr);
        client.deposit(&participant1, &league_id);
        client.deposit(&participant2, &league_id);

        let pause_timestamp = start_time + 500;
        env.ledger().set_timestamp(pause_timestamp);
        client.pause(&admin);

        let unlock_at = pause_timestamp + TIMELOCK_SECONDS;

        // Boundary Condition 1: Timelock - 1 second => MUST fail with TimelockNotElapsed
        env.ledger().set_timestamp(unlock_at - 1);
        let res_before = client.try_emergency_refund_league(&participant1, &league_id);
        prop_assert_eq!(
            res_before,
            Err(Ok(EscrowError::TimelockNotElapsed)),
            "Refund 1 second before timelock must fail with TimelockNotElapsed"
        );

        // Boundary Condition 2: Exact timelock second => MUST succeed
        env.ledger().set_timestamp(unlock_at);
        let res_exact = client.try_emergency_refund_league(&participant1, &league_id);
        prop_assert!(
            res_exact.is_ok(),
            "Refund at exact timelock second must succeed: {:?}",
            res_exact
        );

        // Replay attempt by participant1 => MUST fail with NoDeposit
        let res_replay = client.try_emergency_refund_league(&participant1, &league_id);
        prop_assert_eq!(
            res_replay,
            Err(Ok(EscrowError::NoDeposit)),
            "Double emergency refund must fail with NoDeposit"
        );

        // Boundary Condition 3: Timelock + offset second => MUST succeed for participant2
        env.ledger().set_timestamp(unlock_at + post_unlock_offset);
        let res_after = client.try_emergency_refund_league(&participant2, &league_id);
        prop_assert!(
            res_after.is_ok(),
            "Refund after timelock must succeed: {:?}",
            res_after
        );
    }

    /// Tests Invariant 2: Settled leagues can NEVER trigger emergency refunds,
    /// even after the 14-day timelock has elapsed.
    #[test]
    fn prop_settled_leagues_never_trigger_emergency_refund(
        start_time in 1_000_000u64..100_000_000u64,
        entry_fee in 10_000i128..10_000_000i128,
        extra_elapsed in 0u64..10_000_000u64,
    ) {
        let (env, admin, token_addr, client) = setup_fuzz_env();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        env.ledger().set_timestamp(start_time);

        let creator = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let treasury = Address::generate(&env);
        let league_id = 902u64;

        token_admin_client.mint(&user1, &entry_fee);
        token_admin_client.mint(&user2, &entry_fee);

        client.create_league(&creator, &league_id, &entry_fee, &token_addr);
        client.deposit(&user1, &league_id);
        client.deposit(&user2, &league_id);

        let total_pool = entry_fee * 2;
        let platform_fee = (total_pool * 500) / 10000;
        let prize_pool = total_pool - platform_fee;
        let p1 = (prize_pool * 70) / 100;
        let p2 = prize_pool - p1;

        let winners = vec![
            &env,
            WinnerPayout { winner: user1.clone(), amount: p1 },
            WinnerPayout { winner: user2.clone(), amount: p2 },
        ];

        // Settle the league
        let settle_res = client.try_settle(&admin, &league_id, &winners, &treasury, &platform_fee);
        prop_assert!(settle_res.is_ok(), "League settlement must succeed");

        let league = client.get_league(&league_id).unwrap();
        prop_assert_eq!(league.status, LeagueStatus::Settled);

        // Pause contract and advance timestamp far past 14 days
        client.pause(&admin);
        let past_timelock = start_time + TIMELOCK_SECONDS + extra_elapsed + 100;
        env.ledger().set_timestamp(past_timelock);

        // Invariant: Emergency refund attempt on settled league MUST return AlreadySettled
        let refund_user1 = client.try_emergency_refund_league(&user1, &league_id);
        prop_assert_eq!(
            refund_user1,
            Err(Ok(EscrowError::AlreadySettled)),
            "Settled league must reject emergency refund with AlreadySettled"
        );

        let refund_user2 = client.try_emergency_refund_league(&user2, &league_id);
        prop_assert_eq!(
            refund_user2,
            Err(Ok(EscrowError::AlreadySettled)),
            "Settled league must reject emergency refund with AlreadySettled"
        );
    }

    /// Tests Invariant 3: Conservation of Funds & Solvency
    /// Total refunded + remaining balance == initial total deposits (zero leakage)
    #[test]
    fn prop_emergency_refund_conservation_of_funds(
        entry_fee in 1_000i128..5_000_000i128,
        participant_count in 1u32..=6u32,
        refund_count in 1u32..=6u32,
    ) {
        let (env, admin, token_addr, client) = setup_fuzz_env();
        let token_client = token::Client::new(&env, &token_addr);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let start_time = 5_000_000u64;
        env.ledger().set_timestamp(start_time);

        let creator = Address::generate(&env);
        let league_id = 903u64;
        client.create_league(&creator, &league_id, &entry_fee, &token_addr);

        let mut participants = std::vec::Vec::new();
        for _ in 0..participant_count {
            let p = Address::generate(&env);
            token_admin_client.mint(&p, &entry_fee);
            client.deposit(&p, &league_id);
            participants.push(p);
        }

        let total_deposited = entry_fee * participant_count as i128;
        let contract_addr = env.current_contract_address();
        prop_assert_eq!(token_client.balance(&contract_addr), total_deposited);

        // Pause contract and elapse timelock
        client.pause(&admin);
        env.ledger().set_timestamp(start_time + TIMELOCK_SECONDS + 10);

        let to_refund = refund_count.min(participant_count) as usize;
        let mut refunded_total = 0i128;

        for p in participants.iter().take(to_refund) {
            let balance_before = token_client.balance(p);
            let res = client.try_emergency_refund_league(p, &league_id);
            prop_assert!(res.is_ok(), "Timelock elapsed emergency refund must succeed");

            let balance_after = token_client.balance(p);
            prop_assert_eq!(balance_after - balance_before, entry_fee);
            refunded_total += entry_fee;
        }

        let remaining_balance = token_client.balance(&contract_addr);
        // CONSERVATION INVARIANT: Refunded + Remaining balance strictly equals initial deposits
        prop_assert_eq!(
            refunded_total + remaining_balance,
            total_deposited,
            "Conservation of funds violated: refunded {} + remaining {} != total {}",
            refunded_total,
            remaining_balance,
            total_deposited
        );

        let league = client.get_league(&league_id).unwrap();
        prop_assert_eq!(league.total_deposited, total_deposited - refunded_total);
        prop_assert_eq!(league.participant_count, participant_count - to_refund as u32);
    }

    /// Tests edge cases: unpaused refunds, non-depositor, frozen league, 0 deposit
    #[test]
    fn prop_emergency_refund_edge_cases(
        fee in 10_000i128..1_000_000i128,
    ) {
        let (env, admin, token_addr, client) = setup_fuzz_env();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let start_time = 10_000_000u64;
        env.ledger().set_timestamp(start_time);

        let creator = Address::generate(&env);
        let depositor = Address::generate(&env);
        let outsider = Address::generate(&env);
        let league_id = 904u64;

        token_admin_client.mint(&depositor, &fee);
        client.create_league(&creator, &league_id, &fee, &token_addr);
        client.deposit(&depositor, &league_id);

        // Edge Case 1: Contract NOT paused => MUST fail with NotPaused
        let unpaused_refund = client.try_emergency_refund_league(&depositor, &league_id);
        prop_assert_eq!(
            unpaused_refund,
            Err(Ok(EscrowError::NotPaused)),
            "Refund on active unpaused contract must fail with NotPaused"
        );

        // Edge Case 2: Outsider with 0 deposits attempts refund => MUST fail with NoDeposit
        client.pause(&admin);
        env.ledger().set_timestamp(start_time + TIMELOCK_SECONDS + 5);

        let outsider_refund = client.try_emergency_refund_league(&outsider, &league_id);
        prop_assert_eq!(
            outsider_refund,
            Err(Ok(EscrowError::NoDeposit)),
            "Non-depositor refund must fail with NoDeposit"
        );

        // Edge Case 3: Non-existent league => MUST fail with LeagueNotFound
        let ghost_league = client.try_emergency_refund_league(&depositor, &999_999u64);
        prop_assert_eq!(
            ghost_league,
            Err(Ok(EscrowError::LeagueNotFound)),
            "Non-existent league refund must fail with LeagueNotFound"
        );

        // Edge Case 4: Frozen league under dispute => MUST fail with ContractPaused
        let reason_hash = BytesN::from_array(&env, &[7u8; 32]);
        client.freeze_league(&admin, &league_id, &reason_hash);

        let frozen_refund = client.try_emergency_refund_league(&depositor, &league_id);
        prop_assert_eq!(
            frozen_refund,
            Err(Ok(EscrowError::ContractPaused)),
            "Frozen league must reject refund with ContractPaused"
        );

        // Unfreezing allows refund to proceed
        client.unfreeze_league(&admin, &league_id);
        let unfreezed_refund = client.try_emergency_refund_league(&depositor, &league_id);
        prop_assert!(
            unfreezed_refund.is_ok(),
            "Refund after unfreezing must succeed"
        );
    }
}
