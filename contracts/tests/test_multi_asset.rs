use fantasyxi_escrow::{
    EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, LeagueStatus, WinnerPayout,
};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, vec, Address, Env};

#[test]
fn test_multi_asset_whitelist_deposit_and_settlement() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Register 3 distinct SAC token contracts (e.g., USDC, EURC, native XLM SAC)
    let usdc_admin = Address::generate(&env);
    let eurc_admin = Address::generate(&env);
    let xlm_admin = Address::generate(&env);
    let unapproved_admin = Address::generate(&env);

    let usdc_sac = env.register_stellar_asset_contract_v2(usdc_admin);
    let eurc_sac = env.register_stellar_asset_contract_v2(eurc_admin);
    let xlm_sac = env.register_stellar_asset_contract_v2(xlm_admin);
    let unapproved_sac = env.register_stellar_asset_contract_v2(unapproved_admin);

    let usdc_addr = usdc_sac.address();
    let eurc_addr = eurc_sac.address();
    let xlm_addr = xlm_sac.address();
    let unapproved_addr = unapproved_sac.address();

    let contract_id = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract_id);
    client.initialize(&admin);

    // Whitelist USDC, EURC, and XLM SAC
    client.whitelist_asset(&admin, &usdc_addr);
    client.whitelist_asset(&admin, &eurc_addr);
    client.whitelist_asset(&admin, &xlm_addr);

    assert!(client.is_asset_whitelisted(&usdc_addr));
    assert!(client.is_asset_whitelisted(&eurc_addr));
    assert!(client.is_asset_whitelisted(&xlm_addr));
    assert!(!client.is_asset_whitelisted(&unapproved_addr));
    assert_eq!(client.get_whitelisted_assets().len(), 3);

    // Reject league creation with non-whitelisted SAC token
    let bad_create = client.try_create_league(&creator, &901, &100_000_000, &unapproved_addr);
    assert_eq!(bad_create, Err(Ok(EscrowError::AssetNotWhitelisted)));

    // Reject league creation with uninitialized non-SAC address
    let uninitialized_addr = Address::generate(&env);
    let uninit_create = client.try_create_league(&creator, &902, &100_000_000, &uninitialized_addr);
    assert_eq!(uninit_create, Err(Ok(EscrowError::AssetNotWhitelisted)));

    // Create League #1001 denominated in EURC (non-USDC whitelisted token)
    let entry_fee_eurc = 250_000_000i128; // 25 EURC
    client.create_league(&creator, &1001, &entry_fee_eurc, &eurc_addr);

    // Create League #1002 denominated in XLM SAC
    let entry_fee_xlm = 500_000_000i128; // 50 XLM
    client.create_league(&creator, &1002, &entry_fee_xlm, &xlm_addr);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);

    let eurc_mint = token::StellarAssetClient::new(&env, &eurc_addr);
    let eurc_token = token::Client::new(&env, &eurc_addr);
    eurc_mint.mint(&p1, &entry_fee_eurc);
    eurc_mint.mint(&p2, &entry_fee_eurc);

    let xlm_mint = token::StellarAssetClient::new(&env, &xlm_addr);
    let xlm_token = token::Client::new(&env, &xlm_addr);
    xlm_mint.mint(&p1, &entry_fee_xlm);

    // Deposit into EURC league and XLM league
    client.deposit(&p1, &1001);
    client.deposit(&p2, &1001);
    client.deposit(&p1, &1002);

    assert_eq!(eurc_token.balance(&contract_id), 500_000_000);
    assert_eq!(xlm_token.balance(&contract_id), 500_000_000);

    // Settle EURC league: 5% platform fee (25_000_000), 70/30 split of 475_000_000
    let winners_eurc = vec![
        &env,
        WinnerPayout {
            winner: p1.clone(),
            amount: 332_500_000,
        },
        WinnerPayout {
            winner: p2.clone(),
            amount: 142_500_000,
        },
    ];
    client.settle(&admin, &1001, &winners_eurc, &treasury, &25_000_000);

    let league_eurc = client.get_league(&1001).unwrap();
    assert_eq!(league_eurc.status, LeagueStatus::Settled);
    assert_eq!(eurc_token.balance(&treasury), 25_000_000);

    client.claim_prize(&p1, &1001);
    client.claim_prize(&p2, &1001);
    assert_eq!(eurc_token.balance(&p1), 332_500_000);
    assert_eq!(eurc_token.balance(&p2), 142_500_000);
}

#[test]
fn test_revoking_whitelisted_asset_blocks_subsequent_deposits() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let participant = Address::generate(&env);
    let non_admin = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token_addr = sac.address();
    let token_mint = token::StellarAssetClient::new(&env, &token_addr);

    let contract_id = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract_id);
    client.initialize(&admin);

    // Non-admin cannot whitelist or revoke
    assert_eq!(
        client.try_whitelist_asset(&non_admin, &token_addr),
        Err(Ok(EscrowError::NotAuthorized))
    );

    client.whitelist_asset(&admin, &token_addr);
    client.create_league(&creator, &1005, &50_000_000, &token_addr);

    // Admin revokes asset before participant deposits
    client.revoke_whitelisted_asset(&admin, &token_addr);
    assert!(!client.is_asset_whitelisted(&token_addr));

    token_mint.mint(&participant, &50_000_000);
    let dep_res = client.try_deposit(&participant, &1005);
    assert_eq!(dep_res, Err(Ok(EscrowError::AssetNotWhitelisted)));
}
