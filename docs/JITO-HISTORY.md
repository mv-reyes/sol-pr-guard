# sol-pr-guard over jito-programs' merged history

I ran sol-pr-guard over the jito-foundation/jito-programs PR/commit history
as part of the detector benchmark. Method: for each historical fix commit,
check out the pre-fix revision, scan it, and confirm the tool (a) fires on
the buggy line and (b) is silent on the fixed revision. Everything below
reproduces offline.

## What it found

| Fix commit | File:line | Detector | Class |
|---|---|---|---|
| [`5be43ef2c7`](https://github.com/jito-foundation/jito-programs/commit/5be43ef2c7) (#153) | `mev-programs/programs/vote-state/src/lib.rs:277` | closed-enum-deserialize | `VoteState::deserialize` bincode-deserializes an entire ~3.7 KB versioned vote account into the closed 3-variant enum `VoteStateVersions`: the moment the vote program writes a new variant (VoteStateV4), deserialization fails outright and the affected validator can never create its per-epoch Tip/PriorityFee Distribution Account |

This one is the standout of the whole benchmark. The bug shipped with the
program in 2022 and sat in every merged tree for years, through the
priority-fee-distribution work in PR #136 and the cleanup in #143, until
PR #153 ("Generic Vote Parsing") fixed it in December 2025 without ever
calling it a bug. The #153 body just says: *"New VoteStateV4 is coming.
Instead of continuing to add new VoteStates, we can pull the first bytes
[4..36] from the data structures."* The fix, an owner check plus a raw
`data[4..36]` node-pubkey read, is exactly the bug-shaped fix: parse the
one field you need at a fixed offset instead of fully deserializing a
versioned external account into a closed local enum. sol-pr-guard flags it
in one pass.

One method note, for honesty: the corpus entry (`jito-5be43ef2c7`) replays
the **fix commit's** pre-revision, not the introducing PR's diff. PR #136's
diff never touches `vote-state/src/lib.rs`. The bug predates it and sat
unchanged, so a diff-scoped scan of #136 has nothing to fire on. What the
corpus asserts is: scan the file as it existed the commit before #153 and
the detector fires on the deserialize line; scan the file after #153 and it
is silent.

The full cross-protocol replay (23 historical bugs across gmsol, marginfi,
sanctum, jito, tensor, wormhole, marinade, mpl, spl, drift, and klend) is in
[`bench/corpus/BENCHMARK.md`](../bench/corpus/BENCHMARK.md).

## Actual output (verbatim, offline run)

```
mev-programs/programs/vote-state/src/lib.rs
    277  T2 medium  closed-enum-deserialize
         full deserialize of an externally-owned account into the closed enum `VoteStateVersions` — any new upstream variant becomes a permanent deserialization failure (DoS). Parse the needed fields at fixed offsets instead.
           | deserialize::<Box<VoteStateVersions>>(&data)
```

## Reproduce it yourself

```bash
git clone <this repo> && cd sol-pr-guard
npm install && npm run build
npm run corpus        # replays all 23 historical bugs, offline: fires on the
                      # buggy line, silent on the fixed revision, for each
node dist/src/cli.js scan jito-foundation/jito-programs#<any open PR>   # live mode
```

## Honest misses

This history also contains real bugs the tool does NOT catch, and you should
know that before trusting it:

- [PR #146](https://github.com/jito-foundation/jito-programs/pull/146)
  ("H-01: Rent goes back to the Claimer rent payer"): `CloseClaimStatus` was
  declared `#[account(mut, close = claim_status_payer)]` while
  `claim_status_payer` was pinned by `address = config.expired_funds_account`,
  so anyone could permissionlessly close any expired ClaimStatus and the
  rent lamports went to Jito's fixed expired-funds account, never to the
  user who paid the rent at `claim`. This was **audit-known** (the project's
  own H-01, fixed publicly via the #146 title), not a discovery. The tool
  currently has no detector for a close receiver pinned to a fixed/config
  address instead of the recorded payer, listed here as a known gap
  ("pinned-close-receiver").
- A mutate-then-conditional-skip ordering smell in
  `increment_total_lamports_transferred` (counter incremented before the
  go-live gate returns early without transferring; PR #138's own test
  codifies the behavior, so the project intended it) and a stored
  unvalidated instruction-arg bump (`distribution_acc.bump = bump` instead
  of `ctx.bumps.*`, self-inflicted only). Neither has a detector; both are
  low severity and would not survive an audit dispute as written.
- Anything whose bug is only visible against protocol-level invariants, live
  account state, or cross-program composition. Those need a fork test, not a
  diff scan. See "Honesty: what sol-pr-guard does not catch" in the README.
