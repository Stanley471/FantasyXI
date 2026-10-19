use fantasyxi_escrow::{
    EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, LeagueStatus, WinnerPayout,
};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, Env};

const LEAGUE_COUNT: u64 = 32;
const PARTICIPANT_COUNT: usize = 8;
const ENTRY_FEE: i128 = 1_000_000;

struct Generator(u64);

impl Generator {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        self.0
    }
}

fn assert_solvency(
    token_client: &token::Client,
    client: &FantasyXIEscrowClient<'_>,
    active_deposits: i128,
) {
    assert!(
        token_client.balance(&client.address) >= active_deposits,
        "contract balance must cover all active league deposits"
    );
}

#[test]
fn randomized_operation_sequences_preserve_escrow_invariants() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env.register_stellar_asset_contract_v2(token_admin);
    let contract_address = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract_address);
    let token_address = token_address.address();
    let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
    let token_client = token::Client::new(&env, &token_address);
    let participants: Vec<Address> = (0..PARTICIPANT_COUNT)
        .map(|_| Address::generate(&env))
        .collect();

    for participant in &participants {
        token_admin_client.mint(participant, &(ENTRY_FEE * LEAGUE_COUNT as i128));
    }
    client.initialize(&admin);
    for league_id in 1..=LEAGUE_COUNT {
        client.create_league(&admin, &league_id, &ENTRY_FEE, &token_address);
    }

    let mut deposited = vec![vec![false; PARTICIPANT_COUNT]; LEAGUE_COUNT as usize];
    let mut settled = vec![false; LEAGUE_COUNT as usize];
    let mut active_deposits = 0_i128;
    let mut generator = Generator(0x_fa11_7e11);

    for _ in 0..2_000 {
        let league_index = (generator.next() % LEAGUE_COUNT) as usize;
        let league_id = league_index as u64 + 1;
        let participant_index = (generator.next() % PARTICIPANT_COUNT as u64) as usize;
        let participant = &participants[participant_index];

        if settled[league_index] {
            let deposit_result = client.try_deposit(participant, &league_id);
            assert_eq!(
                deposit_result,
                Err(Ok(EscrowError::LeagueNotAcceptingDeposits))
            );
            assert_eq!(
                client.try_settle(&admin, &league_id, &soroban_sdk::Vec::new(&env), &admin, &0),
                Err(Ok(EscrowError::AlreadySettled))
            );
            assert_solvency(&token_client, &client, active_deposits);
            continue;
        }

        if deposited[league_index][participant_index] {
            let duplicate = client.try_deposit(participant, &league_id);
            assert_eq!(duplicate, Err(Ok(EscrowError::AlreadyDeposited)));
        } else {
            client.deposit(participant, &league_id);
            deposited[league_index][participant_index] = true;
            active_deposits += ENTRY_FEE;
        }

        let should_settle = generator.next().is_multiple_of(5);
        if should_settle {
            let active: Vec<usize> = deposited[league_index]
                .iter()
                .enumerate()
                .filter_map(|(index, is_deposited)| is_deposited.then_some(index))
                .collect();
            let winner_count = active.len().min(3);
            let platform_fee = ENTRY_FEE * active.len() as i128 * 500 / 10_000;
            let prize_pool = ENTRY_FEE * active.len() as i128 - platform_fee;
            let amounts = match winner_count {
                1 => vec![prize_pool],
                2 => vec![prize_pool * 70 / 100, prize_pool * 30 / 100],
                3 => vec![
                    prize_pool * 60 / 100,
                    prize_pool * 30 / 100,
                    prize_pool * 10 / 100,
                ],
                _ => unreachable!(),
            };
            let mut winners = soroban_sdk::Vec::new(&env);
            for (index, amount) in amounts.iter().enumerate() {
                winners.push_back(WinnerPayout {
                    winner: participants[active[index]].clone(),
                    amount: *amount,
                });
            }

            let total_deposited = ENTRY_FEE * active.len() as i128;
            assert_eq!(
                winners.iter().map(|winner| winner.amount).sum::<i128>() + platform_fee,
                total_deposited
            );
            let before_balance = token_client.balance(&client.address);
            client.settle(&admin, &league_id, &winners, &admin, &platform_fee);
            assert_eq!(
                token_client.balance(&client.address),
                before_balance - platform_fee
            );

            for (index, amount) in amounts.iter().enumerate() {
                if *amount > 0 {
                    client.claim_prize(&participants[active[index]], &league_id);
                }
            }
            assert_eq!(
                client.get_league(&league_id).unwrap().status,
                LeagueStatus::Settled
            );
            settled[league_index] = true;
            active_deposits -= total_deposited;
        }

        assert_solvency(&token_client, &client, active_deposits);
    }
}

