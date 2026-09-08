// T1: a manual account-close that zeroes lamports + assigns to the system
// program but never `realloc(0)` — the system-owned account keeps a nonzero
// data length and is revivable (allocate/assign) → state resurrection.
// Evidence: jito-restaking ce5c981bef (#194, Certora AUDIT 37079). Zero-FP shape
// (the safe pattern is literally the fix: add `realloc(0, ...)`).
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'incomplete-account-close',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'Manual account close without realloc(0) — account is revivable',
  provenance: 'jito-foundation/restaking ce5c981bef (#194, Certora AUDIT 37079)',
  provenanceUrl: 'https://github.com/jito-foundation/restaking/commit/ce5c981bef',
  appliesTo: 'both' as const,
};

const ASSIGN_SYSTEM = /\.\s*assign\s*\(\s*&?\s*[\w:]*system_program\s*::\s*(id\s*\(\)|ID)/i;
// The resurrection tell is DATA-zeroing via sol_memset without a realloc(0):
// the data is cleared but the account length stays nonzero, so it is revivable.
// A plain `lamports = 0` + owner-reassign (no memset) is a common safe close
// (marinade remove_validator) and is deliberately NOT matched.
const ZEROES = /sol_memset\s*\([^;]*,\s*0\s*,/;
// Match a literal-zero realloc size regardless of suffix: `realloc(0`, `0usize`,
// `0_usize`, `0,`, `0)` all count. `\b` fails on `0usize` (0→u is not a word
// boundary), so use a negative lookahead for another digit / decimal instead.
const REALLOC_ZERO = /\.\s*realloc\s*\(\s*0(?![xX\d.])/;
// realloc(<IDENT>, ...) where IDENT is an in-file const resolving to 0 is also a
// proper shrink-to-zero close, e.g. `realloc(ZERO_LEN, false)` with
// `const ZERO_LEN: usize = 0;` (evasion E2c — a safe close must not be flagged).
const REALLOC_IDENT = /\.\s*realloc\s*\(\s*([A-Za-z_]\w*)\s*,/;
const zeroConstRe = (name: string) =>
  new RegExp(`\\bconst\\s+${name}\\s*:[^=]*=\\s*0(?![xX\\d.])`);

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const fileStripped = ctx.head.textStripped;
    for (const fn of ctx.headFacts.fns) {
      if (!ctx.changedIntersects(fn.startLine, fn.endLine)) continue;
      // Match on the MASKED body so a comment like `// caller does .realloc(0)`
      // cannot silence the finding (evasion E2b); quote from raw lines.
      const body = fn.bodyStripped;
      const asm = ASSIGN_SYSTEM.exec(body);
      if (!asm) continue;
      if (!ZEROES.test(body)) continue; // must be a close sequence, not a reassign
      if (REALLOC_ZERO.test(body)) continue; // proper close (literal 0) — safe
      // realloc(IDENT, ...) with IDENT a file-level const == 0 — also a shrink.
      const ri = REALLOC_IDENT.exec(body);
      if (ri && zeroConstRe(ri[1]).test(fileStripped)) continue;
      // The whole close sequence (assign-to-system + zero data, no realloc(0)) is
      // the finding; the fn-level changedIntersects gate above scopes it. Anchor
      // at the data-zeroing line the fix replaces (sol_memset), else the assign.
      const memIdx = body.search(/sol_memset\s*\(/);
      const anchorIdx = memIdx >= 0 ? memIdx : asm.index;
      const lineInFn = body.slice(0, anchorIdx).split('\n').length - 1;
      const abs = fn.bodyStartLine + lineInFn;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: abs,
          message:
            'Account is closed by zeroing lamports and assigning to the system program, but its data is never realloc(0)-ed — a system-owned account with nonzero data length can be revived (allocate/assign). Add realloc(0, false)?.',
          evidence: quote(lines, abs),
        })
      );
    }
    return out;
  },
};

export default rule;
