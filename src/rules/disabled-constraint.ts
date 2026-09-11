// T1: a constraint/validation that was disabled or is absent-by-design.
//  (a) commented-out #[account(...)] / address= / constraint=;
//  (b) `/// CHECK: <weak>` safety doc on an UncheckedAccount/AccountInfo;
//  (c) a value unpacked from remaining_accounts feeding a payout/market builder.
// Evidence: tensor 713db3affe (/// CHECK: none, can be anything),
//           gmsol a12c0df6da (remaining_accounts -> final_output_market).
import { Rule, RuleContext, Finding } from '../types';
import { fieldScopeStart, makeFinding, quote, fnContaining } from './helpers';

const meta = {
  id: 'disabled-constraint',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'Account constraint disabled, bypassed, or sourced from untrusted input',
  provenance: 'tensor marketplace 713db3affe; gmsol execute_order a12c0df6da',
  provenanceUrl:
    'https://github.com/tensor-foundation/marketplace/commit/713db3affe',
  appliesTo: 'anchor' as const,
};

// Weak = the comment explicitly asserts NO validation (or is empty). Ambiguous
// notes like "todo" or "address below" are NOT treated as weak (they often sit
// above an account validated elsewhere) — that keeps false positives off clean
// PRs while still catching the corpus "none, can be anything" case.
const WEAK_CHECK =
  /\/\/\/?\s*CHECK\s*:\s*(none|n\/?a|no\s*check|not\s*needed|skip(ped)?|unchecked|can be anything)?\s*(,?\s*(can be anything|anything|unchecked|not needed))?\s*$/i;
const PAYOUT_SETTER =
  /\.\s*(final_output_market|output_market|final_output_token|recipient|destination|payout|escrow|beneficiary|to_account|market)\s*\(/;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines;

    // (a) commented-out account attribute in scope.
    for (let ln = 1; ln <= lines.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      const raw = lines[ln - 1];
      if (
        /^\s*\/\/\s*#\s*\[\s*account\s*\(/.test(raw) ||
        /\/\*[^\n]*#\s*\[\s*account\s*\(/.test(raw)
      ) {
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: ln,
            message:
              'A #[account(...)] constraint is commented out — the account validation it performed is disabled.',
            evidence: quote(lines, ln),
          })
        );
      } else if (
        /^\s*\/\/\s*(#\s*\[\s*account|address\s*=|constraint\s*=|has_one\s*=|seeds\s*=)/.test(
          raw
        )
      ) {
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: ln,
            message:
              'An account constraint clause appears commented out — validation may be disabled.',
            evidence: quote(lines, ln),
          })
        );
      }
    }

    // (b) weak `/// CHECK:` doc on an unchecked account field.
    for (const st of ctx.headFacts.structs) {
      if (!st.isAccounts) continue;
      for (const f of st.fields) {
        if (!ctx.changedIntersects(fieldScopeStart(f), f.endLine)) continue;
        const ty = f.type ?? '';
        const isUnchecked = /\b(UncheckedAccount|AccountInfo)\b/.test(ty);
        if (!isUnchecked) continue;
        const checkDoc = f.comments.find((c) => /CHECK\s*:/i.test(c.text));
        if (!checkDoc) continue;
        if (WEAK_CHECK.test(checkDoc.text.trim())) {
          out.push(
            makeFinding(meta, {
              file: ctx.file,
              line: f.startLine,
              message:
                `Unchecked account '${f.name}' has a placeholder \`/// CHECK:\` safety comment with no real justification` +
                ' — the account is accepted without validation.',
              evidence: quote(lines, checkDoc.startLine, f.startLine),
            })
          );
        }
      }
    }

    // (c) remaining_accounts-derived value feeding a payout/market builder.
    // Match on MASKED body so a comment mentioning remaining_accounts / a payout
    // setter cannot manufacture a taint (blocks (a)/(b) above intentionally read
    // raw comments — that is their subject).
    for (const fn of ctx.headFacts.fns) {
      if (!ctx.changedIntersects(fn.startLine, fn.endLine)) continue;
      const body = fn.bodyStripped;
      if (!/\bremaining_accounts\b/.test(body)) continue;
      const flagged = new Set<number>();
      let m: RegExpExecArray | null;
      const PAYOUT_NAMES =
        'final_output_market|output_market|recipient|destination|payout|escrow|beneficiary|market';

      // Bounded taint: seed with vars bound from an expr mentioning
      // remaining_accounts, then propagate through a couple of `let y = ...x...`
      // hops (catches indirection: `let ra = remaining_accounts; let m = f(ra)`).
      const allBinds = [...body.matchAll(/let\s+([A-Za-z_]\w*)\s*=\s*([^;]*);/g)];
      const tainted = new Set<string>();
      const bindOf = new Map<string, { rhs: string; index: number }>();
      for (const b of allBinds) {
        bindOf.set(b[1], { rhs: b[2], index: b.index ?? 0 });
        if (/\bremaining_accounts\b/.test(b[2])) tainted.add(b[1]);
      }
      for (let pass = 0; pass < 3; pass++) {
        for (const b of allBinds) {
          if (tainted.has(b[1])) continue;
          if ([...tainted].some((t) => new RegExp(`\\b${t}\\b`).test(b[2]))) tainted.add(b[1]);
        }
      }
      // flag any payout setter whose argument is a tainted var.
      for (const v of tainted) {
        const setterRe = new RegExp(`\\.(${PAYOUT_NAMES})\\s*\\(\\s*&?\\s*${v}\\b`, 'g');
        while ((m = setterRe.exec(body))) {
          const lineInFn = body.slice(0, m.index).split('\n').length - 1;
          const abs = fn.bodyStartLine + lineInFn;
          if (!ctx.changedIntersects(abs, abs)) continue;
          if (flagged.has(abs)) continue;
          flagged.add(abs);
          out.push(
            makeFinding(meta, {
              file: ctx.file,
              line: abs,
              message:
                `A payout/market target is derived from caller-controlled remaining_accounts (via '${v}')` +
                ' — the output can be pointed at an account the order never authorized.',
              evidence: quote(lines, abs),
            })
          );
        }
      }
      // inline: `.final_output_market(&...remaining_accounts...)`
      const inlineRe =
        /\.(final_output_market|output_market|recipient|destination|payout|escrow|beneficiary)\s*\(\s*&?[^)]*remaining_accounts[^)]*\)/g;
      while ((m = inlineRe.exec(body))) {
        const lineInFn = body.slice(0, m.index).split('\n').length - 1;
        const abs = fn.bodyStartLine + lineInFn;
        if (!ctx.changedIntersects(abs, abs)) continue;
        if (flagged.has(abs)) continue;
        flagged.add(abs);
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: abs,
            message:
              'A payout/market builder field is set directly from caller-controlled remaining_accounts.',
            evidence: quote(lines, abs),
          })
        );
      }
    }

    return out;
  },
};

export default rule;
