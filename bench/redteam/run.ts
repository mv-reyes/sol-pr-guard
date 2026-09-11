// Reproducible red-team harness (REDTEAM-PLAN §1-§7). Runs crafted adversarial
// inputs through the engine and reports BREAK/BEND/HOLDS. Offline. Exit non-zero
// on any BREAK. The findings here are also locked as unit regressions in
// test/redteam.test.ts.
import { runScan, ScanInput } from '../../src/engine';
import { parseUnifiedDiff } from '../../src/diff';
import { request } from '../../src/http';

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

interface Case { id: string; rule: string; expect: 'fire' | 'silent'; kind: 'evasion' | 'fp-trap'; code: string; }
const CASES: Case[] = [
  { id: 'E1 let _ = checked', rule: 'discarded-checked-result', expect: 'fire', kind: 'evasion', code: `fn f(s: &mut S, a: u64) -> Result<()> {\n    let _ = s.total.checked_add(a);\n    Ok(())\n}` },
  { id: 'E2 let _unused =', rule: 'discarded-checked-result', expect: 'fire', kind: 'evasion', code: `fn f(s: &mut S, a: u64) -> Result<()> {\n    let _unused = s.total.checked_add(a).unwrap();\n    Ok(())\n}` },
  { id: 'E3 .ok() drop', rule: 'discarded-checked-result', expect: 'fire', kind: 'evasion', code: `fn f(s: &mut S, a: u64) -> Result<()> {\n    s.total.checked_add(a).ok();\n    Ok(())\n}` },
  { id: 'E4 copy-paste whitespace noise', rule: 'copy-paste-constraint', expect: 'fire', kind: 'evasion', code: `#[derive(Accounts)]\npub struct S<'info> {\n    #[account(constraint = from_pool.load()?.mint == from_token.key() @ E::X)]\n    pub from_token: Account<'info, Mint>,\n    #[account(constraint = from_pool.load()?.mint  ==  from_token.key()  @ E::X)]\n    pub to_token: Account<'info, Mint>,\n}` },
  { id: 'E5 block-comment attr', rule: 'disabled-constraint', expect: 'fire', kind: 'evasion', code: `#[derive(Accounts)]\npub struct S<'info> {\n    /* #[account(address = RULES_ID)] */\n    pub rules: UncheckedAccount<'info>,\n}` },
  { id: 'E6 remaining_accounts indirection', rule: 'disabled-constraint', expect: 'fire', kind: 'evasion', code: `fn f(ctx: Context<C>) -> Result<()> {\n    let ra = ctx.remaining_accounts;\n    let m = unpack_market(&ra[0])?;\n    builder.final_output_market(&m);\n    Ok(())\n}` },
  { id: 'E7 prefunded CpiContext', rule: 'prefunded-pda-dos', expect: 'fire', kind: 'evasion', code: `fn f(ctx: Context<C>) -> Result<()> {\n    system_program::create_account(\n        CpiContext::new_with_signer(sys, CreateAccount { from, to: pda }, &[seeds]),\n        rent, size, owner,\n    )?;\n    Ok(())\n}` },
  { id: 'E8 realloc helper-zero (safe)', rule: 'realloc-zero-init', expect: 'silent', kind: 'fp-trap', code: `fn f(l: &AccountLoader<M>, n: usize) -> Result<()> {\n    l.as_ref().realloc(n, false)?;\n    zero_grown_region(l, n)?;\n    Ok(())\n}` },
  { id: 'E9 auth helper operands', rule: 'auth-precedence', expect: 'fire', kind: 'evasion', code: `fn can(c: &C) -> bool {\n    if c.is_admin() || c.is_manager() && c.owner_matches() {\n        return true;\n    }\n    false\n}` },
  { id: 'F1 checked used', rule: 'discarded-checked-result', expect: 'silent', kind: 'fp-trap', code: `fn f(s: &mut S, a: u64) -> Result<()> {\n    let t = s.total.checked_add(a).ok_or(E::O)?;\n    s.total = t;\n    Ok(())\n}` },
  { id: 'F2 twin fee accounts', rule: 'copy-paste-constraint', expect: 'silent', kind: 'fp-trap', code: `#[derive(Accounts)]\npub struct S<'info> {\n    #[account(constraint = fee_a.mint == expected_mint @ E::X)]\n    pub fee_a: Account<'info, TokenAccount>,\n    #[account(constraint = fee_b.mint == expected_mint @ E::X)]\n    pub fee_b: Account<'info, TokenAccount>,\n}` },
  { id: 'F3 CHECK justified', rule: 'disabled-constraint', expect: 'silent', kind: 'fp-trap', code: `#[derive(Accounts)]\npub struct S<'info> {\n    /// CHECK: validated via seeds + address constraint in the handler\n    pub thing: UncheckedAccount<'info>,\n}` },
  { id: 'F4 remaining_accounts iter', rule: 'disabled-constraint', expect: 'silent', kind: 'fp-trap', code: `fn f(ctx: Context<C>) -> Result<()> {\n    for a in ctx.remaining_accounts.iter() {\n        validate(a)?;\n    }\n    Ok(())\n}` },
  { id: 'F5 deposit zero-share', rule: 'zero-share-conversion', expect: 'silent', kind: 'fp-trap', code: `fn deposit(b: &mut Bank, bal: &mut Bal, a: I80F48) -> Result<()> {\n    let shares = b.get_asset_shares(a)?;\n    bal.change_asset_shares(shares)?;\n    Ok(())\n}` },
  { id: 'F6 realloc true', rule: 'realloc-zero-init', expect: 'silent', kind: 'fp-trap', code: `fn f(l: &AccountLoader<M>, n: usize) -> Result<()> {\n    l.as_ref().realloc(n, true)?;\n    Ok(())\n}` },
  { id: 'F7 anchor init', rule: 'prefunded-pda-dos', expect: 'silent', kind: 'fp-trap', code: `#[derive(Accounts)]\npub struct S<'info> {\n    #[account(init, payer = payer, space = 40)]\n    pub pda: Account<'info, Data>,\n}` },
  { id: 'F8 parenthesized auth', rule: 'auth-precedence', expect: 'silent', kind: 'fp-trap', code: `fn can(c: &C) -> bool {\n    if (c.is_admin() || c.is_manager()) && c.owner_matches() {\n        return true;\n    }\n    false\n}` },
  { id: 'F9 numeric log-continue', rule: 'discarded-checked-result', expect: 'silent', kind: 'fp-trap', code: `fn f(delta: i64) -> Result<()> {\n    if delta < 0 {\n        msg!("delta negative, skipping");\n    }\n    Ok(())\n}` },
  { id: 'F10 correct loop bound', rule: 'fixed-buffer-arithmetic', expect: 'silent', kind: 'fp-trap', code: `fn shift(&mut self, index: usize) {\n    let len = self.len();\n    for i in index..(len - 1) {\n        self.data[i] = self.data[i + 1];\n    }\n}` },
];

