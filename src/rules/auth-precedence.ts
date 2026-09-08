// T1: an access-control `if` mixing || and && at the same (unparenthesized)
// level, where an operand mentions authority/manager/owner/delegate/signer.
// Rust binds && tighter than ||, so `A || B && C` != `(A || B) && C`.
// Evidence: mpl-core 1a68114713 (UpdateDelegate revoke precedence bug).
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'auth-precedence',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'Auth condition mixes && and || without disambiguating parentheses',
  provenance: 'metaplex mpl-core 1a68114713 (#253)',
  provenanceUrl: 'https://github.com/metaplex-foundation/mpl-core/commit/1a68114713',
  appliesTo: 'both' as const,
};

const AUTH = /(authorit|manager|owner|delegate|signer|admin|is_signer)/i;

/** Read the condition text of an `if` starting on line `ln`, up to the block
 *  `{` at paren-depth 0. `lines` MUST be the masked (comment/string-blanked)
 *  lines so a `//` comment or a `"a && b"` string cannot fake the &&/|| mix.
 *  Returns {text, endLine} or null. */
function readCondition(
  lines: string[],
  ln: number
): { text: string; endLine: number } | null {
  const first = lines[ln - 1];
  const ifIdx = first.search(/\bif\b/);
  if (ifIdx === -1) return null;
  let started = false;
  let depth = 0;
  let text = '';
  let cur = ifIdx + 2; // just after "if"
  for (let l = ln; l <= Math.min(lines.length, ln + 25); l++) {
    const code = lines[l - 1];
    for (let i = l === ln ? cur : 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') {
        depth++;
        started = true;
        text += ch;
      } else if (ch === ')') {
        depth--;
        text += ch;
      } else if (ch === '{' && depth === 0) {
        return { text, endLine: l };
      } else {
        text += ch;
      }
    }
    text += '\n';
    cur = 0;
  }
  return null;
}

/** True if both || and && appear at paren-depth 0 of the condition. */
function mixesTopLevel(cond: string): boolean {
  let depth = 0;
  let hasOr = false;
  let hasAnd = false;
  for (let i = 0; i < cond.length; i++) {
    const ch = cond[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === '|' && cond[i + 1] === '|') {
      hasOr = true;
      i++;
    } else if (depth === 0 && ch === '&' && cond[i + 1] === '&') {
      hasAnd = true;
      i++;
    }
  }
  return hasOr && hasAnd;
}

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      const code = linesStripped[ln - 1];
      if (!/^\s*(\}\s*)?(else\s+)?if\b/.test(code)) continue;
      if (/\bif\s+let\b/.test(code)) continue;
      const cond = readCondition(linesStripped, ln);
      if (!cond) continue;
      if (!ctx.changedIntersects(ln, cond.endLine)) continue;
      if (!AUTH.test(cond.text)) continue;
      if (!mixesTopLevel(cond.text)) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          endLine: cond.endLine,
          message:
            'Access-control condition mixes && and || without parentheses. Because && binds tighter than ||, the intended grouping may not hold and an authority check can apply to only one branch.',
          evidence: quote(lines, ln, Math.min(cond.endLine, ln + 5)),
        })
      );
    }
    return out;
  },
};

export default rule;
