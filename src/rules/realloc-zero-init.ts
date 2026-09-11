// T1: account lifecycle smells.
//  (a) `.realloc(<expr>, false)` — grown region keeps stale bytes;
//  (b) full-range zeroing before re-serialize (clobbers header/flag bytes);
//  (c) `#[account(close = ..)]` on an account the handler also closes manually.
// Evidence: gmsol a2779d14f1 (realloc false), mpl-tm 71b36035a6 (zero-fill flag),
//           mango 69d866008c (double close on insurance vault).
import { Rule, RuleContext, Finding } from '../types';
import { fieldScopeStart, makeFinding, quote } from './helpers';

const meta = {
  id: 'realloc-zero-init',
  tier: 1 as const,
  severity: 'medium' as const,
  title: 'Unsafe realloc / account zeroing / double-close',
  provenance: 'gmsol a2779d14f1 (#362); mpl-token-metadata 71b36035a6; mango 69d866008c',
  provenanceUrl: 'https://github.com/gmsol-labs/gmx-solana/commit/a2779d14f1',
  appliesTo: 'both' as const,
};

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching

    // (a) realloc(expr, false)
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      const code = linesStripped[ln - 1];
      const m = code.match(/\.\s*realloc\s*\(\s*([^,]+),\s*false\s*\)/);
      if (m) {
        // realloc to 0 is a SHRINK (manual close) — there is no grown region to
        // zero, so zero_init=false is irrelevant/safe (phoenix governance.rs).
        // Recognize any zero literal: `0`, `0usize`, `0u64`, `0_usize`, `0x0`.
        const sz = m[1]
          .trim()
          .replace(/_/g, '')
          .replace(/(usize|isize|u8|u16|u32|u64|u128|i8|i16|i32|i64|i128)$/i, '');
        if (/^(0+|0x0+)$/i.test(sz)) continue;
        // Safe pattern: the grown range is explicitly zeroed right after —
        // inline (`fill(0)`/memset/write of zeros/loop-assign-0) OR via a helper
        // whose name says it zeroes/clears the region. Match on MASKED lines so a
        // `// .fill(0) in helper` comment cannot silence the finding (E3b).
        const after = linesStripped.slice(ln, ln + 6).join('\n');
        if (
          /(\.fill\s*\(\s*0\s*\)|sol_memset\s*\([^,]+,\s*0\s*,|write_all\s*\(\s*&?\[?0|for\s+\w+\s+in[^{]*\{\s*[^}]*=\s*0)/.test(after) ||
          /\b(zero|memset|clear|wipe|scrub|zeroize|zero_init|zero_grown|reset)\w*\s*\(/i.test(after)
        )
          continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: ln,
            message:
              'realloc(..., false) grows the account without zeroing the new region — stale bytes will be deserialized as valid data. Pass zero_init=true or explicitly zero the grown range.',
            evidence: quote(lines, ln),
          })
        );
      }
    }

    // (b) full-range zero-fill of account data before a re-serialize.
    for (const fn of ctx.headFacts.fns) {
      if (!ctx.changedIntersects(fn.startLine, fn.endLine)) continue;
      const body = fn.bodyStripped; // masked; offsets preserved for anchoring
      const re =
        /([A-Za-z_]\w*)(?:\.borrow_mut\(\)|\.try_borrow_mut_data\(\)\??|\.data\.borrow_mut\(\))?\s*\[\s*\.\.\s*\]\s*\.\s*fill\s*\(\s*0\s*\)|sol_memset\s*\([^,]+,\s*0\s*,/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) {
        // only if the same fn later re-serializes / writes back a header/flag.
        if (!/(serialize|save|pack|write|store|flag|header)/i.test(body)) continue;
        const lineInFn = body.slice(0, m.index).split('\n').length - 1;
        const abs = fn.bodyStartLine + lineInFn;
        if (!ctx.changedIntersects(abs, abs)) continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: abs,
            message:
              'The whole account buffer is zero-filled before re-serialize — this can clobber header/flag bytes (e.g. a fee flag) that must be preserved.',
            evidence: quote(lines, abs),
          })
        );
      }
    }

    // (c) `close =` field also closed manually in a handler using this struct.
    for (const st of ctx.headFacts.structs) {
      if (!st.isAccounts) continue;
      for (const f of st.fields) {
        if (!f.name) continue;
        const hasClose = f.accountAttrs.some((a) => a.keys.includes('close'));
        if (!hasClose) continue;
        if (!ctx.changedIntersects(fieldScopeStart(f), f.endLine)) continue;
        // a handler bound to this struct that also closes the field manually.
        const manualClose = ctx.headFacts.fns.some(
          (fn) =>
            fn.contextType === st.name &&
            new RegExp(`(close_account|CloseAccount)[\\s\\S]*\\b${f.name}\\b`).test(
              fn.bodyStripped
            )
        );
        if (manualClose) {
          out.push(
            makeFinding(meta, {
              file: ctx.file,
              line: f.startLine,
              message:
                `Account '${f.name}' has \`close =\` in its Anchor constraint but is also closed manually in the handler — double-close / rent misdirection.`,
              evidence: quote(lines, f.startLine),
            })
          );
        }
      }
    }

    return out;
  },
};

export default rule;
