// T1: raw system_instruction::create_account for a PDA with no
// already-exists guard before the CPI. An attacker pre-funds the PDA so
// create_account fails, permanently DoSing the instruction.
// Evidence: wormhole 2b56fcc7da, phoenix 1f01815000, sanctum df580d6e5f.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote, lineOfIndex } from './helpers';

const meta = {
  id: 'prefunded-pda-dos',
  tier: 1 as const,
  severity: 'medium' as const,
  title: 'PDA created via raw create_account with no already-exists guard',
  provenance: 'wormhole 2b56fcc7da; phoenix 1f01815000; sanctum df580d6e5f (3 repos)',
  provenanceUrl: 'https://github.com/wormhole-foundation/wormhole/commit/2b56fcc7da',
  appliesTo: 'both' as const,
};

const CREATE = /system_instruction\s*::\s*create_account\s*\(|system_program\s*::\s*create_account\s*\(/;
// A guard that indicates the code checks whether the PDA already exists before
// creating it. Deliberately NOT including bare `is_initialized` (it commonly
// refers to a different account and produced false negatives).
const GUARD =
  /(data_is_empty\s*\(\)|\.lamports\s*\(\)\s*(==|!=|>|<|>=|<=)|\.owner\s*==|already.?(exist|initialized)|\.data_len\s*\(\)\s*[<>=]|try_borrow_data\s*\(\)\s*\??\s*\.\s*len\s*\(\)|assert_signer\s*\()/;

// Vars bound from a lamports read: `let x = acct.lamports()` /
// `let x = **acct.try_borrow_lamports()?`. A later `x == 0` / `x > 0` on such a
// var is an existence guard the plain GUARD regex misses (jito T25, phoenix T27).
const LAMPORTS_ALIAS = /let\s+(\w+)\s*=\s*[^;]*\.\s*(?:lamports|try_borrow_lamports)\s*\(/g;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    for (const fn of ctx.headFacts.fns) {
      if (!ctx.changedIntersects(fn.startLine, fn.endLine)) continue;
      // Match on the MASKED body so a `// data_is_empty() checked upstream`
      // comment cannot fake an existence guard and silence the finding.
      const body = fn.bodyStripped;
      const cm = CREATE.exec(body);
      if (!cm) continue;
      // Fires for both the raw `system_instruction::create_account(...)` + invoke
      // form AND the anchor `system_program::create_account(CpiContext...)` CPI
      // form. Anchor `#[account(init)]` has no create_account text, so it stays
      // silent (init handles the already-exists case). Precision comes from the
      // exists-guard-before-the-call check below.
      // A guard is mitigating ONLY if it appears BEFORE the create_account call
      // (an existence check placed after the CPI does not prevent the DoS).
      const createIdx = cm.index;
      const before = body.slice(0, createIdx);
      if (GUARD.test(before)) continue;
      // lamports-alias guard: `let cur = acct.lamports(); require!(cur == 0)`.
      let aliasGuard = false;
      let am: RegExpExecArray | null;
      LAMPORTS_ALIAS.lastIndex = 0;
      while ((am = LAMPORTS_ALIAS.exec(before))) {
        const v = am[1];
        if (new RegExp(`\\b${v}\\b\\s*(==|!=|>|<|>=|<=)\\s*0`).test(before)) {
          aliasGuard = true;
          break;
        }
      }
      if (aliasGuard) continue;
      const lineInFn = body.slice(0, createIdx).split('\n').length - 1;
      const abs = fn.bodyStartLine + lineInFn;
      if (!ctx.changedIntersects(abs, abs)) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: abs,
          message:
            'PDA is created with raw create_account + invoke and no preceding "already exists" check (lamports>0 / data_is_empty). An attacker can pre-fund the PDA to make creation fail and permanently block this instruction.',
          evidence: quote(lines, abs),
        })
      );
    }
    return out;
  },
};

export default rule;
