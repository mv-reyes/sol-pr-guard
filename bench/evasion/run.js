// Evasion regression gate — the acceptance-audit v0.2 §C.12 probes, permanent.
//
// A public rule set faces a rule-AWARE adversary: a PR author who has read the
// detectors and tries to silence a real Tier-1 finding with a one-line comment,
// an error-message string, a lower-bound-only check, a wrapped assignment, or a
// named-const zero. Each probe below takes a REAL buggy corpus fixture, applies
// ONE minimal attacker edit, and re-scans. The systemic fix (offset-preserving
// comment/string masking, `SourceFile.textStripped` / `RustFn.bodyStripped`,
// used for ALL suppression tests) plus the direction-aware / multiline / const-
// zero rule fixes must keep every true finding alive (and not create the E2c FP).
//
// Every probe here BROKE against the round-3 build; all must HOLD now. Run:
//   npm run evasion
const path = require('path');
const fs = require('fs');
const { runScan } = require('../../dist/src/engine');
const { defaultConfig } = require('../../dist/src/config');

const FX = path.join(__dirname, '..', 'corpus', 'fixtures');
const before = (id) => fs.readFileSync(path.join(FX, id, 'before.rs'), 'utf8');
const meta = (id) => JSON.parse(fs.readFileSync(path.join(FX, id, 'meta.json'), 'utf8'));

async function firedLines(id, rule, text, changed) {
  const m = meta(id);
  const diff = {
    newPath: m.file, oldPath: m.file, status: 'modified',
    changedLines: new Set(changed), removedLines: new Set(), hunks: [], binary: false,
  };
  const res = await runScan(
    { files: [{ diff, headText: text, baseText: null }], context: { source: 'patch' } },
    { config: defaultConfig(), ruleFilter: [rule], includeTests: true }
  );
  return res.findings.filter((f) => f.ruleId === rule).map((f) => f.line);
}

const results = [];
// expect: 'fire' = finding must survive the evasion; 'silent' = must NOT fire (FP probe)
function rec(id, expect, lines) {
  const fired = lines.length > 0;
  const pass = expect === 'fire' ? fired : !fired;
  results.push({ id, expect, fired, pass, lines });
}

