use fantasyxi_escrow::shielded_batcher::{
    transparent_address_fingerprint, QUARANTINE_INVALID_AMOUNT, QUARANTINE_INVALID_BLINDING,
    QUARANTINE_MALFORMED_ADDRESS, QUARANTINE_UNSHIELDED_LEAK,
};
use fantasyxi_escrow::{
    BatcherConfig, EscrowError, FantasyXIEscrow, FantasyXIEscrowClient, ShieldedOutput,
    MAX_BATCH_SIZE,
};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, BytesN, Env};

struct TestHarness<'a> {
    env: Env,
    admin: Address,
    token_address: Address,
    token: token::Client<'a>,
    token_admin: token::StellarAssetClient<'a>,
    escrow_address: Address,
    escrow: FantasyXIEscrowClient<'a>,
}

impl TestHarness<'_> {
    fn warp(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }

    fn secret(&self, seed: u8) -> BytesN<32> {
        let mut raw = [0u8; 32];
        raw[0] = seed;
        raw[31] = seed.wrapping_mul(17).wrapping_add(3);
        BytesN::from_array(&self.env, &raw)
    }

    fn blinding(&self, seed: u8) -> BytesN<32> {
        let mut raw = [0u8; 32];
        raw[0] = seed.wrapping_add(100);
        raw[15] = seed.wrapping_mul(31).wrapping_add(7);
        BytesN::from_array(&self.env, &raw)
    }

    fn salt(&self, seed: u8) -> BytesN<32> {
        let mut raw = [seed; 32];
        raw[0] = seed.wrapping_add(1);
        BytesN::from_array(&self.env, &raw)
    }
}

fn setup<'a>() -> TestHarness<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(10_000);

    let admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let token_admin = token::StellarAssetClient::new(&env, &token_address);
    let token = token::Client::new(&env, &token_address);
    let escrow_address = env.register(FantasyXIEscrow, ());
    let escrow = FantasyXIEscrowClient::new(&env, &escrow_address);
    escrow.initialize(&admin);

    TestHarness {
        env,
        admin,
        token_address,
        token,
        token_admin,
        escrow_address,
        escrow,
    }
}

#[test]
fn batcher_config_validation_and_window_enforcement() {
    let h = setup();

    // Reject invalid batch sizes (0 and > 50).
    assert_eq!(
        h.escrow.try_set_batcher_config(
            &h.admin,
            &BatcherConfig {
                window_seconds: 600,
                max_batch_size: 0,
            },
        ),
        Err(Ok(EscrowError::InvalidBatchConfig))
    );
    assert_eq!(
        h.escrow.try_set_batcher_config(
            &h.admin,
            &BatcherConfig {
                window_seconds: 600,
                max_batch_size: MAX_BATCH_SIZE + 1,
            },
        ),
        Err(Ok(EscrowError::InvalidBatchConfig))
    );

    // Valid configuration.
    h.escrow.set_batcher_config(
        &h.admin,
        &BatcherConfig {
            window_seconds: 600,
            max_batch_size: 50,
        },
    );
    let cfg = h.escrow.get_batcher_config();
    assert_eq!(cfg.window_seconds, 600);
    assert_eq!(cfg.max_batch_size, 50);

    // Enqueue one valid payout.
    let recipient = h.escrow.derive_shielded_address(&h.secret(1));
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &101,
        &h.token_address,
        &recipient,
        &5_000_000,
        &h.blinding(1),
    );

    // Flushing before window elapses with force=false must fail.
    assert_eq!(
        h.escrow.try_flush_payout_batch(
            &h.admin,
            &h.token_address,
            &h.salt(1),
            &Some(5_000_000),
            &false,
        ),
        Err(Ok(EscrowError::BatchWindowNotElapsed))
    );

    // Advance past the window and flush successfully.
    h.warp(600);
    let report = h.escrow.flush_payout_batch(
        &h.admin,
        &h.token_address,
        &h.salt(1),
        &Some(5_000_000),
        &false,
    );
    assert_eq!(report.batch_ids.len(), 1);
    assert_eq!(report.processed_count, 1);
    assert_eq!(report.quarantined_count, 0);
    assert_eq!(report.total_disbursed, 5_000_000);
}

