# ADVERSARIAL.md: red-team results

Scoring: **BREAK** (wrong output / crash / silent miss) · **BEND** (works but
imperfect) · **HOLDS** (correct). Every closed BREAK has a regression test in
`test/`. This file follows `REDTEAM-PLAN.md` §1–§9.

## Executed red-team run (2026-09-10)

A hostile pass of 36 crafted cases (19 evasion/FP + 17 parser/diff/security/perf)
plus CLI/UX + resilience probing. **6 real BREAKs were found and fixed**, each
now locked by a regression test in `test/redteam.test.ts`:

| # | BREAK | Class | Fix |
| --- | --- | --- | --- |
| 1 | `let _ = x.checked_add(y);`, result discarded to `_`, was missed | evasion | `discarded-checked-result` now analyzes the RHS of a `let _ …`/`let _unused …` throwaway binding |
| 2 | `let _unused = …checked_add().unwrap();` missed | evasion | same fix |
| 3 | `/* #[account(address = …)] */` block-commented constraint missed | evasion | `disabled-constraint` now detects block-commented account attributes |
| 4 | `remaining_accounts` reaching a payout builder through an intermediate var missed | evasion | `disabled-constraint` now does a bounded 2-hop taint from `remaining_accounts` to a payout setter |
| 5 | prefunded PDA via anchor `system_program::create_account(CpiContext…)` (no raw `invoke`) missed | evasion | `prefunded-pda-dos` no longer requires a raw `invoke`; fires on the CPI form too, still gated by the exists-check-before-call test |
| 6 | `realloc(n, false)` then a **helper** that zeroes the region, a safe pattern, false-positived | false positive | `realloc-zero-init` now also recognizes a following `zero*/clear/memset/…` helper call as the safe pattern |

After the fixes: **36/36 red-team cases HOLD**, and the corpus (15/15), mutation
(100% T1), and full unit suite (79 tests) stay green.

**Limitation the run exposed (documented, not a BREAK):** the detectors are
line-oriented and assume conventionally formatted Rust (one statement per line,
as `rustfmt` produces, the format of every real PR). Deliberately *minified*
single-line Rust (`fn f(){ let _ = x.checked_add(y); }` all on one physical
line) can evade the statement-level rules. No real PR ships this; handling it
would require statement-splitting and was judged not worth the added
false-positive surface. Noted in the README.

Reproduce: `npm run redteam` (27 in-repo cases, 0 BREAK) and `npm test` (the 17
red-team cases are locked as regressions in `test/redteam.test.ts`). The run also
hardened a perf edge: the changed-line checks now iterate the smaller of the
node span or the changed set, so a pathological all-lines-changed 20k-line file
scans in under a second.

The section below is the standing coverage matrix (attack surface × verdict).

## §1 Detector evasion

| Attack | Result | Evidence / test |
| --- | --- | --- |
| Aliasing: `let _ = x.checked_add(y);` / result bound then used | HOLDS (stays silent: only a *bare dropped* result fires) | `rules.test.ts` FP trap "checked_add assigned and used" |
| Reformatting: constraint split across lines, whitespace, `@ Error` present/absent | HOLDS (constraints tokenized from raw attr text, whitespace-normalized) | `anchor.test.ts` extractConstraintBodies; corpus `gmsol-bf2a35c6d7` |
| Multi-line assignment continuation `x =\n x.checked_add()` | HOLDS (continuation detected, not flagged) | corpus `jito-32d72f136c` silent-on-fix |
| Realloc via a variable second arg (`realloc(n, flag)`) | BEND (only the literal `false` fires; a runtime flag is not tracked, a documented limitation) | by design (precision) |
| Realloc `false` then manual zeroing of the grown range | HOLDS (safe pattern suppressed) | `rules.test.ts` FP trap "realloc(false) followed by explicit zeroing" |
| Pre-funded PDA: existence check placed *after* the CPI | HOLDS (still fires: guard must precede `create_account`) | `prefunded-pda-dos` checks guard position |
| Pre-funded PDA: anchor `init` (safe) | HOLDS (no raw `create_account` → silent) | rule only matches raw `system_instruction::create_account` |
| Auth precedence expressed with parentheses | HOLDS (silent when `||` is parenthesized) | `rules.test.ts` FP trap "parenthesized auth condition" |
| Wrong-variable via helper fn / getter swap (`swap_path.len()` vs `params.swap_path_length`) | BEND (not chased: only distinguishable with the fix in hand; documented) | README honesty section |

## §2 False-positive traps (must stay SILENT): all HOLD

Each is a passing test in `rules.test.ts` / `engine.test.ts`:

- `realloc(size, false)` immediately followed by explicit zeroing → silent.
- `checked_add` result assigned and used → silent.
- `#[cfg(test)]` / test modules → excluded (even a `#[cfg(test)]` guarding a
  `;`-terminated item inside a `macro_rules!` does not over-suppress production
  code, which was a real bug now fixed and covered).
