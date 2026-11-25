use fantasyxi_escrow::{EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, LeagueStatus};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, vec, Address, BytesN, Env};

const LEAGUE_ID: u64 = 419;
const ENTRY_FEE: i128 = 10_000_000;
const LOCK_WINDOW_SECONDS: u64 = 72 * 60 * 60;
const START_TS: u64 = 10_000;

struct ArbitrationFixture<'a> {
    env: Env,
    league_admin: Address,
    platform_arbitrator: Address,
    escrow_signer: Address,
    outsider: Address,
    players: std::vec::Vec<Address>,
    token: token::Client<'a>,
    escrow: FantasyXIEscrowClient<'a>,
}

fn setup_fixture<'a>() -> ArbitrationFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START_TS);

    let league_admin = Address::generate(&env);
    let platform_arbitrator = Address::generate(&env);
    let escrow_signer = Address::generate(&env);
    let outsider = Address::generate(&env);

    let token_address = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);

    let escrow = FantasyXIEscrowClient::new(&env, &env.register(FantasyXIEscrow, ()));
    let signers = vec![
        &env,
        league_admin.clone(),
        platform_arbitrator.clone(),
        escrow_signer.clone(),
    ];
    escrow.initialize_multisig(&signers, &2);
    escrow.create_league(&league_admin, &LEAGUE_ID, &ENTRY_FEE, &token_address);

    let players: std::vec::Vec<Address> = (0..3).map(|_| Address::generate(&env)).collect();
    for player in &players {
        token_admin.mint(player, &ENTRY_FEE);
        escrow.deposit(player, &LEAGUE_ID);
    }

    ArbitrationFixture {
        token: token::Client::new(&env, &token_address),
        env,
        league_admin,
        platform_arbitrator,
        escrow_signer,
        outsider,
        players,
        escrow,
    }
}

#[test]
fn multisig_refund_requires_threshold_and_transitions_states() {
    let f = setup_fixture();
    let participants = vec![
        &f.env,
        f.players[0].clone(),
        f.players[1].clone(),
        f.players[2].clone(),
    ];
    let reason_hash = BytesN::from_array(&f.env, &[0x42; 32]);

    // 1. Propose refund -> transitions league to Disputed
    let proposal_id = f.escrow.propose_multisig_refund(
        &f.league_admin,
        &LEAGUE_ID,
        &participants,
        &reason_hash,
        &LOCK_WINDOW_SECONDS,
    );
    let league = f.escrow.get_league(&LEAGUE_ID).unwrap();
    assert_eq!(league.status, LeagueStatus::Disputed);
    assert!(f.escrow.is_league_frozen(&LEAGUE_ID));

    // 2. Partial signature (1-of-3) cannot execute refund
    let partial_approvals = vec![&f.env, f.league_admin.clone()];
    assert_eq!(
        f.escrow
            .try_execute_multisig_refund(&partial_approvals, &LEAGUE_ID, &participants),
        Err(Ok(EscrowError::InvalidMultisig))
    );

    // 3. Duplicate approval and unauthorized approval are rejected
    assert_eq!(
        f.escrow
            .try_approve_multisig_refund(&f.league_admin, &proposal_id),
        Err(Ok(EscrowError::AlreadyApproved))
    );
    assert_eq!(
        f.escrow
            .try_approve_multisig_refund(&f.outsider, &proposal_id),
        Err(Ok(EscrowError::NotAuthorized))
    );

    // 4. Second signer approves -> transitions league to ArbitrationPending
    let count = f
        .escrow
        .approve_multisig_refund(&f.platform_arbitrator, &proposal_id);
    assert_eq!(count, 2);
    let league_after_approval = f.escrow.get_league(&LEAGUE_ID).unwrap();
    assert_eq!(
        league_after_approval.status,
        LeagueStatus::ArbitrationPending
    );

    // 5. Execute 2-of-3 multisig refund -> refunds all participants and transitions to Refunded
    let quorum_approvals = vec![
        &f.env,
        f.league_admin.clone(),
        f.platform_arbitrator.clone(),
    ];
    f.escrow
        .execute_multisig_refund(&quorum_approvals, &LEAGUE_ID, &participants);

    let league_final = f.escrow.get_league(&LEAGUE_ID).unwrap();
    assert_eq!(league_final.status, LeagueStatus::Refunded);
    assert!(!f.escrow.is_league_frozen(&LEAGUE_ID));
    for player in &f.players {
        assert_eq!(f.token.balance(player), ENTRY_FEE);
    }
    assert_eq!(f.token.balance(&f.escrow.address), 0);
}

#[test]
fn consensus_timeout_transitions_to_proportional_refund() {
    let f = setup_fixture();
    let participants = vec![
        &f.env,
        f.players[0].clone(),
        f.players[1].clone(),
        f.players[2].clone(),
    ];
    let reason_hash = BytesN::from_array(&f.env, &[0xAB; 32]);

    let proposal_id = f.escrow.propose_multisig_refund(
        &f.league_admin,
        &LEAGUE_ID,
        &participants,
        &reason_hash,
        &LOCK_WINDOW_SECONDS,
    );

    // Before timeout elapses, automated timeout refund is rejected
    assert_eq!(
        f.escrow
            .try_execute_timeout_refund(&f.escrow_signer, &LEAGUE_ID, &proposal_id,),
        Err(Ok(EscrowError::DisputeNotExpired))
    );

    // Advance ledger timestamp past lock window
    f.env
        .ledger()
        .with_mut(|li| li.timestamp += LOCK_WINDOW_SECONDS + 1);

    f.escrow
        .execute_timeout_refund(&f.escrow_signer, &LEAGUE_ID, &proposal_id);

    let league = f.escrow.get_league(&LEAGUE_ID).unwrap();
    assert_eq!(league.status, LeagueStatus::Refunded);
    assert!(!f.escrow.is_league_frozen(&LEAGUE_ID));
    for player in &f.players {
        assert_eq!(f.token.balance(player), ENTRY_FEE);
    }
    assert_eq!(f.token.balance(&f.escrow.address), 0);

    // Re-executing timeout refund is rejected
    assert_eq!(
        f.escrow
            .try_execute_timeout_refund(&f.escrow_signer, &LEAGUE_ID, &proposal_id,),
        Err(Ok(EscrowError::ProposalExecuted))
    );
}
