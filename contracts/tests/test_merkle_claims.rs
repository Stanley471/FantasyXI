use fantasyxi_escrow::{EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, LeagueStatus};
use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, BytesN, Env, Vec};

/// Builds a canonical sorted-pair SHA-256 Merkle tree over a list of leaf hashes.
/// Returns `(merkle_root, proofs_per_leaf_index)`.
fn build_merkle_tree(
    env: &Env,
    leaves: &[BytesN<32>],
) -> (BytesN<32>, std::vec::Vec<Vec<BytesN<32>>>) {
    assert!(!leaves.is_empty(), "Leaves cannot be empty");
    let n = leaves.len();
    let mut proofs: std::vec::Vec<Vec<BytesN<32>>> =
        (0..n).map(|_| Vec::new(env)).collect();
    let mut current_layer: std::vec::Vec<BytesN<32>> = leaves.to_vec();
    let mut leaf_positions: std::vec::Vec<usize> = (0..n).collect();

    while current_layer.len() > 1 {
        let len = current_layer.len();
        let mut next_layer = std::vec::Vec::with_capacity((len + 1) / 2);

        for leaf_idx in 0..n {
            let pos = leaf_positions[leaf_idx];
            let sibling_pos = if pos % 2 == 0 {
                if pos + 1 < len {
                    pos + 1
                } else {
                    pos
                }
            } else {
                pos - 1
            };
            proofs[leaf_idx].push_back(current_layer[sibling_pos].clone());
            leaf_positions[leaf_idx] = pos / 2;
        }

        let mut i = 0;
        while i < len {
            let left = &current_layer[i];
            let right = if i + 1 < len {
                &current_layer[i + 1]
            } else {
                &current_layer[i]
            };
            let parent = FantasyXIEscrow::hash_merkle_pair(env, left, right);
            next_layer.push(parent);
            i += 2;
        }

        current_layer = next_layer;
    }

    (current_layer[0].clone(), proofs)
}

#[test]
fn test_large_league_merkle_settlement_and_claims() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_addr = token_contract.address();
    let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);
    let token_client = token::Client::new(&env, &token_addr);

    let contract_id = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract_id);
    client.initialize(&admin);

    let league_id = 801u64;
    let entry_fee = 10_000_000i128; // 1 USDC
    client.create_league(&creator, &league_id, &entry_fee, &token_addr);

    // 16 participants deposit (160 USDC total)
    let mut participants = std::vec::Vec::new();
    for _ in 0..16 {
        let p = Address::generate(&env);
        token_admin_client.mint(&p, &entry_fee);
        client.deposit(&p, &league_id);
        participants.push(p);
    }

    // Top 8 winners share 152 USDC (after 8 USDC = 5% platform fee)
    let platform_fee = 8_000_000i128;
    let prize_shares: [i128; 8] = [
        50_000_000,
        30_000_000,
        20_000_000,
        15_000_000,
        12_000_000,
        10_000_000,
        8_000_000,
        7_000_000,
    ];

    let mut leaves = std::vec::Vec::new();
    for i in 0..8 {
        let leaf = client.compute_merkle_leaf(&league_id, &participants[i], &prize_shares[i]);
        leaves.push(leaf);
    }

    let (merkle_root, proofs) = build_merkle_tree(&env, &leaves);

    client.settle_merkle_root(&admin, &league_id, &merkle_root, &treasury, &platform_fee);

    let league = client.get_league(&league_id).unwrap();
    assert_eq!(league.status, LeagueStatus::Settled);
    assert_eq!(client.get_merkle_root(&league_id), Some(merkle_root.clone()));
    assert_eq!(token_client.balance(&treasury), platform_fee);

    // Every winner claims their exact share using their Merkle branch proof
    for i in 0..8 {
        assert!(!client.has_claimed_merkle_prize(&league_id, &participants[i]));
        client.claim_merkle_prize(&league_id, &participants[i], &prize_shares[i], &proofs[i]);
        assert!(client.has_claimed_merkle_prize(&league_id, &participants[i]));
        assert_eq!(token_client.balance(&participants[i]), prize_shares[i]);
    }
}

