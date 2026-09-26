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

        let should_settle = generator.next() % 5 == 0;
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
