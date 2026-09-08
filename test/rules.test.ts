import { test } from 'node:test';
import * as assert from 'node:assert';
import { runScan, ScanInput } from '../src/engine';
import { MUTANTS } from '../bench/mutation/mutants';

function allChanged(text: string): ScanInput {
  const n = text.split('\n').length;
  const changed = new Set<number>();
  for (let i = 1; i <= n; i++) changed.add(i);
  return {
    files: [
      {
        diff: {
          newPath: 'x.rs',
          oldPath: 'x.rs',
          status: 'modified',
          changedLines: changed,
          removedLines: new Set(),
          hunks: [],
          binary: false,
        },
        headText: text,
        baseText: null,
      },
    ],
    context: { source: 'patch' },
  };
}

async function fires(text: string, rule: string): Promise<boolean> {
  const r = await runScan(allChanged(text), { ruleFilter: [rule], includeTests: true });
  return r.findings.some((f) => f.ruleId === rule);
}

for (const m of MUTANTS) {
  test(`rule ${m.rule}: fires on mutant [${m.name}]`, async () => {
    assert.ok(await fires(m.mutant, m.rule), 'expected finding on mutant');
  });
  test(`rule ${m.rule}: silent on clean [${m.name}]`, async () => {
    assert.ok(!(await fires(m.clean, m.rule)), 'expected NO finding on clean');
  });
}

// Red-team false-positive traps: these MUST stay silent.
test('FP trap: realloc(false) followed by explicit zeroing is safe', async () => {
  const txt = `pub fn grow(l: &AccountLoader<M>, n: usize) -> Result<()> {
    l.as_ref().realloc(n, false)?;
    let mut data = l.as_ref().try_borrow_mut_data()?;
    data[old_len..].fill(0);
    Ok(())
}`;
  assert.ok(!(await fires(txt, 'realloc-zero-init')));
});

test('FP trap: checked_add assigned and used is fine', async () => {
  const txt = `pub fn f(s: &mut S, a: u64) -> Result<()> {
    s.total = s.total.checked_add(a).unwrap();
    Ok(())
}`;
  assert.ok(!(await fires(txt, 'discarded-checked-result')));
});

test('FP trap: remaining_accounts plain iteration (no payout) is fine', async () => {
  const txt = `fn f(ctx: Context<C>) -> Result<()> {
    for acc in ctx.remaining_accounts.iter() {
        do_something(acc)?;
    }
    Ok(())
}`;
  assert.ok(!(await fires(txt, 'disabled-constraint')));
});

test('FP trap: create_account with data_is_empty guard is fine', async () => {
  const txt = `fn f(ctx: Context<C>) -> Result<()> {
    if ctx.accounts.pda.data_is_empty() {
        let ix = system_instruction::create_account(a, b, c, d, e);
        invoke_signed(&ix, &x, &[s])?;
    }
    Ok(())
}`;
  assert.ok(!(await fires(txt, 'prefunded-pda-dos')));
});

test('FP trap: parenthesized auth condition is fine', async () => {
  const txt = `fn can(c: &C) -> bool {
    if (is_owner(c) || is_delegate(c)) && plugin.manager() == Authority::UpdateAuthority { return true; }
    false
}`;
  assert.ok(!(await fires(txt, 'auth-precedence')));
});

test('FP regression: balance_index as u8 is an index, not a value (marginfi #615)', async () => {
  const txt = `pub fn collect(balance_index: usize) -> Result<()> {
    let idx = balance_index as u8;
    Ok(())
}`;
  assert.ok(!(await fires(txt, 'lossy-as-cast')));
});

test('lossy-as-cast still fires on a value cast', async () => {
  const txt = `pub fn record(outflow_amount: u64) -> Result<()> {
    let delta = outflow_amount as i64;
    Ok(())
}`;
  assert.ok(await fires(txt, 'lossy-as-cast'));
});

// ---- subtype-blind-solvency (drift #1757 / fix #2123) ----
test('subtype-blind-solvency fires on an unfiltered bankruptcy loop', async () => {
  const txt = `pub fn is_cross_margin_bankrupt(user: &User) -> bool {
    let mut has_liability = false;
    for perp_position in user.perp_positions.iter() {
        if perp_position.base_asset_amount != 0
            || perp_position.quote_asset_amount > 0
        {
            return false;
        }
        if perp_position.quote_asset_amount < 0 {
            has_liability = true;
        }
    }
    has_liability
}

pub fn is_isolated_margin_bankrupt(user: &User, market_index: u16) -> DriftResult<bool> {
    let perp_position = user.get_isolated_perp_position(market_index)?;
    if perp_position.isolated_position_scaled_balance > 0 {
        return Ok(false);
    }
    Ok(perp_position.base_asset_amount == 0)
}`;
  assert.ok(await fires(txt, 'subtype-blind-solvency'));
});