(async () => {
  // ---- E1: missing-bounds-gate (sanctum-2c396c275c), buggy setter @ line 23 ----
  const MB = 'sanctum-2c396c275c';
  const mbChanged = [5, 15, 16, 17, 19, 23, 40, 41, 42, 43, 44];
  const s0 = before(MB);
  const ASSIGN_LINE = 'state.lp_withdrawal_fee_bps = lp_withdrawal_fee_bps;';

  rec('E1b comment `// fee <= 10_000 enforced by caller`', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\n// NOTE: lp_withdrawal_fee_bps <= 10_000 is enforced by the caller\n', [23]));

  rec('E1c error-enum string `"fee value out of bounds"`', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\n#[error("fee value out of bounds")] pub enum E { OutOfBounds }\n', [23]));

  rec('E1d lower-bound-only `require!(fee > 5)`', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, 'require!(lp_withdrawal_fee_bps > 5, InvalidFee);\n    ' + ASSIGN_LINE), [23, 24]));

  rec('E1e wrapped multiline assignment', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, 'state.lp_withdrawal_fee_bps =\n        lp_withdrawal_fee_bps;'), [23, 24]));

  // control: a REAL upper bound must still suppress (no false negative regression)
  rec('E1x real upper bound `require!(fee <= 10_000)` (expect silent)', 'silent',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, 'require!(lp_withdrawal_fee_bps <= 10_000, InvalidFee);\n    ' + ASSIGN_LINE), [23, 24]));

  // ---- E2: incomplete-account-close (jito-restaking-pr194) ----
  const IC = 'jito-restaking-pr194';
  const s2 = before(IC);
  const MEMSET = 'sol_memset(*account_data, 0, data_len);';
  rec('E2b comment `// caller does .realloc(0, false)`', 'fire',
    await firedLines(IC, 'incomplete-account-close',
      s2.replace(MEMSET, MEMSET + ' // caller does .realloc(0, false) after'), [111, 112, 113]));

  rec('E2c named-const-zero safe close `realloc(ZERO_LEN, false)` (expect silent)', 'silent',
    await firedLines(IC, 'incomplete-account-close',
      'const ZERO_LEN: usize = 0;\n' + s2.replace(MEMSET, MEMSET + '\n    account_to_close.realloc(ZERO_LEN, false)?;'),
      [111, 112, 113, 114]));

  // ---- E3: realloc-zero-init (gmsol-a2779d14f1) ----
  const RZ = 'gmsol-a2779d14f1';
  const s3 = before(RZ).split('\n');
  const rl = s3.findIndex((l) => /\.realloc\s*\(/.test(l));
  s3.splice(rl + 1, 0, '    // .fill(0) on the grown region happens in helper below');
  rec('E3b comment `// .fill(0) on grown region`', 'fire',
    await firedLines(RZ, 'realloc-zero-init', s3.join('\n'), meta(RZ).buggyChanged.map((x) => (x > rl + 1 ? x + 1 : x))));

  // ---- E4: early-return-skips-cleanup (marinade-c6cdf23ad1) ----
  const ER = 'marinade-c6cdf23ad1';
  const m4 = meta(ER);
  const s4 = before(ER).split('\n');
  s4.splice(m4.buggyChanged[0] - 1, 0, '    // refund happens on all paths via a Drop guard');
  rec('E4b comment with cleanup keyword `// refund ...`', 'fire',
    await firedLines(ER, 'early-return-skips-cleanup', s4.join('\n'), m4.buggyChanged.map((x) => x + 1)));

  // ---- E5: discarded-checked-result (jito-32d72f136c) ----
  const DC = 'jito-32d72f136c';
  const m5 = meta(DC);
  const s5 = before(DC).split('\n');
  s5.splice(m5.buggyChanged[0] - 1, 0, '    // errors are surfaced via msg!("claim failed") upstream');
  rec('E5b comment mentioning `msg!(...)`', 'fire',
    await firedLines(DC, 'discarded-checked-result', s5.join('\n'), m5.buggyChanged.map((x) => x + 1)));

  // ---- E6: one-sided-bound-signed (sanctum-pr192) ----
  const OB = 'sanctum-pr192';
  const s6 = before(OB).replace('if MAX_FEE_BPS < fee_bps_i16 {',
    'if MAX_FEE_BPS < fee_bps_i16 { // fee_bps_i16 >= -MAX_FEE_BPS checked by caller');
  rec('E6b comment `// >= -MAX checked by caller`', 'fire',
    await firedLines(OB, 'one-sided-bound-signed', s6, [6]));

  // ---- Round-3.6: missing-bounds ENFORCEMENT-POSITION probes (§C.12 F/G set) ----
  const mbFire = async (id, edit, changed) =>
    firedLines(MB, 'missing-bounds-gate', s0.replace(ASSIGN_LINE, edit), changed);

  // F1/G4 reject-if that only LOGS (never rejects) must NOT suppress.
  rec('F1 reject-if-without-reject `if fee>C { msg!() }`', 'fire',
    await mbFire(MB, 'if lp_withdrawal_fee_bps > 10_000 { msg!("high fee"); }\n    ' + ASSIGN_LINE, [23, 24]));
  rec('G4 reject-if log-only, braced body', 'fire',
    await mbFire(MB, 'if lp_withdrawal_fee_bps > 10_000 {\n        msg!("fee high");\n    }\n    ' + ASSIGN_LINE, [23, 24, 25, 26]));
  // F2 a comparison computed but never enforced must NOT suppress.
  rec('F2 unenforced bool `let _x = fee <= C`', 'fire',
    await mbFire(MB, 'let _in_range = lp_withdrawal_fee_bps <= 10_000;\n    ' + ASSIGN_LINE, [23, 24]));
  // F3 / F3' an unrelated allowlist .contains(k) / .contains(&k) must NOT suppress.
  rec('F3 allowlist `admins.contains(k)`', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\nfn chk(admins: &[Pubkey], k: &Pubkey) -> bool { admins.contains(k) }\n', [23]));
  rec("F3' allowlist `admins.contains(&k)`", 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\nfn chk(admins: &[Pubkey], k: Pubkey) -> bool { admins.contains(&k) }\n', [23]));
  // F5 masker stress: suppression text inside raw string / nested block comment / escaped string.
  rec('F5a raw-string `r#"fee <= C"#`', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\nconst DOC: &str = r#"lp_withdrawal_fee_bps <= 10_000"#;\n', [23]));
  rec('F5b nested block comment', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\n/* outer /* lp_withdrawal_fee_bps <= 10_000 */ still comment */\n', [23]));
  rec('F5c escaped-quote string', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\nconst D: &str = "fee \\" lp_withdrawal_fee_bps <= 10_000";\n', [23]));

  // Controls: real enforced upper bounds MUST suppress (no over-tightening).
  rec('G1 `if fee>C { return Err }` (expect silent)', 'silent',
    await mbFire(MB, 'if lp_withdrawal_fee_bps > 10_000 { return Err(InvalidFee.into()); }\n    ' + ASSIGN_LINE, [23, 24]));
  rec('G2 `assert!(fee <= C)` (expect silent)', 'silent',
    await mbFire(MB, 'assert!(lp_withdrawal_fee_bps <= 10_000);\n    ' + ASSIGN_LINE, [23, 24]));
  rec('G3 `if fee>=C { panic!() }` (expect silent)', 'silent',
    await mbFire(MB, 'if lp_withdrawal_fee_bps >= 10_001 { panic!("fee too high"); }\n    ' + ASSIGN_LINE, [23, 24]));
  rec('F4 `require!(fee <= C)` (expect silent)', 'silent',
    await mbFire(MB, 'require!(lp_withdrawal_fee_bps <= 10_000, InvalidFee);\n    ' + ASSIGN_LINE, [23, 24]));
  // Real-world control: the comma bound-macro form marinade uses (was a burn-in FP).
  rec('G6 `require_lte!(fee, MAX)` comma-macro (expect silent)', 'silent',
    await mbFire(MB, 'require_lte!(lp_withdrawal_fee_bps, State::MAX_FEE, InvalidFee);\n    ' + ASSIGN_LINE, [23, 24]));

  // ---- Round-3.6: incomplete-account-close const-value probes ----
  rec('F6 forward-declared `const ZERO_LEN=0` safe close (expect silent)', 'silent',
    await firedLines(IC, 'incomplete-account-close',
      s2.replace(MEMSET, MEMSET + '\n    account_to_close.realloc(ZERO_LEN, false)?;') + '\nconst ZERO_LEN: usize = 0;\n',
      [111, 112, 113, 114]));
  rec('F7 nonzero `const LEN64=64` realloc (expect fire)', 'fire',
    await firedLines(IC, 'incomplete-account-close',
      'const LEN64: usize = 64;\n' + s2.replace(MEMSET, MEMSET + '\n    account_to_close.realloc(LEN64, false)?;'),
      [111, 112, 113, 114]));

  // ---- Round-3.7: missing-bounds FN-SCOPED suppression (§C.12 N set) ----
  // N1: a real reject-if in a SIBLING fn (same arg name) must NOT suppress.
  rec('N1 bound-in-other-fn (expect fire)', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\npub fn view_only(lp_withdrawal_fee_bps: u64) -> Result<()> {\n    if lp_withdrawal_fee_bps > 10_000 { return Err(InvalidFee.into()); }\n    Ok(())\n}\n', [23]));
  // N2: `?` on an unrelated call is NOT a rejection — must NOT suppress.
  rec('N2 reject-if body only `self.log()?` (expect fire)', 'fire',
    await mbFire(MB, 'if lp_withdrawal_fee_bps > 10_000 { self.log_fee()?; }\n    ' + ASSIGN_LINE, [23, 24]));
  // N3: a bound inside `#[cfg(test)]` must NOT suppress the production setter.
  rec('N3 cfg(test) bound (expect fire)', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0 + '\n#[cfg(test)]\nmod tests {\n    fn bound() { require!(lp_withdrawal_fee_bps <= 10_000, E); }\n}\n', [23]));
  // N7: bound inside a closure arg — conservative (fires). Locks the BEND.
  rec('N7 closure-bound conservative (expect fire)', 'fire',
    await mbFire(MB, 'with_fee(lp_withdrawal_fee_bps, |f| if f > 10_000 { return Err(InvalidFee.into()); } else { Ok(()) })?;\n    ' + ASSIGN_LINE, [23, 24]));

  // Controls: real in-fn enforced bounds MUST still suppress after fn-scoping.
  rec('N4 multiline require! && chain (expect silent)', 'silent',
    await mbFire(MB, 'require!(\n        lp_withdrawal_fee_bps > 0 && lp_withdrawal_fee_bps <= 10_000,\n        InvalidFee\n    );\n    ' + ASSIGN_LINE, [23, 24, 25, 26, 27]));
  rec('N5 vacuous `<= u64::MAX` (expect fire)', 'fire',
    await mbFire(MB, 'require!(lp_withdrawal_fee_bps <= u64::MAX, InvalidFee);\n    ' + ASSIGN_LINE, [23, 24]));
  rec('N6 require_lte! comma form (expect silent)', 'silent',
    await mbFire(MB, 'require_lte!(lp_withdrawal_fee_bps, 10_000, InvalidFee);\n    ' + ASSIGN_LINE, [23, 24]));

  // ---- Round-3.7b: propagation-aware one-hop scope (§C.12 M set) ----
  // M2: bare `return;` in a CALLEE never gates the caller — must NOT suppress.
  rec('M2 callee bare-return reject (expect fire)', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, 'helper(lp_withdrawal_fee_bps);\n    ' + ASSIGN_LINE) +
      '\nfn helper(lp_withdrawal_fee_bps: u64) { if lp_withdrawal_fee_bps > 10_000 { return; } }\n', [23, 24]));
  // M2b: callee returns Err but the call site does NOT propagate — must NOT suppress.
  rec('M2b callee Err-return, no `?` (expect fire)', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, 'helper(lp_withdrawal_fee_bps);\n    ' + ASSIGN_LINE) +
      '\nfn helper(lp_withdrawal_fee_bps: u64) -> Result<()> { if lp_withdrawal_fee_bps > 10_000 { return Err(E); } Ok(()) }\n', [23, 24]));
  // M4 (control): bound AFTER the assignment in the same fn — Err reverts the tx (expect silent).
  rec('M4 bound-after-assign same-fn (expect silent)', 'silent',
    await mbFire(MB, ASSIGN_LINE + '\n    require!(lp_withdrawal_fee_bps <= 10_000, InvalidFee);', [23, 24]));
  // M6 (control): UFCS path-call to a propagating validator (expect silent).
  rec('M6 path-call validator with `?` (expect silent)', 'silent',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, 'Self::verify_fee(lp_withdrawal_fee_bps)?;\n    ' + ASSIGN_LINE) +
      '\nfn verify_fee(lp_withdrawal_fee_bps: u64) -> Result<()> { if lp_withdrawal_fee_bps > 10_000 { return Err(E); } Ok(()) }\n', [23, 24]));
  // M7: a call mentioned only in a COMMENT must NOT create a call edge (masked).
  rec('M7 call-in-comment (expect fire)', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, '// verify_fee(lp_withdrawal_fee_bps) is called upstream\n    ' + ASSIGN_LINE) +
      '\nfn verify_fee(lp_withdrawal_fee_bps: u64) { if lp_withdrawal_fee_bps > 10_000 { return; } }\n', [23, 24]));
  // M1 (documented limit): TWO-hop validator chains are out of scope — fires (BEND, conservative).
  rec('M1 two-hop validator limit (expect fire, BEND)', 'fire',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, 'verify_a(lp_withdrawal_fee_bps)?;\n    ' + ASSIGN_LINE) +
      '\nfn verify_a(lp_withdrawal_fee_bps: u64) -> Result<()> { verify_b(lp_withdrawal_fee_bps) }\n' +
      '\nfn verify_b(lp_withdrawal_fee_bps: u64) -> Result<()> { if lp_withdrawal_fee_bps > 10_000 { return Err(E); } Ok(()) }\n', [23, 24]));

  // M8: deref-prefixed assignment `(*state).field = rhs` must still be detected.
  rec('M8 deref-assign `(*state).field = rhs` (expect fire)', 'fire',
    await mbFire(MB, '(*state).lp_withdrawal_fee_bps = lp_withdrawal_fee_bps;', [23]));
  // M10 (control): one-line fn with a leading reject-if (expect silent).
  rec('M10 inline reject-if before assign (expect silent)', 'silent',
    await mbFire(MB, 'if lp_withdrawal_fee_bps > 10_000 { return Err(InvalidFee.into()); } ' + ASSIGN_LINE, [23]));
  // M11 (control): require! in a called callee aborts the tx even without `?` (expect silent).
  rec('M11 callee require! aborts, no `?` (expect silent)', 'silent',
    await firedLines(MB, 'missing-bounds-gate',
      s0.replace(ASSIGN_LINE, 'helper(lp_withdrawal_fee_bps);\n    ' + ASSIGN_LINE) +
      '\nfn helper(lp_withdrawal_fee_bps: u64) { require!(lp_withdrawal_fee_bps <= 10_000, E); }\n', [23, 24]));

  let breaks = 0;
  for (const r of results) {
    if (!r.pass) breaks++;
    const tag = r.expect === 'fire' ? (r.fired ? 'HOLDS' : 'BREAK') : (r.fired ? 'BREAK' : 'HOLDS');
    console.log(`${tag}  ${r.id}  [expect ${r.expect}, fired@${JSON.stringify(r.lines)}]`);
  }
  console.log(`\n${results.length - breaks}/${results.length} hold, ${breaks} BREAK`);
  if (breaks > 0) {
    console.log('EVASION GATE FAILED');
    process.exit(1);
  }
  console.log('EVASION GATE PASSED');
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(1); });
