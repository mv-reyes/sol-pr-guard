// Regression tests for red-team findings (REDTEAM-PLAN). Each `evasion` case is
// a real bug an auditor would flag that once slipped past a detector; each
// `fp-trap` is clean code that must stay silent. Every one corresponds to a fix,
// so they must never regress. Inputs are conventionally formatted (one statement
// per line, as rustfmt produces) — the line-oriented detectors assume that.
import { test } from 'node:test';
import * as assert from 'node:assert';
import { runScan, ScanInput } from '../src/engine';
import { parseUnifiedDiff } from '../src/diff';
import { request } from '../src/http';

function all(text: string): ScanInput {
  const n = text.split('\n').length;
  const c = new Set<number>();
  for (let i = 1; i <= n; i++) c.add(i);
  return {
    files: [{ diff: { newPath: 'x.rs', oldPath: 'x.rs', status: 'modified', changedLines: c, removedLines: new Set(), hunks: [], binary: false }, headText: text, baseText: null }],
    context: { source: 'patch' },
  };
}
async function fires(text: string, rule: string): Promise<boolean> {
  const r = await runScan(all(text), { ruleFilter: [rule], includeTests: true });
  return r.findings.some((f) => f.ruleId === rule);
}

// ---- §1 detector-evasion regressions (must FIRE) ----
test('evasion: `let _ = x.checked_add(y);` is still a discarded result', async () => {
  assert.ok(await fires(`pub fn f(s: &mut S, a: u64) -> Result<()> {
    let _ = s.total.checked_add(a);
    Ok(())
}`, 'discarded-checked-result'));
});
test('evasion: `let _unused = ...checked_add().unwrap();` is discarded', async () => {
  assert.ok(await fires(`pub fn f(s: &mut S, a: u64) -> Result<()> {
    let _unused = s.total.checked_add(a).unwrap();
    Ok(())
}`, 'discarded-checked-result'));
});
test('evasion: `.ok()`-dropped checked result', async () => {
  assert.ok(await fires(`pub fn f(s: &mut S, a: u64) -> Result<()> {
    s.total.checked_add(a).ok();
    Ok(())
}`, 'discarded-checked-result'));
});
test('evasion: block-commented account attribute', async () => {
  assert.ok(await fires(`#[derive(Accounts)]
pub struct S<'info> {
    /* #[account(address = RULES_ID)] */
    pub rules: UncheckedAccount<'info>,
}`, 'disabled-constraint'));
});
test('evasion: remaining_accounts reaches a payout builder via an intermediate var', async () => {
  assert.ok(await fires(`fn f(ctx: Context<C>) -> Result<()> {
    let ra = ctx.remaining_accounts;
    let m = unpack_market(&ra[0])?;
    builder.final_output_market(&m);
    Ok(())
}`, 'disabled-constraint'));
});
test('evasion: prefunded PDA via anchor system_program::create_account CpiContext form', async () => {
  assert.ok(await fires(`fn f(ctx: Context<C>) -> Result<()> {
    system_program::create_account(
        CpiContext::new_with_signer(sys, CreateAccount { from, to: pda }, &[seeds]),
        rent, size, owner,
    )?;
    Ok(())
}`, 'prefunded-pda-dos'));
});
test('evasion: auth precedence with helper-named operands', async () => {
  assert.ok(await fires(`fn can(c: &C) -> bool {
    if c.is_admin() || c.is_manager() && c.owner_matches() {
        return true;
    }
    false
}`, 'auth-precedence'));
});

// ---- §2 false-positive regressions (must STAY SILENT) ----
test('fp: realloc(false) then helper zeroing the grown region is safe', async () => {
  assert.ok(!(await fires(`fn f(l: &AccountLoader<M>, n: usize) -> Result<()> {
    l.as_ref().realloc(n, false)?;
    zero_grown_region(l, n)?;
    Ok(())
}`, 'realloc-zero-init')));
});
test('fp: twin fee accounts with identical self-referential constraints', async () => {
  assert.ok(!(await fires(`#[derive(Accounts)]
pub struct S<'info> {
    #[account(constraint = fee_a.mint == expected_mint @ E::X)]
    pub fee_a: Account<'info, TokenAccount>,
    #[account(constraint = fee_b.mint == expected_mint @ E::X)]
    pub fee_b: Account<'info, TokenAccount>,
}`, 'copy-paste-constraint')));
});
test('fp: numeric branch that logs and continues is not an auth bypass', async () => {
  assert.ok(!(await fires(`fn f(delta: i64) -> Result<()> {
    if delta < 0 {
        msg!("delta negative, skipping this cycle");
    }
    Ok(())
}`, 'discarded-checked-result')));
});
test('fp: deposit-direction zero-share (rounds against user) stays silent', async () => {
  assert.ok(!(await fires(`fn deposit(b: &mut Bank, bal: &mut Bal, a: I80F48) -> Result<()> {
    let shares = b.get_asset_shares(a)?;
    bal.change_asset_shares(shares)?;
    Ok(())
}`, 'zero-share-conversion')));
});

// ---- §3 parser stress (must not crash) ----
test('stress: unbalanced-brace file does not crash', async () => {
  const r = await runScan(all('pub fn f( { { { ]]] realloc(x, false) broken'), { includeTests: true });
  assert.ok(Array.isArray(r.findings));
});
test('stress: >4MB file is skipped with a notice (no OOM)', async () => {
  const big = 'pub fn f() { let x = 1; }\n'.repeat(200000);
  const r = await runScan(all(big), { includeTests: true });
  assert.ok(r.notices.some((n) => /not analyzed/.test(n.message)));
});

// ---- §4 diff edges ----
test('diff: lying huge hunk header does not over-allocate', () => {
  const p = 'diff --git a/h.rs b/h.rs\n--- a/h.rs\n+++ b/h.rs\n@@ -1,999999999 +1,999999999 @@\n+a\n+b\n c';
  const f = parseUnifiedDiff(p).get('h.rs')!;
  assert.strictEqual(f.changedLines.size, 2);
});
test('diff: filename with spaces is parsed', () => {
  const p = 'diff --git a/my dir/my file.rs b/my dir/my file.rs\n--- a/my dir/my file.rs\n+++ b/my dir/my file.rs\n@@ -1,1 +1,1 @@\n-a\n+b';
  assert.ok(parseUnifiedDiff(p).has('my dir/my file.rs'));
});

// ---- §6 self-security (request() throws synchronously; wrap so rejects() sees it) ----
test('security: non-GitHub host is refused', async () => {
  await assert.rejects(async () => request('https://evil.example.com/steal'), /GitHub/);
});
test('security: lookalike host (raw.githubusercontent.com.evil.com) is refused', async () => {
  await assert.rejects(async () => request('https://raw.githubusercontent.com.evil.com/x'), /GitHub/);
});
