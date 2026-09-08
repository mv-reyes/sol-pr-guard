// T1: discarded checked_* result, or an error-log-without-exit validation.
// Evidence: jito tip-distribution 32d72f136c (bare `.checked_add(..).unwrap();`),
//           wormhole 972939ee31 (`if mismatch { msg!(...) }` with no return Err).
import { Rule, RuleContext, Finding } from '../types';
import {
  makeFinding,
  quote,
  braceBlockFrom,
} from './helpers';

const meta = {
  id: 'discarded-checked-result',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'Checked computation or failed check has no effect',
  provenance: 'jito tip-distribution #56; wormhole pyth2wormhole attest fix',
  provenanceUrl:
    'https://github.com/jito-foundation/jito-programs/commit/32d72f136c',
  appliesTo: 'both' as const,
};

const CHECKED_STMT =
  /^[A-Za-z_][\w.:\[\]()?]*\s*\.\s*checked_(?:add|sub|mul|div|pow|rem)\s*\(/;
const ERROR_WORDS =
  /(mismatch|invalid|incorrect|unauthori|expected|must match|does not match|not match|out of bound|overflow|not allowed|wrong)/i;
const EXIT_TOKENS =
  /(return\b|\bErr\s*\(|\?\s*;|\bbail!|\bpanic!|\bunreachable!|\brequire|\bassert|\.into\(\)\s*\)?\s*;?\s*$|abort)/;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching

    // (a) bare expression statement discarding a checked_* result.
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      let code = linesStripped[ln - 1].trim();
      // A `let _ = ...` / `let _unused = ...` binds to a throwaway — the result
      // is discarded just like a bare statement. Strip that prefix and analyze
      // the RHS. A NON-underscore `let x = ...` is a real binding: skip it.
      const discardBind = code.match(/^let\s+(_\w*)\s*=\s*(.+)$/);
      if (discardBind) {
        code = discardBind[2].trim();
      } else if (/^(let|return|const|static)\b/.test(code)) {
        continue;
      }
      if (!CHECKED_STMT.test(code)) continue;
      // must be a full statement ending in `;`, result NOT bound/returned.
      if (!code.endsWith(';')) continue;
      if (/[^=!<>]=[^=]/.test(code)) continue; // an assignment `x = ...`
      // skip continuation of a multi-line assignment: `x =` on the prior line.
      if (!discardBind) {
        let prev = ln - 1;
        while (prev >= 1 && linesStripped[prev - 1].trim() === '') prev--;
        const prevCode = prev >= 1 ? linesStripped[prev - 1].trim() : '';
        if (/[^=!<>]=$/.test(prevCode) || prevCode.endsWith('=')) continue;
      }
      if (/\?\s*;$/.test(code)) continue; // `?;` propagates (not fully dropped)
      // require the value is genuinely dropped: ends `.unwrap();`, `.expect(..);`
      // or a bare `);` with no consumer.
      if (!/(\.unwrap\(\)\s*;|\.expect\([^)]*\)\s*;|\)\s*;)$/.test(code)) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          message:
            'Result of checked arithmetic is discarded (bare statement) — the overflow-guarded value is never stored, so the check and the update are both lost.',
          evidence: quote(lines, ln),
        })
      );
    }

    // (b) an `if <validation> { ...error-log... }` block with no exit.
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      const code = linesStripped[ln - 1];
      if (!/^\s*if\b/.test(code)) continue;
      const blk = braceBlockFrom(linesStripped, ln); // masked: correct brace nesting
      if (!blk) continue;
      if (blk.close - blk.open > 40) continue; // huge block: skip (precision)
      // fire if the change touched anywhere in the if..block (header or body).
      if (!ctx.changedIntersects(ln, blk.close)) continue;
      // POSITIVE signals read RAW text: the error word and account token live in
      // the `msg!("...")` message STRING, which is legitimately part of what this
      // rule matches (a string can only ADD a finding, never suppress one, and
      // the masked EXIT_TOKENS gate below still guards suppression).
      const bodyRaw = lines.slice(blk.open - 1, blk.close).join('\n');
      const hasLog = /\b(msg!|sol_log|trace!|log!|error!)\s*\(/.test(bodyRaw);
      if (!hasLog) continue;
      if (!ERROR_WORDS.test(bodyRaw)) continue;
      // condition should look like a check (comparison / negation / key match).
      const condText = linesStripped.slice(ln - 1, blk.open).join(' ');
      if (!/(!=|==|<|>|mismatch|is_none|is_some|!)/.test(condText)) continue;
      // Precision: this shape is only reliable for ACCOUNT / AUTH validations
      // (the corpus case is a program-key mismatch). A numeric branch that logs
      // and continues (e.g. `if delta < 0 { msg!(..) }`) is a normal pattern, so
      // require an account/authority token in the condition or message.
      if (!/(key|owner|authorit|signer|mint|program|account|pubkey|delegate|admin|address)/i.test(condText + ' ' + bodyRaw))
        continue;
      // SUPPRESSION reads MASKED text: a `// return Err` comment inside the block
      // must not fake an exit and silence the validation-bypass finding (E-class).
      const bodyMasked = linesStripped.slice(blk.open - 1, blk.close).join('\n');
      if (EXIT_TOKENS.test(bodyMasked.replace(/^\s*if\b.*$/m, ''))) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          endLine: blk.close,
          severity: 'critical',
          message:
            'A validation branch logs an error but does not return/propagate it — the failed check is ignored and execution continues (validation bypass).',
          evidence: quote(lines, ln, Math.min(blk.close, ln + 3)),
        })
      );
    }

    return out;
  },
};

export default rule;
