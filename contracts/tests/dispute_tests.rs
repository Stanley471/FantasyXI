use fantasyxi_escrow::{
    DisputeConfig, EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, WinnerPayout,
};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, vec, Address, Env, Vec};

const LEAGUE: u64 = 42;
const ENTRY_FEE: i128 = 10_000_000;
const WINDOW: u64 = 24 * 60 * 60;
const RESOLUTION: u64 = 2 * 24 * 60 * 60;
const START: u64 = 1_000;

struct Setup<'a> {
    env: Env,
    admin: Address,
    treasury: Address,
    challenger: Address,
    players: std::vec::Vec<Address>,
    token: token::Client<'a>,
    escrow: FantasyXIEscrowClient<'a>,
}

impl Setup<'_> {
    fn approvals(&self) -> Vec<Address> {
        vec![&self.env, self.admin.clone()]
    }

    fn warp(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }

    /// 70/30 split of the 19_000_000 prize pool left after a 1_000_000 fee.
    fn standard_winners(&self) -> Vec<WinnerPayout> {
        vec![
            &self.env,
            WinnerPayout {
                winner: self.players[0].clone(),
                amount: 13_300_000,
            },
            WinnerPayout {
                winner: self.players[1].clone(),
                amount: 5_700_000,
            },
        ]
    }
}

fn setup<'a>(entry_fee: i128) -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let challenger = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);
    let escrow = FantasyXIEscrowClient::new(&env, &env.register(FantasyXIEscrow, ()));
    escrow.initialize(&admin);
    escrow.set_dispute_config(
        &vec![&env, admin.clone()],
        &DisputeConfig {
            window_seconds: WINDOW,
            resolution_seconds: RESOLUTION,
            min_stake_bps: 1_000,
        },
    );

    escrow.create_league(&admin, &LEAGUE, &entry_fee, &token_address);
    let players: std::vec::Vec<Address> = (0..2).map(|_| Address::generate(&env)).collect();
    for player in &players {
        token_admin.mint(player, &entry_fee);
        escrow.deposit(player, &LEAGUE);
    }
    token_admin.mint(&challenger, &10_000_000);

    Setup {
        token: token::Client::new(&env, &token_address),
        env,
        admin,
        treasury,
        challenger,
        players,
        escrow,
    }
}

fn settle(s: &Setup<'_>, winners: &Vec<WinnerPayout>, fee: i128) {
    s.escrow
        .settle(&s.admin, &LEAGUE, winners, &s.treasury, &fee);
}

#[test]
fn claims_wait_for_the_challenge_window_to_close() {
    let s = setup(ENTRY_FEE);
    settle(&s, &s.standard_winners(), 1_000_000);

    assert_eq!(
        s.escrow.try_claim_prize(&s.players[0], &LEAGUE),
        Err(Ok(EscrowError::DisputeWindowOpen))
    );
    s.warp(WINDOW);
    s.escrow.claim_prize(&s.players[0], &LEAGUE);
    assert_eq!(s.token.balance(&s.players[0]), 13_300_000);
    assert_eq!(
        s.escrow
            .try_open_dispute(&s.challenger, &LEAGUE, &2_000_000),
        Err(Ok(EscrowError::DisputeWindowClosed))
    );
}

#[test]
fn challenge_freezes_settlement_and_enforces_stake_rules() {
    let s = setup(ENTRY_FEE);
    settle(&s, &s.standard_winners(), 1_000_000);

    // 10% of 20_000_000 total deposits.
    assert_eq!(
        s.escrow
            .try_open_dispute(&s.challenger, &LEAGUE, &1_999_999),
        Err(Ok(EscrowError::InsufficientStake))
    );
    s.escrow.open_dispute(&s.challenger, &LEAGUE, &2_000_000);
    assert_eq!(s.token.balance(&s.challenger), 8_000_000);
    assert_eq!(
        s.escrow
            .try_open_dispute(&s.challenger, &LEAGUE, &2_000_000),
        Err(Ok(EscrowError::DisputeActive))
    );

    // Still frozen after the challenge window while the ruling is pending.
    s.warp(WINDOW);
    for player in &s.players {
        assert_eq!(
            s.escrow.try_claim_prize(player, &LEAGUE),
            Err(Ok(EscrowError::DisputeActive))
        );
    }
    assert_eq!(
        s.escrow.try_expire_dispute(&LEAGUE),
        Err(Ok(EscrowError::DisputeNotExpired))
    );
}

#[test]
fn rejected_challenge_slashes_stake_to_winners_pro_rata() {
    let s = setup(ENTRY_FEE);
    settle(&s, &s.standard_winners(), 1_000_000);
    s.escrow.open_dispute(&s.challenger, &LEAGUE, &2_000_001);

    let outsider = vec![&s.env, Address::generate(&s.env)];
    assert_eq!(
        s.escrow
            .try_resolve_dispute(&outsider, &LEAGUE, &false, &Vec::new(&s.env)),
        Err(Ok(EscrowError::NotAuthorized))
    );
    s.escrow
        .resolve_dispute(&s.approvals(), &LEAGUE, &false, &Vec::new(&s.env));

    // Resolution makes the settlement final immediately.
    s.escrow.claim_prize(&s.players[0], &LEAGUE);
    s.escrow.claim_prize(&s.players[1], &LEAGUE);
    // 70% of 2_000_001 = 1_400_000 (+1 rounding remainder), 30% = 600_000.
    assert_eq!(s.token.balance(&s.players[0]), 13_300_000 + 1_400_001);
    assert_eq!(s.token.balance(&s.players[1]), 5_700_000 + 600_000);
    assert_eq!(s.token.balance(&s.challenger), 10_000_000 - 2_000_001);
    assert_eq!(s.token.balance(&s.escrow.address), 0);
    assert!(s.escrow.get_dispute(&LEAGUE).is_none());
}

