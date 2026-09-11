// T1: an instruction-builder marks a SIGNER account as non-signer in its
// AccountMeta (`AccountMeta::new(**multisig_signer, false)`), so the processor's
// signer check can never be satisfied / is silently bypassed.
// Evidence: spl token-2022 96b37d41c6 (#5900, OS-SPL-ADV-02). Near-zero FP:
// keyed on a variable literally named *signer* flagged is_signer=false.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'ix-signer-flag',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'AccountMeta marks a signer account as non-signer',
  provenance: 'spl token-2022 96b37d41c6 (#5900, OtterSec OS-SPL-ADV-02)',
  provenanceUrl: 'https://github.com/solana-labs/solana-program-library/pull/5900',
  appliesTo: 'both' as const,
};

// AccountMeta::new(<...signer...>, false) or new_readonly(<...signer...>, false).
const SIGNER_FALSE =
  /AccountMeta::new(?:_readonly)?\s*\(\s*[&*]*\s*([A-Za-z_][\w.]*signer[\w.]*)\s*,\s*false\s*\)/i;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      const code = linesStripped[ln - 1];
      const m = code.match(SIGNER_FALSE);
      if (!m) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          message:
            `AccountMeta for '${m[1]}' sets is_signer=false, but the name indicates a signer — the processor's signer check can never be enforced. Pass is_signer=true.`,
          evidence: quote(lines, ln),
        })
      );
    }
    return out;
  },
};

export default rule;
