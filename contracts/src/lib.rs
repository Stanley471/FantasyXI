#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, Symbol, Vec,
};

const DAY_IN_LEDGERS: u32 = 17280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;

const PERSISTENT_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;
const EMERGENCY_REFUND_TIMELOCK_SECONDS: u64 = 14 * 24 * 60 * 60;
pub const PARTICIPANTS_PER_PAGE: u32 = 50;
pub const TIMELOCK_DELAY_LEDGERS: u32 = 2 * DAY_IN_LEDGERS; // 34,560 ledgers (48 hours)

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
    InvalidProof = 19,
    InvalidMultisig = 20,
    InvalidGameweekResult = 21,
    GameweekResultConflict = 22,
    LeagueNotCancelled = 23,
    AlreadyClaimed = 24,
    InvalidFeeShare = 25,
    HashMismatch = 26,
    TimelockActive = 27,
    ProposalNotFound = 28,
    AlreadyApproved = 29,
    ProposalExecuted = 30,
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

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct TimelockProposal {
    pub id: u64,
    pub proposer: Address,
    pub destination: Address,
    pub asset: Address,
    pub amount: i128,
    pub unlock_ledger: u32,
    pub approvals: Vec<Address>,
    pub executed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[contracttype]
#[repr(u32)]
pub enum PauseAction {
    Pause = 1,
    Unpause = 2,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PauseProposal {
    pub id: u64,
    pub proposer: Address,
    pub action: PauseAction,
    pub unlock_ledger: u32,
    pub approvals: Vec<Address>,
    pub executed: bool,
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
    GameweekResult(u64),
    ParticipantPage(u64, u32),
    SettlementHash(u64),
    TimelockProposal(u64),
    PauseProposal(u64),
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

    /// Direct M-of-N multi-party authorization to pause contract operations.
    pub fn pause_with_multisig(env: Env, approvals: Vec<Address>) -> Result<(), EscrowError> {
        Self::authorize_signers(&env, &approvals)?;
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

    /// Direct M-of-N multi-party authorization to unpause contract operations.
    pub fn unpause_with_multisig(env: Env, approvals: Vec<Address>) -> Result<(), EscrowError> {
        Self::authorize_signers(&env, &approvals)?;
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

    /// Pauses deposits and settlement via admin or multisig threshold.
    pub fn pause(env: Env, admin: Address) -> Result<(), EscrowError> {
        let mut approvals = Vec::new(&env);
        approvals.push_back(admin);
        Self::pause_with_multisig(env, approvals)
    }

    /// Resumes deposits and settlement after an emergency pause.
    pub fn unpause(env: Env, admin: Address) -> Result<(), EscrowError> {
        let mut approvals = Vec::new(&env);
        approvals.push_back(admin);
        Self::unpause_with_multisig(env, approvals)
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
        if Self::is_paused(&env) {
            return Err(EscrowError::ContractPaused);
        }
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

        // Store participant in paginated page bucket
        let page_index = league.participant_count / PARTICIPANTS_PER_PAGE;
        let page_key = DataKey::ParticipantPage(league_id, page_index);
        let mut page: Vec<Address> = env
            .storage()
            .persistent()
            .get(&page_key)
            .unwrap_or_else(|| Vec::new(&env));
        page.push_back(participant.clone());
        env.storage().persistent().set(&page_key, &page);
        env.storage().persistent().extend_ttl(
            &page_key,
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

    /// Publishes an immutable commitment to finalized off-chain gameweek scores.
    pub fn publish_gameweek_result(
        env: Env,
        admin: Address,
        gameweek_id: u64,
        result_hash: BytesN<32>,
    ) -> Result<(), EscrowError> {
        if Self::is_paused(&env) {
            return Err(EscrowError::ContractPaused);
        }
        let mut approvals = Vec::new(&env);
        approvals.push_back(admin);
        Self::authorize_signers(&env, &approvals)?;

        if result_hash.to_array().iter().all(|byte| *byte == 0) {
            return Err(EscrowError::InvalidGameweekResult);
        }

        let key = DataKey::GameweekResult(gameweek_id);
        if let Some(existing) = env.storage().persistent().get::<_, BytesN<32>>(&key) {
            return if existing == result_hash {
                Ok(())
            } else {
                Err(EscrowError::GameweekResultConflict)
            };
        }

        env.storage().persistent().set(&key, &result_hash);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
        env.events()
            .publish((symbol_short!("gw_result"), gameweek_id), result_hash);
        Ok(())
    }

    pub fn get_gameweek_result_hash(env: Env, gameweek_id: u64) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::GameweekResult(gameweek_id))
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
            None,
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
            None,
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
            None,
        )
    }

    /// Computes the deterministic SHA-256 settlement root hash over concatenated winner payouts and platform fee.
    pub fn compute_settlement_hash(
        env: Env,
        winners: Vec<WinnerPayout>,
        platform_fee: i128,
    ) -> BytesN<32> {
        Self::compute_settlement_hash_internal(&env, &winners, platform_fee)
    }

    /// Returns the committed settlement hash for a settled league, if present.
    pub fn get_settlement_hash(env: Env, league_id: u64) -> Option<BytesN<32>> {
        env.storage()
            .instance()
            .get(&DataKey::SettlementHash(league_id))
    }

    /// Settle league verifying that the provided settlement hash matches the on-chain computed hash.
    pub fn settle_with_settlement_hash(
        env: Env,
        admin: Address,
        league_id: u64,
        winners: Vec<WinnerPayout>,
        platform_treasury: Address,
        platform_fee: i128,
        settlement_hash: BytesN<32>,
    ) -> Result<(), EscrowError> {
        if Self::is_paused(&env) {
            return Err(EscrowError::ContractPaused);
        }
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
            Some(settlement_hash),
        )
    }

    /// Settle league with multisig verifying that the provided settlement hash matches on-chain computed hash.
    pub fn settle_with_multisig_hash(
        env: Env,
        approvals: Vec<Address>,
        league_id: u64,
        winners: Vec<WinnerPayout>,
        platform_treasury: Address,
        platform_fee: i128,
        settlement_hash: BytesN<32>,
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
            Some(settlement_hash),
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
        settlement_hash: Option<BytesN<32>>,
    ) -> Result<(), EscrowError> {
        if Self::is_paused(&env) {
            return Err(EscrowError::ContractPaused);
        }
        Self::authorize_signers(&env, &approvals)?;

        if let Some(ref expected_hash) = settlement_hash {
            let computed = Self::compute_settlement_hash_internal(&env, &winners, platform_fee);
            if computed != *expected_hash {
                return Err(EscrowError::HashMismatch);
            }
            env.storage()
                .instance()
                .set(&DataKey::SettlementHash(league_id), expected_hash);
            env.storage()
                .instance()
                .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        }

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

        if affiliate_cut < 0 {
            return Err(EscrowError::InvalidAmount);
        }

        if affiliate_cut > platform_fee {
            return Err(EscrowError::InvalidFeeShare);
        }

        // Maximum affiliate payout cap (max 20% of platform fee, net platform fee >= 4%)
        let max_affiliate_cut = (platform_fee * 2000) / 10000;
        if affiliate_cut > max_affiliate_cut {
            return Err(EscrowError::InvalidFeeShare);
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
                    (Symbol::new(&env, "AffiliatePayoutTransferred"), league_id),
                    (affiliate.clone(), affiliate_cut),
                );
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

        if let Some(hash_val) = settlement_hash {
            env.events()
                .publish((symbol_short!("setl_hash"), league_id), hash_val);
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
        Self::require_admin(&env, &admin)?;

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

    /// Cancels an un-settled league so enrolled participants can claim refunds.
    /// Caller must be either admin or league creator.
    pub fn cancel_league(env: Env, caller: Address, league_id: u64) -> Result<(), EscrowError> {
        if Self::is_paused(&env) {
            return Err(EscrowError::ContractPaused);
        }
        caller.require_auth();

        let league_key = DataKey::League(league_id);
        let mut league: LeagueState = env
            .storage()
            .persistent()
            .get(&league_key)
            .ok_or(EscrowError::LeagueNotFound)?;

        if league.status == LeagueStatus::Settled {
            return Err(EscrowError::AlreadySettled);
        }

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(EscrowError::NotInitialized)?;

        if caller != stored_admin && caller != league.creator {
            return Err(EscrowError::NotAuthorized);
        }

        league.status = LeagueStatus::Cancelled;
        env.storage().persistent().set(&league_key, &league);
        env.storage().persistent().extend_ttl(
            &league_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events()
            .publish((Symbol::new(&env, "LeagueCancelled"), league_id), caller);
        Ok(())
    }

    /// Enrolled participant claims their full deposit back after a league is cancelled.
    pub fn claim_refund(env: Env, participant: Address, league_id: u64) -> Result<(), EscrowError> {
        participant.require_auth();

        let league_key = DataKey::League(league_id);
        let mut league: LeagueState = env
            .storage()
            .persistent()
            .get(&league_key)
            .ok_or(EscrowError::LeagueNotFound)?;

        if league.status != LeagueStatus::Cancelled {
            return Err(EscrowError::LeagueNotCancelled);
        }

        let deposit_key = DataKey::Deposit(league_id, participant.clone());
        let amount: i128 = env
            .storage()
            .persistent()
            .get(&deposit_key)
            .ok_or(EscrowError::NoDeposit)?;

        if amount <= 0 {
            return Err(EscrowError::AlreadyClaimed);
        }

        token::Client::new(&env, &league.asset).transfer(
            &env.current_contract_address(),
            &participant,
            &amount,
        );

        // Update participant deposit state to 0 and reduce total_deposited to prevent double claims
        env.storage().persistent().set(&deposit_key, &0i128);
        league.total_deposited -= amount;
        env.storage().persistent().set(&league_key, &league);

        env.events().publish(
            (Symbol::new(&env, "LeagueRefundClaimed"), league_id),
            (participant, amount),
        );
        Ok(())
    }

    /// Admin upgrades the executing contract to a new WASM executable.
    ///
    /// Uses Soroban's WASM hash substitution via `update_current_contract_wasm`:
    /// `new_wasm_hash` must already be uploaded to the ledger beforehand. The
    /// contract address and all existing state (admin, leagues, deposits,
    /// prizes) are preserved across the upgrade.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), EscrowError> {
        Self::require_admin(&env, &admin)?;

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
        if Self::is_paused(&env) {
            return Err(EscrowError::ContractPaused);
        }
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

    /// Returns a specific paginated page of participant addresses for a league.
    pub fn get_participants_page(env: Env, league_id: u64, page: u32) -> Vec<Address> {
        let key = DataKey::ParticipantPage(league_id, page);
        if let Some(page_vec) = env.storage().persistent().get::<_, Vec<Address>>(&key) {
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
            env.storage()
                .instance()
                .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
            page_vec
        } else {
            Vec::new(&env)
        }
    }

    /// Returns the total number of participant pages allocated for a league.
    pub fn get_participant_pages_count(env: Env, league_id: u64) -> u32 {
        let league_key = DataKey::League(league_id);
        if let Some(league) = env
            .storage()
            .persistent()
            .get::<_, LeagueState>(&league_key)
        {
            env.storage().persistent().extend_ttl(
                &league_key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
            if league.participant_count == 0 {
                0
            } else {
                ((league.participant_count - 1) / PARTICIPANTS_PER_PAGE) + 1
            }
        } else {
            0
        }
    }

    /// Extends the storage TTL for a specific participant page bucket.
    pub fn extend_participant_page_ttl(
        env: Env,
        league_id: u64,
        page: u32,
        threshold: u32,
        extend_to: u32,
    ) -> Result<(), EscrowError> {
        let key = DataKey::ParticipantPage(league_id, page);
        if !env.storage().persistent().has(&key) {
            return Err(EscrowError::LeagueNotFound);
        }
        env.storage()
            .persistent()
            .extend_ttl(&key, threshold, extend_to);
        env.storage().instance().extend_ttl(threshold, extend_to);
        Ok(())
    }

    /// Proposes an emergency fee withdrawal subject to timelock and multisig approval.
    pub fn propose_fee_withdrawal(
        env: Env,
        caller: Address,
        proposal_id: u64,
        destination: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), EscrowError> {
        caller.require_auth();

        if amount <= 0 {
            return Err(EscrowError::InvalidAmount);
        }

        let config: AdminConfig = env
            .storage()
            .instance()
            .get(&DataKey::AdminConfig)
            .ok_or(EscrowError::NotInitialized)?;

        if !config.signers.iter().any(|s| s == caller) {
            return Err(EscrowError::NotAuthorized);
        }

        let key = DataKey::TimelockProposal(proposal_id);
        if env.storage().persistent().has(&key) {
            return Err(EscrowError::AlreadyInitialized);
        }

        let unlock_ledger = env.ledger().sequence() + TIMELOCK_DELAY_LEDGERS;
        let mut approvals = Vec::new(&env);
        approvals.push_back(caller.clone());

        let proposal = TimelockProposal {
            id: proposal_id,
            proposer: caller,
            destination: destination.clone(),
            asset,
            amount,
            unlock_ledger,
            approvals,
            executed: false,
        };

        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "TimelockProposed"), proposal_id),
            (destination, amount),
        );

        Ok(())
    }

    /// Approves a proposed fee withdrawal.
    pub fn approve_fee_withdrawal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), EscrowError> {
        caller.require_auth();

        let config: AdminConfig = env
            .storage()
            .instance()
            .get(&DataKey::AdminConfig)
            .ok_or(EscrowError::NotInitialized)?;

        if !config.signers.iter().any(|s| s == caller) {
            return Err(EscrowError::NotAuthorized);
        }

        let key = DataKey::TimelockProposal(proposal_id);
        let mut proposal: TimelockProposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::ProposalNotFound)?;

        if proposal.executed {
            return Err(EscrowError::ProposalExecuted);
        }

        if proposal.approvals.iter().any(|s| s == caller) {
            return Err(EscrowError::AlreadyApproved);
        }

        proposal.approvals.push_back(caller.clone());
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events()
            .publish((Symbol::new(&env, "TimelockApproved"), proposal_id), caller);

        Ok(())
    }

    /// Executes an approved fee withdrawal once the timelock delay has elapsed.
    pub fn execute_fee_withdrawal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), EscrowError> {
        caller.require_auth();

        let config: AdminConfig = env
            .storage()
            .instance()
            .get(&DataKey::AdminConfig)
            .ok_or(EscrowError::NotInitialized)?;

        if !config.signers.iter().any(|s| s == caller) {
            return Err(EscrowError::NotAuthorized);
        }

        let key = DataKey::TimelockProposal(proposal_id);
        let mut proposal: TimelockProposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::ProposalNotFound)?;

        if proposal.executed {
            return Err(EscrowError::ProposalExecuted);
        }

        if env.ledger().sequence() < proposal.unlock_ledger {
            return Err(EscrowError::TimelockActive);
        }

        let required_threshold = if config.signers.len() >= 2 && config.threshold < 2 {
            2
        } else {
            config.threshold
        };

        if proposal.approvals.len() < required_threshold {
            return Err(EscrowError::InvalidMultisig);
        }

        let client = token::Client::new(&env, &proposal.asset);
        client.transfer(
            &env.current_contract_address(),
            &proposal.destination,
            &proposal.amount,
        );

        proposal.executed = true;
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "TimelockExecuted"), proposal_id),
            (proposal.destination.clone(), proposal.amount),
        );

        Ok(())
    }

    /// Retrieves a timelock proposal by id.
    pub fn get_timelock_proposal(env: Env, proposal_id: u64) -> Option<TimelockProposal> {
        let key = DataKey::TimelockProposal(proposal_id);
        env.storage().persistent().get(&key)
    }

    /// Proposes an emergency pause action subject to multisig approval.
    pub fn propose_pause(env: Env, caller: Address, proposal_id: u64) -> Result<(), EscrowError> {
        Self::propose_pause_action_internal(&env, caller, proposal_id, PauseAction::Pause, 0)
    }

    /// Proposes an unpause action subject to multisig approval.
    pub fn propose_unpause(env: Env, caller: Address, proposal_id: u64) -> Result<(), EscrowError> {
        Self::propose_pause_action_internal(&env, caller, proposal_id, PauseAction::Unpause, 0)
    }

    /// Proposes a pause/unpause action with an explicit timelock delay in ledgers.
    pub fn propose_pause_with_timelock(
        env: Env,
        caller: Address,
        proposal_id: u64,
        action: PauseAction,
        timelock_ledgers: u32,
    ) -> Result<(), EscrowError> {
        Self::propose_pause_action_internal(&env, caller, proposal_id, action, timelock_ledgers)
    }

    fn propose_pause_action_internal(
        env: &Env,
        caller: Address,
        proposal_id: u64,
        action: PauseAction,
        timelock_ledgers: u32,
    ) -> Result<(), EscrowError> {
        caller.require_auth();

        let config: AdminConfig = env
            .storage()
            .instance()
            .get(&DataKey::AdminConfig)
            .ok_or(EscrowError::NotInitialized)?;

        if !config.signers.iter().any(|s| s == caller) {
            return Err(EscrowError::NotAuthorized);
        }

        let key = DataKey::PauseProposal(proposal_id);
        if env.storage().persistent().has(&key) {
            return Err(EscrowError::AlreadyInitialized);
        }

        let unlock_ledger = env.ledger().sequence().saturating_add(timelock_ledgers);
        let mut approvals = Vec::new(env);
        approvals.push_back(caller.clone());

        let proposal = PauseProposal {
            id: proposal_id,
            proposer: caller.clone(),
            action,
            unlock_ledger,
            approvals,
            executed: false,
        };

        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(env, "PauseProposalCreated"), proposal_id),
            (caller, action as u32),
        );

        Ok(())
    }

    /// Approves a proposed pause or unpause action.
    pub fn approve_pause_proposal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), EscrowError> {
        caller.require_auth();

        let config: AdminConfig = env
            .storage()
            .instance()
            .get(&DataKey::AdminConfig)
            .ok_or(EscrowError::NotInitialized)?;

        if !config.signers.iter().any(|s| s == caller) {
            return Err(EscrowError::NotAuthorized);
        }

        let key = DataKey::PauseProposal(proposal_id);
        let mut proposal: PauseProposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::ProposalNotFound)?;

        if proposal.executed {
            return Err(EscrowError::ProposalExecuted);
        }

        if proposal.approvals.iter().any(|s| s == caller) {
            return Err(EscrowError::AlreadyApproved);
        }

        proposal.approvals.push_back(caller.clone());
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "PauseProposalApproved"), proposal_id),
            caller,
        );

        Ok(())
    }

    /// Executes an approved pause/unpause proposal once threshold approvals and timelock conditions are satisfied.
    pub fn execute_pause_proposal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), EscrowError> {
        caller.require_auth();

        let config: AdminConfig = env
            .storage()
            .instance()
            .get(&DataKey::AdminConfig)
            .ok_or(EscrowError::NotInitialized)?;

        if !config.signers.iter().any(|s| s == caller) {
            return Err(EscrowError::NotAuthorized);
        }

        let key = DataKey::PauseProposal(proposal_id);
        let mut proposal: PauseProposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(EscrowError::ProposalNotFound)?;

        if proposal.executed {
            return Err(EscrowError::ProposalExecuted);
        }

        if env.ledger().sequence() < proposal.unlock_ledger {
            return Err(EscrowError::TimelockActive);
        }

        let required_threshold = if config.signers.len() >= 2 && config.threshold < 2 {
            2
        } else {
            config.threshold
        };

        if proposal.approvals.len() < required_threshold {
            return Err(EscrowError::InvalidMultisig);
        }

        match proposal.action {
            PauseAction::Pause => {
                if Self::is_paused(&env) {
                    return Err(EscrowError::AlreadyPaused);
                }
                let paused_at = env.ledger().timestamp();
                env.storage().instance().set(&DataKey::IsPaused, &true);
                env.storage().instance().set(&DataKey::PausedAt, &paused_at);
                env.events()
                    .publish((Symbol::new(&env, "ContractPaused"),), paused_at);
            }
            PauseAction::Unpause => {
                if !Self::is_paused(&env) {
                    return Err(EscrowError::NotPaused);
                }
                let unpaused_at = env.ledger().timestamp();
                env.storage().instance().set(&DataKey::IsPaused, &false);
                env.storage().instance().remove(&DataKey::PausedAt);
                env.events()
                    .publish((Symbol::new(&env, "ContractUnpaused"),), unpaused_at);
            }
        }

        proposal.executed = true;
        env.storage().persistent().set(&key, &proposal);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        env.events().publish(
            (Symbol::new(&env, "PauseProposalExecuted"), proposal_id),
            (caller, proposal.action as u32),
        );

        Ok(())
    }

    /// Retrieves a pause proposal by id.
    pub fn get_pause_proposal(env: Env, proposal_id: u64) -> Option<PauseProposal> {
        let key = DataKey::PauseProposal(proposal_id);
        env.storage().persistent().get(&key)
    }
}