test('subtype-blind-solvency silent when the loop filters by subtype', async () => {
  const txt = `pub fn is_cross_margin_bankrupt(user: &User) -> bool {
    let mut has_liability = false;
    for perp_position in user.perp_positions.iter() {
        if perp_position.is_isolated() {
            continue;
        }
        if perp_position.quote_asset_amount < 0 {
            has_liability = true;
        }
    }
    has_liability
}`;
  assert.ok(!(await fires(txt, 'subtype-blind-solvency')));
});

test('subtype-blind-solvency silent when no subtype flag exists in the file', async () => {
  const txt = `pub fn is_bankrupt(user: &User) -> bool {
    let mut has_liability = false;
    for position in user.positions.iter() {
        if position.amount < 0 {
            has_liability = true;
        }
    }
    has_liability
}`;
  assert.ok(!(await fires(txt, 'subtype-blind-solvency')));
});

// ---- early-return-skips-cleanup extension (drift #1757 / fix #2122) ----
test('early-return-skips-cleanup: ?-abort upstream of a state-machine exit', async () => {
  const txt = `pub fn liquidate_perp(user: &mut User, market_index: u16) -> DriftResult {
    let liquidation_mode = get_perp_liquidation_mode(&user, market_index)?;
    let user_is_being_liquidated = liquidation_mode.user_is_being_liquidated(&user)?;
    if user_is_being_liquidated && liquidation_mode.can_exit_liquidation(&margin)? {
        liquidation_mode.exit_liquidation(user)?;
        return Ok(());
    }
    Ok(())
}`;
  assert.ok(await fires(txt, 'early-return-skips-cleanup'));
});

test('early-return-skips-cleanup: mode-dispatch helper propagating ? on a lookup', async () => {
  const txt = `pub fn get_perp_liquidation_mode(
    user: &User,
    market_index: u16,
) -> DriftResult<Box<dyn LiquidatePerpMode>> {
    let perp_position = user.get_perp_position(market_index)?;
    let mode: Box<dyn LiquidatePerpMode> = if perp_position.is_isolated() {
        Box::new(IsolatedMarginLiquidatePerpMode::new(market_index))
    } else {
        Box::new(CrossMarginLiquidatePerpMode::new(market_index))
    };
    Ok(mode)
}`;
  assert.ok(await fires(txt, 'early-return-skips-cleanup'));
});

test('early-return-skips-cleanup: Err-arm fallback (the #2122 fix) is silent', async () => {
  const txt = `pub fn get_perp_liquidation_mode(
    user: &User,
    market_index: u16,
) -> DriftResult<Box<dyn LiquidatePerpMode>> {
    let perp_position = match user.get_perp_position(market_index) {
        Ok(pos) => pos,
        Err(_) => return Ok(Box::new(CrossMarginLiquidatePerpMode::new(market_index))),
    };
    let mode: Box<dyn LiquidatePerpMode> = if perp_position.is_isolated() {
        Box::new(IsolatedMarginLiquidatePerpMode::new(market_index))
    } else {
        Box::new(CrossMarginLiquidatePerpMode::new(market_index))
    };
    Ok(mode)
}`;
  assert.ok(!(await fires(txt, 'early-return-skips-cleanup')));
});

// ---- closed-enum-deserialize (jito #136 / fix #153) ----
test('closed-enum-deserialize fires on a full *Versions deserialize of a raw account', async () => {
  const txt = `impl VoteState {
    pub fn deserialize(account_info: &AccountInfo) -> Result<Box<Self>> {
        if account_info.owner != &solana_program::vote::program::id() {
            return Err(ConstraintOwner.into());
        }
        let data = account_info.data.borrow();
        deserialize::<Box<VoteStateVersions>>(&data)
            .map(|v| v.convert_to_current())
            .map_err(|_| AccountDidNotDeserialize.into())
    }
}`;
  assert.ok(await fires(txt, 'closed-enum-deserialize'));
});

