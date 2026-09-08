// T1 (promoted from T2; N=6 across sanctum/jito/squads/drift/marinade): an
// admin/instruction-settable fee/bps/threshold field is written from an argument
// with no UPPER-bound range check in its setter (or a validator the setter calls).
// Evidence: sanctum 2c396c275c (unbounded LP withdrawal fee bps),
//           jito-restaking cdac2eab4c (set_withdrawal_fee_bps no cap),
//           squads 720ca8c3b2 (SetTimeLock unbounded), marinade 75aa6b56f9.
//
// All matching runs against the OFFSET-PRESERVING MASKED text (comments and
// string literals blanked) so a rule-aware author cannot silence the finding
// with a `// fee <= 10_000 elsewhere` comment or an `#[error("out of bounds")]`
// string (acceptance-audit v0.2 §C.12, evasions E1b/E1c).
//
// A bound suppresses ONLY when it is DIRECTION-correct (an upper bound),
// ENFORCEMENT-POSITIONED (it actually gates — a require!/assert! macro, a comma
// bound-macro, or a reject-if whose body returns/panics), AND FN-SCOPED (it sits
// in the SAME function body as the assignment, or is a validator the fn calls).
// A comparison merely computed (`let _x = fee <= C`, F2), a reject-if that only
// logs (`if fee > C { msg!(..) }`, F1/G4) or only propagates an unrelated error
// (`if fee > C { self.log()?; }` — `?` is NOT a rejection, N2), a lower bound
// (`require!(fee > 5)`, E1d), an allowlist `admins.contains(&k)` (F3'), a bound
// in a SIBLING function (N1), or a bound inside `#[cfg(test)]` (N3) do NOT
// suppress. (acceptance-audit v0.2, rounds 3.5–3.7.)
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'missing-bounds-gate',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'Settable fee/bps/threshold written without a bounds check',
  provenance: 'sanctum 2c396c275c; jito-restaking cdac2eab4c; squads 720ca8c3b2; marinade 75aa6b56f9',
  provenanceUrl: 'https://github.com/igneous-labs/S/commit/2c396c275c',
  appliesTo: 'both' as const,
};

const ASSIGN =
  /^[\s]*[A-Za-z_][\w.]*\.([A-Za-z_]\w*(?:_bps|_fee|fee_bps|_threshold|threshold|_bound|time_lock))\s*=\s*([A-Za-z_][\w.]*)\s*;/;
