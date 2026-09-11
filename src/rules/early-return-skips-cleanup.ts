// T2: an early `return Ok(())` that skips a cleanup CPI performed on other
// paths of the same function (e.g. returning split-stake rent).
// Evidence: marinade c6cdf23ad1 (deactivate_stake early returns skip rent return).
//
// Extension (drift protocol-v2 PR #1757 merge 97355509a,
// state/liquidation_mode.rs:92-105 via controller/liquidation.rs:99): a
// `?`-propagated lookup of the very position/state being acted on sits
// UPSTREAM of a state-machine exit transition in the same flow — when the
// lookup fails on that state (position fully liquidated and removed), the
// exit path is unreachable and the account is stuck (permanent
// BeingLiquidated). Fixed by e6ee7b4e1 (#2122): the lookup's Err arm falls
// back to a default cross-margin mode so `exit_liquidation` stays reachable.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote, braceBlockFrom, enclosingBlockStart, lineOfIndex } from './helpers';

const meta = {
  id: 'early-return-skips-cleanup',
  tier: 2 as const,
  severity: 'medium' as const,
  title: 'Early return skips a cleanup performed on sibling paths',
  provenance: 'marinade-finance c6cdf23ad1 (deactivate_stake rent return)',
  provenanceUrl: 'https://github.com/marinade-finance/liquid-staking-program/commit/c6cdf23ad1',
  appliesTo: 'both' as const,
};

const CLEANUP =
  /(withdraw\s*\(|close_account|CloseAccount|return_[a-z_]*rent|return_unused|refund|reclaim|drain_)/;

// A `?`-propagated lookup of the very account/position/state being acted on.
// The callee name must reference such an entity (`get_perp_position`,
// `get_perp_liquidation_mode`, `load`, …) — a generic `get_ref(&market)?` /
// `get_price_data(..)?` is an oracle/market-map fetch, not the state whose
// exit transition is at stake (keeps drift isolated_position.rs / user.rs
// silent — those lookups gate on the MARKET, not the exited position).
const LOOKUP_Q =
  /\b(?:[A-Za-z_]\w*\s*\.\s*)*[a-z0-9_]*(?:get|load|fetch)_[a-z0-9_]*(?:position|account|state|status|mode|obligation|liquidat)[a-z0-9_]*\s*\([^;?]*\)\s*\?/g;
// A state-machine exit/terminal transition later in the same fn.
const EXIT_TRANSITION = /\b(?:exit_[a-z0-9_]+|clear_[a-z0-9_]+|close_[a-z0-9_]+)\s*\(/;
// A fn whose job is selecting a state-machine mode/strategy to act through.
const MODE_DISPATCH = /(liquidation_mode|_mode\b|_modes\b|_dispatch\b|_strategy\b)/;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const linesStripped = ctx.head.linesStripped; // masked, for matching
    for (const fn of ctx.headFacts.fns) {
      // Match on MASKED body/lines so a `// refund on all paths` comment cannot
      // fake a cleanup (either satisfying the has-cleanup gate or the
      // this-path-cleans-up suppression).
      const bodyStripped = fn.bodyStripped;
      if (!CLEANUP.test(bodyStripped)) continue; // fn must have a cleanup somewhere
      // locate each early `return Ok(())`.
      const re = /return\s+Ok\s*\(\s*\(\s*\)\s*\)\s*;/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(bodyStripped))) {
        const lineInFn = bodyStripped.slice(0, m.index).split('\n').length - 1;
        const abs = fn.bodyStartLine + lineInFn;
        if (!ctx.changedIntersects(abs, abs)) continue;
        // is there a cleanup AFTER this return in the fn? (i.e. return skips it)
        const after = bodyStripped.slice(m.index);
        if (!CLEANUP.test(after)) continue;
        // does the enclosing block already do cleanup before the return?
        const bstart = enclosingBlockStart(linesStripped, abs);
        const blk = braceBlockFrom(linesStripped, bstart);
        const blockText = blk
          ? linesStripped.slice(blk.open - 1, blk.close).join('\n')
          : '';
        if (CLEANUP.test(blockText)) continue; // this path cleans up: fine
        // the fn's FINAL return is not "early"; require code after the return
        // within the fn body.
        if (!/\S/.test(bodyStripped.slice(m.index + m[0].length).replace(/[}\s]/g, ''))) {
          continue;
        }
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: abs,
            message:
              'Early `return Ok(())` on this branch skips a cleanup (rent return / account close) that other paths of this function perform — funds/rent can be left stranded.',
            evidence: quote(lines, abs),
          })
        );
      }
    }
    // Extension: `?`-abort upstream of a state-machine exit (drift #1757/#2122).
    for (const fn of ctx.headFacts.fns) {
      const bodyStripped = fn.bodyStripped;
      const isModeDispatch = MODE_DISPATCH.test(fn.name ?? '');
      if (!isModeDispatch && !EXIT_TRANSITION.test(bodyStripped)) continue;
      LOOKUP_Q.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LOOKUP_Q.exec(bodyStripped))) {
        // B1: the lookup must sit UPSTREAM of the exit transition.
        if (!isModeDispatch && !EXIT_TRANSITION.test(bodyStripped.slice(m.index + m[0].length))) {
          continue;
        }
        const abs = fn.bodyStartLine + lineOfIndex(bodyStripped, m.index) - 1;
        if (!ctx.changedIntersects(abs, abs)) continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: abs,
            message: isModeDispatch
              ? '`?` on this lookup aborts a liquidation-mode dispatch when the position/state is absent — the caller\'s exit transition (e.g. exit_liquidation) becomes permanently unreachable. Handle the Err arm with a default mode instead.'
              : '`?` on this lookup aborts before a later state-machine exit transition (exit_*/clear_*/close_*) in this fn — if the lookup fails on the very state being exited (e.g. a fully-liquidated position), the exit path is permanently unreachable.',
            evidence: quote(lines, abs),
          })
        );
        break; // one finding per fn for this shape
      }
    }
    return out;
  },
};

export default rule;
