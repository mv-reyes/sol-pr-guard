# sol-pr-guard over gmsol's merged history

I ran sol-pr-guard over the gmx-solana PR/commit history as part of the
detector benchmark. Method: for each historical fix commit, check out the
pre-fix revision, scan it, and confirm the tool (a) fires on the buggy line and
(b) is silent on the fixed revision. Everything below reproduces offline.

## What it found

| Fix commit | File:line | Detector | Class |
|---|---|---|---|
| [`bf2a35c6d7`](https://github.com/gmsol-labs/gmx-solana/commit/bf2a35c6d7) | `programs/store/src/instructions/exchange/shift.rs:54` | copy-paste-constraint | `to_market_token` constraint references `from_market`/`from_market_token`, so the target token is effectively unconstrained |
| [`a12c0df6da`](https://github.com/gmsol-labs/gmx-solana/commit/a12c0df6da) | `programs/store/src/instructions/exchange/execute_order.rs:412,547` | disabled-constraint | payout/market targets derived from caller-controlled `remaining_accounts` with no constraint |
| [`a2779d14f1`](https://github.com/gmsol-labs/gmx-solana/commit/a2779d14f1) (#362) | `programs/store/src/instructions/token_config.rs:475` | realloc-zero-init | `realloc(new_space, false)` grows the token-map account without zeroing the new region |
| [`93044f7442`](https://github.com/gmsol-labs/gmx-solana/commit/93044f7442) | `crates/utils/src/fixed_map.rs:140,157` | fixed-buffer-arithmetic | `data[i + 1]` shift inside a reverse loop reads one past the end on a full buffer |
| [PR #439](https://github.com/gmsol-labs/gmx-solana/pull/439) (head `c6b08561`, buggy rev) | `crates/sdk/src/position/mod.rs:224` | checked-sub-ordering (T3 hint) | `remaining_collateral_usd.checked_add(funding)?.checked_sub(collateral_value)?` is always ≤ 0, so it returns `None` in production and no liquidation price is computed |

Every fire line is the exact line the upstream fix changed. The full
cross-protocol replay (24 historical bugs across gmsol, marginfi, sanctum,
jito, tensor, wormhole, marinade, mpl, spl, drift, and klend) is in
[`bench/corpus/BENCHMARK.md`](../bench/corpus/BENCHMARK.md).

## Actual output (verbatim, offline run)

```
crates/utils/src/fixed_map.rs
    140  T2 medium  fixed-buffer-arithmetic
         Index `i + k` inside a loop bounded by `self.len()).rev()` reads one past the end on the final iteration (out-of-bounds on a full buffer).
           | self.data[i + 1] = self.data[i];
           ↳ gmsol 93044f7442 (fixed_map remove); sanctum a8623b718a (memmove offset) — https://github.com/gmsol-labs/gmx-solana/commit/93044f7442
    157  T2 medium  fixed-buffer-arithmetic
         Index `i + k` inside a loop bounded by `len` reads one past the end on the final iteration (out-of-bounds on a full buffer).
           | self.data[i] = self.data[i + 1];
           ↳ gmsol 93044f7442 (fixed_map remove); sanctum a8623b718a (memmove offset) — https://github.com/gmsol-labs/gmx-solana/commit/93044f7442

programs/store/src/instructions/exchange/execute_order.rs
    412  T1 high  disabled-constraint
         A payout/market target is derived from caller-controlled remaining_accounts (via 'market') — the output can be pointed at an account the order never authorized.
           | .market(&market)
           ↳ tensor marketplace 713db3affe; gmsol execute_order a12c0df6da — https://github.com/tensor-foundation/marketplace/commit/713db3affe
    547  T1 high  disabled-constraint
         A payout/market target is derived from caller-controlled remaining_accounts (via 'final_output_market') — the output can be pointed at an account the order never authorized.
           | .final_output_market(&final_output_market)
           ↳ tensor marketplace 713db3affe; gmsol execute_order a12c0df6da — https://github.com/tensor-foundation/marketplace/commit/713db3affe

programs/store/src/instructions/exchange/shift.rs
     54  T1 high  copy-paste-constraint
         Constraint on 'to_market_token' is identical to the one on 'from_market_token' and references 'from_market', never 'to_market_token' — the constraint appears copy-pasted, leaving 'to_market_token' effectively unconstrained.
           | #[account(constraint = from_market.load()?.meta().market_token_mint == from_market_token.key() @ CoreError::MarketTokenMintMismatched)]
           ↳ gmsol-labs/gmx-solana shift.rs constraint fix — https://github.com/gmsol-labs/gmx-solana/commit/bf2a35c6d7

programs/store/src/instructions/token_config.rs
    475  T1 medium  realloc-zero-init
         realloc(..., false) grows the account without zeroing the new region — stale bytes will be deserialized as valid data. Pass zero_init=true or explicitly zero the grown range.
           | token_map_loader.as_ref().realloc(new_space, false)?;
           ↳ gmsol a2779d14f1 (#362); mpl-token-metadata 71b36035a6; mango 69d866008c — https://github.com/gmsol-labs/gmx-solana/commit/a2779d14f1
```

## Reproduce it yourself

```bash
git clone <this repo> && cd sol-pr-guard
npm install && npm run build
npm run corpus        # replays all 24 historical bugs, offline: fires on the
                      # buggy line, silent on the fixed revision, for each
node dist/src/cli.js scan gmsol-labs/gmx-solana#<any open PR>   # live mode
```

## Honest misses

This history also contains real bugs the tool does NOT catch, and you should
know that before trusting it:

- [`107abed445`](https://github.com/gmsol-labs/gmx-solana/commit/107abed445)
  (`fix(model): fix incorrect factor used`): a wrong-getter copy-paste
  (`max_position_impact_factor_for_liquidations()` where
  `min_collateral_factor_for_liquidation()` was meant). Distinguishing this
  from correct code requires knowing the intended semantics, which a diff-local
  rule cannot infer. Scanning the pre-fix file produces zero findings.
- Anything whose bug is only visible against protocol-level invariants, live
  account state, or cross-program composition. Those need a fork test, not a
  diff scan. See "Honesty: what sol-pr-guard does not catch" in the README.
