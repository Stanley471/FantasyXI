#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;

const PERSISTENT_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;
const EMERGENCY_REFUND_TIMELOCK_SECONDS: u64 = 14 * 24 * 60 * 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    LeagueAlreadyExists = 3,
    LeagueNotFound = 4,
    LeagueNotAcceptingDeposits = 5,
    AlreadyDeposited = 6,
    AlreadySettled = 7,
    InvalidAmount = 8,
    PayoutExceedsDeposits = 9,
    NotAuthorized = 10,
    FeeExceedsMaxCap = 11,
    InvalidPrizeDistribution = 12,
    NoClaimablePrize = 13,
    ContractPaused = 14,
    AlreadyPaused = 15,
    NotPaused = 16,
    TimelockNotElapsed = 17,
    NoDeposit = 18,
    InvalidProof = 14,
    InvalidMultisig = 15,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[contracttype]
#[repr(u32)]
pub enum LeagueStatus {
    Upcoming = 0,
    Active = 1,
    Settled = 2,
    Cancelled = 3,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct LeagueState {
    pub creator: Address,
    pub entry_fee: i128,
    pub asset: Address,
    pub total_deposited: i128,
    pub participant_count: u32,
    pub status: LeagueStatus,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct WinnerPayout {
    pub winner: Address,
    pub amount: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct AdminConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    IsPaused,
    PausedAt,
    AdminConfig,
    League(u64),
    Deposit(u64, Address),
    ClaimablePrize(u64, Address),
}

/// # Issue #83: Soroban Escrow Smart Contract for Fantasy Leagues
/// Provides non-custodial holding of USDC entry fee deposits for competition partitions.
/// Ensures trustless settlement, prize claim storage, and refund mechanisms.
#[contract]
pub struct FantasyXIEscrow;

#[contractimpl]
impl FantasyXIEscrow {
    fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false)
    }

    fn require_admin(env: &Env, admin: &Address) -> Result<(), EscrowError> {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;
        if admin != &stored_admin {
            return Err(EscrowError::NotAuthorized);
        }
        Ok(())
    }

    /// Initializes the global escrow contract with an admin.
    pub fn initialize(env: Env, admin: Address) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        let mut signers = Vec::new(&env);
        signers.push_back(admin.clone());
        env.storage().instance().set(
            &DataKey::AdminConfig,
            &AdminConfig {
                signers,
                threshold: 1,
            },
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Initializes the contract with an M-of-N signer set. Each signer must
    /// authorize the transaction so the deployed configuration is explicit.
    pub fn initialize_multisig(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(EscrowError::AlreadyInitialized);
        }
        if threshold == 0 || threshold > signers.len() || signers.len() > 32 {
            return Err(EscrowError::InvalidMultisig);
        }
        for signer in signers.iter() {
            signer.require_auth();
        }
        env.storage()
            .instance()
            .set(&DataKey::Admin, &signers.get(0).unwrap());
        env.storage()
            .instance()
            .set(&DataKey::AdminConfig, &AdminConfig { signers, threshold });
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Pauses deposits and settlement while leaving refunds available.
    pub fn pause(env: Env, admin: Address) -> Result<(), EscrowError> {
        Self::require_admin(&env, &admin)?;
        if Self::is_paused(&env) {
            return Err(EscrowError::AlreadyPaused);
        }

        let paused_at = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::IsPaused, &true);
        env.storage().instance().set(&DataKey::PausedAt, &paused_at);
        env.events()
            .publish((Symbol::new(&env, "ContractPaused"),), paused_at);
        Ok(())
    }

    /// Resumes deposits and settlement after an emergency pause.
    pub fn unpause(env: Env, admin: Address) -> Result<(), EscrowError> {
        Self::require_admin(&env, &admin)?;
        if !Self::is_paused(&env) {
            return Err(EscrowError::NotPaused);
        }

        let unpaused_at = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage().instance().remove(&DataKey::PausedAt);
        env.events()
            .publish((Symbol::new(&env, "ContractUnpaused"),), unpaused_at);
        Ok(())
    }

    /// Returns whether the escrow is currently paused.
    pub fn is_paused_view(env: Env) -> bool {
        Self::is_paused(&env)
    }