async function main() {
  let breaks = 0, holds = 0;
  console.log('== §1/§2 detector evasion & false-positive traps ==');
  for (const c of CASES) {
    const hit = await fires(c.code, c.rule);
    const ok = hit === (c.expect === 'fire');
    if (ok) holds++; else breaks++;
    console.log(`${ok ? 'HOLDS' : 'BREAK'}  [${c.kind}] ${c.id}`);
  }

  console.log('\n== §3/§4/§6/§7 parser / diff / security / perf ==');
  const checks: Array<[string, () => Promise<boolean> | boolean]> = [
    ['P2 broken file no crash', async () => Array.isArray((await runScan(all('fn f( { { ]]] broken'), { includeTests: true })).findings)],
    ['P4 >4MB skipped w/ notice', async () => (await runScan(all('pub fn f() { let x = 1; }\n'.repeat(200000)), { includeTests: true })).notices.some((n) => /not analyzed/.test(n.message))],
    ['P4b 20k-line file, all lines changed, < 5s', async () => { const t = Date.now(); await runScan(all('let x = 1;\n'.repeat(20000)), { includeTests: true }); return Date.now() - t < 5000; }],
    ['D3 lying hunk header bounded', () => parseUnifiedDiff('diff --git a/h.rs b/h.rs\n--- a/h.rs\n+++ b/h.rs\n@@ -1,999999999 +1,999999999 @@\n+a\n+b\n c').get('h.rs')!.changedLines.size === 2],
    ['D4 filename with spaces', () => parseUnifiedDiff('diff --git a/my f.rs b/my f.rs\n--- a/my f.rs\n+++ b/my f.rs\n@@ -1,1 +1,1 @@\n-a\n+b').has('my f.rs')],
    ['S1 path traversal skipped', async () => { const r = await runScan({ files: [{ diff: { newPath: '../../etc/e.rs', oldPath: '../../etc/e.rs', status: 'modified', changedLines: new Set([1]), removedLines: new Set(), hunks: [], binary: false }, headText: 'x', baseText: null }], context: { source: 'patch' } }, {}); return r.notices.some((n) => /unsafe path/.test(n.message)); }],
    ['S5 non-github host refused', async () => { try { await request('https://evil.example.com/x'); return false; } catch { return true; } }],
    ['P7 5000-line file < 3s', async () => { let s = ''; for (let i = 0; i < 5000; i++) s += `let v${i}=${i};\n`; const t = Date.now(); await runScan(all(s), { includeTests: true }); return Date.now() - t < 3000; }],
  ];
  for (const [id, fn] of checks) {
    const ok = await fn();
    if (ok) holds++; else breaks++;
    console.log(`${ok ? 'HOLDS' : 'BREAK'}  ${id}`);
  }

  console.log(`\n${holds} HOLDS, ${breaks} BREAK`);
  if (breaks) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