// Direction-AGNOSTIC, always-enforcing mitigations: a validator hand-off
// (`.validate()` / `verify_*bound` / `*_bps_bound`) or a clamp/range helper CALLED
// FROM THE SETTER FN (fn-scoped since round-3.7 — the call sits in the setter even
// when the range lives in another file: marginfi bank.rs, drift admin.rs, and the
// sanctum fix `verify_unsigned_fee_bps_bound` — FP-trap T28/T29, corpus fixed).
// NOTE: `contains(&` is NOT here — a bare `.contains(&k)` is an allowlist check,
// not a range bound (evasion F3'); range membership is handled per-RHS below.
const MITIGATION_IN_FILE =
  /(verify_[a-z_]*bound|[a-z_]*_bps_bound|\.clamp\s*\(|is_in_range|\.validate\s*\()/;

// A MAX-like bound operand: a SCREAMING_CASE const (>=2 chars, optionally
// path-qualified like `State::MAX_FEE`) or a positive integer literal (>0 —
// `> 0` is a nonzero check, not an upper bound). A bound against the RHS's own
// type MAX (`u64::MAX`, `i16::MAX`, …) is VACUOUS — it rejects nothing — and
// must not count (evasion N5).
const VACUOUS = '(?:u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|usize|isize)::MAX';
const C =
  `(?!${VACUOUS}\\b)(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Z_][A-Z0-9_]+|[1-9][0-9_]*`;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// What counts as a rejection depends on WHERE the reject-if lives:
// - REJECT_SETTER_PRE (setter fn, BEFORE the assignment): bare `return`/`return Ok`
//   skips the assignment, so `return` counts too.
// - REJECT_ANYWHERE (setter fn, any position): only tx-reverting outcomes —
//   `Err(..)` return (the ix result is Err → whole tx reverts) or an abort.
//   A bare `return` / `return Ok(())` AFTER the assignment persists the state.
// - REJECT_PROPAGATED (called sibling fn): `Err(..)` counts only when the call
//   site propagates (`?` / unwrap / expect); a bare `return;` in a callee just
//   exits the callee and never gates the caller (evasion M2).
// - REJECT_ABORT (called sibling fn): panic!/bail!/unreachable! abort the tx
//   regardless of propagation.
const REJECT_ANYWHERE = /\bErr\s*\(|\bpanic!|\bbail!|\bunreachable!/;
const REJECT_SETTER_PRE = /\breturn\b|\bErr\s*\(|\bpanic!|\bbail!|\bunreachable!/;
const REJECT_PROPAGATED = /\bErr\s*\(/;
const REJECT_ABORT = /\bpanic!|\bbail!|\bunreachable!/;

/** A reject-if actually rejects when its body returns/errors/aborts. Scans the
 *  balanced `{...}` block following an `if <cond involving rhs vs C> {`.
 *  `tokens` selects what counts as a rejection for the scope being tested. */
function rejectIfRejects(r: string, stripped: string, tokens: RegExp): boolean {
  const condRe = new RegExp(
    `\\bif\\b[^{;]*?(?:\\b${r}\\b\\s*>=?\\s*(?:${C})|(?:${C})\\s*<=?\\s*\\b${r}\\b)[^{;]*\\{`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = condRe.exec(stripped))) {
    const open = m.index + m[0].length - 1; // position of the `{`
    let depth = 0;
    let close = -1;
    for (let i = open; i < stripped.length; i++) {
      if (stripped[i] === '{') depth++;
      else if (stripped[i] === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) continue;
    const block = stripped.slice(open + 1, close);
    // `?` is NOT a rejection: it propagates an unrelated call's error and
    // execution falls through to the assignment (evasion N2). What counts as a
    // rejection depends on scope — see REJECT_* below.
    if (tokens.test(block)) {
      return true;
    }
  }
  return false;
}

/** Does the scope impose an ENFORCED UPPER bound on `rhs`? (masked text)
 *  `rejectTokens` selects the rejection vocabulary for this scope. */
function hasUpperBound(rhs: string, stripped: string, rejectTokens: RegExp): boolean {
  const r = esc(rhs);
  // (1) comma bound-macros — the macro name asserts both direction + enforcement:
  //   require_lte!(rhs, C) / require_lt!(rhs, C) / require_gte!(C, rhs) / require_gt!(C, rhs)
  if (new RegExp(`\\brequire_lte?!\\s*\\(\\s*${r}\\s*,`).test(stripped)) return true;
  if (new RegExp(`\\brequire_gte?!\\s*\\(\\s*[^,;()]+,\\s*${r}\\b`).test(stripped)) return true;
  // (2) an at-most comparison INSIDE an enforcing assert macro (not a bare bool):
  //   require!(rhs <= C) / assert!(C >= rhs) / ensure!(rhs < C) ...
  const cmp = `(?:\\b${r}\\b\\s*<=?\\s*(?:${C})|(?:${C})\\s*>=?\\s*\\b${r}\\b)`;
  if (
    new RegExp(
      `\\b(?:require|assert|ensure|debug_assert|require_eq|assert_eq)!\\s*\\([^;]*?${cmp}`
    ).test(stripped)
  ) {
    return true;
  }
  // (3) a reject-if whose body actually rejects (F1/G4: a log-only if does not;
  //     the token set is scope-dependent — see REJECT_* above).
  if (rejectIfRejects(r, stripped, rejectTokens)) return true;
  // (4) range membership: (lo..=hi).contains(&rhs) — NOT a bare allowlist (F3').
  if (new RegExp(`\\.\\.=?\\s*[^;()]*\\)\\s*\\.\\s*contains\\s*\\(\\s*&\\s*${r}\\b`).test(stripped)) {
    return true;
  }
  return false;
}

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, for evidence quoting only
    const linesStripped = ctx.head.linesStripped;
    for (let ln = 1; ln <= linesStripped.length; ln++) {
      if (!ctx.changedIntersects(ln, ln)) continue;
      // Join wrapped-assignment continuations: rustfmt breaks a long
      // `state.field =` onto the next line, and a manual wrap is a trivial
      // evasion (E1e). Build the logical statement from this (masked) line until
      // a `;`, then match ASSIGN — anchored on the LHS line so a pure-RHS
      // continuation line never matches on its own.
      let logical = linesStripped[ln - 1];
      for (let k = ln; k < linesStripped.length && !logical.includes(';') && k - ln < 4; k++) {
        logical += ' ' + linesStripped[k].trim();
      }
      // Normalize a leading deref-group so `(*state).field = rhs` (and
      // `(**loader.load_mut()?).field = rhs`-style writes through a manual
      // deref) match the same ASSIGN shape (evasion M8).
      logical = logical.replace(/^\s*\(\*+\s*([A-Za-z_][\w.]*)\s*\)\s*\./, '$1.');
      const m = logical.match(ASSIGN);
      if (!m) continue;
      const field = m[1];
      const rhs = m[2];
      if (/^\d/.test(rhs)) continue; // literal RHS, not attacker-settable
      // FN-SCOPED suppression with a ONE-HOP call graph (round-3.7):
      // the bound must gate THIS assignment. It can live in:
      //  (a) the setter's own fn body — macros/Err/panic count anywhere (they
      //      revert the tx even after the write); a bare `return` counts only
      //      BEFORE the assignment (it skips the write; a post-write
      //      `return Ok(())` persists state);
      //  (b) a fn the setter CALLS — panic/abort rejection always enforces;
      //      `Err(..)`-return and validator hand-offs enforce only when the
      //      call site propagates (`?` / unwrap / expect) — a bare `return;`
      //      in a callee never gates the caller (evasion M2);
      // A bound in a fn the setter does NOT call (N1 sibling, N3 cfg(test))
      // does not count. No enclosing fn found → no suppression.
      const fn = ctx.headFacts.fns.find((f) => f.startLine <= ln && ln <= f.endLine);
      if (fn) {
        if (MITIGATION_IN_FILE.test(fn.bodyStripped)) continue; // validator hand-off call
        if (hasUpperBound(rhs, fn.bodyStripped, REJECT_ANYWHERE)) continue;
        const preAssign = linesStripped.slice(fn.bodyStartLine - 1, ln - 1).join('\n');
        if (preAssign && hasUpperBound(rhs, preAssign, REJECT_SETTER_PRE)) continue;
        let suppressed = false;
        for (const g of ctx.headFacts.fns) {
          if (g === fn || !g.name) continue;
          const gn = esc(g.name);
          if (!new RegExp(`\\b${gn}\\s*\\(`).test(fn.bodyStripped)) continue; // not called
          if (hasUpperBound(rhs, g.bodyStripped, REJECT_ABORT)) { suppressed = true; break; }
          const propagates = new RegExp(
            `\\b${gn}\\s*\\([^;]*\\)\\s*(?:\\?|\\.\\s*(?:unwrap|expect)\\s*\\()`
          ).test(fn.bodyStripped);
          if (!propagates) continue;
          if (MITIGATION_IN_FILE.test(g.bodyStripped)) { suppressed = true; break; }
          if (hasUpperBound(rhs, g.bodyStripped, REJECT_PROPAGATED)) { suppressed = true; break; }
        }
        if (suppressed) continue;
      }
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: ln,
          message:
            `'${field}' is set from '${rhs}' with no upper-bound check in its setter — a fee/bps/threshold set out of range (e.g. > 100%) is accepted.`,
          evidence: quote(lines, ln),
        })
      );
    }
    return out;
  },
};

export default rule;
