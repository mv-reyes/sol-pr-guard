// T2: full bincode deserialize of an externally-owned, VERSIONED native/sysvar
// account into a CLOSED local enum (`*Versions`) — the moment the upstream
// program writes a new variant, deserialization fails permanently and every
// code path needing the account is dead (protocol-level DoS). The safe pattern
// is an offset/length-prefixed partial parse of just the fields you need
// (jito's own fix reads `&data[4..36]` for the node pubkey).
// Evidence: jito-programs PR #136 merge 24ec5d8 —
// mev-programs/programs/vote-state/src/lib.rs:271-280 did
// `bincode::deserialize::<Box<VoteStateVersions>>(&data)` on a raw vote
// account; fixed by PR #153 (5be43ef, "Generic Vote Parsing") when
// VoteStateV4 was announced.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'closed-enum-deserialize',
  tier: 2 as const,
  severity: 'medium' as const,
  title: 'Full deserialize of a versioned external account into a closed enum',
  provenance: 'jito-programs 24ec5d8 (VoteStateVersions full bincode deserialize DoS)',
  provenanceUrl: 'https://github.com/jito-foundation/jito-programs/pull/136',
  appliesTo: 'both' as const,
};

// deserialize::<[Box<]>FooVersions> / try_from_slice::<[Box<]>FooVersions> —
// the *Versions name marks a closed enum mirroring an upstream versioned layout.
const FULL_DESER =
  /\b(?:bincode::)?(?:deserialize|try_from_slice)::<\s*(?:Box\s*<\s*)?([A-Za-z_]\w*Versions)\b/;
// An offset/length-prefixed partial parse (`&data[4..36]`) is the safe fix.
const PARTIAL_PARSE = /\[\s*\d+\s*\.\.=?/;
// The account is externally owned: raw AccountInfo data borrows / owner checks.
const EXTERNAL_ACCOUNT = /(AccountInfo|try_borrow_data|\.data\.borrow\s*\()/;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching
    if (!EXTERNAL_ACCOUNT.test(ctx.head.textStripped)) return out;
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      // Join wrapped continuations (rustfmt breaks the turbofish / args).
      let logical = linesStripped[ln - 1];
      for (let k = ln; k < linesStripped.length && !logical.includes(';') && k - ln < 4; k++) {
        logical += ' ' + linesStripped[k].trim();
      }
      const m = logical.match(FULL_DESER);
      if (!m) continue;
      // partial offset/length-prefixed parse of the same buffer is the safe shape.
      if (PARTIAL_PARSE.test(logical)) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          message:
            `full deserialize of an externally-owned account into the closed enum \`${m[1]}\` — any new upstream variant becomes a permanent deserialization failure (DoS). Parse the needed fields at fixed offsets instead.`,
          evidence: quote(lines, ln),
        })
      );
    }
    return out;
  },
};

export default rule;
