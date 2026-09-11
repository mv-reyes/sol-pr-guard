// T3 (low confidence, summary-only): a `checked_sub` whose subtrahend is a
// full-value/total term subtracted from a RESIDUAL term (remaining/residual/
// net) built by a checked_add/mul chain and propagated with `?` — when the
// residual already nets out the value, the subtraction underflows to None at
// runtime and the whole computation dies (verify the ordering: subtract the
// complement instead).
// Evidence: gmsol-labs/gmx-solana PR #439 head c6b08561,
// crates/sdk/src/position/mod.rs:222-226 — `remaining_collateral_usd
//   .checked_add(pending_funding_fee_value)?
//   .checked_sub(collateral_value)?`
// is always <= 0 (it equals impact - borrowing_fee - close_order_fee), so the
// checked_sub returns None in production and no liquidation price is computed
// for same-token-collateral positions.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote, lineOfIndex } from './helpers';

const meta = {
  id: 'checked-sub-ordering',
  tier: 3 as const,
  severity: 'low' as const,
  title: 'checked_sub of a full-value term from a residual underflows to None',
  provenance: 'gmsol-labs/gmx-solana PR #439 c6b08561 (residual - collateral_value always None)',
  provenanceUrl: 'https://github.com/gmsol-labs/gmx-solana/pull/439',
  appliesTo: 'both' as const,
};

// Start from each propagated `.checked_sub(<term>)?` and walk BACKWARD over
// `.checked_add/checked_mul(…)?` links to the chain's base identifier — this
// never lets a lazy regex swallow an intervening `.and_then(|a| …)` closure
// (the gmsol fn has one right above the bug).
const SUB_Q = /\.\s*checked_sub\s*\(\s*([A-Za-z_][\w.]*)\s*\)\s*\?/g;
const LINK_BACK =
  /([A-Za-z_]\w*)\s*\.\s*(?:checked_add|checked_add_signed|checked_mul|checked_mul_add)\s*\(\s*[^();]*\s*\)\s*\??\s*$/;
// The minuend must be a RESIDUAL (already netted) term…
const RESIDUAL = /(remaining|residual|^net_|\bnet_|_net\b)/i;
// …and the subtrahend a FULL value/total term. Both gates are required — a
// bare `a.checked_sub(b)` never fires.
const FULL_VALUE = /(_value\b|^total_|\btotal_|collateral|size_in_)/i;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    for (const fn of ctx.headFacts.fns) {
      // Match on the MASKED body so a comment cannot fake the chain shape.
      const body = fn.bodyStripped;
      SUB_Q.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SUB_Q.exec(body))) {
        const subtrahend = m[1];
        if (!FULL_VALUE.test(subtrahend)) continue;
        // walk backward over the checked_add/mul links to the chain base.
        let end = m.index;
        let minuend: string | undefined;
        for (;;) {
          const pre = body.slice(0, end);
          const lm = pre.match(LINK_BACK);
          if (!lm) break;
          minuend = lm[1];
          end = pre.length - lm[0].length;
        }
        if (!minuend || !RESIDUAL.test(minuend)) continue;
        const abs = fn.bodyStartLine + lineOfIndex(body, m.index) - 1;
        if (!ctx.changedIntersects(abs, abs)) continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: abs,
            message:
              `\`${minuend} … .checked_sub(${subtrahend})?\` subtracts a full-value term from a residual — if the residual already nets out ${subtrahend}, this underflows to None at runtime. Verify the ordering (subtract the complement instead).`,
            evidence: quote(lines, abs),
          })
        );
      }
    }
    return out;
  },
};

export default rule;
