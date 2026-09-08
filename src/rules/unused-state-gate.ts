// T3 (low confidence, summary-only): a PR adds a `check_*`/`validate_*`/
// `assert_*` guard fn for a state flag on a struct, but NO sibling mutating
// method in the same impl block ever invokes it — the gate exists and is never
// enforced where state is mutated (e.g. an ownership-transfer flag that borrow/
// withdraw/repay paths ignore).
// Evidence: klend PR #60 merge 95d694b — `Obligation::check_ownership_transfer_
// not_in_progress` added with the `ownership_transfer_state` flag, but the
// position-mutating paths (init/repay/withdraw/find_or_add_*) never call it.
// Cross-function by nature, so this is deliberately conservative: same impl
// block only, and the state machine's own transition methods (whose names share
// the guard's subject, e.g. initiate/accept_ownership_transfer) don't count.
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote, lineOfIndex } from './helpers';

const meta = {
  id: 'unused-state-gate',
  tier: 3 as const,
  severity: 'low' as const,
  title: 'State-flag guard fn defined but never invoked by sibling mutating methods',
  provenance: 'klend 95d694b (check_ownership_transfer_not_in_progress unused by borrow/withdraw paths)',
  provenanceUrl: 'https://github.com/Kamino-Finance/klend/pull/60',
  appliesTo: 'both' as const,
};

const GUARD_NAME = /^(?:check|validate|assert|ensure)_[a-z0-9_]+$/;
// The guard gates a STATE FLAG: it reads self.is_*() or a self.*_state/_status/
// _flag/_mode field.
const STATE_FLAG_READ = /self\.(?:is_[a-z0-9_]+|[a-z0-9_]*(?:_state|_status|_flag|_mode)s?\b)/;
// A mutating method writes its own struct's state.
const SELF_WRITE = /self\.[A-Za-z0-9_.[\]]+\s*=(?![=>])/;
const IMPL_RE = /\bimpl(?:\s*<[^>]*>)?\s+[A-Za-z_]\w*[^{};]*\{/g;

/** Balanced-brace span following the `{` at `openIdx`. */
function blockSpan(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Subject tokens of a guard name (>=6 chars), used to exclude the state
 *  machine's own transition methods (initiate/accept_ownership_transfer are
 *  RELATED to check_ownership_transfer_not_in_progress, not gated by it). */
function subjectTokens(guardName: string): string[] {
  const core = guardName
    .replace(/^(?:check|validate|assert|ensure)_/, '')
    .replace(/(?:_not)?_in_progress$/, '');
  return core.split('_').filter((t) => t.length >= 6);
}

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    const text = ctx.head.textStripped; // masked, for matching
    IMPL_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = IMPL_RE.exec(text))) {
      const openIdx = im.index + im[0].length - 1;
      const closeIdx = blockSpan(text, openIdx);
      const startLn = lineOfIndex(text, im.index);
      const endLn = lineOfIndex(text, closeIdx);
      const methods = ctx.headFacts.fns.filter(
        (f) => f.name && f.startLine >= startLn && f.endLine <= endLn
      );
      const guards = methods.filter(
        (f) => GUARD_NAME.test(f.name!) && STATE_FLAG_READ.test(f.bodyStripped)
      );
      if (!guards.length) continue;
      const mutators = methods.filter((f) => {
        if (GUARD_NAME.test(f.name!)) return false;
        const header = ctx.head.linesStripped
          .slice(f.startLine - 1, f.bodyStartLine)
          .join('\n');
        if (!/&mut\s+self/.test(header)) return false;
        return SELF_WRITE.test(f.bodyStripped);
      });
      if (!mutators.length) continue;
      for (const g of guards) {
        // the guard must be part of this PR's changed surface.
        if (!ctx.changedIntersects(g.startLine, g.startLine)) continue;
        const subjects = subjectTokens(g.name!);
        // exclude the state machine's own transition methods for this flag.
        const unrelated = mutators.filter(
          (f) => !subjects.some((t) => f.name!.includes(t))
        );
        if (!unrelated.length) continue;
        // used = invoked by at least one non-guard sibling in the impl block
        // (including the state machine's own transition methods — a guard the
        // machine itself calls is enforced; one nobody calls is decoration).
        const callRe = new RegExp(`\\b${g.name}\\s*\\(`);
        const used = methods.some(
          (f) => !GUARD_NAME.test(f.name!) && callRe.test(f.bodyStripped)
        );
        if (used) continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: g.startLine,
            endLine: g.startLine,
            message:
              `\`${g.name}\` guards a state flag but is never invoked by any sibling mutating method (${unrelated
                .map((f) => f.name)
                .slice(0, 4)
                .join(', ')}${unrelated.length > 4 ? ', …' : ''}) — position-altering paths can bypass the gate.`,
            evidence: quote(lines, g.startLine),
          })
        );
      }
    }
    return out;
  },
};

export default rule;
