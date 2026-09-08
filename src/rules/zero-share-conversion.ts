// T1: an amount->shares conversion on a VALUE-OUT path whose result is used to
// move value with no guard that the result is > 0. A dust amount that rounds to
// zero shares lets the user take assets (withdraw) or debt (borrow) for free.
//
// Precision is critical here: firing on the DEPOSIT (asset increase) or REPAY
// (liability decrease) direction is a false positive — those round AGAINST the
// user, not the protocol. We therefore require (a) a drain DIRECTION, inferred
// from the source-amount name and the sign of the shares mutation, and (b) a
// LOCAL window around the binding (not the whole function, which can reuse the
// `shares` name across deposit/withdraw blocks). Evidence: marginfi 28222ee531.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'zero-share-conversion',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'Value-out share conversion used without a nonzero guard',
  provenance: 'marginfi-v2 28222ee531 (small-withdraw zero-share fix)',
  provenanceUrl: 'https://github.com/mrgnlabs/marginfi-v2/commit/28222ee531',
  appliesTo: 'both' as const,
};

const BIND =
  /let\s+([A-Za-z_]\w*)\s*=\s*[^;{}]*?\b(get_asset_shares|get_liability_shares|to_shares|to_assets|shares_from|amount_to_shares|calc_shares|calc_[a-z_]*_from_[a-z_]*)\s*\(\s*([A-Za-z_][\w.]*)/g;

const WITHDRAWish = /(decrease|withdraw|redeem|remove|\bout\b|liquidat|seize)/i;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    for (const fn of ctx.headFacts.fns) {
      if (!ctx.changedIntersects(fn.startLine, fn.endLine)) continue;
      // Match on MASKED body so a `// shares > 0 checked upstream` comment cannot
      // fake the nonzero guard and silence the finding.
      const body = fn.bodyStripped;
      let m: RegExpExecArray | null;
      BIND.lastIndex = 0;
      while ((m = BIND.exec(body))) {
        const varName = m[1];
        const getter = m[2];
        const arg = m[3];
        // Local window: the binding and the next couple of statements (its
        // block) — NOT the whole fn, which reuses `shares` across deposit and
        // withdraw blocks.
        const win = body.slice(m.index, m.index + 320);

        // Value-OUT direction = the drain shape. Determined by the SIGN of the
        // shares mutation, so it is independent of variable naming:
        //   asset shares DECREASE (`change_asset_shares(-v)`)  -> withdraw
        //   liability shares INCREASE (`change_liability_shares(v)`, not -v) -> borrow
        //   or a generic transfer/withdraw of the value.
        // Only the ASSET-WITHDRAW direction is patch-verified (marginfi
        // 28222ee531): assets leave the user while shares round to 0. The
        // symmetric borrow side (liability increase) is NOT emitted — it is
        // unproven and health/min-borrow gates commonly cover it (see README
        // limitations). This keeps Tier-1 precision at 100% on clean PRs.
        const assetWithdraw = new RegExp(`change_asset_shares\\s*\\(\\s*-\\s*${varName}\\b`).test(win);
        const genericOut =
          getter !== 'get_asset_shares' &&
          getter !== 'get_liability_shares' &&
          (WITHDRAWish.test(arg) ||
            new RegExp(`(transfer|withdraw|send|payout)[^;]*\\b${varName}\\b`).test(win));
        const valueOut = assetWithdraw || genericOut;
        if (!valueOut) continue;

        // A nonzero guard in the local window clears it.
        const guarded = new RegExp(
          `(check!\\s*\\(\\s*${varName}\\s*>|require!\\s*\\(\\s*${varName}\\s*>|require_gt!\\s*\\(\\s*${varName}\\b|require_gte!\\s*\\(\\s*${varName}\\b|assert!\\s*\\(\\s*${varName}\\s*>|ensure!\\s*\\(\\s*${varName}\\s*>|${varName}\\s*>\\s*[^;]*(ZERO|0)|${varName}\\s*!=\\s*[^;]*(ZERO|0)|${varName}\\s*==\\s*[^;]*(ZERO|0)|${varName}\\.is_zero\\(\\)|if\\s+${varName}\\b)`
        ).test(win);
        if (guarded) continue;

        const lineInFn = body.slice(0, m.index).split('\n').length - 1;
        const abs = fn.bodyStartLine + lineInFn;
        if (!ctx.changedIntersects(abs, abs)) continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: abs,
            severity: 'critical',
            message:
              `'${varName}' is converted from an amount on a value-out path but never checked to be > 0 before it moves value` +
              ' — a dust amount can round to zero shares and take assets/debt for free.',
            evidence: quote(lines, abs),
          })
        );
      }
    }
    return out;
  },
};

export default rule;
