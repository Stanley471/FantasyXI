use fantasyxi_escrow::{EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, WinnerPayout};
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, vec, Address, Env};

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50))]

    /// Invariant 1 & 3: Contract Solvency & Conservation of Funds
    /// - Contract Token Balance >= Sum(Undisbursed League Deposits)
    /// - Winner distribution sum strictly equals 95% of league prize pool
    /// - Sum of winner payouts + platform fee strictly equals total league pool (zero rounding leaks)
    #[test]
    fn prop_solvency_and_prize_pool_conservation(
        entry_fee in 1_000i128..10_000_000i128,
        participant_count in 1u32..=8u32,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(10_000);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_address = token_contract.address();
        let token_client = token::Client::new(&env, &token_address);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let contract_address = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_address);

        client.initialize(&admin);

        let league_id = 101u64;
        let creator = Address::generate(&env);
        client.create_league(&creator, &league_id, &entry_fee, &token_address);

        let mut participants = std::vec::Vec::new();
        for _ in 0..participant_count {
            let p = Address::generate(&env);
            token_admin_client.mint(&p, &entry_fee);
            client.deposit(&p, &league_id);
            participants.push(p);
        }

        let total_pool = entry_fee * participant_count as i128;
        let contract_balance_after_deposits = token_client.balance(&contract_address);

        // INVARIANT 1: Contract Token Balance >= Sum(Undisbursed League Deposits)
        prop_assert!(
            contract_balance_after_deposits >= total_pool,
            "Contract balance {} must cover total undisbursed deposits {}",
            contract_balance_after_deposits,
            total_pool
        );

        // INVARIANT 2: Platform fee is strictly 5% (500 bps = 5%)
        let platform_fee = (total_pool * 500) / 10000;
        let prize_pool = total_pool - platform_fee;

        // INVARIANT 3: Winner distribution sum strictly equals 95% of league prize pool
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

        let winner_sum: i128 = winners.iter().map(|w| w.amount).sum();
        prop_assert_eq!(
            winner_sum,
            prize_pool,
            "Winner payouts sum ({}) must strictly equal prize pool ({})",
            winner_sum,
            prize_pool
        );

        prop_assert_eq!(
            winner_sum + platform_fee,
            total_pool,
            "Winner sum + platform fee ({}) must equal total league deposits ({}) without rounding leaks",
            winner_sum + platform_fee,
            total_pool
        );

        // Perform settlement
        let treasury = Address::generate(&env);
        client.settle(&admin, &league_id, &winners, &treasury, &platform_fee);

        // Platform fee is transferred directly during settle, prize pool remains until claimed
        let expected_remaining = total_pool - platform_fee;
        prop_assert_eq!(
            token_client.balance(&contract_address),
            expected_remaining,
            "Contract balance after settlement must equal prize pool"
        );
        prop_assert_eq!(
            token_client.balance(&treasury),
            platform_fee,
            "Treasury must receive exactly 5% platform fee"
        );

        // Winners claim prizes
        for winner in winners.iter() {
            if winner.amount > 0 {
                client.claim_prize(&winner.winner, &league_id);
                prop_assert_eq!(
                    token_client.balance(&winner.winner),
                    winner.amount,
                    "Winner received exact designated payout"
                );
            }
        }

        // Post-claim: all funds disbursed, balance must be zero for this league
        prop_assert_eq!(
            token_client.balance(&contract_address),
            0,
            "Contract balance must be fully disbursed after claims"
        );
    }

    /// Invariant 2: Platform fee cap enforcement
    /// Any fee exceeding 5% (500 bps) must be rejected with EscrowError::FeeExceedsMaxCap
    #[test]
    fn prop_platform_fee_strictly_capped_at_5_percent(
        entry_fee in 100_000i128..1_000_000i128,
        fee_basis_points in 501u32..10_000u32,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_address = token_contract.address();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let contract_address = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_address);
        client.initialize(&admin);

        let league_id = 202u64;
        let creator = Address::generate(&env);
        client.create_league(&creator, &league_id, &entry_fee, &token_address);

        let p1 = Address::generate(&env);
        token_admin_client.mint(&p1, &entry_fee);
        client.deposit(&p1, &league_id);

        let total_pool = entry_fee;
        // Construct an excessive fee (> 5%)
        let excessive_fee = (total_pool * fee_basis_points as i128) / 10_000;
        let adjusted_prize_pool = total_pool - excessive_fee;

        let mut winners: soroban_sdk::Vec<WinnerPayout> = vec![&env];
        winners.push_back(WinnerPayout {
            winner: p1.clone(),
            amount: adjusted_prize_pool,
        });

        let treasury = Address::generate(&env);
        let res = client.try_settle(&admin, &league_id, &winners, &treasury, &excessive_fee);
        prop_assert_eq!(
            res,
            Err(Ok(EscrowError::FeeExceedsMaxCap)),
            "Settlement with fee > 5% must fail with FeeExceedsMaxCap"
        );
    }

    /// Invariant: Non-admin or manipulated payout distribution rejection
    /// - Non-admin cannot settle (EscrowError::NotAuthorized)
    /// - Payout ratios manipulated away from standard curve are rejected (EscrowError::InvalidPrizeDistribution)
    #[test]
    fn prop_unauthorized_settlement_and_manipulated_payout_rejected(
        entry_fee in 10_000i128..500_000i128,
        manipulated_delta in 1i128..1_000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_address = token_contract.address();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

        let contract_address = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_address);
        client.initialize(&admin);

        let league_id = 303u64;
        let creator = Address::generate(&env);
        client.create_league(&creator, &league_id, &entry_fee, &token_address);

        let p1 = Address::generate(&env);
        let p2 = Address::generate(&env);
        token_admin_client.mint(&p1, &entry_fee);
        token_admin_client.mint(&p2, &entry_fee);
        client.deposit(&p1, &league_id);
        client.deposit(&p2, &league_id);

        let total_pool = entry_fee * 2;
        let platform_fee = (total_pool * 500) / 10000;
        let prize_pool = total_pool - platform_fee;

        let p1_payout = (prize_pool * 70) / 100;
        let p2_payout = prize_pool - p1_payout;

        let mut valid_winners: soroban_sdk::Vec<WinnerPayout> = vec![&env];
        valid_winners.push_back(WinnerPayout {
            winner: p1.clone(),
            amount: p1_payout,
        });
        valid_winners.push_back(WinnerPayout {
            winner: p2.clone(),
            amount: p2_payout,
        });

        let treasury = Address::generate(&env);

        // 1. Non-admin settlement attempt fails
        let unauth_res = client.try_settle(&non_admin, &league_id, &valid_winners, &treasury, &platform_fee);
        prop_assert_eq!(
            unauth_res,
            Err(Ok(EscrowError::NotAuthorized)),
            "Non-admin caller must be rejected with NotAuthorized"
        );

        // 2. Manipulated payout distribution attempt fails
        let mut manipulated_winners: soroban_sdk::Vec<WinnerPayout> = vec![&env];
        manipulated_winners.push_back(WinnerPayout {
            winner: p1.clone(),
            amount: p1_payout + manipulated_delta,
        });
        manipulated_winners.push_back(WinnerPayout {
            winner: p2.clone(),
            amount: p2_payout - manipulated_delta,
        });

        let manip_res = client.try_settle(&admin, &league_id, &manipulated_winners, &treasury, &platform_fee);
        prop_assert_eq!(
            manip_res,
            Err(Ok(EscrowError::InvalidPrizeDistribution)),
            "Manipulated payout ratios must be rejected with InvalidPrizeDistribution"
        );
    }
}

