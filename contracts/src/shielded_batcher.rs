use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Symbol, Vec};

use crate::{
    DataKey, EscrowError, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
    PERSISTENT_BUMP_AMOUNT, PERSISTENT_LIFETIME_THRESHOLD,
};

/// Maximum number of shielded transfers allowed in a single batch transaction.
pub const MAX_BATCH_SIZE: u32 = 50;

/// Quarantine reason codes for isolated malformed payout records.
pub const QUARANTINE_MALFORMED_ADDRESS: u32 = 1;
pub const QUARANTINE_INVALID_AMOUNT: u32 = 2;
pub const QUARANTINE_UNSHIELDED_LEAK: u32 = 3;
pub const QUARANTINE_INVALID_BLINDING: u32 = 4;

const DOMAIN_SHIELDED_ADDR: &[u8] = b"FANTASYXI_SHIELDED_ADDR_V1";
const DOMAIN_SHIELDED_OUT: &[u8] = b"FANTASYXI_SHIELDED_OUT_V1";
const DOMAIN_SHIELDED_AGG: &[u8] = b"FANTASYXI_SHIELDED_AGG_V1";
const DOMAIN_SHIELDED_BATCH: &[u8] = b"FANTASYXI_SHIELDED_BATCH_V1";

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct BatcherConfig {
    pub window_seconds: u64,
    pub max_batch_size: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct QueuedPayout {
    pub payout_id: u64,
    pub league_id: u64,
    pub asset: Address,
    pub shielded_recipient: BytesN<32>,
    pub amount: i128,
    pub blinding_factor: BytesN<32>,
    pub queued_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct ShieldedOutput {
    pub shielded_recipient: BytesN<32>,
    pub commitment: BytesN<32>,
    pub amount: i128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct QuarantinedPayout {
    pub payout_id: u64,
    pub league_id: u64,
    pub amount: i128,
    pub reason_code: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct ShieldedBatch {
    pub batch_id: u64,
    pub asset: Address,
    pub outputs: Vec<ShieldedOutput>,
    pub total_amount: i128,
    pub proof_digest: BytesN<32>,
    pub created_at: u64,
    pub executed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct BatchExecutionReport {
    pub batch_ids: Vec<u64>,
    pub processed_count: u32,
    pub quarantined_count: u32,
    pub total_disbursed: i128,
}

fn is_all_zero(bytes: &BytesN<32>) -> bool {
    bytes.to_array().iter().all(|b| *b == 0)
}

fn is_all_ff(bytes: &BytesN<32>) -> bool {
    bytes.to_array().iter().all(|b| *b == 0xff)
}

/// Derives a 32-byte shielded address from a 32-byte secret preimage.
pub fn derive_shielded_address(env: &Env, secret: &BytesN<32>) -> BytesN<32> {
    let mut payload = Bytes::from_slice(env, DOMAIN_SHIELDED_ADDR);
    payload.append(&Bytes::from_slice(env, &secret.to_array()));
    env.crypto().sha256(&payload).into()
}

/// Computes the canonical SHA-256 fingerprint of a transparent Soroban address
/// so the batcher can detect and reject accidental unshielded address leaks.
pub fn transparent_address_fingerprint(env: &Env, address: &Address) -> BytesN<32> {
    let xdr = address.to_xdr(env);
    env.crypto().sha256(&xdr).into()
}

/// Registers a transparent address fingerprint in persistent storage for leak detection.
pub fn register_transparent_address(env: &Env, address: &Address) {
    let fp = transparent_address_fingerprint(env, address);
    let key = DataKey::TransparentAddressFingerprint(fp);
    env.storage().persistent().set(&key, &true);
    env.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

/// Returns true if `candidate` matches a known transparent address fingerprint.
pub fn is_unshielded_leak(env: &Env, candidate: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::TransparentAddressFingerprint(candidate.clone()))
        .unwrap_or(false)
}

/// Computes a hiding commitment for a shielded payout output.
pub fn compute_output_commitment(
    env: &Env,
    shielded_recipient: &BytesN<32>,
    amount: i128,
    blinding_factor: &BytesN<32>,
) -> BytesN<32> {
    let mut payload = Bytes::from_slice(env, DOMAIN_SHIELDED_OUT);
    payload.append(&Bytes::from_slice(env, &shielded_recipient.to_array()));
    payload.append(&Bytes::from_slice(env, &amount.to_be_bytes()));
    payload.append(&Bytes::from_slice(env, &blinding_factor.to_array()));
    env.crypto().sha256(&payload).into()
}

/// Combines two blinding factors deterministically when aggregating multiple
/// payouts to the same shielded address.
fn combine_blinding_factors(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let mut payload = Bytes::from_slice(env, DOMAIN_SHIELDED_AGG);
    payload.append(&Bytes::from_slice(env, &a.to_array()));
    payload.append(&Bytes::from_slice(env, &b.to_array()));
    env.crypto().sha256(&payload).into()
}

/// Computes the cryptographic proof digest binding a shielded batch's outputs,
/// total amount, asset, batch ID, and salt.
pub fn compute_batch_proof(
    env: &Env,
    batch_id: u64,
    asset: &Address,
    total_amount: i128,
    outputs: &Vec<ShieldedOutput>,
    salt: &BytesN<32>,
) -> BytesN<32> {
    let mut payload = Bytes::from_slice(env, DOMAIN_SHIELDED_BATCH);
    payload.append(&Bytes::from_slice(env, &batch_id.to_be_bytes()));
    payload.append(&asset.to_xdr(env));
    payload.append(&Bytes::from_slice(env, &total_amount.to_be_bytes()));
    payload.append(&Bytes::from_slice(env, &outputs.len().to_be_bytes()));
    for out in outputs.iter() {
        payload.append(&Bytes::from_slice(env, &out.shielded_recipient.to_array()));
        payload.append(&Bytes::from_slice(env, &out.commitment.to_array()));
        payload.append(&Bytes::from_slice(env, &out.amount.to_be_bytes()));
    }
    payload.append(&Bytes::from_slice(env, &salt.to_array()));
    env.crypto().sha256(&payload).into()
}

/// Verifies a shielded batch's cryptographic proof, size bounds, amount conservation,
/// and absence of unshielded wallet leaks.
pub fn verify_batch_proof(
    env: &Env,
    batch: &ShieldedBatch,
    salt: &BytesN<32>,
    expected_proof: &BytesN<32>,
) -> bool {
    if batch.outputs.is_empty() || batch.outputs.len() > MAX_BATCH_SIZE {
        return false;
    }
    if is_all_zero(salt) || is_all_zero(expected_proof) {
        return false;
    }

    let mut running_total: i128 = 0;
    for out in batch.outputs.iter() {
        if out.amount <= 0
            || is_all_zero(&out.shielded_recipient)
            || is_all_ff(&out.shielded_recipient)
            || is_all_zero(&out.commitment)
            || is_unshielded_leak(env, &out.shielded_recipient)
        {
            return false;
        }
        match running_total.checked_add(out.amount) {
            Some(sum) => running_total = sum,
            None => return false,
        }
    }

    if running_total != batch.total_amount {
        return false;
    }

    let computed = compute_batch_proof(
        env,
        batch.batch_id,
        &batch.asset,
        batch.total_amount,
        &batch.outputs,
        salt,
    );
    computed == batch.proof_digest && computed == *expected_proof
}

pub fn set_config(env: &Env, config: BatcherConfig) -> Result<(), EscrowError> {
    if config.max_batch_size == 0 || config.max_batch_size > MAX_BATCH_SIZE {
        return Err(EscrowError::InvalidBatchConfig);
    }
    env.storage()
        .instance()
        .set(&DataKey::BatcherConfig, &config);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    Ok(())
}

pub fn get_config(env: &Env) -> BatcherConfig {
    env.storage()
        .instance()
        .get(&DataKey::BatcherConfig)
        .unwrap_or(BatcherConfig {
            window_seconds: 3600,
            max_batch_size: MAX_BATCH_SIZE,
        })
}

pub fn enqueue_payout(
    env: &Env,
    league_id: u64,
    asset: Address,
    shielded_recipient: BytesN<32>,
    amount: i128,
    blinding_factor: BytesN<32>,
) -> Result<u64, EscrowError> {
    let next_id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextPayoutId)
        .unwrap_or(1);
    env.storage()
        .instance()
        .set(&DataKey::NextPayoutId, &(next_id + 1));

    let queue_key = DataKey::PayoutQueue(asset.clone());
    let mut queue: Vec<QueuedPayout> = env
        .storage()
        .persistent()
        .get(&queue_key)
        .unwrap_or_else(|| Vec::new(env));

    let now = env.ledger().timestamp();
    if queue.is_empty() {
        env.storage()
            .persistent()
            .set(&DataKey::BatchWindowStart(asset.clone()), &now);
    }

    queue.push_back(QueuedPayout {
        payout_id: next_id,
        league_id,
        asset: asset.clone(),
        shielded_recipient,
        amount,
        blinding_factor,
        queued_at: now,
    });

    env.storage().persistent().set(&queue_key, &queue);
    env.storage().persistent().extend_ttl(
        &queue_key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

    Ok(next_id)
}

pub fn get_queued_payouts(env: &Env, asset: Address) -> Vec<QueuedPayout> {
    env.storage()
        .persistent()
        .get(&DataKey::PayoutQueue(asset))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn get_quarantined_payouts(env: &Env) -> Vec<QuarantinedPayout> {
    env.storage()
        .persistent()
        .get(&DataKey::QuarantinedPayouts)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn get_shielded_balance(env: &Env, shielded_recipient: BytesN<32>, asset: Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::ShieldedBalance(shielded_recipient, asset))
        .unwrap_or(0)
}

pub fn get_batch(env: &Env, batch_id: u64) -> Option<ShieldedBatch> {
    env.storage()
        .persistent()
        .get(&DataKey::ShieldedBatch(batch_id))
}

/// Validates a single queued payout record. Returns `Ok(())` if valid,
/// or `Err(reason_code)` if malformed or leaking an unshielded address.
fn validate_queued_payout(env: &Env, record: &QueuedPayout) -> Result<(), u32> {
    if is_all_zero(&record.shielded_recipient) || is_all_ff(&record.shielded_recipient) {
        return Err(QUARANTINE_MALFORMED_ADDRESS);
    }
    if is_unshielded_leak(env, &record.shielded_recipient) {
        return Err(QUARANTINE_UNSHIELDED_LEAK);
    }
    if record.amount <= 0 {
        return Err(QUARANTINE_INVALID_AMOUNT);
    }
    if is_all_zero(&record.blinding_factor) {
        return Err(QUARANTINE_INVALID_BLINDING);
    }
    Ok(())
}

/// Flushes the queued payouts for `asset` into one or more privacy-preserving
/// shielded batches (at most `config.max_batch_size`, capped at 50 per batch).
///
/// - Malformed or unshielded-leaking records are isolated into quarantine
///   without aborting valid entries.
/// - Multiple payouts to the same shielded recipient are aggregated into a
///   single shielded output and balance entry.
/// - Verifies that `total_disbursed` matches `expected_valid_total` when provided.
/// - Generates and verifies a cryptographic proof digest for every batch.
pub fn flush_payout_batch(
    env: &Env,
    asset: Address,
    salt: BytesN<32>,
    expected_valid_total: Option<i128>,
    force: bool,
) -> Result<BatchExecutionReport, EscrowError> {
    if is_all_zero(&salt) {
        return Err(EscrowError::InvalidProof);
    }

    let config = get_config(env);
    let queue_key = DataKey::PayoutQueue(asset.clone());
    let queue: Vec<QueuedPayout> = env
        .storage()
        .persistent()
        .get(&queue_key)
        .unwrap_or_else(|| Vec::new(env));

    if queue.is_empty() {
        return Err(EscrowError::EmptyBatch);
    }

    if !force {
        let window_start: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::BatchWindowStart(asset.clone()))
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        if now < window_start.saturating_add(config.window_seconds) {
            return Err(EscrowError::BatchWindowNotElapsed);
        }
    }

    // Partition valid records from malformed/leaking records (atomicity via isolation).
    let mut quarantined: Vec<QuarantinedPayout> = get_quarantined_payouts(env);
    let mut quarantined_count: u32 = 0;
    let mut processed_count: u32 = 0;

    // Aggregated entries: parallel Vecs for recipients, amounts, and blinding factors.
    let mut agg_recipients: Vec<BytesN<32>> = Vec::new(env);
    let mut agg_amounts: Vec<i128> = Vec::new(env);
    let mut agg_blindings: Vec<BytesN<32>> = Vec::new(env);
    let mut total_disbursed: i128 = 0;

    for record in queue.iter() {
        match validate_queued_payout(env, &record) {
            Ok(()) => {
                total_disbursed = total_disbursed
                    .checked_add(record.amount)
                    .ok_or(EscrowError::InvalidAmount)?;
                processed_count += 1;

                // Aggregate into existing shielded recipient if already present.
                let mut found_idx: Option<u32> = None;
                for i in 0..agg_recipients.len() {
                    if agg_recipients.get(i).unwrap() == record.shielded_recipient {
                        found_idx = Some(i);
                        break;
                    }
                }

                if let Some(idx) = found_idx {
                    let prev_amt = agg_amounts.get(idx).unwrap();
                    let new_amt = prev_amt
                        .checked_add(record.amount)
                        .ok_or(EscrowError::InvalidAmount)?;
                    agg_amounts.set(idx, new_amt);

                    let prev_blind = agg_blindings.get(idx).unwrap();
                    let combined =
                        combine_blinding_factors(env, &prev_blind, &record.blinding_factor);
                    agg_blindings.set(idx, combined);
                } else {
                    agg_recipients.push_back(record.shielded_recipient.clone());
                    agg_amounts.push_back(record.amount);
                    agg_blindings.push_back(record.blinding_factor.clone());
                }
            }
            Err(reason_code) => {
                quarantined_count += 1;
                quarantined.push_back(QuarantinedPayout {
                    payout_id: record.payout_id,
                    league_id: record.league_id,
                    amount: record.amount,
                    reason_code,
                });
                env.events().publish(
                    (Symbol::new(env, "PayoutQuarantined"), record.payout_id),
                    reason_code,
                );
            }
        }
    }

    // Verify exact league allocation match when an expected total is provided.
    if let Some(expected) = expected_valid_total {
        if total_disbursed != expected {
            return Err(EscrowError::AllocationMismatch);
        }
    }

    // Persist quarantine list and clear the processed queue.
    if quarantined_count > 0 {
        let q_key = DataKey::QuarantinedPayouts;
        env.storage().persistent().set(&q_key, &quarantined);
        env.storage().persistent().extend_ttl(
            &q_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }
    env.storage().persistent().remove(&queue_key);
    env.storage()
        .persistent()
        .remove(&DataKey::BatchWindowStart(asset.clone()));

    let mut batch_ids: Vec<u64> = Vec::new(env);
    let total_outputs = agg_recipients.len();
    let chunk_size = config.max_batch_size.min(MAX_BATCH_SIZE);
    let now = env.ledger().timestamp();

    let mut offset: u32 = 0;
    while offset < total_outputs {
        let end = (offset + chunk_size).min(total_outputs);
        let mut outputs: Vec<ShieldedOutput> = Vec::new(env);
        let mut chunk_total: i128 = 0;

        for i in offset..end {
            let recipient = agg_recipients.get(i).unwrap();
            let amount = agg_amounts.get(i).unwrap();
            let blinding = agg_blindings.get(i).unwrap();
            let commitment = compute_output_commitment(env, &recipient, amount, &blinding);

            chunk_total = chunk_total
                .checked_add(amount)
                .ok_or(EscrowError::InvalidAmount)?;
            outputs.push_back(ShieldedOutput {
                shielded_recipient: recipient.clone(),
                commitment,
                amount,
            });

            // Credit aggregated shielded balance.
            let bal_key = DataKey::ShieldedBalance(recipient, asset.clone());
            let prev_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
            let new_bal = prev_bal
                .checked_add(amount)
                .ok_or(EscrowError::InvalidAmount)?;
            env.storage().persistent().set(&bal_key, &new_bal);
            env.storage().persistent().extend_ttl(
                &bal_key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }

        let batch_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextBatchId)
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&DataKey::NextBatchId, &(batch_id + 1));

        let proof_digest = compute_batch_proof(env, batch_id, &asset, chunk_total, &outputs, &salt);
        let batch = ShieldedBatch {
            batch_id,
            asset: asset.clone(),
            outputs,
            total_amount: chunk_total,
            proof_digest: proof_digest.clone(),
            created_at: now,
            executed: true,
        };

        if !verify_batch_proof(env, &batch, &salt, &proof_digest) {
            return Err(EscrowError::InvalidProof);
        }

        let batch_key = DataKey::ShieldedBatch(batch_id);
        env.storage().persistent().set(&batch_key, &batch);
        env.storage().persistent().extend_ttl(
            &batch_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // Emit privacy-preserving event: no league_id and no transparent addresses.
        env.events().publish(
            (Symbol::new(env, "ShieldedBatchExecuted"), batch_id),
            (batch.outputs.len(), chunk_total, proof_digest),
        );

        batch_ids.push_back(batch_id);
        offset = end;
    }

    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

    Ok(BatchExecutionReport {
        batch_ids,
        processed_count,
        quarantined_count,
        total_disbursed,
    })
}

/// Claims funds from a shielded balance by proving ownership of the shielded
/// address preimage, without linking the destination to any league outcome.
pub fn claim_shielded_balance(
    env: &Env,
    shielded_recipient: BytesN<32>,
    asset: Address,
    destination: Address,
    amount: i128,
    preimage_secret: BytesN<32>,
) -> Result<(), EscrowError> {
    if amount <= 0 {
        return Err(EscrowError::InvalidAmount);
    }
    if is_all_zero(&preimage_secret) {
        return Err(EscrowError::InvalidProof);
    }

    let derived = derive_shielded_address(env, &preimage_secret);
    if derived != shielded_recipient {
        return Err(EscrowError::InvalidProof);
    }

    let bal_key = DataKey::ShieldedBalance(shielded_recipient.clone(), asset.clone());
    let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
    if current_bal < amount {
        return Err(EscrowError::InsufficientShieldedBalance);
    }

    let remaining = current_bal - amount;
    env.storage().persistent().set(&bal_key, &remaining);
    env.storage().persistent().extend_ttl(
        &bal_key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );

    let token_client = soroban_sdk::token::Client::new(env, &asset);
    token_client.transfer(&env.current_contract_address(), &destination, &amount);

    env.events().publish(
        (
            Symbol::new(env, "ShieldedClaimExecuted"),
            shielded_recipient,
        ),
        amount,
    );

    Ok(())
}
