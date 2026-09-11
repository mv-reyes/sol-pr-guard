// Acceptance-audit regressions (Kimi audit, 2026-09-10). Root cause: a field's
// preceding #[account(...)] attributes and /// CHECK: comments were NOT part of
// the field's scope span, so a PR that edited ONLY the attribute/comment line
// put nothing in scope and three detectors went silent. The corpus replay masked
// it because buggyChanged used whole-hunk envelopes instead of exact edited
// lines. These tests pin the exact edited-line-only scenarios.
import { test } from 'node:test';
import * as assert from 'node:assert';
import { runScan, ScanInput } from '../src/engine';

function diffInput(text: string, changed: number[]): ScanInput {
  return {
    files: [
      {
        diff: {
          newPath: 'x.rs',
          oldPath: 'x.rs',
          status: 'modified',
          changedLines: new Set(changed),
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

const SHIFT = `use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CreateShift<'info> {
    pub from_market: AccountLoader<'info, Market>,
    #[account(constraint = from_market.load()?.meta().market_token_mint == from_market_token.key() @ CoreError::MarketTokenMintMismatched)]
    pub from_market_token: Box<Account<'info, Mint>>,
    #[account(constraint = from_market.load()?.meta().market_token_mint == from_market_token.key() @ CoreError::MarketTokenMintMismatched)]
    pub to_market_token: Box<Account<'info, Mint>>,
    pub to_market: AccountLoader<'info, Market>,
}
`;

test('audit: single-line constraint edit fires copy-paste-constraint (only line 8 changed)', async () => {
  const r = await runScan(diffInput(SHIFT, [8]), { ruleFilter: ['copy-paste-constraint'] });
  const f = r.findings.find((f) => f.ruleId === 'copy-paste-constraint');
  assert.ok(f, 'must fire when ONLY the constraint attribute line was edited');
  assert.strictEqual(f!.line, 8);
});

const CHECK_DOC = `use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Buy<'info> {
    pub payer: Signer<'info>,
    /// CHECK: none, can be anything
    pub rules: UncheckedAccount<'info>,
}
`;

test('audit: single-line /// CHECK comment addition fires disabled-constraint (only line 6 changed)', async () => {
  const r = await runScan(diffInput(CHECK_DOC, [6]), { ruleFilter: ['disabled-constraint'] });
  assert.ok(
    r.findings.some((f) => f.ruleId === 'disabled-constraint'),
    'must fire when ONLY the weak /// CHECK comment line was added'
  );
});

const DOUBLE_CLOSE = `use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub payer: Signer<'info>,
    #[account(mut, close = payer)]
    pub insurance_vault: Account<'info, TokenAccount>,
}

pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
    close_account(ctx.accounts.insurance_vault.to_account_info())?;
    Ok(())
}
`;

test('audit: close= added to an existing attribute fires realloc-zero-init (only line 6 changed)', async () => {
  const r = await runScan(diffInput(DOUBLE_CLOSE, [6]), { ruleFilter: ['realloc-zero-init'] });
  assert.ok(
    r.findings.some((f) => f.ruleId === 'realloc-zero-init'),
    'must fire when ONLY the attribute line gained close='
  );
});