struct Federation<'a> {
    env: Env,
    admin: Address,
    guardian: Address,
    participant: Address,
    winner: Address,
    token_address: Address,
    escrow: FantasyXIEscrowClient<'a>,
    treasury: FantasyXIEscrowClient<'a>,
}

const FED_LEAGUE: u64 = 77;
const FED_PROPOSAL: u64 = 5;

/// Two linked instances: an escrow holding a live league with an unclaimed
/// prize, and a treasury holding fees with an executable withdrawal proposal.
fn setup_federation<'a>() -> Federation<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_admin_client = token::StellarAssetClient::new(&env, &token_address);

    let escrow = FantasyXIEscrowClient::new(&env, &env.register(FantasyXIEscrow, ()));
    let treasury = FantasyXIEscrowClient::new(&env, &env.register(FantasyXIEscrow, ()));
    let approvals = soroban_sdk::vec![&env, admin.clone()];
    for (instance, peer) in [(&escrow, &treasury), (&treasury, &escrow)] {
        instance.initialize(&admin);
        instance.set_guardian(&approvals, &guardian);
        instance.link_federation_peer(&approvals, &peer.address);
    }

    // Escrow: one settled league with a pending prize and one open league.
    let winner = Address::generate(&env);
    let participant = Address::generate(&env);
    token_admin_client.mint(&winner, &ENTRY_FEE);
    token_admin_client.mint(&participant, &ENTRY_FEE);
    escrow.create_league(&admin, &FED_LEAGUE, &ENTRY_FEE, &token_address);
    escrow.create_league(&admin, &(FED_LEAGUE + 1), &ENTRY_FEE, &token_address);
    escrow.deposit(&winner, &FED_LEAGUE);
    let fee = ENTRY_FEE * 500 / 10_000;
    let winners = soroban_sdk::vec![
        &env,
        WinnerPayout {
            winner: winner.clone(),
            amount: ENTRY_FEE - fee,
        },
    ];
    escrow.settle(&admin, &FED_LEAGUE, &winners, &treasury.address, &fee);

    // Treasury: fee withdrawal proposal past its timelock.
    token_admin_client.mint(&treasury.address, &ENTRY_FEE);
    treasury.propose_fee_withdrawal(
        &admin,
        &FED_PROPOSAL,
        &Address::generate(&env),
        &token_address,
        &fee,
    );
    env.ledger().with_mut(|li| {
        li.sequence_number += fantasyxi_escrow::TIMELOCK_DELAY_LEDGERS + 1;
    });

    Federation {
        env,
        admin,
        guardian,
        participant,
        winner,
        token_address,
        escrow,
        treasury,
    }
}

/// Every value-moving entrypoint on both instances must be frozen, and no
/// balance or league state may change while attempting them.
fn assert_federation_frozen(f: &Federation<'_>) {
    let token_client = token::Client::new(&f.env, &f.token_address);
    let balances = (
        token_client.balance(&f.escrow.address),
        token_client.balance(&f.treasury.address),
    );
    let open_league = f.escrow.get_league(&(FED_LEAGUE + 1));
    let paused = Err(Ok(EscrowError::ContractPaused));

    assert!(f.escrow.is_paused_view() && f.treasury.is_paused_view());
    assert_eq!(
        f.escrow.try_deposit(&f.participant, &(FED_LEAGUE + 1)),
        paused
    );
    assert_eq!(f.escrow.try_claim_prize(&f.winner, &FED_LEAGUE), paused);
    assert_eq!(
        f.escrow.try_settle(
            &f.admin,
            &(FED_LEAGUE + 1),
            &soroban_sdk::Vec::new(&f.env),
            &f.treasury.address,
            &0,
        ),
        paused
    );
    assert_eq!(
        f.treasury
            .try_execute_fee_withdrawal(&f.admin, &FED_PROPOSAL),
        paused
    );

    assert_eq!(
        (
            token_client.balance(&f.escrow.address),
            token_client.balance(&f.treasury.address),
        ),
        balances
    );
    assert_eq!(f.escrow.get_league(&(FED_LEAGUE + 1)), open_league);
    assert!(f.escrow.get_deposit(&(FED_LEAGUE + 1), &f.participant) == 0);
    assert!(
        !f.treasury
            .get_timelock_proposal(&FED_PROPOSAL)
            .unwrap()
            .executed
    );
}

