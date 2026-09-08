// T1: a bounds check on a SIGNED value that only checks one side of the range
// (`if MAX_FEE_BPS < fee_bps_i16 { Err }`) — a large-magnitude negative value
// (e.g. a >100% rebate) passes. Fix: `!(-MAX..=MAX).contains(&x)`.
// Evidence: sanctum e081f6e8b1 (#192, OtterSec). Near-zero FP.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote, fnContaining } from './helpers';

const meta = {
  id: 'one-sided-bound-signed',
  tier: 1 as const,
  severity: 'medium' as const,
  title: 'One-sided bound on a signed value (negative side unchecked)',
  provenance: 'igneous-labs/S e081f6e8b1 (#192, OtterSec)',
  provenanceUrl: 'https://github.com/igneous-labs/S/commit/e081f6e8b1',
  appliesTo: 'both' as const,
};

// `if <MAX const> < <ident>` or `if <ident> > <MAX const>` — an upper-only bound.
const UPPER_ONLY =
  /\bif\s+(?:!?\s*)(?:([A-Z][A-Z0-9_]*)\s*<\s*([A-Za-z_]\w*)|([A-Za-z_]\w*)\s*>\s*([A-Z][A-Z0-9_]*))/;
// signals that the checked value is signed.
const SIGNED_HINT = /(_i8|_i16|_i32|_i64|_i128|\bi8\b|\bi16\b|\bi32\b|\bi64\b|\bi128\b|signed)/;
// signals a lower bound / full-range check is present (so it is NOT one-sided).
const LOWER_PRESENT =
  /(-\s*[A-Z][A-Z0-9_]*|\.contains\s*\(|MIN\b|>=\s*0|>\s*0|<\s*0|\.\.=|\.abs\s*\(\)|0\s*<=)/;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      const code = linesStripped[ln - 1];
      const m = code.match(UPPER_ONLY);
      if (!m) continue;
      const constName = m[1] || m[4] || '';
      const varName = m[2] || m[3] || '';
      if (!/MAX|BOUND|LIMIT|CAP/.test(constName)) continue; // must be an upper limit const
      // The value must be signed: by name, by the enclosing fn's signature, or
      // the fn is a *bound*/*verify* helper over a signed arg.
      const fn = fnContaining(ctx.headFacts, ln);
      // Match LOWER_PRESENT on the MASKED body so a `// >= -MAX checked by caller`
      // comment cannot fake a lower bound and silence the finding (evasion E6b).
      const fnText = fn ? fn.bodyStripped : '';
      const sigText = (fn?.name ?? '') + ' ' + fn?.params.map((p) => `${p.name}:${p.type}`).join(' ');
      const signed = SIGNED_HINT.test(varName) || SIGNED_HINT.test(sigText);
      if (!signed) continue;
      // A lower bound anywhere in the enclosing fn clears it.
      if (LOWER_PRESENT.test(fnText)) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          message:
            `Signed value '${varName}' is bounded only above (against ${constName}); a large negative value passes. Check the full range, e.g. !(-${constName}..=${constName}).contains(&${varName}).`,
          evidence: quote(lines, ln),
        })
      );
      break;
    }
    return out;
  },
};

export default rule;
