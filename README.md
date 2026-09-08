# sol-pr-guard

**Diff-scoped security review for Solana (Rust / Anchor) pull requests.**
Precise, `file:line` findings, each one derived from a real, patch-verified exploit or fix, posted the way a careful reviewer would post them.

sol-pr-guard reads a PR's diff, parses the changed Rust at both revisions with
[`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter) (no native
build, no compiler, no code execution), and fires a small set of
**high-precision** detectors only on the code the PR actually touched. It is
built around one rule: **precision beats recall.** One false positive on a clean
PR costs more than one missed bug, so a finding you would reject is treated as a
bug in the tool.

- **Zero native dependencies.** Pure Node + a prebuilt WASM grammar → the same
  npm package runs on macOS (Apple Silicon and Intel), Linux, and Windows.
- **No telemetry, no phone-home.** The only network destinations are
  `github.com`, `api.github.com`, and `raw.githubusercontent.com`. Nothing you
  scan ever leaves your machine except read-only GETs to GitHub.
- **No fetched code is ever executed.** No `cargo`, no build scripts, no macro
  expansion: the analysis is purely static over a WASM parse tree.

---

## Why this exists

Copilot reviews your code. Nobody reviews your Anchor constraints.

Every bug below sailed through human review. People read those PRs and clicked
approve. None of the bugs are exotic: a constraint copy-pasted from the field
above it, a `realloc` that leaves stale bytes to be deserialized as money, a
`check_*` function that exists and nobody calls. That is the class a tired
reviewer misses at 1am and a pattern matcher never does.

This tool exists because I kept finding that class by hand in merged,
reviewed, sometimes audited code. So I turned each real bug into a detector and
ran it back over protocol history:

| Protocol | What it found | What happened to the bug |
| --- | --- | --- |
| gmsol | unconstrained payout accounts, copy-pasted constraint, unzeroed realloc | [4 bugs, all fixed after shipping](docs/GMSOL-HISTORY.md) |
| Drift | isolated positions leaking into cross-margin bankruptcy; users stuck in `BeingLiquidated` | [shipped ~10 weeks, fixed quietly](docs/DRIFT-HISTORY.md) |
| Jito | vote-account deserialization that any new vote-state variant permanently bricks | [live 2022 → Dec 2025, fixed without ever being called a bug](docs/JITO-HISTORY.md) |
| Kamino (klend) | ownership-transfer gate the borrow/withdraw/deposit handlers never check | [still in the code as of writing](docs/KLEND-HISTORY.md) |

Every linked doc shows the verbatim tool output and the exact upstream fix
commit, and every claim replays offline with `npm run corpus`. Don't trust the
table; run it against your own merged history:

```bash
node dist/src/cli.js scan your-org/your-repo#<any-merged-pr>
```

The worst it can do is tell you your review process already works.

---

## Quickstart (zero → first real finding in under 5 minutes)

```bash
# 1. install (no compiler, no native modules)
npm install
npm run build            # compiles TypeScript -> dist/ and bundles the grammar

# 2. see it catch two real gmsol bugs, fully offline, on bundled example code
node dist/src/cli.js scan examples --whole-repo

# 3. run it on your own PR (public repo, no token needed)
node dist/src/cli.js scan your-org/your-repo#123

# 4. run it before you even open the PR
node dist/src/cli.js scan . --base origin/main
```

After cloning, `npm link` makes the command available as just `sol-pr-guard`.
A registry package is planned; for now the repo *is* the distribution: clone,
pin, review the bytes you run.

### Example run

`sol-pr-guard scan examples --whole-repo` on the bundled pre-fix gmsol files:

```
shift.rs
     54  T1 high  copy-paste-constraint
         Constraint on 'to_market_token' is identical to the one on 'from_market_token'
         and references 'from_market', never 'to_market_token' — the constraint appears
         copy-pasted, leaving 'to_market_token' effectively unconstrained.
           | #[account(constraint = from_market.load()?.meta().market_token_mint == from_market_token.key() @ CoreError::MarketTokenMintMismatched)]
           ↳ gmsol-labs/gmx-solana shift.rs constraint fix — https://github.com/gmsol-labs/gmx-solana/commit/bf2a35c6d7

token_config.rs
    475  T1 medium  realloc-zero-init
         realloc(..., false) grows the account without zeroing the new region — stale
         bytes will be deserialized as valid data. Pass zero_init=true or explicitly
         zero the grown range.
           | token_map_loader.as_ref().realloc(new_space, false)?;
           ↳ gmsol a2779d14f1 (#362) — https://github.com/gmsol-labs/gmx-solana/commit/a2779d14f1

2 finding(s): 2 T1 · 0 T2 · 0 T3
```

Both land on the exact lines the upstream fixes changed
([`bf2a35c6d7`](https://github.com/gmsol-labs/gmx-solana/commit/bf2a35c6d7),
[`a2779d14f1`](https://github.com/gmsol-labs/gmx-solana/commit/a2779d14f1), the
`#362` realloc fix). Scan the *fixed* revisions and the tool is silent. That
"silent on the fix" property is verified in CI for every detector (see
[Validation](#validation)).

---

## Usage

```
sol-pr-guard scan <owner/repo#PR>                review a pull request (open / merged / closed, incl. forks)
sol-pr-guard scan --repo o/r --base A --head B   review a commit range
sol-pr-guard scan <path> [--base <ref>]          review a local repo vs a base ref
sol-pr-guard scan <path> --staged                review staged changes (pre-push)
sol-pr-guard scan <path> --whole-repo            scan every .rs file (no diff scoping)
sol-pr-guard watch <owner/repo>                  review open PRs that changed since last run
```

**Output formats:** default human terminal, `--json`, `--sarif` (GitHub code
scanning / reviewdog), `--format=efm` (reviewdog errorformat). All tested.

**Gating & exit codes:** `0` = clean below the gate · `1` = findings at/above
the gate · `2` = tool error. The default gate is `T2` (Tier-1 + Tier-2);
override with `--fail-on T1|T2|T3|none`.

**Confidence tiers:** `T1` deterministic/diff-local (failure), `T2` file-context
heuristic (warning), `T3` lint-grade (summary only, never inline, never fails).

**Suppression** (always visible in the summary, never silent):
```rust
// sol-pr-guard-ignore-next-line realloc-zero-init
loader.realloc(new_space, false)?;
```

**Baseline**: adopt on an existing codebase and only see *new* findings:
```bash
sol-pr-guard scan . --base origin/main --write-baseline .spg-baseline.json
sol-pr-guard scan . --base origin/main --baseline .spg-baseline.json
```

**Config** (`sol-pr-guard.toml`, discovered upward from the scan dir):
```toml
fail_on = "T2"
include_tests = false
exclude = ["vendor/**", "**/generated.rs"]

[rules]
unchecked-arithmetic = false      # disable a rule

[severity]
copy-paste-constraint = "critical"
```

By default `tests/`, `benches/`, `#[cfg(test)]` modules, and `idl/` are
excluded.

### Reviewing live PRs

```bash
# post one atomic review with inline comments (needs a token with repo scope)
sol-pr-guard scan o/r#123 --post review --token $GITHUB_TOKEN

# or a Check Run with annotations (token needs checks:write)
sol-pr-guard scan o/r#123 --post check --token $GITHUB_TOKEN

# review all open PRs that changed since last run
sol-pr-guard watch o/r --interval 300
```

`--post` is **anti-spam by construction**: one review, comments batched, its own
summary comment updated *in place* on re-runs, and findings you previously
dismissed are never re-reported (dismiss memory is kept in an OS-appropriate
state file). Scanning always works with a read-only token; if posting
permissions are missing, the scan still runs and posting is skipped with a clear
message.

### GitHub Action

The tool is distributed as a repository, so the Action checks it out at an
**exact commit SHA**: a registry artifact is mutable, a commit is not. Review
the tool once, then trust the hash. `node dist/src/cli.js init` writes this
workflow with the SHA filled in for you.

```yaml
# .github/workflows/sol-pr-guard.yml
name: sol-pr-guard
on: pull_request
permissions:
  contents: read
  pull-requests: write
  checks: write
  security-events: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/checkout@v4   # the tool, pinned to a reviewed commit
        with:
          repository: mv-reyes/sol-pr-guard
          ref: <PINNED-TOOL-SHA>
          path: .sol-pr-guard
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd .sol-pr-guard && npm ci && npm run build
      - run: node .sol-pr-guard/dist/src/cli.js scan --repo ${{ github.repository }} \
               --base ${{ github.event.pull_request.base.sha }} \
               --head ${{ github.event.pull_request.head.sha }} \
               --sarif > results.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: results.sarif }
```

On fork PRs the default `GITHUB_TOKEN` is read-only, so use the SARIF upload path
(code scanning) rather than `--post`; comment/check posting from fork PRs
requires a `pull_request_target` workflow, which you own the trust decision for.

---

## Detectors

Each detector cites the real fix commit(s) it was derived from and is proven to
fire on that buggy commit and stay silent on the fix (see
[Validation](#validation)). Full signatures live in
[`research/pr-bug-corpus-deep.md`](../research/pr-bug-corpus-deep.md).

### Tier 1: diff-local, default ON, can fail a check

| Rule | Catches | Derived from |
| --- | --- | --- |
| `discarded-checked-result` | a `checked_*` result dropped as a bare statement; a validation branch that logs but never returns `Err` | [jito 32d72f136c](https://github.com/jito-foundation/jito-programs/commit/32d72f136c), [wormhole 972939ee31](https://github.com/wormhole-foundation/wormhole/commit/972939ee31) |
| `copy-paste-constraint` | an `#[account(constraint=…)]` copied from a sibling field, leaving this account unconstrained | [gmsol bf2a35c6d7](https://github.com/gmsol-labs/gmx-solana/commit/bf2a35c6d7) |
| `disabled-constraint` | a commented-out `#[account(…)]`, a placeholder `/// CHECK: none`, or a payout target taken from `remaining_accounts` | [tensor 713db3affe](https://github.com/tensor-foundation/marketplace/commit/713db3affe), [gmsol a12c0df6da](https://github.com/gmsol-labs/gmx-solana/commit/a12c0df6da) |
| `zero-share-conversion` | an amount→shares conversion used to move value with no `> 0` guard (dust withdraws for free) | [marginfi 28222ee531](https://github.com/mrgnlabs/marginfi-v2/commit/28222ee531) |
| `realloc-zero-init` | `realloc(x, false)` leaving stale bytes; whole-buffer zeroing that clobbers header/flag bytes; double-close | [gmsol a2779d14f1](https://github.com/gmsol-labs/gmx-solana/commit/a2779d14f1) |
| `prefunded-pda-dos` | raw `create_account` for a PDA with no already-exists guard (pre-fund → permanent DoS) | [wormhole 2b56fcc7da](https://github.com/wormhole-foundation/wormhole/commit/2b56fcc7da), phoenix `1f01815000`, sanctum `df580d6e5f` |
| `auth-precedence` | an access-control `if` mixing `&&` and `\|\|` without parentheses | [mpl-core 1a68114713](https://github.com/metaplex-foundation/mpl-core/commit/1a68114713) |
| `missing-bounds-gate` | a settable fee/bps/threshold/time-lock written with no range check (in-file, incl. `.validate()`) | sanctum `2c396c275c`, [jito-restaking cdac2eab4c](https://github.com/jito-foundation/restaking/commit/cdac2eab4c), squads `720ca8c3b2` (N=6) |
| `incomplete-account-close` | a manual close (`sol_memset` + `assign(system_program)`) with no `realloc(0)` → account revivable | [jito-restaking ce5c981bef](https://github.com/jito-foundation/restaking/commit/ce5c981bef) (Certora) |
| `ix-signer-flag` | an `AccountMeta` marking a `*signer*` account `is_signer=false` (processor check unenforceable) | [spl token-2022 96b37d41c6](https://github.com/solana-labs/solana-program-library/pull/5900) (OtterSec) |
| `lossy-as-cast` | `<amount> as i64` (u64→i64 wraps negative: an outflow booked as an inflow) | [marginfi 2d6de777ef](https://github.com/mrgnlabs/marginfi-v2/commit/2d6de777ef) |
| `one-sided-bound-signed` | a signed value bounded only above (`if MAX < x`), so large negatives pass | [sanctum e081f6e8b1](https://github.com/igneous-labs/S/commit/e081f6e8b1) (OtterSec) |

### Tier 2: file-context, default ON, inline warning

| Rule | Catches | Derived from |
| --- | --- | --- |
| `early-return-skips-cleanup` | an early `return Ok(())` or `?` abort that skips the state-machine exit / cleanup other paths perform | [marinade c6cdf23ad1](https://github.com/marinade-finance/liquid-staking-program/commit/c6cdf23ad1), [drift e6ee7b4e1](https://github.com/velocity-exchange/protocol-v2/commit/e6ee7b4e1) |
| `wrong-object-auth-check` | an owner check on a token account never tied to the mint/metadata the handler also takes | [mpl-token-metadata 9485552af1](https://github.com/metaplex-foundation/mpl-token-metadata/commit/9485552af1) |
| `fixed-buffer-arithmetic` | `arr[i+1]` at a loop bound; a `ptr::copy` to a base pointer that should be offset | [gmsol 93044f7442](https://github.com/gmsol-labs/gmx-solana/commit/93044f7442), [sanctum a8623b718a](https://github.com/igneous-labs/S/commit/a8623b718a) |
| `subtype-blind-solvency` | a solvency/bankruptcy loop aggregating positions without filtering by the subtype flag the struct carries (isolated vs cross) | [drift b7fff7875](https://github.com/velocity-exchange/protocol-v2/commit/b7fff7875) |
| `closed-enum-deserialize` | full `bincode`/`borsh` deserialize of an externally-owned versioned account into a closed enum (a new upstream variant bricks it) | [jito 5be43ef2c7](https://github.com/jito-foundation/jito-programs/commit/5be43ef2c7) |

### Tier 3: summary-only hints (never inline, never fails)

| Rule | Catches | Derived from |
| --- | --- | --- |
| `unchecked-arithmetic` | raw `+ - *` / `+= -=` on amount/lamport values without `checked_`/`saturating_` | [jito 1455366f44](https://github.com/jito-foundation/jito-programs/commit/1455366f44) |
| `unused-state-gate` | a `check_*`/`validate_*` guard added for a state flag that sibling mutating handlers never call | [klend 95d694b](https://github.com/Kamino-Finance/klend/commit/95d694b) |
| `checked-sub-ordering` | a residual term (`remaining_*`/`net_*`) `checked_sub`-ing a full-value term (`*_value`/`total_*`/`collateral`) with `?` — underflows to `None` if the residual already nets out the value | [gmsol PR #439](https://github.com/gmsol-labs/gmx-solana/pull/439) |

The classic Anchor-audit classes (missing-signer, PDA-seeds, sysvar,
discriminator, duplicate-mutable) are **deliberately not** Tier-1 rules: across
44 modern merged PRs from 14 Solana repos they had ~zero incidence, and leading
with them is how a tool trains developers to ignore it.

---

## Validation

Everything below is reproducible from this repo.

- **Corpus replay** (`npm run corpus`, offline): every Tier-1/Tier-2 detector
  fires on its real buggy commit *and* stays silent on the fix: **24/24 pass**.
  Fixtures are the real pre-/post-fix files, reconstructed by reverse-applying
  the cached patches, so the reported `file:line` is the actual buggy line.
  Results are written to [`bench/corpus/BENCHMARK.md`](bench/corpus/BENCHMARK.md).
- **FP-trap suite** (`npm run fp-traps`, offline): **35 source-verified safe
  fragments** that each tempt a detector must produce **zero Tier-1/Tier-2
  findings**, CI-enforced like the corpus. See [`bench/fp-traps/FP-TRAPS.md`](bench/fp-traps/FP-TRAPS.md).
- **Evasion suite** (`npm run evasion`, offline): the rules are public, so a
  rule-aware PR author is the primary adversary. This gate takes each real buggy
  fixture, applies one minimal attacker edit (a comment, an error string, a
  lower-bound-only or never-enforced check, a log-only or callee-local reject-if,
  an allowlist `.contains`, a wrapped assignment, a named-const zero, a bound in a
  sibling function the setter never calls or whose result it never propagates) and
  asserts the true Tier-1 finding **still fires**, with paired controls asserting
  real enforced bounds still suppress (42/42). It is backed by three properties:
  the engine's offset-preserving comment/string masking (`SourceFile.textStripped`,
  so a comment/string can never silence a finding), **enforcement-position-aware**
  suppression (a bound only suppresses when it actually gates: a `require!`/
  `assert!`/comma bound-macro, or a reject-if that returns/panics, never a value
  merely computed or logged), and **function-scoped, propagation-aware** suppression
  (the bound must sit in the setter's own body or in a fn it calls whose result it
  propagates; a bound in an uncalled sibling or a `#[cfg(test)]` module does not
  count).
- **Mutation testing** (`npm run mutation`, offline): each bug class is planted
  into clean realistic Rust; the detector must catch the mutant and stay silent
  on the clean version. **Tier-1 recall 14/14 = 100%, zero clean false positives.**
- **False-positive burn-in** (`npm run fp-burnin`): scans recently-merged PRs
  across up to 7 Anchor repos (gmsol, marginfi, mpl-core, marinade, tensor,
  sanctum/S, jito-restaking) and asserts **0 Tier-1 false positives**: every
  FP it has ever surfaced was a rule bug, fixed at the root. The PR/repo count is
  bounded by unauthenticated fetch speed and varies run to run (66–82 PRs across
  5–7 repos observed); the zero-Tier-1 invariant is what the gate enforces, not a
  fixed N. See [`bench/fp-burnin/report.md`](bench/fp-burnin/report.md).
- **Red-team suite** (`npm run redteam`, offline): 27 adversarial evasion / FP /
  parser / diff / security cases; see [`ADVERSARIAL.md`](ADVERSARIAL.md).
- **Unit tests** (`npm test`): diff coordinates, attribute extraction, linkage,
  the anchor 0.25→1.0 constraint-grammar drift, suppression, config, output
  formats, the AI layer (offline, mock transport), and every rule's match /
  no-match pairs.

## Optional AI layer (`--ai`, off by default)

The zero-key, offline, deterministic tool is the default and is never weakened by
AI. When you opt in, AI is a **strictly additive** layer that **cannot create a
Tier-1 finding and never gates a merge**; its output is always labeled
*"AI-assisted — needs human confirmation."* Provider-agnostic: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or a local `SPG_AI_PROVIDER=ollama` (for air-gapped use nothing
leaves the machine).

- **Phase A, the explainer** (`--ai`): for each *deterministic* finding, the LLM
  writes a plain-English explanation + suggested fix. Zero FP risk (it annotates a
  confirmed finding, never invents one).
- **Phase B, the semantic pass** (`--ai=experimental`): targets the repo-context
  classes the detectors can't see (the `ef7dc2c3d2` over-mint class). It builds a
  grounded context pack from the tool's own AST (diff + enclosing fns + linked
  structs + 1-hop callees), only engages on diffs with value-flow signal, and
  **mechanically validates every claim against the source** (line in file, quote
  verbatim, anchor resolves). A hallucinated claim is dropped silently. Output is
  Tier-3 only. It ships behind `--ai=experimental` until the calibration gate
  (`npm run ai-calibration`) shows it catches the `ef7dc2c3d2` class with an
  acceptable clean-PR FP rate.

Results are cached by content hash so re-runs (and CI) are reproducible and cheap.
With `--ai` on, the one added network destination is the chosen LLM endpoint
(documented; still no telemetry).

---

## Honesty: what sol-pr-guard does *not* catch

Diff-local and file-context bugs are the sweet spot. **Bugs that need
cross-file, protocol-level reasoning are out of scope by design**, and pretending
otherwise would make the tool worse, not better.

**Worked example: gmsol GT over-mint
([`ef7dc2c3d2`](https://github.com/gmsol-labs/gmx-solana/commit/ef7dc2c3d2), #418).**
On an insolvent liquidation/ADL close, `process_collateral` short-circuits
before the fee-collection step, but `paid_order_and_borrowing_fee_value` was
computed up front and survives, so GT is minted against fees that were never
paid (an unbacked mint, Critical severity). No single line is flaggable: catching
it requires knowing the pipeline order (Funding → Pnl → Fees → Impact → Diff),
that an insolvent close skips later steps, and that the up-front value flows into
GT minting. This is a *repo-context* bug. sol-pr-guard will not report it, and it
would be dishonest to claim it could. (Its Tier-3 hints can surface "a value
computed before a short-circuiting pipeline is consumed after it" as a review
prompt, but never as a finding.)

Other known limitations: it reasons over a syntax tree, not types or macro
expansion; some wrong-variable bugs (e.g. `swap_path.len()` vs
`params.swap_path_length`) are only distinguishable with the fix in hand and are
not chased, to keep Tier-1 precision at 100%; and the statement-level detectors
assume conventionally formatted Rust (one statement per line, as `rustfmt`
produces, the format of every real PR), so deliberately minified single-line
Rust can evade them. These trade-offs are recorded in `ADVERSARIAL.md`, which
also logs the red-team run (6 evasions/false-positives found and fixed, each with
a regression test).

---

## How it compares

| | diff-scoped | inline PR review | runs locally, no code leaves machine | deterministic | proven on this corpus |
| --- | --- | --- | --- | --- | --- |
| **sol-pr-guard** | ✅ only fires on changed surface | ✅ atomic review + check run + SARIF | ✅ GitHub-only GETs, no telemetry | ✅ | ✅ 24/24 corpus, 35/35 FP-traps, 100% T1 mutation recall |
| [Radar](https://github.com/auditware/radar) | ❌ whole-directory at a commit | ❌ (CI annotations) | ✅ (Docker) | ✅ | not measured. Its rules target classic Anchor classes that are ~absent in modern merged PRs |
| [Sec3 X-Ray](https://github.com/sec3-product/x-ray) | ❌ whole-program | ❌ (SARIF → code scanning) | ✅ | ✅ | not measured |
| CodeRabbit | partial (LLM sees the diff) | ✅ | ❌ sends code to a third-party LLM | ❌ non-deterministic | not measured |

Only the sol-pr-guard column is independently measured here; the corpus replay
harness ships so you can reproduce it, and the competitor columns state
capabilities, not invented recall numbers. The gap sol-pr-guard fills is the
combination in row one: **diff-scoped inline PR review with deterministic,
provenance-backed, low-false-positive findings that run on your own machine.**

---

## Cross-platform

macOS is the primary target (Apple Silicon and Intel); Linux and Windows are
first-class. The parser is a portable WASM grammar, so there are no per-platform
binaries. Cache and state files use OS-appropriate locations
(`$XDG_CACHE_HOME` / `~/.cache` on macOS+Linux, `%LOCALAPPDATA%` on Windows), all
paths are handled portably, and no command assumes a particular shell. CI runs
the full suite on `macos-latest`, `ubuntu-latest`, and `windows-latest`.

## Development

```bash
npm run build       # tsc -> dist/ + bundle grammar wasm
npm test            # unit tests (node --test)
npm run corpus      # offline corpus replay (regenerate fixtures: node dist/scripts/build-fixtures.js)
npm run fp-traps    # FP-trap suite (35 safe fragments must stay silent)
npm run evasion     # rule-aware evasion suite (comment/string/direction/multiline)
npm run mutation    # mutation recall gate
npm run redteam     # adversarial suite (REDTEAM-PLAN)
npm run fp-burnin   # false-positive burn-in (network)
npm run ai-calibration  # Phase-B AI gate (needs an LLM backend)
```

## License

MIT. No telemetry. No phone-home. No fabricated benchmarks.
