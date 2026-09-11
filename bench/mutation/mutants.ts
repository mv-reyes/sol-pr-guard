// Mutation corpus: for each detector, a CLEAN realistic Rust snippet and a
// MUTANT that plants the bug class. The detector must fire on the mutant and
// stay silent on the clean version. Snippets mirror real Anchor/Solana shapes.
export interface Mutant {
  name: string;
  rule: string;
  tier: 1 | 2 | 3;
  clean: string;
  mutant: string;
}

export const MUTANTS: Mutant[] = [
  {
    name: 'discarded-checked/bare-unwrap',
    rule: 'discarded-checked-result',
    tier: 1,
    clean: `pub fn accrue(state: &mut State, amount: u64) -> Result<()> {
    state.total = state.total.checked_add(amount).unwrap();
    Ok(())
}`,
    mutant: `pub fn accrue(state: &mut State, amount: u64) -> Result<()> {
    state.total.checked_add(amount).unwrap();
    Ok(())
}`,
  },
  {
    name: 'discarded-checked/log-no-return',
    rule: 'discarded-checked-result',
    tier: 1,
    clean: `pub fn verify(a: Pubkey, b: Pubkey) -> Result<()> {
    if a != b {
        msg!("owner mismatch expected {} got {}", a, b);
        return Err(ErrorCode::Mismatch.into());
    }
    Ok(())
}`,
    mutant: `pub fn verify(a: Pubkey, b: Pubkey) -> Result<()> {
    if a != b {
        msg!("owner mismatch expected {} got {}", a, b);
    }
    Ok(())
}`,
  },
  {
    name: 'copy-paste-constraint/sibling',
    rule: 'copy-paste-constraint',
    tier: 1,
    clean: `#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(constraint = from_pool.load()?.mint == from_token.key() @ E::X)]
    pub from_token: Account<'info, Mint>,
    #[account(constraint = to_pool.load()?.mint == to_token.key() @ E::X)]
    pub to_token: Account<'info, Mint>,
}`,
    mutant: `#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(constraint = from_pool.load()?.mint == from_token.key() @ E::X)]
    pub from_token: Account<'info, Mint>,
    #[account(constraint = from_pool.load()?.mint == from_token.key() @ E::X)]
    pub to_token: Account<'info, Mint>,
}`,
  },
  {
    name: 'disabled-constraint/weak-check',
    rule: 'disabled-constraint',
    tier: 1,
    clean: `#[derive(Accounts)]
pub struct Buy<'info> {
    /// CHECK: validated against the rules program in the handler
    pub rules_program: UncheckedAccount<'info>,
}`,
    mutant: `#[derive(Accounts)]
pub struct Buy<'info> {
    /// CHECK: none, can be anything
    pub rules_program: UncheckedAccount<'info>,
}`,
  },
  {
    name: 'disabled-constraint/commented-out',
    rule: 'disabled-constraint',
    tier: 1,
    clean: `#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(address = RULES_ID)]
    pub rules: UncheckedAccount<'info>,
}`,
    mutant: `#[derive(Accounts)]
pub struct Buy<'info> {
    /// CHECK: address below
    //#[account(address = RULES_ID)]
    pub rules: UncheckedAccount<'info>,
}`,
  },
  {
    name: 'zero-share-conversion/no-guard',
    rule: 'zero-share-conversion',
    tier: 1,
    clean: `pub fn withdraw(bank: &mut Bank, bal: &mut Balance, amt: I80F48) -> Result<()> {
    let shares = bank.get_asset_shares(amt)?;
    check!(shares > I80F48::ZERO, E::Illegal);
    bal.change_asset_shares(-shares)?;
    Ok(())
}`,
    mutant: `pub fn withdraw(bank: &mut Bank, bal: &mut Balance, amt: I80F48) -> Result<()> {
    let shares = bank.get_asset_shares(amt)?;
    bal.change_asset_shares(-shares)?;
    Ok(())
}`,
  },
  {
    name: 'realloc-zero-init/false',
    rule: 'realloc-zero-init',
    tier: 1,
    clean: `pub fn grow(loader: &AccountLoader<Map>, new_space: usize) -> Result<()> {
    loader.as_ref().realloc(new_space, true)?;
    Ok(())
}`,
    mutant: `pub fn grow(loader: &AccountLoader<Map>, new_space: usize) -> Result<()> {
    loader.as_ref().realloc(new_space, false)?;
    Ok(())
}`,
  },
  {
    name: 'prefunded-pda-dos/no-guard',
    rule: 'prefunded-pda-dos',
    tier: 1,
    clean: `pub fn init(ctx: Context<Init>) -> Result<()> {
    if ctx.accounts.pda.data_is_empty() {
        let ix = system_instruction::create_account(payer.key, pda.key, rent, size, id);
        invoke_signed(&ix, &accs, &[seeds])?;
    }
    Ok(())
}`,
    mutant: `pub fn init(ctx: Context<Init>) -> Result<()> {
    let ix = system_instruction::create_account(payer.key, pda.key, rent, size, id);
    invoke_signed(&ix, &accs, &[seeds])?;
    Ok(())
}`,
  },
  {
    name: 'auth-precedence/mixed',
    rule: 'auth-precedence',
    tier: 1,
    clean: `pub fn can(ctx: &Ctx) -> bool {
    if (is_owner(ctx) || is_delegate(ctx)) && plugin.manager() == Authority::UpdateAuthority {
        return true;
    }
    false
}`,
    mutant: `pub fn can(ctx: &Ctx) -> bool {
    if is_owner(ctx) || is_delegate(ctx) && plugin.manager() == Authority::UpdateAuthority {
        return true;
    }
    false
}`,
  },
  {
    name: 'fixed-buffer/index-plus-one',
    rule: 'fixed-buffer-arithmetic',
    tier: 2,
    clean: `pub fn remove(&mut self, index: usize) {
    let len = self.len();
    self.data.copy_within(index + 1..len, index);
}`,
    mutant: `pub fn remove(&mut self, index: usize) {
    let len = self.len();
    for i in index..len {
        self.data[i] = self.data[i + 1];
    }
}`,
  },
  {
    name: 'missing-bounds-gate/fee-bps',
    rule: 'missing-bounds-gate',
    tier: 1,
    clean: `pub fn set_fee(state: &mut State, args: Args) -> Result<()> {
    verify_unsigned_fee_bps_bound(args.fee_bps)?;
    state.lp_withdrawal_fee_bps = args.fee_bps;
    Ok(())
}`,
    mutant: `pub fn set_fee(state: &mut State, args: Args) -> Result<()> {
    state.lp_withdrawal_fee_bps = args.fee_bps;
    Ok(())
}`,
  },
  {
    name: 'incomplete-account-close/no-realloc0',
    rule: 'incomplete-account-close',
    tier: 1,
    clean: `pub fn close_acc(account_to_close: &AccountInfo, dest: &AccountInfo) -> Result<()> {
    **dest.lamports.borrow_mut() += account_to_close.lamports();
    **account_to_close.lamports.borrow_mut() = 0;
    account_to_close.assign(&system_program::id());
    account_to_close.realloc(0, false)?;
    Ok(())
}`,
    mutant: `pub fn close_acc(account_to_close: &AccountInfo, dest: &AccountInfo) -> Result<()> {
    **dest.lamports.borrow_mut() += account_to_close.lamports();
    **account_to_close.lamports.borrow_mut() = 0;
    account_to_close.assign(&system_program::id());
    let mut data = account_to_close.data.borrow_mut();
    sol_memset(*data, 0, data.len());
    Ok(())
}`,
  },
  {
    name: 'one-sided-bound-signed/upper-only',
    rule: 'one-sided-bound-signed',
    tier: 1,
    clean: `pub fn verify_signed_fee_bps_bound(fee_bps_i16: i16) -> Result<()> {
    if !(-MAX_FEE_BPS..=MAX_FEE_BPS).contains(&fee_bps_i16) {
        return Err(FlatFeeError::SignedFeeOutOfBound);
    }
    Ok(())
}`,
    mutant: `pub fn verify_signed_fee_bps_bound(fee_bps_i16: i16) -> Result<()> {
    if MAX_FEE_BPS < fee_bps_i16 {
        return Err(FlatFeeError::SignedFeeOutOfBound);
    }
    Ok(())
}`,
  },
  {
    name: 'lossy-as-cast/u64-as-i64',
    rule: 'lossy-as-cast',
    tier: 1,
    clean: `fn record_outflow(&mut self, amount: u64) -> Option<()> {
    let amount = i64::try_from(amount).ok()?;
    self.cur_window_outflow = self.cur_window_outflow.saturating_add(amount);
    Some(())
}`,
    mutant: `fn record_outflow(&mut self, amount: u64) -> Option<()> {
    self.cur_window_outflow = self.cur_window_outflow.saturating_add(amount as i64);
    Some(())
}`,
  },
  {
    name: 'ix-signer-flag/signer-false',
    rule: 'ix-signer-flag',
    tier: 1,
    clean: `fn build(multisig_signers: &[&Pubkey]) {
    for multisig_signer in multisig_signers.iter() {
        accounts.push(AccountMeta::new(**multisig_signer, true));
    }
}`,
    mutant: `fn build(multisig_signers: &[&Pubkey]) {
    for multisig_signer in multisig_signers.iter() {
        accounts.push(AccountMeta::new(**multisig_signer, false));
    }
}`,
  },
  {
    name: 'wrong-object-auth/owner-only',
    rule: 'wrong-object-auth-check',
    tier: 2,
    clean: `fn create_delegate(ctx: &Ctx, mint_info: &AccountInfo, token_info: &AccountInfo) -> Result<()> {
    assert_holding_amount(ctx.authority_info, mint_info, token_info, 1)?;
    Ok(())
}`,
    mutant: `fn create_delegate(ctx: &Ctx, mint_info: &AccountInfo, token_info: &AccountInfo) -> Result<()> {
    let token = unpack::<Account>(&token_info.try_borrow_data()?)?;
    if token.owner != *ctx.authority_info.key {
        return Err(E::IncorrectOwner.into());
    }
    Ok(())
}`,
  },
];