#[test]
fn aggregates_multiple_leagues_into_unified_shielded_balance() {
    let h = setup();
    let r1 = h.escrow.derive_shielded_address(&h.secret(10));
    let r2 = h.escrow.derive_shielded_address(&h.secret(20));

    // Recipient r1 wins across two separate leagues (201 and 202).
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &201,
        &h.token_address,
        &r1,
        &3_000_000,
        &h.blinding(1),
    );
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &202,
        &h.token_address,
        &r1,
        &4_500_000,
        &h.blinding(2),
    );
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &202,
        &h.token_address,
        &r2,
        &2_500_000,
        &h.blinding(3),
    );

    let salt = h.salt(9);
    let report =
        h.escrow
            .flush_payout_batch(&h.admin, &h.token_address, &salt, &Some(10_000_000), &true);
    assert_eq!(report.batch_ids.len(), 1);
    assert_eq!(report.processed_count, 3);
    assert_eq!(report.total_disbursed, 10_000_000);

    // Unified batch collapses r1's two league payouts into 1 shielded output.
    let batch = h
        .escrow
        .get_shielded_batch(&report.batch_ids.get(0).unwrap())
        .unwrap();
    assert_eq!(batch.outputs.len(), 2);
    assert_eq!(batch.total_amount, 10_000_000);
    assert!(h
        .escrow
        .verify_shielded_batch_proof(&batch, &salt, &batch.proof_digest));

    // Aggregated shielded balances match exact sums.
    assert_eq!(
        h.escrow.get_shielded_balance(&r1, &h.token_address),
        7_500_000
    );
    assert_eq!(
        h.escrow.get_shielded_balance(&r2, &h.token_address),
        2_500_000
    );
}

#[test]
fn groups_up_to_50_transfers_and_splits_overflow_into_multiple_batches() {
    let h = setup();

    // Enqueue 65 distinct shielded recipients (should split into 50 + 15).
    let mut expected_total: i128 = 0;
    for i in 1u8..=65u8 {
        let recipient = h.escrow.derive_shielded_address(&h.secret(i));
        let amount = (i as i128) * 100_000;
        expected_total += amount;
        h.escrow.enqueue_shielded_payout(
            &h.admin,
            &(300 + i as u64),
            &h.token_address,
            &recipient,
            &amount,
            &h.blinding(i),
        );
    }

    // Mismatched allocation total must be rejected without mutating balances.
    assert_eq!(
        h.escrow.try_flush_payout_batch(
            &h.admin,
            &h.token_address,
            &h.salt(5),
            &Some(expected_total + 1),
            &true,
        ),
        Err(Ok(EscrowError::AllocationMismatch))
    );

    let salt = h.salt(5);
    let report = h.escrow.flush_payout_batch(
        &h.admin,
        &h.token_address,
        &salt,
        &Some(expected_total),
        &true,
    );
    assert_eq!(report.batch_ids.len(), 2);
    assert_eq!(report.processed_count, 65);
    assert_eq!(report.quarantined_count, 0);
    assert_eq!(report.total_disbursed, expected_total);

    let b1 = h
        .escrow
        .get_shielded_batch(&report.batch_ids.get(0).unwrap())
        .unwrap();
    let b2 = h
        .escrow
        .get_shielded_batch(&report.batch_ids.get(1).unwrap())
        .unwrap();
    assert_eq!(b1.outputs.len(), 50);
    assert_eq!(b2.outputs.len(), 15);
    assert_eq!(b1.total_amount + b2.total_amount, expected_total);
    assert!(h
        .escrow
        .verify_shielded_batch_proof(&b1, &salt, &b1.proof_digest));
    assert!(h
        .escrow
        .verify_shielded_batch_proof(&b2, &salt, &b2.proof_digest));
}

#[test]
fn isolates_malformed_and_leaking_records_without_aborting_valid_batch() {
    let h = setup();

    // Register a transparent wallet address to test unshielded leak detection.
    let transparent_wallet = Address::generate(&h.env);
    h.escrow
        .register_transparent_address(&h.admin, &transparent_wallet);
    let leaked_fp = transparent_address_fingerprint(&h.env, &transparent_wallet);

    let valid_1 = h.escrow.derive_shielded_address(&h.secret(1));
    let valid_2 = h.escrow.derive_shielded_address(&h.secret(2));
    let all_zero = BytesN::from_array(&h.env, &[0u8; 32]);
    let all_ff = BytesN::from_array(&h.env, &[0xffu8; 32]);

    // Mix valid and invalid payouts in the same queue.
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &401,
        &h.token_address,
        &valid_1,
        &1_000_000,
        &h.blinding(1),
    );
    // Malformed: all-zero address.
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &401,
        &h.token_address,
        &all_zero,
        &500_000,
        &h.blinding(2),
    );
    // Malformed: all-0xFF address.
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &401,
        &h.token_address,
        &all_ff,
        &500_000,
        &h.blinding(3),
    );
    // Unshielded leak: matches registered transparent wallet fingerprint.
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &402,
        &h.token_address,
        &leaked_fp,
        &750_000,
        &h.blinding(4),
    );
    // Invalid amount (zero).
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &402,
        &h.token_address,
        &valid_2,
        &0,
        &h.blinding(5),
    );
    // Invalid blinding factor (all-zero).
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &402,
        &h.token_address,
        &valid_2,
        &300_000,
        &all_zero,
    );
    // Second valid payout.
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &403,
        &h.token_address,
        &valid_2,
        &2_000_000,
        &h.blinding(6),
    );

    let salt = h.salt(12);
    let report =
        h.escrow
            .flush_payout_batch(&h.admin, &h.token_address, &salt, &Some(3_000_000), &true);
    assert_eq!(report.processed_count, 2);
    assert_eq!(report.quarantined_count, 5);
    assert_eq!(report.total_disbursed, 3_000_000);
    assert_eq!(report.batch_ids.len(), 1);

    // Valid recipients received their exact shielded balances.
    assert_eq!(
        h.escrow.get_shielded_balance(&valid_1, &h.token_address),
        1_000_000
    );
    assert_eq!(
        h.escrow.get_shielded_balance(&valid_2, &h.token_address),
        2_000_000
    );
    assert_eq!(
        h.escrow.get_shielded_balance(&leaked_fp, &h.token_address),
        0
    );

    // Quarantined records preserve exact reason codes for operator inspection/retry.
    let quarantined = h.escrow.get_quarantined_payouts();
    assert_eq!(quarantined.len(), 5);
    assert_eq!(
        quarantined.get(0).unwrap().reason_code,
        QUARANTINE_MALFORMED_ADDRESS
    );
    assert_eq!(
        quarantined.get(1).unwrap().reason_code,
        QUARANTINE_MALFORMED_ADDRESS
    );
    assert_eq!(
        quarantined.get(2).unwrap().reason_code,
        QUARANTINE_UNSHIELDED_LEAK
    );
    assert_eq!(
        quarantined.get(3).unwrap().reason_code,
        QUARANTINE_INVALID_AMOUNT
    );
    assert_eq!(
        quarantined.get(4).unwrap().reason_code,
        QUARANTINE_INVALID_BLINDING
    );
}

