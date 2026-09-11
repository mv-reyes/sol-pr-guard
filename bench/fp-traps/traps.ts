// FP-trap corpus (research/fp-traps-and-sealevel-mapping.md, Part A).
// 32 source-verified clean fragments that TEMPT a detector but are SAFE. Every
// one must produce ZERO T1/T2 findings across ALL rules. Fragments are faithful
// minimal reconstructions of the quoted source (each retains the exact tempting
// shape it was cited for). `tempts` records the detector it targets.
export interface Trap {
  id: string;
  tempts: string; // detector id it must not trip
  repo: string;
  code: string;
}

export const TRAPS: Trap[] = [
  // ---- D9 realloc-zero-init (T1-T3) ----
  {
    id: 'T1', tempts: 'realloc-zero-init', repo: 'mango-v4 account_expand.rs',
    code: `pub fn account_expand(ctx: Context<AccountExpand>, new_size: usize) -> Result<()> {
    // This instruction has <= 1 calls to AccountInfo::realloc(), meaning that the
    // new data when expanding the account will be zero initialized already.
    let no_zero_init = false;
    account_ai.realloc(new_size, no_zero_init)?;
    Ok(())
}`,
  },
  {
    id: 'T2', tempts: 'realloc-zero-init', repo: 'mango-v4 account_size_migration.rs',
    code: `pub fn account_size_migration(ctx: Context<Migrate>, new_size: usize) -> Result<()> {
    // Runtime guarantees zero-init on the first realloc within an instruction.
    let no_zero_init = false;
    account_ai.realloc(new_size, no_zero_init)?;
    Ok(())
}`,
  },
  {
    id: 'T3', tempts: 'realloc-zero-init', repo: 'phoenix-v1 governance.rs',
    code: `pub fn remove_market() -> ProgramResult {
    **receiver.lamports.borrow_mut() = destination_starting_lamports + market_info.lamports();
    **market_info.lamports.borrow_mut() = 0;
    market_info.assign(&system_program::id());
    market_info.realloc(0, false)?;
    Ok(())
}`,
  },
  // ---- D10 unchecked-arithmetic (T5-T8) ----
  {
    id: 'T5', tempts: 'unchecked-arithmetic', repo: 'mango-v4 account_expand.rs',
    code: `fn f(current_lamports: u64, new_rent_minimum: u64) {
    if current_lamports < new_rent_minimum {
    } else if current_lamports > new_rent_minimum {
        let excess = current_lamports - new_rent_minimum;
        account_lamports -= excess;
        payer_lamports += excess;
    }
}`,
  },
  {
    id: 'T6', tempts: 'unchecked-arithmetic', repo: 'mango-v4 perp_settle_fees.rs',
    code: `fn settle() -> Result<()> {
    let settlement = settleable_pnl.abs().min(fees_accrued.abs()).min(max_settle_amount);
    require!(settlement >= 0, MangoError::SomethingWrong);
    perp_market.fees_accrued -= settlement;
    Ok(())
}`,
  },
  {
    id: 'T7', tempts: 'unchecked-arithmetic', repo: 'phoenix-v1 new_order.rs',
    code: `fn place() {
    // This should never underflow, but if it does, the program will panic and
    // the transaction will fail.
    quote_lots_available -= quote_lots_deposited + matching_engine_response.num_free_quote_lots_used;
    quote_lots_to_deposit += quote_lots_deposited;
}`,
  },
  {
    id: 'T8', tempts: 'unchecked-arithmetic', repo: 'phoenix-v1 governance.rs',
    code: `fn close() {
    **receiver.lamports.borrow_mut() = destination_starting_lamports + market_info.lamports();
}`,
  },
  // ---- D4 discarded-checked-result (T9-T12) ----
  {
    id: 'T9', tempts: 'discarded-checked-result', repo: 'marginfi interest_rate.rs',
    code: `fn ir(apr: I80F48, time_delta: u64) -> Option<I80F48> {
    let ir_per_period: I80F48 = apr
        .checked_mul(time_delta.into())?
        .checked_div(SECONDS_PER_YEAR)?;
    Some(ir_per_period)
}`,
  },
  {
    id: 'T10', tempts: 'discarded-checked-result', repo: 'mango-v4 benchmark.rs',
    code: `fn bench() {
    run_bench("division_i80f48", || a.checked_div(b).unwrap());
}`,
  },
  {
    id: 'T11', tempts: 'discarded-checked-result', repo: 'drift keeper.rs',
    code: `fn fill(order_id: u32) -> Result<()> {
    match order {
        None => {
            msg!("Order does not exist {}", order_id);
            return Ok(());
        }
        Some(o) => process(o),
    }
    Ok(())
}`,
  },
  {
    id: 'T12', tempts: 'discarded-checked-result', repo: 'drift keeper.rs',
    code: `fn signed_msg() -> Result<()> {
    if max_slot < current_slot {
        msg!("SignedMsg order max_slot {} < current slot {}", max_slot, current_slot);
        return Ok(());
    }
    Ok(())
}`,
  },
  // ---- D3 disabled-constraint (T13-T19) ----
  {
    id: 'T13', tempts: 'disabled-constraint', repo: 'marginfi claim_bad_debt.rs',
    code: `#[derive(Accounts)]
pub struct ClaimBadDebt<'info> {
    #[account(has_one = integration_acc_2)]
    pub bank: AccountLoader<'info, Bank>,
    /// CHECK: Address is locked by the bank's integration account field.
    pub integration_acc_2: UncheckedAccount<'info>,
}`,
  },
  {
    id: 'T14', tempts: 'disabled-constraint', repo: 'marginfi claim_bad_debt.rs',
    code: `#[derive(Accounts)]
pub struct Claim<'info> {
    /// CHECK: MerkleDistributor account. The distributor program validates its contents during CPI.
    #[account(mut, owner = MERKLE_DISTRIBUTOR_PROGRAM_ID)]
    pub distributor: UncheckedAccount<'info>,
}`,
  },
  {
    id: 'T15', tempts: 'disabled-constraint', repo: 'drift keeper.rs',
    code: `#[derive(Accounts)]
pub struct SignedMsg<'info> {
    /// CHECK: The address check is needed because otherwise the supplied Sysvar could be anything
    /// else. The Instruction Sysvar has not been implemented in the Anchor framework yet, so this
    /// is the safe approach.
    #[account(address = IX_ID)]
    pub ix_sysvar: AccountInfo<'info>,
}`,
  },
  {
    id: 'T16', tempts: 'disabled-constraint', repo: 'mango-v4 token_force_withdraw.rs',
    code: `#[derive(Accounts)]
pub struct ForceWithdraw<'info> {
    #[account(has_one = oracle)]
    pub bank: AccountLoader<'info, Bank>,
    /// CHECK: The oracle can be one of several different account types
    pub oracle: UncheckedAccount<'info>,
}`,
  },
  {
    id: 'T17', tempts: 'disabled-constraint', repo: 'marginfi sync_indexer_flags.rs',
    code: `fn sync(ctx: Context<Sync>) -> Result<()> {
    for account_info in ctx.remaining_accounts.iter() {
        let loader = AccountLoader::<MarginfiAccount>::try_from(account_info)?;
        let mut account = loader.load_mut()?;
        account.indexer_flags.sync_balance_derived(&balances);
    }
    Ok(())
}`,
  },
  {
    id: 'T18', tempts: 'disabled-constraint', repo: 'mango-v4 token_deregister.rs',
    code: `fn deregister(ctx: Context<Deregister>) -> Result<()> {
    require_eq!(total_banks * 2, ctx.remaining_accounts.len());
    for i in (0..ctx.remaining_accounts.len()).step_by(2) {
        let bank_ai = &ctx.remaining_accounts[i];
        let vault_ai = &ctx.remaining_accounts[i + 1];
        require_eq!(bank_ai.key(), mint_info.banks[i / 2]);
        require_eq!(vault_ai.key(), mint_info.vaults[i / 2]);
        token::transfer(cpi(vault_ai), dust)?;
    }
    Ok(())
}`,
  },
  {
    id: 'T19', tempts: 'disabled-constraint', repo: 'drift token.rs',
    code: `fn build(remaining_accounts: &[AccountInfo]) {
    for account_info in remaining_accounts {
        ix.accounts.push(if account_info.is_writable {
            AccountMeta::new(*account_info.key, false)
        } else {
            AccountMeta::new_readonly(*account_info.key, false)
        });
        account_infos.push(account_info.to_account_info());
    }
}`,
  },
  // ---- D2 copy-paste-constraint (T20) ----
  {
    id: 'T20', tempts: 'copy-paste-constraint', repo: 'marginfi collect_bank_fees.rs',
    code: `#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(constraint = destination_account.mint == bank.load()?.mint)]
    pub destination_account: Account<'info, TokenAccount>,
    #[account(constraint = fees_destination_account.mint == bank.load()?.mint)]
    pub fees_destination_account: Account<'info, TokenAccount>,
}`,
  },
  // ---- D1 auth-precedence (T21-T23) ----
  {
    id: 'T21', tempts: 'auth-precedence', repo: 'drift constraints.rs',
    code: `fn is_authorized(user: &User, signer: &Signer) -> bool {
    user.authority.eq(signer.key)
        || (user.delegate.eq(signer.key) && !user.delegate.eq(&Pubkey::default()))
}`,
  },
  {
    id: 'T22', tempts: 'auth-precedence', repo: 'mpl-core update_delegate.rs',
    code: `fn validate() -> Result<ValidationResult, ProgramError> {
    if ((ctx.resolved_authorities.is_some()
        && ctx.resolved_authorities.unwrap().contains(ctx.self_authority))
        || (self.additional_delegates.contains(ctx.authority_info.key)
            && PluginType::from(plugin) != PluginType::UpdateDelegate))
        && plugin.manager() == Authority::UpdateAuthority
    {
        approve!()
    }
}`,
  },
  {
    id: 'T23', tempts: 'auth-precedence', repo: 'mpl-core asset.rs',
    code: `fn check() -> bool {
    if (plugin.manager() == Authority::UpdateAuthority
        && self.update_authority == UpdateAuthority::Address(*authority_info.key))
        || (plugin.manager() == Authority::Owner && authority_info.key == &self.owner)
    {
        return true;
    }
    false
}`,
  },
  // ---- D8 prefunded-pda-dos (T24-T27) ----
  {
    id: 'T24', tempts: 'prefunded-pda-dos', repo: 'mpl-core create.rs',
    code: `fn create(ctx: Context<Create>) -> ProgramResult {
    assert_signer(ctx.accounts.asset)?;
    invoke(
        &system_instruction::create_account(
            ctx.accounts.payer.key,
            ctx.accounts.asset.key,
            lamports,
            serialized_data.len() as u64,
            &crate::ID,
        ),
        &[ctx.accounts.payer.clone(), ctx.accounts.asset.clone()],
    )?;
    Ok(())
}`,
  },
  {
    id: 'T25', tempts: 'prefunded-pda-dos', repo: 'jito tip-payment lib.rs',
    code: `fn init_account(account_info: &AccountInfo) -> Result<()> {
    let current_lamports = account_info.lamports();
    require!(current_lamports == 0, TipPaymentError::AccountAlreadyFunded);
    anchor_lang::system_program::create_account(
        cpi_context.with_signer(signer_seeds),
        rent,
        space,
        program_id,
    )?;
    Ok(())
}`,
  },
  {
    id: 'T26', tempts: 'prefunded-pda-dos', repo: 'drift pda.rs',
    code: `fn create_pda(pda_account: &AccountInfo) -> Result<()> {
    if pda_account.lamports() > 0 {
        transfer_top_up(pda_account)?;
        allocate(pda_account)?;
        assign(pda_account)?;
    } else {
        invoke_signed(&system_instruction::create_account(payer, pda, rent, space, owner), accs, seeds)?;
    }
    Ok(())
}`,
  },
  {
    id: 'T27', tempts: 'prefunded-pda-dos', repo: 'phoenix system_utils.rs',
    code: `fn create_account_helper(new_account: &AccountInfo) -> ProgramResult {
    let current_lamports = **new_account.try_borrow_lamports()?;
    if current_lamports == 0 {
        invoke_signed(&system_instruction::create_account(payer, key, rent, space, owner), accs, seeds)?;
    } else {
        transfer_top_up(new_account)?;
        allocate(new_account)?;
        assign(new_account)?;
    }
    Ok(())
}`,
  },
  // ---- D7 missing-bounds-gate (T28-T29) ----
  {
    id: 'T28', tempts: 'missing-bounds-gate', repo: 'marginfi bank.rs',
    code: `fn configure(&mut self, config: &BankConfigOpt) -> Result<()> {
    set_if_some!(self.config.cb_ema_alpha_bps, config.cb_ema_alpha_bps);
    set_if_some!(self.config.protocol_fixed_fee_bps, config.protocol_fixed_fee_bps);
    self.config.validate()?;
    Ok(())
}`,
  },
  {
    id: 'T29', tempts: 'missing-bounds-gate', repo: 'drift admin.rs',
    code: `fn update(ctx: Context<Update>, params: Params) -> Result<()> {
    config.max_slippage_bps = params.max_slippage_bps;
    config.validate()?;
    Ok(())
}`,
  },
  // ---- D12 zero-share-conversion (T30-T31) ----
  {
    id: 'T30', tempts: 'zero-share-conversion', repo: 'marginfi marginfi_account.rs',
    code: `fn deposit(bank: &mut Bank, balance: &mut Balance, asset_amount_increase: I80F48) -> Result<()> {
    let asset_shares_increase = if asset_amount_increase > I80F48::ZERO {
        let shares = bank.get_asset_shares(asset_amount_increase)?;
        balance.change_asset_shares(shares)?;
        shares
    } else {
        I80F48::ZERO
    };
    Ok(())
}`,
  },
  {
    id: 'T31', tempts: 'zero-share-conversion', repo: 'marginfi marginfi_account.rs',
    code: `fn borrow(bank: &mut Bank, balance: &mut Balance, liability_amount_increase: I80F48) -> Result<()> {
    let liability_shares_increase = if liability_amount_increase > I80F48::ZERO {
        let shares = bank.get_liability_shares(liability_amount_increase)?;
        balance.change_liability_shares(shares)?;
        shares
    } else {
        I80F48::ZERO
    };
    Ok(())
}`,
  },
  // ---- D5 early-return-skips-cleanup (T32) ----
  {
    id: 'T32', tempts: 'early-return-skips-cleanup', repo: 'mango-v4 perp_settle_fees.rs',
    code: `fn settle_fees(ctx: Context<SettleFees>) -> Result<()> {
    if !settleable_pnl.is_negative() || !perp_market.fees_accrued.is_positive() {
        msg!("Not settling: settle amount would be zero");
        return Ok(());
    }
    settle_bank.withdraw_without_fee(settlement)?;
    Ok(())
}`,
  },
  // ---- D11 wrong-object-auth-check (T33) ----
  {
    id: 'T33', tempts: 'wrong-object-auth-check', repo: 'mango-v4 token_force_withdraw.rs',
    code: `#[derive(Accounts)]
pub struct ForceWithdraw<'info> {
    // the mints of bank/vault/token_accounts are implicitly the same because
    // spl::token::transfer succeeds between token_account and vault.
    #[account(has_one = vault)]
    pub bank: AccountLoader<'info, Bank>,
    #[account(constraint = alternate_owner_token_account.owner == account.load()?.owner)]
    pub alternate_owner_token_account: Account<'info, TokenAccount>,
}`,
  },
  // ---- Round-2 red-team regression locks (T34-T36) ----
  // T34: a proper manual close that DOES realloc to zero, written with the typed
  // literal `0usize`. `\b` after `0` fails on `0usize` (0->u is not a word
  // boundary), which had let incomplete-account-close fire on the safe fix. Must
  // stay silent. (Complements T3, which uses the bare `0`.)
  {
    id: 'T34', tempts: 'incomplete-account-close', repo: 'jito-restaking (fixed close, 0usize)',
    code: `fn close_account(a: &AccountInfo) -> ProgramResult {
    **a.lamports.borrow_mut() = 0;
    a.assign(&system_program::ID);
    let mut data = a.try_borrow_mut_data()?;
    sol_memset(&mut data, 0, data.len());
    a.realloc(0usize, false)?;
    Ok(())
}`,
  },
  // T35: a fee setter guarded by the classic `if arg > MAX_CONST { return Err }`
  // idiom (upper-bound via `>`, mirror of `<=`). Must stay silent.
  {
    id: 'T35', tempts: 'missing-bounds-gate', repo: 'anchor-style guarded setter',
    code: `fn set_lp_withdrawal_fee(state: &mut PoolState, new_fee_bps: u16) -> Result<()> {
    if new_fee_bps > MAX_FEE_BPS {
        return Err(PoolError::FeeTooHigh.into());
    }
    state.lp_withdrawal_fee_bps = new_fee_bps;
    Ok(())
}`,
  },
  // T36: a threshold setter guarded by `require!(arg < N)` (strict-less against a
  // numeric literal, not `<=`). Must stay silent.
  {
    id: 'T36', tempts: 'missing-bounds-gate', repo: 'anchor-style require! setter',
    code: `fn set_liquidation_threshold(state: &mut PoolState, new_threshold: u64) -> Result<()> {
    require!(new_threshold < 10_000, PoolError::ThresholdTooHigh);
    state.liquidation_threshold = new_threshold;
    Ok(())
}`,
  },
];
