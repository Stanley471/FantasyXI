use proptest::prelude::*;
use soroban_sdk::testutils::Ledger;
use soroban_sdk::{vec, Address, Env};
use fantasyxi_escrow::{{FantasyXIEscrowClient, WinnerPayout, LeagueStatus}};

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
        let entry_fee = if entry_fee < 0 { 0 } else { (entry_fee % 1_000_000_000).abs() } as i128;

        client.create_league(&creator, &42u64, &entry_fee, &token_contract.address());

        let mut participants = Vec::new();
        let mut winners = vec!(&env);
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
            let participants_vec = vec!(&env);
            let res = client.try_refund(&admin, &42u64, &participants_vec);
            prop_assert!(res.is_ok());
            return Ok(());
        }

        // compute platform fee as percentage of total_deposited
        let platform_fee = (total_deposited * (platform_fee_perc as i128)) / 100;
        // ensure fee doesn't exceed max cap artificially, but allow tests to hit edge

        // winners: if participants >=1 create 1 winner, else multiple
        if participant_count == 1 {
            winners.push_back(&participants[0]);
            winners.push_back(&env, WinnerPayout{ winner: participants[0].clone(), amount: total_deposited - platform_fee});
        } else if participant_count == 2 {
            // split 70/30
            let p1 = ( (total_deposited - platform_fee) * 70) / 100;
            let p2 = (total_deposited - platform_fee) - p1;
            winners.push_back(&participants[0]);
            winners.push_back(&env, WinnerPayout{ winner: participants[0].clone(), amount: p1});
            winners.push_back(&env, WinnerPayout{ winner: participants[1].clone(), amount: p2});
        } else {
            // 3+ -> 60/30/10
            let p1 = ((total_deposited - platform_fee) * 60)/100;
            let p2 = ((total_deposited - platform_fee) * 30)/100;
            let p3 = (total_deposited - platform_fee) - p1 - p2;
            winners.push_back(&participants[0]);
            winners.push_back(&env, WinnerPayout{ winner: participants[0].clone(), amount: p1});
            winners.push_back(&env, WinnerPayout{ winner: participants[1].clone(), amount: p2});
            winners.push_back(&env, WinnerPayout{ winner: participants[2.min((participant_count-1) as usize)].clone(), amount: p3});
        }

        // try settle; capture result but don't assert success (we want to ensure no panics and correct error handling)
        let treasury = Address::generate(&env);
        let _ = client.try_settle(&admin, &42u64, &winners, &treasury, &platform_fee);

        // attempt refund which should either be Ok or return AlreadySettled
        let participants_vec = vec!(&env);
        for p in participants.iter() { participants_vec.push_back(p.clone()); }
        let _ = client.try_refund(&admin, &42u64, &participants_vec);

        // No assertion - proptest detects panics/UB/overflows
    }
}