    /// Registers a new competition partition identified by `league_id`.
    pub fn create_league(
        env: Env,
        creator: Address,
        league_id: u64,
        entry_fee: i128,
        asset: Address,
    ) -> Result<(), EscrowError> {
        creator.require_auth();

        if entry_fee < 0 {
            return Err(EscrowError::InvalidAmount);
        }

        let key = DataKey::League(league_id);
        if env.storage().persistent().has(&key) {
            return Err(EscrowError::LeagueAlreadyExists);
        }

        // Validate that the token is a valid contract by executing a dummy read
        let _ = token::Client::new(&env, &asset).balance(&env.current_contract_address());

        let state = LeagueState {
            creator: creator.clone(),
            entry_fee,
            asset,
            total_deposited: 0,
            participant_count: 0,
            status: LeagueStatus::Upcoming,
        };

        env.storage().persistent().set(&key, &state);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("created"), league_id), (creator, entry_fee));

        Ok(())
    }

    /// Participant deposits their entry fee into the league escrow partition.
    pub fn deposit(env: Env, participant: Address, league_id: u64) -> Result<(), EscrowError> {
        if Self::is_paused(&env) {
            return Err(EscrowError::ContractPaused);
        }
        participant.require_auth();

        let league_key = DataKey::League(league_id);
        let mut league: LeagueState = env
            .storage()
            .persistent()
            .get(&league_key)
            .ok_or(EscrowError::LeagueNotFound)?;

        env.storage().persistent().extend_ttl(
            &league_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        if league.status != LeagueStatus::Upcoming {
            return Err(EscrowError::LeagueNotAcceptingDeposits);
        }

        let deposit_key = DataKey::Deposit(league_id, participant.clone());
        if env.storage().persistent().has(&deposit_key) {
            return Err(EscrowError::AlreadyDeposited);
        }

        // If entry fee > 0, transfer tokens into this contract
        if league.entry_fee > 0 {
            let token_client = token::Client::new(&env, &league.asset);
            token_client.transfer(
                &participant,
                &env.current_contract_address(),
                &league.entry_fee,
            );
        }

        env.storage()
            .persistent()
            .set(&deposit_key, &league.entry_fee);

        env.storage().persistent().extend_ttl(
            &deposit_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        league.total_deposited += league.entry_fee;
        league.participant_count += 1;
        env.storage().persistent().set(&league_key, &league);

        env.storage().persistent().extend_ttl(
            &league_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("deposit"), league_id),
            (participant, league.entry_fee),
        );

        Ok(())
    }

    /// Admin settles the league, transferring platform fee and winner payouts.
    /// Strictly prevents double settlement by transitioning to Settled.
    pub fn settle(
        env: Env,
        admin: Address,
        league_id: u64,
        winners: Vec<WinnerPayout>,
        platform_treasury: Address,
        platform_fee: i128,
    ) -> Result<(), EscrowError> {
        if Self::is_paused(&env) {
            return Err(EscrowError::ContractPaused);
        }
        Self::settle_with_affiliate(
        let mut approvals = Vec::new(&env);
        approvals.push_back(admin);
        Self::settle_internal(
            env,
            approvals,
            league_id,
            winners,
            platform_treasury,
            platform_fee,
            None,
            0,
            None,
        )
    }

    pub fn settle_with_proof(
        env: Env,
        admin: Address,
        league_id: u64,
        winners: Vec<WinnerPayout>,
        platform_treasury: Address,
        platform_fee: i128,
        proof: BytesN<32>,
    ) -> Result<(), EscrowError> {
        let mut approvals = Vec::new(&env);
        approvals.push_back(admin);
        Self::settle_internal(
            env,
            approvals,
            league_id,
            winners,
            platform_treasury,
            platform_fee,
            None,
            0,
            Some(proof),
        )
    }

    pub fn settle_with_multisig(
        env: Env,
        approvals: Vec<Address>,
        league_id: u64,
        winners: Vec<WinnerPayout>,
        platform_treasury: Address,
        platform_fee: i128,
    ) -> Result<(), EscrowError> {
        Self::settle_internal(
            env,
            approvals,
            league_id,
            winners,
            platform_treasury,
            platform_fee,
            None,
            0,
            None,
        )
    }

    pub fn settle_with_multisig_and_proof(
        env: Env,
        approvals: Vec<Address>,
        league_id: u64,
        winners: Vec<WinnerPayout>,
        platform_treasury: Address,
        platform_fee: i128,
        proof: BytesN<32>,
    ) -> Result<(), EscrowError> {
        Self::settle_internal(
            env,
            approvals,
            league_id,
            winners,
            platform_treasury,
            platform_fee,
            None,
            0,
            Some(proof),
        )
    }

    /// Admin settles the league with optional affiliate payout split from platform fee.
    pub fn settle_with_affiliate(
        env: Env,
        admin: Address,
        league_id: u64,
        winners: Vec<WinnerPayout>,
        platform_treasury: Address,
        platform_fee: i128,
        affiliate_address: Option<Address>,
        affiliate_cut: i128,
    ) -> Result<(), EscrowError> {
        let mut approvals = Vec::new(&env);
        approvals.push_back(admin);
        Self::settle_internal(
            env,
            approvals,
            league_id,
            winners,
            platform_treasury,
            platform_fee,
            affiliate_address,
            affiliate_cut,
            None,
        )
    }

    fn settle_internal(
        env: Env,
        approvals: Vec<Address>,
        league_id: u64,
        winners: Vec<WinnerPayout>,
        platform_treasury: Address,
        platform_fee: i128,
        affiliate_address: Option<Address>,
        affiliate_cut: i128,
        proof: Option<BytesN<32>>,
    ) -> Result<(), EscrowError> {
        Self::authorize_signers(&env, &approvals)?;

        if let Some(ref proof_value) = proof {
            if proof_value.to_array().iter().all(|byte| *byte == 0) {
                return Err(EscrowError::InvalidProof);
            }
        }

        let league_key = DataKey::League(league_id);
        let mut league: LeagueState = env
            .storage()
            .persistent()
            .get(&league_key)
            .ok_or(EscrowError::LeagueNotFound)?;

        env.storage().persistent().extend_ttl(
            &league_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        if league.status == LeagueStatus::Settled || league.status == LeagueStatus::Cancelled {
            return Err(EscrowError::AlreadySettled);
        }

        // Platform Fee Hard Cap check
        let max_fee = (league.total_deposited * 500) / 10000;
        if platform_fee > max_fee {
            return Err(EscrowError::FeeExceedsMaxCap);
        }

        if affiliate_cut < 0 || affiliate_cut > platform_fee {
            return Err(EscrowError::InvalidAmount);
        }

        // Calculate expected distributions based on prize curve rules
        let prize_pool = league.total_deposited - platform_fee;
        let mut expected_payouts = Vec::new(&env);
        let mut tied_first_payouts = Vec::new(&env);
        if winners.len() == 1 {
            expected_payouts.push_back(prize_pool);
        } else if winners.len() == 2 {
            let p1 = (prize_pool * 70) / 100;
            let p2 = prize_pool - p1;
            expected_payouts.push_back(p1);
            expected_payouts.push_back(p2);
            let tied_first = prize_pool / 2;
            tied_first_payouts.push_back(tied_first);
            tied_first_payouts.push_back(prize_pool - tied_first);
        } else if winners.len() >= 3 {
            let p1 = (prize_pool * 60) / 100;
            let p2 = (prize_pool * 30) / 100;
            let p3 = prize_pool - p1 - p2;
            expected_payouts.push_back(p1);
            expected_payouts.push_back(p2);
            expected_payouts.push_back(p3);
            let tied_first = (p1 + p2) / 2;
            tied_first_payouts.push_back(tied_first);
            tied_first_payouts.push_back(p1 + p2 - tied_first);
            tied_first_payouts.push_back(p3);
            for _ in 3..winners.len() {
                expected_payouts.push_back(0);
                tied_first_payouts.push_back(0);
            }
        } else {
            return Err(EscrowError::InvalidPrizeDistribution);
        }

        let uses_tied_first = winners.len() >= 2
            && !tied_first_payouts.is_empty()
            && winners.get(0).unwrap().amount == tied_first_payouts.get(0).unwrap()
            && winners.get(1).unwrap().amount == tied_first_payouts.get(1).unwrap();

        let mut total_payout = platform_fee;
        for (i, winner) in winners.iter().enumerate() {
            if winner.amount < 0 {
                return Err(EscrowError::InvalidAmount);
            }
            let matches_standard = winner.amount == expected_payouts.get(i as u32).unwrap();
            let matches_tied_first =
                uses_tied_first && winner.amount == tied_first_payouts.get(i as u32).unwrap();
            if !matches_standard && !matches_tied_first {
                return Err(EscrowError::InvalidPrizeDistribution);
            }
            total_payout += winner.amount;
        }

        if total_payout != league.total_deposited {
            return Err(EscrowError::PayoutExceedsDeposits);
        }

        let token_client = token::Client::new(&env, &league.asset);

        // 1. Transfer net platform fee and affiliate cut
        let net_platform_fee = platform_fee - affiliate_cut;
        if net_platform_fee > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &platform_treasury,
                &net_platform_fee,
            );
        }

        if let Some(affiliate) = affiliate_address {
            if affiliate_cut > 0 {
                token_client.transfer(&env.current_contract_address(), &affiliate, &affiliate_cut);
                env.events().publish(
                    (symbol_short!("affiliate"), league_id),
                    (affiliate, affiliate_cut),
                );
            }
        }

        // 2. Write winner prizes to claimable storage
        for winner in winners.iter() {
            if winner.amount > 0 {
                let claim_key = DataKey::ClaimablePrize(league_id, winner.winner.clone());
                env.storage().persistent().set(&claim_key, &winner.amount);
                env.storage().persistent().extend_ttl(
                    &claim_key,
                    PERSISTENT_LIFETIME_THRESHOLD,
                    PERSISTENT_BUMP_AMOUNT,
                );
            }
        }

        league.status = LeagueStatus::Settled;
        env.storage().persistent().set(&league_key, &league);

        env.storage().persistent().extend_ttl(
            &league_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("settle"), league_id),
            (total_payout, platform_fee),
        );

        if let Some(proof_value) = proof {
            env.events()
                .publish((symbol_short!("proof"), league_id), proof_value);
        }

        Ok(())
    }

    fn authorize_signers(env: &Env, approvals: &Vec<Address>) -> Result<(), EscrowError> {
        let config: AdminConfig = env
            .storage()
            .instance()
            .get(&DataKey::AdminConfig)
            .ok_or(EscrowError::NotInitialized)?;
        if approvals.len() < config.threshold || approvals.len() > config.signers.len() {
            return Err(EscrowError::InvalidMultisig);
        }
        for (index, signer) in approvals.iter().enumerate() {
            if approvals
                .iter()
                .take(index)
                .any(|previous| previous == signer)
            {
                return Err(EscrowError::InvalidMultisig);
            }
            if !config.signers.iter().any(|configured| configured == signer) {
                return Err(EscrowError::NotAuthorized);
            }
            signer.require_auth();
        }
        Ok(())
    }

    /// Allows a depositor to recover their original entry fee after the
    /// contract has remained paused for the emergency timelock.
    pub fn emergency_refund_league(
        env: Env,
        participant: Address,
        league_id: u64,
    ) -> Result<(), EscrowError> {
        participant.require_auth();

        if !Self::is_paused(&env) {
            return Err(EscrowError::NotPaused);
        }

        let paused_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PausedAt)
            .ok_or(EscrowError::NotPaused)?;
        let unlock_at = paused_at
            .checked_add(EMERGENCY_REFUND_TIMELOCK_SECONDS)
            .ok_or(EscrowError::TimelockNotElapsed)?;
        if env.ledger().timestamp() < unlock_at {
            return Err(EscrowError::TimelockNotElapsed);
        }

        let league_key = DataKey::League(league_id);
        let mut league: LeagueState = env
            .storage()
            .persistent()
            .get(&league_key)
            .ok_or(EscrowError::LeagueNotFound)?;
        let deposit_key = DataKey::Deposit(league_id, participant.clone());
        let amount: i128 = env
            .storage()
            .persistent()
            .get(&deposit_key)
            .ok_or(EscrowError::NoDeposit)?;

        if amount > 0 {
            token::Client::new(&env, &league.asset).transfer(
                &env.current_contract_address(),
                &participant,
                &amount,
            );
        }

        env.storage().persistent().remove(&deposit_key);
        league.total_deposited -= amount;
        league.participant_count -= 1;
        env.storage().persistent().set(&league_key, &league);
        env.events().publish(
            (Symbol::new(&env, "EmergencyRefund"), league_id),
            (participant, amount),
        );
        Ok(())
    }

    /// Admin refunds deposits if a competition cannot proceed or is cancelled.
    pub fn refund(
        env: Env,
        admin: Address,
        league_id: u64,
        participants: Vec<Address>,
    ) -> Result<(), EscrowError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;

        if admin != stored_admin {
            return Err(EscrowError::NotAuthorized);
        }

        let league_key = DataKey::League(league_id);
        let mut league: LeagueState = env
            .storage()
            .persistent()
            .get(&league_key)
            .ok_or(EscrowError::LeagueNotFound)?;

        env.storage().persistent().extend_ttl(
            &league_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        if league.status == LeagueStatus::Settled {
            return Err(EscrowError::AlreadySettled);
        }

        let token_client = token::Client::new(&env, &league.asset);

        for participant in participants.iter() {
            let dep_key = DataKey::Deposit(league_id, participant.clone());
            if let Some(deposit_amount) = env.storage().persistent().get::<_, i128>(&dep_key) {
                if deposit_amount > 0 {
                    token_client.transfer(
                        &env.current_contract_address(),
                        &participant,
                        &deposit_amount,
                    );
                }
                env.storage().persistent().remove(&dep_key);
            }
        }

        league.status = LeagueStatus::Cancelled;
        env.storage().persistent().set(&league_key, &league);

        env.storage().persistent().extend_ttl(
            &league_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("refund"), league_id), participants.len());

        Ok(())
    }

    /// Admin upgrades the executing contract to a new WASM executable.
    ///
    /// Uses Soroban's WASM hash substitution via `update_current_contract_wasm`:
    /// `new_wasm_hash` must already be uploaded to the ledger beforehand. The
    /// contract address and all existing state (admin, leagues, deposits,
    /// prizes) are preserved across the upgrade.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), EscrowError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;

        if admin != stored_admin {
            return Err(EscrowError::NotAuthorized);
        }

        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Read queries
    pub fn get_league(env: Env, league_id: u64) -> Option<LeagueState> {
        let key = DataKey::League(league_id);
        let result = env.storage().persistent().get(&key);
        if result.is_some() {
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
        result
    }

    pub fn get_deposit(env: Env, league_id: u64, participant: Address) -> i128 {
        let key = DataKey::Deposit(league_id, participant);
        let result = env.storage().persistent().get(&key);
        if result.is_some() {
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
        result.unwrap_or(0)
    }

    /// Returns the total aggregated prize pool balance (in atomic units/USDC) for a specific league.
    /// Handles non-existent leagues gracefully by returning 0.
    pub fn get_prize_pool(env: Env, league_id: u64) -> i128 {
        let key = DataKey::League(league_id);
        if let Some(league) = env.storage().persistent().get::<_, LeagueState>(&key) {
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
            league.total_deposited
        } else {
            0
        }
    }

    /// Winner claims their prize for a settled league.
    pub fn claim_prize(env: Env, winner: Address, league_id: u64) -> Result<(), EscrowError> {
        winner.require_auth();

        let claim_key = DataKey::ClaimablePrize(league_id, winner.clone());
        let amount: i128 = env
            .storage()
            .persistent()
            .get(&claim_key)
            .ok_or(EscrowError::NoClaimablePrize)?;

        let league_key = DataKey::League(league_id);
        let league: LeagueState = env
            .storage()
            .persistent()
            .get(&league_key)
            .ok_or(EscrowError::LeagueNotFound)?;

        env.storage().persistent().extend_ttl(
            &league_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let token_client = token::Client::new(&env, &league.asset);
        token_client.transfer(&env.current_contract_address(), &winner, &amount);

        env.storage().persistent().remove(&claim_key);

        env.events()
            .publish((symbol_short!("claimed"), league_id), (winner, amount));

        Ok(())
    }

    /// Admin / Public endpoint to manually extend TTL of a league and instance
    pub fn extend_league_ttl(
        env: Env,
        league_id: u64,
        threshold: u32,
        extend_to: u32,
    ) -> Result<(), EscrowError> {
        let key = DataKey::League(league_id);
        if !env.storage().persistent().has(&key) {
            return Err(EscrowError::LeagueNotFound);
        }

        env.storage()
            .persistent()
            .extend_ttl(&key, threshold, extend_to);

        env.storage().instance().extend_ttl(threshold, extend_to);
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        vec, Env,
    };

    fn setup_test() -> (Env, Address, Address, FantasyXIEscrowClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let contract_id = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_id);

        client.initialize(&admin);

        (env, admin, token_contract.address(), client)
    }

    #[test]
    fn test_initialize_and_create_league() {
        let (env, _admin, token, client) = setup_test();
        let creator = Address::generate(&env);

        client.create_league(&creator, &101, &50_000_000, &token); // 5 USDC (with 7 decimals)

        let league = client.get_league(&101).expect("League should exist");
        assert_eq!(league.entry_fee, 50_000_000);
        assert_eq!(league.asset, token);
        assert_eq!(league.total_deposited, 0);
        assert_eq!(league.participant_count, 0);
        assert_eq!(league.status, LeagueStatus::Upcoming);
    }

    #[test]
    fn test_deposit_and_single_settlement() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let treasury = Address::generate(&env);

        // Mint USDC to participants
        token_admin_client.mint(&user1, &50_000_000);
        token_admin_client.mint(&user2, &50_000_000);

        // Create league
        client.create_league(&admin, &200, &50_000_000, &token_addr);

        // Deposits
        client.deposit(&user1, &200);
        client.deposit(&user2, &200);

        let league = client.get_league(&200).unwrap();
        assert_eq!(league.participant_count, 2);
        assert_eq!(league.total_deposited, 100_000_000); // 10 USDC

        // Settlement:
        // Platform fee: 5% of 10 USDC = 0.5 USDC = 5_000_000
        // Prize pool: 9.5 USDC = 95_000_000
        // 1st place: 70% of 9.5 USDC = 6.65 USDC = 66_500_000
        // 2nd place: 30% of 9.5 USDC = 2.85 USDC = 28_500_000
        let winners = vec![
            &env,
            WinnerPayout {
                winner: user1.clone(),
                amount: 66_500_000,
            },
            WinnerPayout {
                winner: user2.clone(),
                amount: 28_500_000,
            },
        ];

        client.settle(&admin, &200, &winners, &treasury, &5_000_000);

        let settled_league = client.get_league(&200).unwrap();
        assert_eq!(settled_league.status, LeagueStatus::Settled);

        client.claim_prize(&user1, &200);
        client.claim_prize(&user2, &200);

        // Verify balances
        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&user1), 66_500_000);
        assert_eq!(token_client.balance(&user2), 28_500_000);
        assert_eq!(token_client.balance(&treasury), 5_000_000);

        // Double settlement must fail
        let result = client.try_settle(&admin, &200, &winners, &treasury, &5_000_000);
        assert_eq!(result, Err(Ok(EscrowError::AlreadySettled)));
    }

    #[test]
    fn test_duplicate_deposit_rejected() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let user1 = Address::generate(&env);
        token_admin_client.mint(&user1, &100_000_000);

        client.create_league(&admin, &201, &50_000_000, &token_addr);
        client.deposit(&user1, &201);

        // Second deposit must fail
        let result = client.try_deposit(&user1, &201);
        assert_eq!(result, Err(Ok(EscrowError::AlreadyDeposited)));
    }

    #[test]
    fn test_unauthorized_settlement_rejected() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let user1 = Address::generate(&env);
        let attacker = Address::generate(&env);
        let treasury = Address::generate(&env);

        token_admin_client.mint(&user1, &50_000_000);
        client.create_league(&admin, &202, &50_000_000, &token_addr);
        client.deposit(&user1, &202);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: attacker.clone(),
                amount: 47_500_000,
            },
        ];

        // Attacker attempts to settle
        let result = client.try_settle(&attacker, &202, &winners, &treasury, &2_500_000);
        assert_eq!(result, Err(Ok(EscrowError::NotAuthorized)));
    }

    #[test]
    fn test_settlement_payout_exceeding_deposits_rejected() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let user1 = Address::generate(&env);
        let treasury = Address::generate(&env);

        token_admin_client.mint(&user1, &50_000_000);
        client.create_league(&admin, &203, &50_000_000, &token_addr);
        client.deposit(&user1, &203); // Total deposited = 50_000_000

        // Attempt payout of 90_000_000, fee 10_000_000 (fee exceeds cap)
        let winners = vec![
            &env,
            WinnerPayout {
                winner: user1.clone(),
                amount: 90_000_000,
            },
        ];

        let result = client.try_settle(&admin, &203, &winners, &treasury, &10_000_000);
        assert_eq!(result, Err(Ok(EscrowError::FeeExceedsMaxCap)));

        // Attempt payout exceeding deposits with valid fee
        let winners2 = vec![
            &env,
            WinnerPayout {
                winner: user1.clone(),
                amount: 90_000_000,
            },
        ];
        let result2 = client.try_settle(&admin, &203, &winners2, &treasury, &2_500_000);
        assert_eq!(result2, Err(Ok(EscrowError::InvalidPrizeDistribution)));
    }

    #[test]
    fn test_refund_cancelled_league() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let user1 = Address::generate(&env);
        token_admin_client.mint(&user1, &50_000_000);

        client.create_league(&admin, &300, &50_000_000, &token_addr);
        client.deposit(&user1, &300);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&user1), 0);

        // Refund
        let participants = vec![&env, user1.clone()];
        client.refund(&admin, &300, &participants);

        assert_eq!(token_client.balance(&user1), 50_000_000);
        let league = client.get_league(&300).unwrap();
        assert_eq!(league.status, LeagueStatus::Cancelled);

        // Duplicate refund should do nothing (balance remains 50_000_000, no second payout)
        client.refund(&admin, &300, &participants);
        assert_eq!(token_client.balance(&user1), 50_000_000);

        // Settlement on a cancelled league must fail
        let winners = vec![
            &env,
            WinnerPayout {
                winner: user1.clone(),
                amount: 50_000_000,
            },
        ];
        let result = client.try_settle(&admin, &300, &winners, &admin, &0);
        assert_eq!(result, Err(Ok(EscrowError::AlreadySettled)));
    }

    #[test]
    fn test_multiple_assets_parallel_leagues() {
        let (env, admin, usdc_addr, client) = setup_test();
        let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc_addr);
        let usdc_client = token::Client::new(&env, &usdc_addr);

        let xlm_admin = Address::generate(&env);
        let xlm_addr = env.register_stellar_asset_contract_v2(xlm_admin).address();
        let xlm_admin_client = token::StellarAssetClient::new(&env, &xlm_addr);
        let xlm_client = token::Client::new(&env, &xlm_addr);

        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let treasury = Address::generate(&env);

        usdc_admin_client.mint(&user1, &100_000_000);
        xlm_admin_client.mint(&user2, &200_000_000);

        client.create_league(&admin, &400, &50_000_000, &usdc_addr);
        client.create_league(&admin, &401, &150_000_000, &xlm_addr);

        client.deposit(&user1, &400);
        client.deposit(&user2, &401);

        assert_eq!(usdc_client.balance(&user1), 50_000_000);
        assert_eq!(xlm_client.balance(&user2), 50_000_000);

        let usdc_winners = vec![
            &env,
            WinnerPayout {
                winner: user1.clone(),
                amount: 47_500_000,
            },
        ];
        client.settle(&admin, &400, &usdc_winners, &treasury, &2_500_000);

        let xlm_winners = vec![
            &env,
            WinnerPayout {
                winner: user2.clone(),
                amount: 142_500_000,
            },
        ];
        client.settle(&admin, &401, &xlm_winners, &treasury, &7_500_000);

        client.claim_prize(&user1, &400);
        client.claim_prize(&user2, &401);

        assert_eq!(usdc_client.balance(&user1), 97_500_000);
        assert_eq!(usdc_client.balance(&treasury), 2_500_000);
        assert_eq!(xlm_client.balance(&user2), 192_500_000);
        assert_eq!(xlm_client.balance(&treasury), 7_500_000);
    }

    #[test]
    fn test_multisig_settlement_requires_threshold_and_emits_proof_path() {
        let env = Env::default();
        env.mock_all_auths();
        let signer_one = Address::generate(&env);
        let signer_two = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let contract_id = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_id);
        let signers = vec![&env, signer_one.clone(), signer_two.clone()];
        client.initialize_multisig(&signers, &2);

        let participant = Address::generate(&env);
        let treasury = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_contract.address());
        token_admin_client.mint(&participant, &50_000_000);
        client.create_league(&signer_one, &901, &50_000_000, &token_contract.address());
        client.deposit(&participant, &901);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: participant.clone(),
                amount: 47_500_000,
            },
        ];
        let proof = BytesN::from_array(&env, &[1; 32]);

        let one_signature = vec![&env, signer_one.clone()];
        assert_eq!(
            client.try_settle_with_multisig(&one_signature, &901, &winners, &treasury, &2_500_000),
            Err(Ok(EscrowError::InvalidMultisig))
        );
        client.settle_with_multisig_and_proof(
            &signers, &901, &winners, &treasury, &2_500_000, &proof,
        );
        assert_eq!(
            client.get_league(&901).unwrap().status,
            LeagueStatus::Settled
        );
    }

    #[test]
    fn test_zero_fee_league() {
        let (env, admin, token_addr, client) = setup_test();
        let creator = Address::generate(&env);
        let user = Address::generate(&env);
        let treasury = Address::generate(&env);

        client.create_league(&creator, &500, &0, &token_addr);
        client.deposit(&user, &500);

        let league = client.get_league(&500).unwrap();
        assert_eq!(league.total_deposited, 0);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: user.clone(),
                amount: 0,
            },
        ];
        client.settle(&admin, &500, &winners, &treasury, &0);
        let settled_league = client.get_league(&500).unwrap();
        assert_eq!(settled_league.status, LeagueStatus::Settled);
    }

    #[test]
    fn test_fractional_stroop_roundings() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        let u3 = Address::generate(&env);
        let treasury = Address::generate(&env);

        token_admin_client.mint(&u1, &10_000_011);
        client.create_league(&admin, &600, &10_000_011, &token_addr);
        client.deposit(&u1, &600);

        let platform_fee = 500_000;
        let _prize_pool = 10_000_011 - 500_000; // 9_500_011
                                                // 60% = 5_700_006
                                                // 30% = 2_850_003
                                                // 10% (remainder) = 9_500_011 - 5_700_006 - 2_850_003 = 950_002

        let winners = vec![
            &env,
            WinnerPayout {
                winner: u1.clone(),
                amount: 5_700_006,
            },
            WinnerPayout {
                winner: u2.clone(),
                amount: 2_850_003,
            },
            WinnerPayout {
                winner: u3.clone(),
                amount: 950_002,
            },
        ];

        client.settle(&admin, &600, &winners, &treasury, &platform_fee);

        client.claim_prize(&u1, &600);
        client.claim_prize(&u2, &600);
        client.claim_prize(&u3, &600);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&u1), 5_700_006);
        assert_eq!(token_client.balance(&u2), 2_850_003);
        assert_eq!(token_client.balance(&u3), 950_002);
    }

    #[test]
    fn test_independent_claims() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        let treasury = Address::generate(&env);

        token_admin_client.mint(&u1, &50_000_000);
        token_admin_client.mint(&u2, &50_000_000);

        client.create_league(&admin, &700, &50_000_000, &token_addr);
        client.deposit(&u1, &700);
        client.deposit(&u2, &700);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: u1.clone(),
                amount: 66_500_000,
            },
            WinnerPayout {
                winner: u2.clone(),
                amount: 28_500_000,
            },
        ];

        client.settle(&admin, &700, &winners, &treasury, &5_000_000);

        // U2 claims before U1
        client.claim_prize(&u2, &700);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&u1), 0); // Not claimed yet
        assert_eq!(token_client.balance(&u2), 28_500_000);

        // U1 claims later
        client.claim_prize(&u1, &700);
        assert_eq!(token_client.balance(&u1), 66_500_000);
    }

    #[test]
    fn test_ttl_extensions() {
        let (env, _admin, token_addr, client) = setup_test();
        let creator = Address::generate(&env);

        client.create_league(&creator, &800, &50_000_000, &token_addr);

        // Advance ledger by some time (e.g., 50 ledgers)
        env.ledger().with_mut(|li| {
            li.sequence_number += 50;
        });

        // Use the explicit endpoint
        let res = client.try_extend_league_ttl(&800, &100_000, &200_000);
        assert_eq!(res, Ok(Ok(())));

        // Call an operation that inherently extends TTL
        let _league = client.get_league(&800).unwrap();

        // Check if an unknown league errors correctly
        let res_err = client.try_extend_league_ttl(&999, &100_000, &200_000);
        assert_eq!(res_err, Err(Ok(EscrowError::LeagueNotFound)));
    }

    #[test]
    fn test_pause_blocks_deposit_and_settle_until_unpaused() {
        let (env, admin, token_addr, client) = setup_test();
        let user = Address::generate(&env);
        let treasury = Address::generate(&env);
        let token_admin = token::StellarAssetClient::new(&env, &token_addr);
        token_admin.mint(&user, &50_000_000);
        client.create_league(&admin, &820, &50_000_000, &token_addr);

        client.pause(&admin);
        assert!(client.is_paused_view());
        assert_eq!(
            client.try_deposit(&user, &820),
            Err(Ok(EscrowError::ContractPaused))
        );
        let winners = vec![
            &env,
            WinnerPayout {
                winner: user.clone(),
                amount: 47_500_000,
            },
        ];
        assert_eq!(
            client.try_settle(&admin, &820, &winners, &treasury, &2_500_000),
            Err(Ok(EscrowError::ContractPaused))
        );

        client.unpause(&admin);
        assert!(!client.is_paused_view());
        client.deposit(&user, &820);
        assert_eq!(client.get_deposit(&820, &user), 50_000_000);
    }

    #[test]
    fn test_emergency_refund_requires_timelock_and_returns_original_deposit() {
        let (env, admin, token_addr, client) = setup_test();
        let user = Address::generate(&env);
        let token_admin = token::StellarAssetClient::new(&env, &token_addr);
        token_admin.mint(&user, &50_000_000);
        client.create_league(&admin, &821, &50_000_000, &token_addr);
        client.deposit(&user, &821);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&user), 0);
        client.pause(&admin);

        env.ledger().set_timestamp(14 * 24 * 60 * 60 - 1);
        assert_eq!(
            client.try_emergency_refund_league(&user, &821),
            Err(Ok(EscrowError::TimelockNotElapsed))
        );

        env.ledger().set_timestamp(14 * 24 * 60 * 60);
        client.emergency_refund_league(&user, &821);
        assert_eq!(token_client.balance(&user), 50_000_000);
        assert_eq!(client.get_deposit(&821, &user), 0);
        assert_eq!(client.get_league(&821).unwrap().total_deposited, 0);
        assert_eq!(
            client.try_emergency_refund_league(&user, &821),
            Err(Ok(EscrowError::NoDeposit))
        );
    }

    #[test]
    fn test_only_admin_can_pause_and_unpause() {
        let (env, admin, _token_addr, client) = setup_test();
        let attacker = Address::generate(&env);

        assert_eq!(
            client.try_pause(&attacker),
            Err(Ok(EscrowError::NotAuthorized))
        );
        client.pause(&admin);
        assert_eq!(
            client.try_pause(&admin),
            Err(Ok(EscrowError::AlreadyPaused))
        );
        client.unpause(&admin);
        assert_eq!(client.try_unpause(&admin), Err(Ok(EscrowError::NotPaused)));
    fn test_settle_with_affiliate_payout() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        let referrer = Address::generate(&env);
        let treasury = Address::generate(&env);

        token_admin_client.mint(&u1, &50_000_000);
        token_admin_client.mint(&u2, &50_000_000);

        client.create_league(&admin, &900, &50_000_000, &token_addr);
        client.deposit(&u1, &900);
        client.deposit(&u2, &900);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: u1.clone(),
                amount: 66_500_000,
            },
            WinnerPayout {
                winner: u2.clone(),
                amount: 28_500_000,
            },
        ];

        client.settle_with_affiliate(
            &admin,
            &900,
            &winners,
            &treasury,
            &5_000_000,
            &Some(referrer.clone()),
            &1_000_000,
        );

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&treasury), 4_000_000);
        assert_eq!(token_client.balance(&referrer), 1_000_000);
    }

    fn release_wasm() -> &'static [u8] {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/target/wasm32-unknown-unknown/release/fantasyxi_escrow.wasm"
        ))
    }

    #[test]
    fn test_upgrade_preserves_contract_state() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let user1 = Address::generate(&env);
        let treasury = Address::generate(&env);

        token_admin_client.mint(&user1, &100_000_000);
        client.create_league(&admin, &810, &50_000_000, &token_addr);
        client.deposit(&user1, &810);

        // Pre-upgrade state sanity check
        let before = client.get_league(&810).unwrap();
        assert_eq!(before.participant_count, 1);
        assert_eq!(before.total_deposited, 50_000_000);

        // Upload a new WASM executable and perform the V1 -> V2 upgrade via
        // WASM hash substitution. State must survive the upgrade.
        let new_wasm_hash = env.deployer().upload_contract_wasm(release_wasm());
        client.upgrade(&admin, &new_wasm_hash);

        let after = client
            .get_league(&810)
            .expect("League still accessible after upgrade");
        assert_eq!(after.creator, before.creator);
        assert_eq!(after.entry_fee, before.entry_fee);
        assert_eq!(after.asset, token_addr);
        assert_eq!(after.total_deposited, 50_000_000);
        assert_eq!(after.participant_count, 1);
        assert_eq!(after.status, LeagueStatus::Upcoming);

        // Deposits are still visible after the upgrade
        assert_eq!(client.get_deposit(&810, &user1), 50_000_000);

        // Business logic keeps working on the upgraded executable
        let winners = vec![
            &env,
            WinnerPayout {
                winner: user1.clone(),
                amount: 47_500_000,
            },
        ];
        client.settle(&admin, &810, &winners, &treasury, &2_500_000);
        client.claim_prize(&user1, &810);

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&user1), 97_500_000);
    }

    #[test]
    fn test_upgrade_rejected_for_non_admin() {
        let (env, admin, token_addr, client) = setup_test();
        let attacker = Address::generate(&env);

        client.create_league(&admin, &811, &50_000_000, &token_addr);

        let new_wasm_hash = env.deployer().upload_contract_wasm(release_wasm());

        // A non-admin cannot trigger the upgrade
        let result = client.try_upgrade(&attacker, &new_wasm_hash);
        assert_eq!(result, Err(Ok(EscrowError::NotAuthorized)));

        // A doomed upgrade must not disturb existing state
        let league = client.get_league(&811).unwrap();
        assert_eq!(league.participant_count, 0);
    }

    #[test]
    fn test_get_prize_pool() {
        let (env, creator, token, client) = setup_test();
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        let token_admin_client = token::StellarAssetClient::new(&env, &token);
        token_admin_client.mint(&user1, &100_000_000);
        token_admin_client.mint(&user2, &100_000_000);

        // 1. Querying non-existent league returns 0 gracefully
        assert_eq!(client.get_prize_pool(&99999), 0);

        // 2. Newly created league starts with 0 prize pool
        client.create_league(&creator, &900, &50_000_000, &token);
        assert_eq!(client.get_prize_pool(&900), 0);

        // 3. First deposit updates total prize pool to 50_000_000 (5 USDC)
        client.deposit(&user1, &900);
        assert_eq!(client.get_prize_pool(&900), 50_000_000);

        // 4. Second deposit aggregates to 100_000_000 (10 USDC)
        client.deposit(&user2, &900);
        assert_eq!(client.get_prize_pool(&900), 100_000_000);
    }
}