#[test]
fn cryptographic_proof_verification_rejects_tampering_and_unshielded_leaks() {
    let h = setup();
    let r1 = h.escrow.derive_shielded_address(&h.secret(77));
    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &501,
        &h.token_address,
        &r1,
        &4_000_000,
        &h.blinding(77),
    );

    let salt = h.salt(33);
    let report = h
        .escrow
        .flush_payout_batch(&h.admin, &h.token_address, &salt, &None, &true);
    let batch = h
        .escrow
        .get_shielded_batch(&report.batch_ids.get(0).unwrap())
        .unwrap();

    // Valid proof verifies.
    assert!(h
        .escrow
        .verify_shielded_batch_proof(&batch, &salt, &batch.proof_digest));

    // Wrong salt fails.
    assert!(!h
        .escrow
        .verify_shielded_batch_proof(&batch, &h.salt(34), &batch.proof_digest));

    // Tampered output amount fails.
    let mut tampered = batch.clone();
    let orig = tampered.outputs.get(0).unwrap();
    tampered.outputs.set(
        0,
        ShieldedOutput {
            shielded_recipient: orig.shielded_recipient,
            commitment: orig.commitment,
            amount: orig.amount + 1,
        },
    );
    assert!(!h
        .escrow
        .verify_shielded_batch_proof(&tampered, &salt, &batch.proof_digest));
}

#[test]
fn end_to_end_shielded_balance_claim_transfers_tokens_privately() {
    let h = setup();

    // Fund escrow contract to simulate settled league prize pool.
    h.token_admin.mint(&h.escrow_address, &10_000_000);

    let secret = h.secret(99);
    let shielded_addr = h.escrow.derive_shielded_address(&secret);

    h.escrow.enqueue_shielded_payout(
        &h.admin,
        &601,
        &h.token_address,
        &shielded_addr,
        &6_000_000,
        &h.blinding(99),
    );
    h.escrow.flush_payout_batch(
        &h.admin,
        &h.token_address,
        &h.salt(2),
        &Some(6_000_000),
        &true,
    );

    let fresh_destination = Address::generate(&h.env);

    // Wrong preimage secret must be rejected.
    assert_eq!(
        h.escrow.try_claim_shielded_balance(
            &shielded_addr,
            &h.token_address,
            &fresh_destination,
            &6_000_000,
            &h.secret(98),
        ),
        Err(Ok(EscrowError::InvalidProof))
    );

    // Overdraft claim must be rejected.
    assert_eq!(
        h.escrow.try_claim_shielded_balance(
            &shielded_addr,
            &h.token_address,
            &fresh_destination,
            &6_000_001,
            &secret,
        ),
        Err(Ok(EscrowError::InsufficientShieldedBalance))
    );

    // Partial claim succeeds and transfers tokens to fresh unlinked destination.
    h.escrow.claim_shielded_balance(
        &shielded_addr,
        &h.token_address,
        &fresh_destination,
        &4_000_000,
        &secret,
    );
    assert_eq!(h.token.balance(&fresh_destination), 4_000_000);
    assert_eq!(
        h.escrow
            .get_shielded_balance(&shielded_addr, &h.token_address),
        2_000_000
    );
}