#[test]
fn emergency_pause_on_escrow_freezes_linked_treasury() {
    let f = setup_federation();

    f.escrow.emergency_pause(&f.guardian);
    assert_federation_frozen(&f);

    // Unpause governance is time-bound on both sides.
    assert_eq!(
        f.escrow.try_unpause(&f.admin),
        Err(Ok(EscrowError::TimelockNotElapsed))
    );
    f.env
        .ledger()
        .set_timestamp(1_000 + fantasyxi_escrow::EMERGENCY_UNPAUSE_DELAY_SECONDS);
    f.escrow.unpause(&f.admin);

    // The treasury is still frozen, so the escrow stays frozen through the link.
    assert_eq!(
        f.escrow.try_deposit(&f.participant, &(FED_LEAGUE + 1)),
        Err(Ok(EscrowError::ContractPaused))
    );

    f.treasury.unpause(&f.admin);
    f.escrow.deposit(&f.participant, &(FED_LEAGUE + 1));
    f.escrow.claim_prize(&f.winner, &FED_LEAGUE);
    f.treasury.execute_fee_withdrawal(&f.admin, &FED_PROPOSAL);
}

#[test]
fn emergency_pause_on_treasury_freezes_linked_escrow() {
    let f = setup_federation();

    f.treasury.emergency_pause(&f.guardian);
    assert_federation_frozen(&f);
}

#[test]
fn manual_pause_on_one_instance_blocks_peer_operations() {
    let f = setup_federation();

    // Even without propagation, actions cross-check every linked peer.
    f.treasury.pause(&f.admin);
    assert!(!f.escrow.is_paused_view());
    assert_eq!(
        f.escrow.try_claim_prize(&f.winner, &FED_LEAGUE),
        Err(Ok(EscrowError::ContractPaused))
    );
    f.treasury.unpause(&f.admin);
    f.escrow.claim_prize(&f.winner, &FED_LEAGUE);
}

#[test]
fn unauthorized_callers_cannot_trigger_or_configure_federated_pause() {
    let f = setup_federation();
    let attacker = Address::generate(&f.env);
    let not_authorized = Err(Ok(EscrowError::NotAuthorized));

    assert_eq!(f.escrow.try_emergency_pause(&attacker), not_authorized);
    assert_eq!(f.escrow.try_emergency_pause(&f.admin), not_authorized);
    // An unlinked contract cannot propagate a pause.
    assert_eq!(f.treasury.try_federated_pause(&attacker), not_authorized);
    // Only the admin quorum can rewire the guardian or the federation.
    let attacker_approval = soroban_sdk::vec![&f.env, attacker.clone()];
    assert_eq!(
        f.escrow.try_set_guardian(&attacker_approval, &attacker),
        not_authorized
    );
    assert_eq!(
        f.escrow
            .try_link_federation_peer(&attacker_approval, &attacker),
        not_authorized
    );
    assert_eq!(
        f.escrow.try_link_federation_peer(
            &soroban_sdk::vec![&f.env, f.admin.clone()],
            &f.escrow.address
        ),
        Err(Ok(EscrowError::InvalidFederationPeer))
    );

    // Spoofing a linked peer fails: the peer contract never authorized it.
    f.env.set_auths(&[]);
    assert!(f.treasury.try_federated_pause(&f.escrow.address).is_err());
    f.env.mock_all_auths();

    assert!(!f.escrow.is_paused_view() && !f.treasury.is_paused_view());
    f.escrow.claim_prize(&f.winner, &FED_LEAGUE);
}