impl FantasyXIEscrow {
    /// Internal helper that computes SHA-256 hash over winner addresses, payout amounts, and platform fee.
    pub fn compute_settlement_hash_internal(
        env: &Env,
        winners: &Vec<WinnerPayout>,
        platform_fee: i128,
    ) -> BytesN<32> {
        let mut data = Bytes::new(env);
        for winner in winners.iter() {
            data.append(&winner.winner.clone().to_xdr(env));
            data.append(&winner.amount.to_xdr(env));
        }
        data.append(&platform_fee.to_xdr(env));
        env.crypto().sha256(&data).to_bytes()
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
    fn test_partial_refund_multi_party_league() {
        // 4 participants deposit into a league that is later cancelled. The
        // admin refunds them in two separate batches (mirroring the
        // backend's batched mass-refund job), and unrefunded participants
        // must keep their deposit recorded until their own batch runs.
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);
        let token_client = token::Client::new(&env, &token_addr);

        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        let u3 = Address::generate(&env);
        let u4 = Address::generate(&env);

        for user in [&u1, &u2, &u3, &u4] {
            token_admin_client.mint(user, &50_000_000);
        }

        client.create_league(&admin, &1000, &50_000_000, &token_addr);
        for user in [&u1, &u2, &u3, &u4] {
            client.deposit(user, &1000);
        }

        let league = client.get_league(&1000).unwrap();
        assert_eq!(league.total_deposited, 200_000_000);
        assert_eq!(league.participant_count, 4);

        // First batch: refund only u1 and u2.
        let first_batch = vec![&env, u1.clone(), u2.clone()];
        client.refund(&admin, &1000, &first_batch);

        assert_eq!(token_client.balance(&u1), 50_000_000);
        assert_eq!(token_client.balance(&u2), 50_000_000);
        // Not yet refunded participants keep zero balance and their deposit
        // record is still readable (a follow-up batch can still find them).
        assert_eq!(token_client.balance(&u3), 0);
        assert_eq!(token_client.balance(&u4), 0);
        assert_eq!(client.get_deposit(&1000, &u3), 50_000_000);
        assert_eq!(client.get_deposit(&1000, &u4), 50_000_000);

        // The league is already flagged Cancelled after the first partial batch.
        let mid_state = client.get_league(&1000).unwrap();
        assert_eq!(mid_state.status, LeagueStatus::Cancelled);

        // Re-running the first batch must be a no-op (deposit already removed).
        client.refund(&admin, &1000, &first_batch);
        assert_eq!(token_client.balance(&u1), 50_000_000);
        assert_eq!(token_client.balance(&u2), 50_000_000);

        // Second batch: refund the remaining participants.
        let second_batch = vec![&env, u3.clone(), u4.clone()];
        client.refund(&admin, &1000, &second_batch);

        assert_eq!(token_client.balance(&u3), 50_000_000);
        assert_eq!(token_client.balance(&u4), 50_000_000);
        assert_eq!(client.get_deposit(&1000, &u3), 0);
        assert_eq!(client.get_deposit(&1000, &u4), 0);
    }

