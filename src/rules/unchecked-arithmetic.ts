// T1-category, emitted at confidence tier 3 (summary-only): raw +/-/* on
// amount/lamport-typed variables in program code with no checked_/saturating_.
// Lowest-precision rule by design -> tier 3 so it never blocks or inlines.
// Evidence: jito 1455366f44 (raw lamport arithmetic).
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'unchecked-arithmetic',
  tier: 3 as const,
  severity: 'low' as const,
  title: 'Raw arithmetic on amount/lamport values without checked_/saturating_',
  provenance: 'jito 1455366f44 (soteria unchecked arithmetic)',
  provenanceUrl: 'https://github.com/jito-foundation/jito-programs/commit/1455366f44',
  appliesTo: 'both' as const,
};

const MONEY = /(lamport|amount|balance|\bfee\b|reward|stake|supply|deposit|collateral|debt|payout|tips?|token_amount)/i;
// binary + or - or * between two identifier-ish operands.
const BINOP = /([A-Za-z_][\w.]*(?:\([^)]*\))?)\s*([+\-*])\s*([A-Za-z_][\w.]*(?:\([^)]*\))?)/;
// compound assignment on an amount-typed lhs (e.g. `x += tips`).
const COMPOUND = /([A-Za-z_][\w.*()?\[\]]*?)\s*([+\-*])=\s*([^;]+)/;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      const code = linesStripped[ln - 1];
      if (!/[+\-*]/.test(code)) continue;
      if (/checked_|saturating_|wrapping_|overflowing_/.test(code)) continue;
      let a: string;
      let b: string;
      const comp = code.match(COMPOUND);
      if (comp) {
        a = comp[1];
        b = comp[3];
      } else {
        const m = code.match(BINOP);
        if (!m) continue;
        a = m[1];
        b = m[3];
      }
      // require at least one operand to look money-typed.
      if (!MONEY.test(a) && !MONEY.test(b)) continue;
      // avoid obvious constants/indices/type params.
      if (/\b(len|index|idx|LEN|SIZE|size_of|DECIMALS)\b/.test(a + ' ' + b)) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          message:
            'Raw arithmetic on an amount/lamport value without checked_/saturating_ — verify it cannot overflow/underflow with attacker-influenced inputs.',
          evidence: quote(lines, ln),
        })
      );
    }
    return out;
  },
};

export default rule;
