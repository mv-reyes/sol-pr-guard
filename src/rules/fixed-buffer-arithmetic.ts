// T2: fixed-buffer index/pointer arithmetic errors.
//  (a) `arr[i + k]` inside `for i in lo..len` -> reads one past the end;
//  (b) `ptr::copy(src.add(n), dst_base, ..)` -> memmove to base instead of +offset.
// Evidence: gmsol 93044f7442 (fixed_map remove OOB), sanctum a8623b718a (memmove).
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote, braceBlockFrom } from './helpers';

const meta = {
  id: 'fixed-buffer-arithmetic',
  tier: 2 as const,
  severity: 'medium' as const,
  title: 'Fixed-buffer index/pointer arithmetic may read/write out of bounds',
  provenance: 'gmsol 93044f7442 (fixed_map remove); sanctum a8623b718a (memmove offset)',
  provenanceUrl: 'https://github.com/gmsol-labs/gmx-solana/commit/93044f7442',
  appliesTo: 'both' as const,
};

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching

    // (a) for <i> in <lo>..<len-ish> { ... arr[i + k] ... }
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      const code = linesStripped[ln - 1];
      const fm = code.match(
        /\bfor\s+([A-Za-z_]\w*)\s+in\s+[^.]*\.\.\s*([A-Za-z_][\w().]*)/
      );
      if (!fm) continue;
      const idx = fm[1];
      const upper = fm[2];
      if (!/(len|count|capacity|size|N|LEN)/.test(upper)) continue; // length-ish bound
      // A strided loop (`.step_by(k)`) with `[i+1]` addresses a pair element, not
      // an out-of-bounds read (mango token_deregister.rs pairs banks+vaults).
      if (/\.step_by\s*\(/.test(code)) continue;
      const blk = braceBlockFrom(linesStripped, ln);
      if (!blk) continue;
      const oob = new RegExp(`\\[\\s*${idx}\\s*\\+\\s*\\d+\\s*\\]`);
      for (let l = blk.open; l <= blk.close; l++) {
        if (!ctx.changedIntersects(l, l)) continue;
        if (oob.test(linesStripped[l - 1])) {
          out.push(
            makeFinding(meta, {
              file: ctx.file,
              line: l,
              message:
                `Index \`${idx} + k\` inside a loop bounded by \`${upper}\` reads one past the end on the final iteration (out-of-bounds on a full buffer).`,
              evidence: quote(lines, l),
            })
          );
          break;
        }
      }
    }

    // (b) ptr::copy(src.add(..), dst, ..) with dst a bare pointer (no .add).
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      // join up to 3 lines to catch multi-line copy(...) calls.
      const joined = [linesStripped[ln - 1], linesStripped[ln] ?? '', linesStripped[ln + 1] ?? '']
        .join(' ');
      const m = joined.match(
        /\b(?:std::)?ptr::copy(?:_nonoverlapping)?\s*\(\s*([A-Za-z_][\w.]*)\s*\.\s*add\s*\([^)]*\)\s*,\s*([A-Za-z_][\w.]*)\s*,/
      );
      if (!m) continue;
      const dst = m[2];
      // dst must NOT itself be offset with .add( to be suspicious.
      if (/\.add\s*\(/.test(dst)) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          message:
            `ptr::copy writes to base pointer '${dst}' while the source is offset with .add(..) — the destination is likely missing its own offset, corrupting the buffer on any non-zero index.`,
          evidence: quote(lines, ln, Math.min(lines.length, ln + 2)),
        })
      );
    }

    return out;
  },
};

export default rule;