fn release_wasm() -> &'static [u8] {
    include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm"
    ))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    /// Upgrade governance: an M-of-N quorum (M >= 2) is the only path to a WASM
    /// upgrade. Any approval set that is short of quorum, padded with duplicates,
    /// or contains an outsider is rejected with an explicit error and leaves the
    /// pending proposal untouched; the full quorum then upgrades successfully.
    #[test]
    fn prop_upgrade_requires_signature_threshold(
        signer_count in 2u32..=5u32,
        threshold_seed in any::<u32>(),
        short_by_seed in any::<u32>(),
        pad_with_duplicate in any::<bool>(),
        include_outsider in any::<bool>(),
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let threshold = 2 + threshold_seed % (signer_count - 1);
        let signers: std::vec::Vec<Address> =
            (0..signer_count).map(|_| Address::generate(&env)).collect();
        let mut signer_vec = vec![&env];
        for signer in &signers {
            signer_vec.push_back(signer.clone());
        }

        let contract_address = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_address);
        client.initialize_multisig(&signer_vec, &threshold);

        // Keep the uploaded code live across the upgrade timelock.
        env.ledger().with_mut(|li| {
            li.min_persistent_entry_ttl = 2 * fantasyxi_escrow::UPGRADE_TIMELOCK_LEDGERS;
        });
        let wasm_hash = env.deployer().upload_contract_wasm(release_wasm());

        // Executing without a proposal is impossible even with full quorum.
        prop_assert_eq!(
            client.try_upgrade(&signer_vec, &wasm_hash),
            Err(Ok(EscrowError::UpgradeNotProposed))
        );

        client.propose_upgrade(&signers[0], &wasm_hash);

        // Full quorum is still blocked until the timelock elapses.
        prop_assert_eq!(
            client.try_upgrade(&signer_vec, &wasm_hash),
            Err(Ok(EscrowError::TimelockActive))
        );
        env.ledger().with_mut(|li| {
            li.sequence_number += fantasyxi_escrow::UPGRADE_TIMELOCK_LEDGERS;
        });

        // Single signature never suffices.
        for signer in &signers {
            prop_assert_eq!(
                client.try_upgrade(&vec![&env, signer.clone()], &wasm_hash),
                Err(Ok(EscrowError::InvalidMultisig))
            );
        }

        // Any sub-quorum set, optionally padded to quorum size with a duplicate
        // or an outsider, is rejected.
        let short_len = 1 + short_by_seed % (threshold - 1);
        let mut insufficient = vec![&env];
        for signer in signers.iter().take(short_len as usize) {
            insufficient.push_back(signer.clone());
        }
        prop_assert_eq!(
            client.try_upgrade(&insufficient, &wasm_hash),
            Err(Ok(EscrowError::InvalidMultisig))
        );
        while insufficient.len() < threshold {
            if include_outsider {
                insufficient.push_back(Address::generate(&env));
            } else if pad_with_duplicate {
                insufficient.push_back(signers[0].clone());
            } else {
                break;
            }
        }
        if insufficient.len() >= threshold {
            let expected = if include_outsider {
                EscrowError::NotAuthorized
            } else {
                EscrowError::InvalidMultisig
            };
            prop_assert_eq!(client.try_upgrade(&insufficient, &wasm_hash), Err(Ok(expected)));
        }

        // Quorum approving a different hash than the one proposed is rejected.
        let mut quorum = vec![&env];
        for signer in signers.iter().take(threshold as usize) {
            quorum.push_back(signer.clone());
        }
        let other_hash = soroban_sdk::BytesN::from_array(&env, &[9; 32]);
        prop_assert_eq!(
            client.try_upgrade(&quorum, &other_hash),
            Err(Ok(EscrowError::HashMismatch))
        );
        prop_assert!(client.get_pending_upgrade().is_some());

        // Exactly M distinct signers succeed and consume the proposal.
        client.upgrade(&quorum, &wasm_hash);
        prop_assert!(client.get_pending_upgrade().is_none());
        prop_assert_eq!(
            client.try_upgrade(&quorum, &wasm_hash),
            Err(Ok(EscrowError::UpgradeNotProposed))
        );
    }
}
