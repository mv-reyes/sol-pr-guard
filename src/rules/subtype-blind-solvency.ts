// T2: an aggregate solvency/health/bankruptcy loop over ALL positions that
// never filters by position subtype (isolated vs cross), when such a subtype
// flag exists in the same file — segregated positions leak into the aggregate
// solvency decision (wrongful bankruptcy flag / insurance-fund draw).
// Evidence: drift protocol-v2 PR #1757 merge 97355509a — is_cross_margin_bankrupt
// iterated user.perp_positions treating quote_asset_amount < 0 as a cross
// liability without skipping isolated positions; fixed by b7fff7875 adding
// `if perp_position.is_isolated() { continue; }`.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote, lineOfIndex } from './helpers';

const meta = {
  id: 'subtype-blind-solvency',
  tier: 2 as const,
  severity: 'medium' as const,
  title: 'Aggregate solvency loop ignores a position subtype flag',
  provenance: 'drift protocol-v2 97355509a (is_cross_margin_bankrupt counts isolated positions)',
  provenanceUrl: 'https://github.com/velocity-exchange/protocol-v2/pull/1757',
  appliesTo: 'both' as const,
};

// The fn computes a solvency/health/bankruptcy/liquidation predicate.
const SOLVENCY = /(bankrupt|solvenc|insolvent|health|liquidatab|margin_calc)/i;
// A loop over a positions/balances/accounts collection (drift iterates
// user.perp_positions / user.spot_positions). No leading \b on the collection
// noun — `_` is a word char, so `\bpositions\b` cannot match `perp_positions`.
const LOOP = /\bfor\s+[A-Za-z_]\w*\s+in\s+([^;{}]*?(?:positions|balances|accounts)\b[^;{}]*?)\{/g;
// A subtype/kind filter applied to the loop element — in the iterator
// expression (`.filter(|p| !p.is_isolated())`) or the loop body
// (`if p.is_isolated() { continue; }`, `match p.balance_type { .. }`).
const SUBTYPE_FILTER = /(is_isolated|isolated|\w+_type\b|\w+_kind\b|margin_type|subtype)/;
// The file knows a subtype flag exists at all (else there is nothing to miss).
const SUBTYPE_EXISTS = /(is_isolated|isolated_position|margin_type|position_kind|position_type)/;

/** Balanced-brace body following the `{` at `openIdx` in `text`. */
function blockAfter(text: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return text.slice(openIdx + 1);
}

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    if (!SUBTYPE_EXISTS.test(ctx.head.textStripped)) return out; // no subtype flag in play
    for (const fn of ctx.headFacts.fns) {
      // Match on the MASKED body so a `// skip isolated positions` comment
      // cannot fake a subtype filter.
      const body = fn.bodyStripped;
      if (!SOLVENCY.test(fn.name ?? '') && !SOLVENCY.test(body)) continue;
      LOOP.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LOOP.exec(body))) {
        const iterExpr = m[1];
        const loopBody = blockAfter(body, m.index + m[0].length - 1);
        // a subtype filter anywhere in the iterator chain or loop body is safe.
        if (SUBTYPE_FILTER.test(iterExpr) || SUBTYPE_FILTER.test(loopBody)) continue;
        const abs = fn.bodyStartLine + lineOfIndex(body, m.index) - 1;
        if (!ctx.changedIntersects(abs, abs)) continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: abs,
            message:
              `solvency/bankruptcy loop over \`${iterExpr.trim()}\` never filters by position subtype — this file has a subtype flag (isolated/kind), so segregated positions leak into the aggregate solvency decision.`,
            evidence: quote(lines, abs),
          })
        );
      }
    }
    return out;
  },
};

export default rule;