#[test]
fn test_rejects_tampered_winner_forged_amount_and_double_claim() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_addr = token_contract.address();
    let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

    let contract_id = env.register(FantasyXIEscrow, ());
    let client = FantasyXIEscrowClient::new(&env, &contract_id);
    client.initialize(&admin);

    let league_id = 802u64;
    let entry_fee = 50_000_000i128;
    client.create_league(&creator, &league_id, &entry_fee, &token_addr);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let attacker = Address::generate(&env);
    token_admin_client.mint(&p1, &entry_fee);
    token_admin_client.mint(&p2, &entry_fee);
    client.deposit(&p1, &league_id);
    client.deposit(&p2, &league_id);

    let leaf1 = client.compute_merkle_leaf(&league_id, &p1, &65_000_000);
    let leaf2 = client.compute_merkle_leaf(&league_id, &p2, &30_000_000);
    let (merkle_root, proofs) = build_merkle_tree(&env, &[leaf1, leaf2]);

    client.settle_merkle_root(&admin, &league_id, &merkle_root, &treasury, &5_000_000);

    // 1. Tampered winner address with p1's valid proof must fail with InvalidProof
    let tampered_winner = client.try_claim_merkle_prize(&league_id, &attacker, &65_000_000, &proofs[0]);
    assert_eq!(tampered_winner, Err(Ok(EscrowError::InvalidProof)));

    // 2. Forged amount with p1's valid address & proof must fail with InvalidProof
    let forged_amount = client.try_claim_merkle_prize(&league_id, &p1, &65_000_001, &proofs[0]);
    assert_eq!(forged_amount, Err(Ok(EscrowError::InvalidProof)));

    // 3. Valid claim succeeds
    client.claim_merkle_prize(&league_id, &p1, &65_000_000, &proofs[0]);

    // 4. Replay / double-claim attempt fails with AlreadyClaimed
    let replay = client.try_claim_merkle_prize(&league_id, &p1, &65_000_000, &proofs[0]);
    assert_eq!(replay, Err(Ok(EscrowError::AlreadyClaimed)));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn fuzz_merkle_tree_sizes_and_proof_validation(
        winner_count in 1usize..25usize,
        base_prize in 1_000i128..10_000_000i128,
        target_idx_raw in 0usize..25usize,
    ) {
        let env = Env::default();
        let league_id = 999u64;
        let target_idx = target_idx_raw % winner_count;

        let mut winners = std::vec::Vec::with_capacity(winner_count);
        let mut amounts = std::vec::Vec::with_capacity(winner_count);
        let mut leaves = std::vec::Vec::with_capacity(winner_count);

        for i in 0..winner_count {
            let addr = Address::generate(&env);
            let amount = base_prize + (i as i128) * 100;
            let leaf = FantasyXIEscrow::compute_merkle_leaf_internal(&env, league_id, &addr, amount);
            winners.push(addr);
            amounts.push(amount);
            leaves.push(leaf);
        }

        let (root, proofs) = build_merkle_tree(&env, &leaves);

        // Valid leaf and proof always verify
        prop_assert!(FantasyXIEscrow::verify_merkle_proof_internal(
            &env,
            &root,
            &leaves[target_idx],
            &proofs[target_idx],
        ));

        // Forged amount leaf never verifies against the valid root
        let forged_leaf = FantasyXIEscrow::compute_merkle_leaf_internal(
            &env,
            league_id,
            &winners[target_idx],
            amounts[target_idx] + 1,
        );
        prop_assert!(!FantasyXIEscrow::verify_merkle_proof_internal(
            &env,
            &root,
            &forged_leaf,
            &proofs[target_idx],
        ));
    }
}