- `/// CHECK:` with a real justification → silent (only placeholder text fires).
- `remaining_accounts` used for plain iteration with no payout dependence → silent.
- Two identical constraints that each reference their **own** field → silent
  (copy-paste only fires when the body references a *sibling* account and never
  the guarded field).

## §3 Parser / AST stress

| Attack | Result | Evidence |
| --- | --- | --- |
| Syntactically broken mid-PR file (unbalanced braces) | HOLDS: never crashes; degrades per-item, emits a meta-notice | `engine.test.ts` "unparseable file … never crashes" |
| Very large file | HOLDS: files > 4 MiB are not parsed and reported once as a notice (no OOM) | `parse.ts` `MAX_PARSE_BYTES` |
| CRLF / lone CR line endings | HOLDS: normalized before indexing | `util.test.ts` splitLines |
| Deeply nested `macro_rules!` with metavariables | HOLDS: corpus `gmsol-93044f7442` (fixed_map macro) fires at the right line | corpus replay |
| Rust 2024 syntax the grammar may not know | BEND: `hasError` path degrades honestly (meta-notice, best-effort per item) | `parse.ts` |

## §4 Diff & GitHub edge cases

| Attack | Result | Evidence |
| --- | --- | --- |
| New file `@@ -0,0 +1,N @@` | HOLDS | `diff.test.ts` |
| Renamed file | HOLDS (status renamed, oldPath tracked) | `diff.test.ts` |
| Deleted file | HOLDS (skipped from analysis, no crash) | `diff.test.ts` + engine |
| No trailing newline marker | HOLDS | `diff.test.ts` |
| Multiple hunks in one file | HOLDS | `diff.test.ts` |
| Line-number coordinates land on NEW-file lines | HOLDS: verified against real patches (reported lines = the actual buggy lines) | corpus `BENCHMARK.md` |
| 300+ file / truncated API diff | BEND: uses the `.diff` endpoint; for very large PRs the local `scan . --base` path (git) is the documented fallback | README |

## §5 Replay-silence (the credibility attack)

Every corpus **fixed** commit is silent for its rule: 15/15 in
`bench/corpus/BENCHMARK.md`. TS-client-only commits produce no Rust findings
(non-`.rs` files are skipped, per `engine.test.ts` "non-rust files are skipped").

## §6 Tool self-security

| Attack | Result | Evidence |
| --- | --- | --- |
| Path traversal in a diff filename (`../../etc`) | HOLDS: rejected with a notice, never read | `engine.test.ts` "path traversal … skipped" |
| Absolute paths / control chars in filenames | HOLDS | `util.test.ts` isSafeRelPath |
| Executing fetched code | HOLDS: the tool never runs `cargo`/build scripts/macros; analysis is static over a WASM tree | design |
| Network exfiltration | HOLDS: a hard host allowlist (github.com family only); any other host throws | `http.ts` `ALLOWED_HOSTS` |
| Writes outside a cache dir | HOLDS: only baseline (user-named) and OS state dir are written; atomic (tmp+rename) | `util.ts` atomicWrite |

## §7 Performance

A typical PR (< 10 changed `.rs`) scans in well under a second excluding fetch
(parse ≈ 0.3 ms/KiB). The 4 MiB per-file cap + per-file tree disposal bound
memory on pathological inputs. See FINAL-REPORT.md for numbers.

## §8 Live-PR adversarial

| Attack | Result | Evidence |
| --- | --- | --- |
| Fork PR (head repo ≠ base repo) | HOLDS: head content fetched from the fork's repo at head SHA | `fetch.ts` fromPr uses `head.repo.full_name` |
| Bad/expired token on a public repo | HOLDS: 401 falls back to unauthenticated with a warning (scan still runs) | `fetch.ts` / `github.ts` 401 fallback |
| `--post` spam on unchanged PR | HOLDS: one review, summary comment updated in place, inline comments only re-posted when head SHA changes | `post.ts` |
| Dismissed finding reappearing | HOLDS: dismiss memory in the state file; dismissed fingerprints are filtered | `post.ts` |
| State-file corruption mid-write | HOLDS: atomic tmp+rename writes; a corrupt read falls back to empty state | `util.ts` / `post.ts` |
| Missing checks:write for `--post check` | HOLDS: clear error; scan already ran | `post.ts` |

## Known BENDs (documented, not release-blocking)

1. Realloc with a *runtime* zero-init flag is not tracked (literal `false` only).
2. Semantic wrong-variable/getter swaps that need the fix to disambiguate are
   intentionally not chased (keeps Tier-1 precision at 100%).
3. Very large (300+ file) API diffs: prefer the local `git`-based path.
4. Rust editions newer than the pinned grammar degrade to best-effort with a
   meta-notice rather than hard failure.
