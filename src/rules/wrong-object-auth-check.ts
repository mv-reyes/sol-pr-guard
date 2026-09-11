// T2: an owner/authority check performed on a token account without tying it
// to the mint/metadata the handler also receives (authority proven over the
// wrong object). Evidence: mpl-token-metadata 9485552af1 (holder-delegate),
//           sanctum 0f3bb5c239 (missing rebalance-authority binding).
import { Rule, RuleContext, Finding } from '../types';
import { makeFinding, quote } from './helpers';

const meta = {
  id: 'wrong-object-auth-check',
  tier: 2 as const,
  severity: 'high' as const,
  title: 'Owner check not tied to the mint/metadata it should hold',
  provenance: 'mpl-token-metadata 9485552af1; sanctum 0f3bb5c239',
  provenanceUrl: 'https://github.com/metaplex-foundation/mpl-token-metadata/commit/9485552af1',
  appliesTo: 'both' as const,
};

const OWNER_CHECK = /\.owner\s*(==|!=)\s*[^;{]*\b(authority|signer|owner|payer)\w*/i;
const HAS_MINT_OR_META = /(mint_info|metadata_info|\bmint\b|\bmetadata\b)/;
const LINK =
  /(assert_holding_amount|assert_holding|assert_derivation|\.mint\s*==|token\.mint|amount\s*(>=|==|>)|assert_keys_eq!\s*\([^)]*mint)/;

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    const lines = ctx.head.lines; // raw, evidence only
    for (const fn of ctx.headFacts.fns) {
      if (!ctx.changedIntersects(fn.startLine, fn.endLine)) continue;
      // Match on MASKED body so a comment mentioning `.mint ==` cannot fake the
      // object-binding LINK and silence the finding.
      const body = fn.bodyStripped;
      if (!OWNER_CHECK.test(body)) continue;
      // "the handler also receives a mint/metadata account": check the body AND
      // the parameter list (the account may only be referenced by name in
      // params or elsewhere in a large handler).
      const paramText = fn.params.map((p) => `${p.name ?? ''} ${p.type ?? ''}`).join(' ');
      if (!HAS_MINT_OR_META.test(body) && !HAS_MINT_OR_META.test(paramText)) continue;
      if (LINK.test(body)) continue; // it does tie the object to the mint/metadata
      const m = OWNER_CHECK.exec(body);
      if (!m) continue;
      const lineInFn = body.slice(0, m.index).split('\n').length - 1;
      const abs = fn.bodyStartLine + lineInFn;
      if (!ctx.changedIntersects(abs, abs)) continue;
      out.push(
        makeFinding(meta, {
          file: ctx.file,
          line: abs,
          message:
            'An owner/authority check is performed on a token account, but the handler also takes a mint/metadata account that is never tied to it — the authority may be proven over the wrong object.',
          evidence: quote(lines, abs),
        })
      );
    }
    return out;
  },
};

export default rule;
