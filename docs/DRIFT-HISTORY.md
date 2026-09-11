# sol-pr-guard over drift's merged history

I ran sol-pr-guard over the velocity-exchange/protocol-v2 (formerly
drift-labs) PR/commit history as part of the detector benchmark. Method: for
each historical fix commit, check out the pre-fix revision, scan it, and
confirm the tool (a) fires on the buggy line and (b) is silent on the fixed
revision. Everything below reproduces offline.

One verification note: the repo's later history includes a commit (PR #2174)
that comments out every instruction, so "was the bug live" was checked at
each relevant merge commit rather than at HEAD.

## What it found

Both findings come from the same PR, #1757 "program: isolated position"
(merge commit `97355509a`, merged 2026-01-05), and both were fixed about
ten weeks later, on 2026-03-16, without either bug being publicly called out
at merge time.

| Fix commit | File:line | Detector | Class |
|---|---|---|---|
| [`b7fff7875`](https://github.com/velocity-exchange/protocol-v2/commit/b7fff7875) (#2123) | `programs/drift/src/math/bankruptcy.rs:22` | subtype-blind-solvency | `is_cross_margin_bankrupt` iterates `user.perp_positions` and treats `quote_asset_amount < 0` as a cross-margin liability without skipping isolated positions: isolated collateral is deliberately excluded from cross margin, so an isolated position closed at a loss can flag a user "cross-margin bankrupt", bricking deposits/withdraws/orders behind the `is_bankrupt()` gate and opening a wrongful bankruptcy-resolution path |
| [`e6ee7b4e1`](https://github.com/velocity-exchange/protocol-v2/commit/e6ee7b4e1) (#2122) | `programs/drift/src/state/liquidation_mode.rs:95` | early-return-skips-cleanup | `user.get_perp_position(market_index)?` errors out of the liquidation-mode dispatch when the position record is already gone, before the caller's `exit_liquidation` path can run, so a user whose position was fully liquidated is stuck in `BeingLiquidated` (withdrawals and other actions blocked) until the fix ships |

Every fire line is the exact line the upstream fix changed: #2123 adds
`if perp_position.is_isolated() { continue; }` to the loop; #2122 adds an
Err-arm fallback (`Err(_) => return Ok(Box::new(CrossMarginLiquidatePerpMode::new(market_index)))`)
and its own test is named `clear_being_liquidated_when_position_fully_liquidated`.
The full cross-protocol replay (23 historical bugs across gmsol, marginfi,
sanctum, jito, tensor, wormhole, marinade, mpl, spl, drift, and klend) is in
[`bench/corpus/BENCHMARK.md`](../bench/corpus/BENCHMARK.md) (entries
`drift-b7fff7875`, `drift-e6ee7b4e1`).

## Actual output (verbatim, offline run)

```
programs/drift/src/math/bankruptcy.rs
     22  T2 medium  subtype-blind-solvency
         solvency/bankruptcy loop over `user.perp_positions.iter()` never filters by position subtype — this file has a subtype flag (isolated/kind), so segregated positions leak into the aggregate solvency decision.
           | for perp_position in user.perp_positions.iter() {

programs/drift/src/state/liquidation_mode.rs
     95  T2 medium  early-return-skips-cleanup
         `?` on this lookup aborts a liquidation-mode dispatch when the position/state is absent — the caller's exit transition (e.g. exit_liquidation) becomes permanently unreachable. Handle the Err arm with a default mode instead.
           | let perp_position = user.get_perp_position(market_index)?;
```

## Reproduce it yourself

```bash
git clone <this repo> && cd sol-pr-guard
npm install && npm run build
npm run corpus        # replays all 23 historical bugs, offline: fires on the
                      # buggy line, silent on the fixed revision, for each
node dist/src/cli.js scan velocity-exchange/protocol-v2#<any open PR>   # live mode
```

## Honest misses

This history also contains real bugs the tool does NOT catch, and you should
know that before trusting it:

- [PR #2104](https://github.com/velocity-exchange/protocol-v2/pull/2104)
  (remove same-slot matching restriction): after the change, the only
  self-match check upstream is `maker_key == taker_key` on the User account
  pubkey, so same-authority sub-accounts can self-match in the same slot.
  It is bounded by the maker-oracle price-band expiry, and no
  insurance-fund-drain primitive was found, but nothing in the diff shape
  lets a diff-local rule see the economic interaction at all. Zero findings.
- [PR #2139](https://github.com/velocity-exchange/protocol-v2/pull/2139)
  ("fund stuck in isolated margin"): the fix inline-clears
  `isolated_position_scaled_balance` into the user's quote spot position
  inside `settle_pnl`, implying residual isolated collateral no instruction
  could recover before it. This is a liveness/funds-locked invariant visible
  only against the protocol's state machine, not in any single diff hunk;
  the tool has no detector for it (and the mining pass did not fully verify
  whether the fix landed on master or only the devnet branch, reported here
  as unverified, not as a confirmed bug).
- Anything whose bug is only visible against protocol-level invariants, live
  account state, or cross-program composition. Those need a fork test, not a
  diff scan. See "Honesty: what sol-pr-guard does not catch" in the README.