test('closed-enum-deserialize silent on an offset-prefixed partial parse', async () => {
  const txt = `impl VoteState {
    pub fn deserialize_node_pubkey(account_info: &AccountInfo) -> Result<Pubkey> {
        if Pubkey::from(account_info.owner.to_bytes()) != Pubkey::from(vote::id().to_bytes()) {
            return Err(ConstraintOwner.into());
        }
        let data = account_info.data.borrow();
        deserialize::<Pubkey>(&data[4..36]).map_err(|_| AccountDidNotDeserialize.into())
    }
}`;
  assert.ok(!(await fires(txt, 'closed-enum-deserialize')));
});

// ---- unused-state-gate (klend #60) ----
test('unused-state-gate fires when no mutating sibling invokes the guard', async () => {
  const txt = `impl Obligation {
    pub fn repay(&mut self, settle_amount: Fraction, liquidity_index: usize) {
        let liquidity = &mut self.borrows[liquidity_index];
        if settle_amount == liquidity.borrowed_amount() {
            self.borrows[liquidity_index] = ObligationLiquidity::default();
        }
    }

    pub fn withdraw(&mut self, withdraw_amount: u64, collateral_index: usize) -> Result<WithdrawResult> {
        let collateral = &mut self.deposits[collateral_index];
        self.deposits[collateral_index] = ObligationCollateral::default();
        Ok(WithdrawResult::Full)
    }

    pub fn check_ownership_transfer_not_in_progress(&self) -> Result<()> {
        if self.is_ownership_transfer_in_progress() {
            return err!(LendingError::ObligationOwnershipTransferInProgress);
        }
        Ok(())
    }

    pub fn initiate_ownership_transfer(&mut self, pending_owner: Pubkey) -> Result<()> {
        self.ownership_transfer_state = OwnershipTransferState::Initiated.into();
        self.pending_owner = pending_owner;
        Ok(())
    }
}`;
  assert.ok(await fires(txt, 'unused-state-gate'));
});

test('unused-state-gate silent when a mutating sibling invokes the guard', async () => {
  const txt = `impl Obligation {
    pub fn repay(&mut self, settle_amount: Fraction, liquidity_index: usize) {
        self.check_ownership_transfer_not_in_progress()?;
        let liquidity = &mut self.borrows[liquidity_index];
        if settle_amount == liquidity.borrowed_amount() {
            self.borrows[liquidity_index] = ObligationLiquidity::default();
        }
    }

    pub fn check_ownership_transfer_not_in_progress(&self) -> Result<()> {
        if self.is_ownership_transfer_in_progress() {
            return err!(LendingError::ObligationOwnershipTransferInProgress);
        }
        Ok(())
    }
}`;
  assert.ok(!(await fires(txt, 'unused-state-gate')));
});

// ---- checked-sub-ordering (gmsol #439) ----
test('checked-sub-ordering fires on the gmsol #439 shape', async () => {
  const txt = `fn status_with_options(&self) -> crate::Result<PositionStatus> {
    let fixed = if collateral_tracks_index {
        remaining_collateral_usd
            .checked_add(pending_funding_fee_value)?
            .checked_sub(collateral_value)?
    } else {
        remaining_collateral_usd
    };
    Ok(fixed)
}`;
  assert.ok(await fires(txt, 'checked-sub-ordering'));
});

test('checked-sub-ordering silent on plain checked_sub of two value terms', async () => {
  const txt = `fn f() -> Option<u128> {
    collateral_value
        .checked_add(pending_pnl_value)?
        .checked_sub(close_order_fee_value)?
}`;
  assert.ok(!(await fires(txt, 'checked-sub-ordering')));
});

test('checked-sub-ordering silent on residual minus residual', async () => {
  const txt = `fn f() -> Option<u128> {
    remaining_collateral_usd
        .checked_add(pending_funding_fee_value)?
        .checked_sub(remaining_fee_usd)?
}`;
  assert.ok(!(await fires(txt, 'checked-sub-ordering')));
});

test('checked-sub-ordering silent without ? propagation', async () => {
  const txt = `fn f() -> Option<u128> {
    let fixed = remaining_collateral_usd
        .checked_add(pending_funding_fee_value)
        .and_then(|r| r.checked_sub(collateral_value));
    fixed
}`;
  assert.ok(!(await fires(txt, 'checked-sub-ordering')));
});