    #[test]
    fn test_refund_rejected_after_settlement() {
        // Once a league has been settled, it must never be refundable -
        // otherwise winners could be paid twice (settlement payouts plus a
        // stray refund of already-cleared deposits).
        let (env, admin, token_addr, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        let user1 = Address::generate(&env);
        let treasury = Address::generate(&env);

        token_admin_client.mint(&user1, &50_000_000);
        client.create_league(&admin, &1001, &50_000_000, &token_addr);
        client.deposit(&user1, &1001);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: user1.clone(),
                amount: 47_500_000,
            },
        ];
        client.settle(&admin, &1001, &winners, &treasury, &2_500_000);

        let participants = vec![&env, user1.clone()];
        let result = client.try_refund(&admin, &1001, &participants);
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
    }

    #[test]
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

    #[test]
    fn test_cancel_league_and_claim_refund_lifecycle() {
        let (env, _admin, token_addr, client) = setup_test();
        let token_admin = token::StellarAssetClient::new(&env, &token_addr);
        let token_client = token::Client::new(&env, &token_addr);

        let creator = Address::generate(&env);
        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        let non_participant = Address::generate(&env);

        token_admin.mint(&u1, &50_000_000);
        token_admin.mint(&u2, &50_000_000);

        let league_id = 950u64;
        client.create_league(&creator, &league_id, &50_000_000, &token_addr);
        client.deposit(&u1, &league_id);
        client.deposit(&u2, &league_id);

        assert_eq!(token_client.balance(&u1), 0);
        assert_eq!(token_client.balance(&u2), 0);

        // Cannot claim refund while league is not cancelled
        let premature = client.try_claim_refund(&u1, &league_id);
        assert_eq!(premature, Err(Ok(EscrowError::LeagueNotCancelled)));

        // Non-admin / non-creator cannot cancel
        let bad_cancel = client.try_cancel_league(&u1, &league_id);
        assert_eq!(bad_cancel, Err(Ok(EscrowError::NotAuthorized)));

        // Creator cancels league
        client.cancel_league(&creator, &league_id);
        let league = client.get_league(&league_id).unwrap();
        assert_eq!(league.status, LeagueStatus::Cancelled);

        // Non-participant claim fails
        let non_p = client.try_claim_refund(&non_participant, &league_id);
        assert_eq!(non_p, Err(Ok(EscrowError::NoDeposit)));

        // u1 claims refund successfully
        client.claim_refund(&u1, &league_id);
        assert_eq!(token_client.balance(&u1), 50_000_000);

        // Double claim by u1 fails with AlreadyClaimed
        let double_claim = client.try_claim_refund(&u1, &league_id);
        assert_eq!(double_claim, Err(Ok(EscrowError::AlreadyClaimed)));

        // u2 claims refund successfully
        client.claim_refund(&u2, &league_id);
        assert_eq!(token_client.balance(&u2), 50_000_000);
    }

    #[test]
    fn test_affiliate_payout_exceeding_cap_rejected() {
        let (env, admin, token_addr, client) = setup_test();
        let token_admin = token::StellarAssetClient::new(&env, &token_addr);

        let u1 = Address::generate(&env);
        let referrer = Address::generate(&env);
        let treasury = Address::generate(&env);

        token_admin.mint(&u1, &100_000_000);

        let league_id = 960u64;
        client.create_league(&admin, &league_id, &100_000_000, &token_addr);
        client.deposit(&u1, &league_id);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: u1.clone(),
                amount: 95_000_000,
            },
        ];

        // Platform fee = 5_000_000 (5%). Max affiliate is 20% of fee = 1_000_000.
        // Attempting to set affiliate cut to 1_500_000 (> 20%) must return InvalidFeeShare
        let over_cap = client.try_settle_with_affiliate(
            &admin,
            &league_id,
            &winners,
            &treasury,
            &5_000_000,
            &Some(referrer.clone()),
            &1_500_000,
        );
        assert_eq!(over_cap, Err(Ok(EscrowError::InvalidFeeShare)));

        // Attempting to set affiliate cut > platform fee entirely (e.g. 6_000_000) returns InvalidFeeShare
        let over_fee = client.try_settle_with_affiliate(
            &admin,
            &league_id,
            &winners,
            &treasury,
            &5_000_000,
            &Some(referrer.clone()),
            &6_000_000,
        );
        assert_eq!(over_fee, Err(Ok(EscrowError::InvalidFeeShare)));

        // Valid affiliate payout within 20% cap succeeds
        client.settle_with_affiliate(
            &admin,
            &league_id,
            &winners,
            &treasury,
            &5_000_000,
            &Some(referrer.clone()),
            &1_000_000,
        );

        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&referrer), 1_000_000);
        assert_eq!(token_client.balance(&treasury), 4_000_000);
    }

    #[test]
    fn test_dynamic_league_participant_expansion_500_plus() {
        let (env, admin, token, client) = setup_test();
        let token_admin_client = token::StellarAssetClient::new(&env, &token);

        let league_id = 999;
        let entry_fee = 10_000_000; // 1 USDC
        client.create_league(&admin, &league_id, &entry_fee, &token);

        // Simulate 520 participant deposits
        let total_participants = 520;
        let mut sample_addresses = Vec::new(&env);

        for i in 0..total_participants {
            let participant = Address::generate(&env);
            token_admin_client.mint(&participant, &entry_fee);
            client.deposit(&participant, &league_id);
            if i % 50 == 0 || i == total_participants - 1 {
                sample_addresses.push_back(participant);
            }
        }

        // Verify total participant count and deposit tally
        let league = client.get_league(&league_id).unwrap();
        assert_eq!(league.participant_count, total_participants);
        assert_eq!(
            league.total_deposited,
            (total_participants as i128) * entry_fee
        );

        // Verify pagination across storage buckets
        // 520 participants with 50 per page -> 11 pages (10 full pages of 50, 1 partial page of 20)
        let page_count = client.get_participant_pages_count(&league_id);
        assert_eq!(page_count, 11);

        let first_page = client.get_participants_page(&league_id, &0);
        assert_eq!(first_page.len(), 50);

        let last_page = client.get_participants_page(&league_id, &10);
        assert_eq!(last_page.len(), 20);

        // Verify O(1) deposit lookup for sampled participants
        for addr in sample_addresses.iter() {
            let deposit = client.get_deposit(&league_id, &addr);
            assert_eq!(deposit, entry_fee);
        }

        // Verify page TTL extension
        client.extend_participant_page_ttl(&league_id, &0, &1000, &2000);
    }

    #[test]
    fn test_settlement_hash_verification_success() {
        let (env, admin, token_addr, client) = setup_test();
        let participant = Address::generate(&env);
        let treasury = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        token_admin_client.mint(&participant, &50_000_000);
        client.create_league(&admin, &701, &50_000_000, &token_addr);
        client.deposit(&participant, &701);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: participant.clone(),
                amount: 47_500_000,
            },
        ];
        let platform_fee = 2_500_000;

        let hash = client.compute_settlement_hash(&winners, &platform_fee);

        client.settle_with_settlement_hash(&admin, &701, &winners, &treasury, &platform_fee, &hash);

        let league = client.get_league(&701).unwrap();
        assert_eq!(league.status, LeagueStatus::Settled);

        let stored_hash = client.get_settlement_hash(&701);
        assert_eq!(stored_hash, Some(hash));

        client.claim_prize(&participant, &701);
        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&participant), 47_500_000);
        assert_eq!(token_client.balance(&treasury), 2_500_000);
    }

    #[test]
    fn test_settlement_hash_mismatch_rejected() {
        let (env, admin, token_addr, client) = setup_test();
        let participant1 = Address::generate(&env);
        let participant2 = Address::generate(&env);
        let treasury = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        token_admin_client.mint(&participant1, &50_000_000);
        client.create_league(&admin, &702, &50_000_000, &token_addr);
        client.deposit(&participant1, &702);

        let winners = vec![
            &env,
            WinnerPayout {
                winner: participant1.clone(),
                amount: 47_500_000,
            },
        ];
        let platform_fee = 2_500_000;

        // Compute hash for a different winner array (altered winner)
        let altered_winners = vec![
            &env,
            WinnerPayout {
                winner: participant2.clone(),
                amount: 47_500_000,
            },
        ];
        let altered_hash = client.compute_settlement_hash(&altered_winners, &platform_fee);

        // Attempting to settle winners with an altered settlement hash must fail with HashMismatch
        let result = client.try_settle_with_settlement_hash(
            &admin,
            &702,
            &winners,
            &treasury,
            &platform_fee,
            &altered_hash,
        );
        assert_eq!(result, Err(Ok(EscrowError::HashMismatch)));

        // Verify league was NOT settled
        let league = client.get_league(&702).unwrap();
        assert_eq!(league.status, LeagueStatus::Upcoming);
        assert_eq!(client.get_settlement_hash(&702), None);
    }

    #[test]
    fn test_multisig_timelock_fee_withdrawal_lifecycle() {
        let env = Env::default();
        env.mock_all_auths();

        let signer_one = Address::generate(&env);
        let signer_two = Address::generate(&env);
        let signer_three = Address::generate(&env);
        let non_signer = Address::generate(&env);
        let destination = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_contract.address());

        let contract_id = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_id);

        let signers = vec![
            &env,
            signer_one.clone(),
            signer_two.clone(),
            signer_three.clone(),
        ];
        // Threshold: 2 of 3
        client.initialize_multisig(&signers, &2);

        // Fund the escrow contract with 500 USDC
        let withdrawal_amount = 200_000_000; // 20 USDC
        token_admin_client.mint(&contract_id, &500_000_000);

        let proposal_id = 101;

        // 1. Non-signer cannot propose
        let non_signer_propose = client.try_propose_fee_withdrawal(
            &non_signer,
            &proposal_id,
            &destination,
            &token_contract.address(),
            &withdrawal_amount,
        );
        assert_eq!(non_signer_propose, Err(Ok(EscrowError::NotAuthorized)));

        // 2. Propose with invalid amount fails
        let invalid_amount_propose = client.try_propose_fee_withdrawal(
            &signer_one,
            &proposal_id,
            &destination,
            &token_contract.address(),
            &0,
        );
        assert_eq!(invalid_amount_propose, Err(Ok(EscrowError::InvalidAmount)));

        // 3. Signer one proposes withdrawal successfully
        client.propose_fee_withdrawal(
            &signer_one,
            &proposal_id,
            &destination,
            &token_contract.address(),
            &withdrawal_amount,
        );

        let proposal = client.get_timelock_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.id, proposal_id);
        assert_eq!(proposal.proposer, signer_one);
        assert_eq!(proposal.approvals.len(), 1);
        assert!(!proposal.executed);

        // 4. Duplicate proposal ID fails
        let dup_propose = client.try_propose_fee_withdrawal(
            &signer_two,
            &proposal_id,
            &destination,
            &token_contract.address(),
            &withdrawal_amount,
        );
        assert_eq!(dup_propose, Err(Ok(EscrowError::AlreadyInitialized)));

        // 5. Attempting to execute before timelock expiry returns TimelockActive
        let premature_exec = client.try_execute_fee_withdrawal(&signer_one, &proposal_id);
        assert_eq!(premature_exec, Err(Ok(EscrowError::TimelockActive)));

        // 6. Advance ledger past 48h timelock
        env.ledger().with_mut(|li| {
            li.sequence_number += TIMELOCK_DELAY_LEDGERS + 1;
        });

        // 7. Attempting to execute with only 1 signer (proposer) fails multisig threshold (2-of-3)
        let single_admin_exec = client.try_execute_fee_withdrawal(&signer_one, &proposal_id);
        assert_eq!(single_admin_exec, Err(Ok(EscrowError::InvalidMultisig)));

        // 8. Non-signer cannot approve
        let non_signer_approve = client.try_approve_fee_withdrawal(&non_signer, &proposal_id);
        assert_eq!(non_signer_approve, Err(Ok(EscrowError::NotAuthorized)));

        // 9. Signer one duplicate approval fails
        let dup_approve = client.try_approve_fee_withdrawal(&signer_one, &proposal_id);
        assert_eq!(dup_approve, Err(Ok(EscrowError::AlreadyApproved)));

        // 10. Signer two approves
        client.approve_fee_withdrawal(&signer_two, &proposal_id);
        let proposal_after_approval = client.get_timelock_proposal(&proposal_id).unwrap();
        assert_eq!(proposal_after_approval.approvals.len(), 2);

        // 11. Execute withdrawal successfully
        client.execute_fee_withdrawal(&signer_one, &proposal_id);

        let token_client = token::Client::new(&env, &token_contract.address());
        assert_eq!(token_client.balance(&destination), withdrawal_amount);
        let final_proposal = client.get_timelock_proposal(&proposal_id).unwrap();
        assert!(final_proposal.executed);

        // 12. Cannot re-execute or re-approve already executed proposal
        let re_exec = client.try_execute_fee_withdrawal(&signer_one, &proposal_id);
        assert_eq!(re_exec, Err(Ok(EscrowError::ProposalExecuted)));

        let re_approve = client.try_approve_fee_withdrawal(&signer_three, &proposal_id);
        assert_eq!(re_approve, Err(Ok(EscrowError::ProposalExecuted)));
    }

    #[test]
    fn test_multisig_emergency_pause_prevents_unilateral_admin_and_restores_operations() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_id);

        let signer_one = Address::generate(&env);
        let signer_two = Address::generate(&env);
        let signer_three = Address::generate(&env);

        let signers = vec![
            &env,
            signer_one.clone(),
            signer_two.clone(),
            signer_three.clone(),
        ];
        // Threshold: 2 of 3
        client.initialize_multisig(&signers, &2);

        // 1. Unilateral pause by single admin fails InvalidMultisig
        let unilateral_pause = client.try_pause(&signer_one);
        assert_eq!(unilateral_pause, Err(Ok(EscrowError::InvalidMultisig)));
        assert!(!client.is_paused_view());

        // 2. Direct multisig pause with only 1 approval fails InvalidMultisig
        let one_approval = vec![&env, signer_one.clone()];
        let direct_one_pause = client.try_pause_with_multisig(&one_approval);
        assert_eq!(direct_one_pause, Err(Ok(EscrowError::InvalidMultisig)));
        assert!(!client.is_paused_view());

        // 3. Direct multisig pause with threshold approvals (2-of-3) succeeds
        let two_approvals = vec![&env, signer_one.clone(), signer_two.clone()];
        client.pause_with_multisig(&two_approvals);
        assert!(client.is_paused_view());

        // 4. Pausing again returns AlreadyPaused
        let repeat_pause = client.try_pause_with_multisig(&two_approvals);
        assert_eq!(repeat_pause, Err(Ok(EscrowError::AlreadyPaused)));

        // 5. Unilateral unpause fails InvalidMultisig
        let unilateral_unpause = client.try_unpause(&signer_one);
        assert_eq!(unilateral_unpause, Err(Ok(EscrowError::InvalidMultisig)));
        assert!(client.is_paused_view());

        // 6. Direct multisig unpause with threshold approvals (2-of-3) succeeds
        let unpause_approvals = vec![&env, signer_two.clone(), signer_three.clone()];
        client.unpause_with_multisig(&unpause_approvals);
        assert!(!client.is_paused_view());

        // 7. Unpausing again returns NotPaused
        let repeat_unpause = client.try_unpause_with_multisig(&unpause_approvals);
        assert_eq!(repeat_unpause, Err(Ok(EscrowError::NotPaused)));
    }

    #[test]
    fn test_pause_governance_proposal_lifecycle_and_timelock() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(FantasyXIEscrow, ());
        let client = FantasyXIEscrowClient::new(&env, &contract_id);

        let signer_one = Address::generate(&env);
        let signer_two = Address::generate(&env);
        let signer_three = Address::generate(&env);
        let non_signer = Address::generate(&env);

        let signers = vec![
            &env,
            signer_one.clone(),
            signer_two.clone(),
            signer_three.clone(),
        ];
        client.initialize_multisig(&signers, &2);

        let proposal_id = 101u64;

        // 1. Non-signer cannot propose
        let unauthorized = client.try_propose_pause(&non_signer, &proposal_id);
        assert_eq!(unauthorized, Err(Ok(EscrowError::NotAuthorized)));

        // 2. Propose pause with timelock delay of 50 ledgers
        client.propose_pause_with_timelock(&signer_one, &proposal_id, &PauseAction::Pause, &50);

        let proposal = client.get_pause_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.id, proposal_id);
        assert_eq!(proposal.proposer, signer_one);
        assert_eq!(proposal.action, PauseAction::Pause);
        assert_eq!(proposal.approvals.len(), 1);
        assert!(!proposal.executed);

        // 3. Duplicate proposal ID fails
        let dup = client.try_propose_pause(&signer_two, &proposal_id);
        assert_eq!(dup, Err(Ok(EscrowError::AlreadyInitialized)));

        // 4. Execution before timelock expiry fails TimelockActive
        let premature = client.try_execute_pause_proposal(&signer_one, &proposal_id);
        assert_eq!(premature, Err(Ok(EscrowError::TimelockActive)));

        // 5. Advance ledger past timelock
        env.ledger().with_mut(|li| {
            li.sequence_number += 51;
        });

        // 6. Attempt execution with only 1 approval fails InvalidMultisig
        let single_exec = client.try_execute_pause_proposal(&signer_one, &proposal_id);
        assert_eq!(single_exec, Err(Ok(EscrowError::InvalidMultisig)));

        // 7. Non-signer cannot approve
        let bad_approve = client.try_approve_pause_proposal(&non_signer, &proposal_id);
        assert_eq!(bad_approve, Err(Ok(EscrowError::NotAuthorized)));

        // 8. Signer one duplicate approval fails AlreadyApproved
        let dup_approve = client.try_approve_pause_proposal(&signer_one, &proposal_id);
        assert_eq!(dup_approve, Err(Ok(EscrowError::AlreadyApproved)));

        // 9. Signer two approves proposal
        client.approve_pause_proposal(&signer_two, &proposal_id);
        let proposal_after_approval = client.get_pause_proposal(&proposal_id).unwrap();
        assert_eq!(proposal_after_approval.approvals.len(), 2);

        // 10. Execute pause proposal successfully
        client.execute_pause_proposal(&signer_one, &proposal_id);
        assert!(client.is_paused_view());

        let final_proposal = client.get_pause_proposal(&proposal_id).unwrap();
        assert!(final_proposal.executed);

        // 11. Already executed proposal cannot be executed again
        let re_exec = client.try_execute_pause_proposal(&signer_two, &proposal_id);
        assert_eq!(re_exec, Err(Ok(EscrowError::ProposalExecuted)));

        // 12. Propose unpause (default 0 delay for rapid recovery once multisig threshold achieved)
        let unpause_id = 102u64;
        client.propose_unpause(&signer_two, &unpause_id);
        client.approve_pause_proposal(&signer_three, &unpause_id);
        client.execute_pause_proposal(&signer_three, &unpause_id);
        assert!(!client.is_paused_view());

        let unpause_prop = client.get_pause_proposal(&unpause_id).unwrap();
        assert!(unpause_prop.executed);
        assert_eq!(unpause_prop.action, PauseAction::Unpause);
    }

    #[test]
    fn test_paused_state_blocks_all_modifying_methods_and_permits_emergency_refund() {
        let (env, admin, token_addr, client) = setup_test();
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let treasury = Address::generate(&env);
        let token_admin = token::StellarAssetClient::new(&env, &token_addr);

        token_admin.mint(&user1, &100_000_000);
        token_admin.mint(&user2, &100_000_000);

        let league_id = 910u64;
        client.create_league(&admin, &league_id, &50_000_000, &token_addr);
        client.deposit(&user1, &league_id);

        // Emergency pause
        client.pause(&admin);
        assert!(client.is_paused_view());

        // 1. create_league rejected with ContractPaused
        let err_create = client.try_create_league(&admin, &911, &50_000_000, &token_addr);
        assert_eq!(err_create, Err(Ok(EscrowError::ContractPaused)));

        // 2. deposit rejected with ContractPaused
        let err_deposit = client.try_deposit(&user2, &league_id);
        assert_eq!(err_deposit, Err(Ok(EscrowError::ContractPaused)));

        // 3. publish_gameweek_result rejected with ContractPaused
        let dummy_hash = BytesN::from_array(&env, &[1u8; 32]);
        let err_publish = client.try_publish_gameweek_result(&admin, &1, &dummy_hash);
        assert_eq!(err_publish, Err(Ok(EscrowError::ContractPaused)));

        // 4. settle rejected with ContractPaused
        let winners = vec![
            &env,
            WinnerPayout {
                winner: user1.clone(),
                amount: 47_500_000,
            },
        ];
        let err_settle = client.try_settle(&admin, &league_id, &winners, &treasury, &2_500_000);
        assert_eq!(err_settle, Err(Ok(EscrowError::ContractPaused)));

        // 5. settle_with_multisig rejected with ContractPaused
        let err_settle_multi = client.try_settle_with_multisig(
            &vec![&env, admin.clone()],
            &league_id,
            &winners,
            &treasury,
            &2_500_000,
        );
        assert_eq!(err_settle_multi, Err(Ok(EscrowError::ContractPaused)));

        // 6. claim_prize rejected with ContractPaused
        let err_claim = client.try_claim_prize(&user1, &league_id);
        assert_eq!(err_claim, Err(Ok(EscrowError::ContractPaused)));

        // 7. cancel_league rejected with ContractPaused
        let err_cancel = client.try_cancel_league(&admin, &league_id);
        assert_eq!(err_cancel, Err(Ok(EscrowError::ContractPaused)));

        // 8. Emergency refund is permitted once timelock elapses while paused
        env.ledger().set_timestamp(14 * 24 * 60 * 60);
        let token_client = token::Client::new(&env, &token_addr);
        assert_eq!(token_client.balance(&user1), 50_000_000); // 100M - 50M deposit
        client.emergency_refund_league(&user1, &league_id);
        assert_eq!(token_client.balance(&user1), 100_000_000); // recovered!

        // 9. Unpause restores normal contract operations
        client.unpause(&admin);
        assert!(!client.is_paused_view());

        let new_league_id = 912u64;
        client.create_league(&admin, &new_league_id, &50_000_000, &token_addr);
        client.deposit(&user2, &new_league_id);
        assert_eq!(client.get_deposit(&new_league_id, &user2), 50_000_000);
    }
}