#[test]
fn upheld_challenge_refunds_stake_and_applies_corrected_payouts() {
    let s = setup(ENTRY_FEE);
    settle(&s, &s.standard_winners(), 1_000_000);
    s.escrow.open_dispute(&s.challenger, &LEAGUE, &2_000_000);

    let swapped = vec![
        &s.env,
        WinnerPayout {
            winner: s.players[1].clone(),
            amount: 13_300_000,
        },
        WinnerPayout {
            winner: s.players[0].clone(),
            amount: 5_700_000,
        },
    ];
    let inflated = vec![
        &s.env,
        WinnerPayout {
            winner: s.players[1].clone(),
            amount: 19_000_001,
        },
    ];
    assert_eq!(
        s.escrow
            .try_resolve_dispute(&s.approvals(), &LEAGUE, &true, &inflated),
        Err(Ok(EscrowError::InvalidPrizeDistribution))
    );
    assert!(s.escrow.get_dispute(&LEAGUE).is_some());

    s.escrow
        .resolve_dispute(&s.approvals(), &LEAGUE, &true, &swapped);
    assert_eq!(s.token.balance(&s.challenger), 10_000_000);

    s.escrow.claim_prize(&s.players[0], &LEAGUE);
    s.escrow.claim_prize(&s.players[1], &LEAGUE);
    assert_eq!(s.token.balance(&s.players[0]), 5_700_000);
    assert_eq!(s.token.balance(&s.players[1]), 13_300_000);
    assert_eq!(s.token.balance(&s.escrow.address), 0);
    assert_eq!(
        s.escrow.try_claim_prize(&s.players[1], &LEAGUE),
        Err(Ok(EscrowError::NoClaimablePrize))
    );
}

#[test]
fn unresolved_challenge_expires_and_is_slashed_automatically() {
    let s = setup(ENTRY_FEE);
    settle(&s, &s.standard_winners(), 1_000_000);
    s.escrow.open_dispute(&s.challenger, &LEAGUE, &3_000_000);

    s.warp(RESOLUTION);
    assert_eq!(
        s.escrow
            .try_resolve_dispute(&s.approvals(), &LEAGUE, &true, &Vec::new(&s.env)),
        Err(Ok(EscrowError::DisputeWindowClosed))
    );

    // The first claim after expiry slashes the stake before paying out.
    s.escrow.claim_prize(&s.players[1], &LEAGUE);
    assert_eq!(s.token.balance(&s.players[1]), 5_700_000 + 900_000);
    assert!(s.escrow.get_dispute(&LEAGUE).is_none());
    assert_eq!(
        s.escrow.try_expire_dispute(&LEAGUE),
        Err(Ok(EscrowError::NoDispute))
    );
    s.escrow.claim_prize(&s.players[0], &LEAGUE);
    assert_eq!(s.token.balance(&s.players[0]), 13_300_000 + 2_100_000);
    assert_eq!(s.token.balance(&s.escrow.address), 0);
}

#[test]
fn stake_is_burned_when_no_winner_received_a_prize() {
    let s = setup(0);
    let zero_prize = vec![
        &s.env,
        WinnerPayout {
            winner: s.players[0].clone(),
            amount: 0,
        },
    ];
    settle(&s, &zero_prize, 0);
    s.escrow.open_dispute(&s.challenger, &LEAGUE, &1);

    s.warp(RESOLUTION);
    s.escrow.expire_dispute(&LEAGUE);
    assert_eq!(s.token.balance(&s.challenger), 10_000_000 - 1);
    assert_eq!(s.token.balance(&s.escrow.address), 0);
}

#[test]
fn dispute_config_is_quorum_gated_and_bounded() {
    let s = setup(ENTRY_FEE);
    let config = |window, resolution, bps| DisputeConfig {
        window_seconds: window,
        resolution_seconds: resolution,
        min_stake_bps: bps,
    };

    let outsider = vec![&s.env, Address::generate(&s.env)];
    assert_eq!(
        s.escrow
            .try_set_dispute_config(&outsider, &config(WINDOW, RESOLUTION, 100)),
        Err(Ok(EscrowError::NotAuthorized))
    );
    for invalid in [
        config(WINDOW, 0, 100),
        config(WINDOW, RESOLUTION, 0),
        config(WINDOW, RESOLUTION, 10_001),
        config(31 * 24 * 60 * 60, RESOLUTION, 100),
    ] {
        assert_eq!(
            s.escrow.try_set_dispute_config(&s.approvals(), &invalid),
            Err(Ok(EscrowError::InvalidDisputeConfig))
        );
    }

    // Disabling disputes makes new settlements claimable immediately.
    s.escrow
        .set_dispute_config(&s.approvals(), &config(0, 0, 0));
    settle(&s, &s.standard_winners(), 1_000_000);
    s.escrow.claim_prize(&s.players[0], &LEAGUE);
    assert_eq!(
        s.escrow
            .try_open_dispute(&s.challenger, &LEAGUE, &2_000_000),
        Err(Ok(EscrowError::DisputeWindowClosed))
    );
}
