// T1: a lossy `as` cast on an amount/value variable — most dangerously
// `u64 as i64` in accounting, where any value above i64::MAX wraps negative
// (an outflow recorded as an inflow credit). Distinct from unchecked-arithmetic
// (raw +/-) and cast-panic (.try_into().unwrap()). The fix idiom is
// `i64::try_from(x)`. Evidence: marginfi 2d6de777ef (rate limiter i64 wrap).
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'lossy-as-cast',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'Lossy `as` cast on an amount/value (u64 as i64 wraps negative)',
  provenance: 'marginfi-v2 2d6de777ef (rate-limiter amount as i64)',
  provenanceUrl: 'https://github.com/mrgnlabs/marginfi-v2/commit/2d6de777ef',
  appliesTo: 'both' as const,
};

// A value-bearing operand cast to a signed / narrower integer type.
// Value/amount operands only. Deliberately NOT bare `max_`/`rate`/`price`/`age`
// (those match time thresholds like `max_age`, `slot`, oracle staleness — not
// values that wrap). `max_outflow`/`max_amount` are already covered by outflow/amount.
const MONEYISH = /(amount|outflow|inflow|balance|\bfee\b|reward|stake|supply|deposit|collateral|debt|payout|lamport|shares?)/i;
// `<expr> as (i8|i16|i32|i64|u8|u16|u32)` — sign-changing (u64 -> signed) or
// width-narrowing casts. `as i128`/`as u64`/`as u128`/`as usize` are widening or
// index casts (lossless / safe; the marginfi fix itself widens to i128) — skipped.
const CAST = /([A-Za-z_][\w.()]*)\s+as\s+(i8|i16|i32|i64|u8|u16|u32)\b/g;
// Index-like trailing suffixes. `\bindex\b` alone cannot match `balance_index`
// (`_` is a word char — marginfi #615 FP: `balance_index as u8` on a raw array
// index into a fixed-size balances array). Strip these suffixes off the operand
// before the MONEYISH / skip-name matching below.
const IDX_SUFFIX = /(?:_(?:index|idx|count|len|decimals|bump|slot|epoch))+$/i;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      const code = linesStripped[ln - 1];
      CAST.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CAST.exec(code))) {
        const operand = m[1];
        const target = m[2];
        // require the operand to look like a value/amount (not an index/enum).
        if (!MONEYISH.test(operand)) continue;
        // skip obvious constants and bound-sentinels (`i64::MAX as i128` etc.).
        if (/^(i\d+|u\d+)::/.test(operand)) continue;
        if (/\b(len|idx|index|decimals|bump|slot|epoch|count)\b/i.test(operand)) continue;
        // a value-named variable that ends in an index-like suffix is an index
        // (`balance_index`, `fee_idx`), not a value — strip-and-skip (marginfi #615).
        if (IDX_SUFFIX.test(operand)) continue;
        // an already range-clamped value cast to the clamp's own type is safe
        // (`x.clamp(i64::MIN.., i64::MAX..) as i64`).
        if (/\.\s*clamp\s*\(/.test(operand)) continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: ln,
            message:
              `'${operand} as ${target}' is a lossy cast on a value — a u64 above ${target}::MAX wraps (e.g. an outflow recorded as an inflow). Use ${target}::try_from(${operand}).`,
            evidence: quote(lines, ln),
          })
        );
        break; // one finding per line
      }
    }
    return out;
  },
};

export default rule;
