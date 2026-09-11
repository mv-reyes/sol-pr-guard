# sol-pr-guard over klend's merged history

I ran sol-pr-guard over the Kamino-Finance/klend PR/commit history as part
of the detector benchmark. klend is a release-mirror repo: on-chain changes
ship inside "Prepare release X" PRs, so the unit of review is the release
PR. Method: for the flagged release merge, check out the merged revision,
scan it, and confirm the tool fires on the guard functions the release
added. Everything below reproduces offline.

## What it found

| Commit | File:line | Detector | Class |
|---|---|---|---|
| [`95d694b`](https://github.com/Kamino-Finance/klend/commit/95d694b) (#60, release 1.19.0) | `programs/klend/src/state/obligation.rs:388` | unused-state-gate | the 3-step obligation ownership transfer (initiate → `global_admin` approves → `pending_owner` accepts) sets `obligation.ownership_transfer_state` and defines `check_ownership_transfer_not_in_progress()`, but no position-mutating method ever calls it, so the outgoing owner can still withdraw collateral or borrow in a separate transaction between admin approval and the buyer's accept |

Two things to state plainly:

1. **As of writing this is still live at HEAD** (`a087609`, release 1.25.0).
   There is no upstream fix commit. The corpus entry (`klend-95d694b`)
   therefore pairs the merged `impl Obligation` block with a **synthesized
   would-be fix** as its after-fixture: our suggested patch (wire the check
   into the borrow/withdraw/repay paths), not an upstream commit. The
   replay asserts the detector fires on the merged code and goes silent on
   our patched version.
2. **This may be intended, accepted design.** The transfer flow is
   global-admin-gated, the PR states it was audited (OtterSec, Certora), and
   the per-transaction introspection guard does block bundling transfer
   instructions with other instructions in the *same* transaction, just not
   a *separate* transaction in the approve→accept window. Impact is limited
   to OTC transfer counterparties (a seller can pull collateral or add debt
   the buyer agreed to assume), not protocol-wide funds. A reviewer would
   still flag the missing gate, because acceptance is not atomic with any
   position check; severity T3/low, as the tool reports it.

Line-number note: the corpus fixture is the verbatim `impl Obligation` block
(full-file lines 210–687 of `obligation.rs` at `95d694b`), so the reported
lines are fixture-relative. The guard is
`check_ownership_transfer_not_in_progress`; at HEAD it sits at
`programs/klend/src/state/obligation.rs:665`, still with zero call sites in
the borrow/withdraw/repay handlers.

The full cross-protocol replay (23 historical bugs across gmsol, marginfi,
sanctum, jito, tensor, wormhole, marinade, mpl, spl, drift, and klend) is in
[`bench/corpus/BENCHMARK.md`](../bench/corpus/BENCHMARK.md).

## Actual output (verbatim, offline run)

Scan of the merged revision, diff-scoped to the lines PR #60 added (the same
scoping `npm run corpus` uses; PR #60 added four transfer-guard predicates
and the tool flags all four):

```
programs/klend/src/state/obligation.rs
    388  T3 low  unused-state-gate
         `check_ownership_transfer_not_in_progress` guards a state flag but is never invoked by any sibling mutating method (init, repay, withdraw, update_has_debt, …) — position-altering paths can bypass the gate.
           | pub fn check_ownership_transfer_not_in_progress(&self) -> Result<()> {
    396  T3 low  unused-state-gate
         `check_ownership_transfer_in_progress` guards a state flag but is never invoked by any sibling mutating method (init, repay, withdraw, update_has_debt, …) — position-altering paths can bypass the gate.
           | pub fn check_ownership_transfer_in_progress(&self) -> Result<()> {
    414  T3 low  unused-state-gate
         `check_ownership_transfer_initiated` guards a state flag but is never invoked by any sibling mutating method (init, repay, withdraw, update_has_debt, …) — position-altering paths can bypass the gate.
           | pub fn check_ownership_transfer_initiated(&self) -> Result<()> {
    422  T3 low  unused-state-gate
         `check_ownership_transfer_approved` guards a state flag but is never invoked by any sibling mutating method (init, repay, withdraw, update_has_debt, …) — position-altering paths can bypass the gate.
           | pub fn check_ownership_transfer_approved(&self) -> Result<()> {
```

## Reproduce it yourself

```bash
git clone <this repo> && cd sol-pr-guard
npm install && npm run build
npm run corpus        # replays all 23 historical bugs, offline: fires on the
                      # buggy line, silent on the fixed revision, for each
node dist/src/cli.js scan Kamino-Finance/klend#<any open PR>   # live mode
```

## Honest misses

This history also contains real issues the tool does NOT catch, and you
should know that before trusting it:

- [PR #35](https://github.com/Kamino-Finance/klend/pull/35) (token-2022
  allowlist additions): `Pausable` mints are accepted when unpaused *at
  validation time*: the pause authority can freeze deposits, withdrawals,
  and liquidations for that reserve later (a liveness trust assumption on an
  external authority). `ScaledUiAmount` mints are accepted with no
  constraint; klend's internal accounting uses raw amounts so the residual
  risk is integrator/UI mispricing, not a protocol drain. Both are
  deliberate, PR-documented listing decisions, and flagging them requires
  reasoning about what an extension *means*, not what the diff does. Zero
  findings.
- [PR #69](https://github.com/Kamino-Finance/klend/pull/69):
  `saturating_fraction_collateral_to_liquidity` saturates to
  `Fraction::from(u64::MAX)` on overflow, and at HEAD it has zero callers
  (all money paths use the panicking variant). Dead code today; if it is
  ever wired into a redemption path, saturate-to-MAX would massively
  overpay. "This helper is unused but dangerous if adopted" is a
  cross-time, repo-wide fact no diff-scoped rule expresses. Zero findings.
- Anything whose bug is only visible against protocol-level invariants, live
  account state, or cross-program composition. Those need a fork test, not a
  diff scan. See "Honesty: what sol-pr-guard does not catch" in the README.
