// T1: a field's #[account(constraint=...)] body is copy-pasted from a sibling
// field and validates the wrong account (the field's own name never appears,
// but a sibling account's name does).
// Evidence: gmsol bf2a35c6d7 (CreateShift.to_market_token).
import { Rule, RuleContext, Finding, AnchorField, AnchorStruct } from '../types';
import { fieldScopeStart, makeFinding, normWs, identifiers, quote } from './helpers';

const meta = {
  id: 'copy-paste-constraint',
  tier: 1 as const,
  severity: 'high' as const,
  title: 'Copy-pasted account constraint validates the wrong account',
  provenance: 'gmsol-labs/gmx-solana shift.rs constraint fix',
  provenanceUrl:
    'https://github.com/gmsol-labs/gmx-solana/commit/bf2a35c6d7',
  appliesTo: 'anchor' as const,
};

interface FC {
  field: AnchorField;
  attrLine: number;
  body: string;
  ids: Set<string>;
}

export const rule: Rule = {
  ...meta,
  run(ctx: RuleContext): Finding[] {
    const out: Finding[] = [];
    for (const st of ctx.headFacts.structs) {
      if (!st.isAccounts) continue;
      const fieldNames = new Set(
        st.fields.map((f) => f.name).filter((n): n is string => !!n)
      );
      const fcs: FC[] = [];
      for (const f of st.fields) {
        if (!f.name) continue;
        for (const attr of f.accountAttrs) {
          for (const body of attr.constraints) {
            fcs.push({
              field: f,
              attrLine: attr.startLine,
              body: normWs(body),
              ids: identifiers(body),
            });
          }
        }
      }
      for (const fc of fcs) {
        if (!ctx.changedIntersects(fieldScopeStart(fc.field), fc.field.endLine)) continue;
        if (fc.ids.has(fc.field.name!)) continue; // references itself: fine
        // find another field with a byte-identical body.
        const twin = fcs.find(
          (o) => o.field.name !== fc.field.name && o.body === fc.body
        );
        if (!twin) continue;
        // the body must reference some OTHER sibling account field name —
        // that is the strong copy-paste signal (kills identical-guard FPs).
        const referencedSibling = [...fc.ids].find(
          (id) => fieldNames.has(id) && id !== fc.field.name
        );
        if (!referencedSibling) continue;
        out.push(
          makeFinding(meta, {
            file: ctx.file,
            line: fc.attrLine,
            message:
              `Constraint on '${fc.field.name}' is identical to the one on '${twin.field.name}' and references '${referencedSibling}', never '${fc.field.name}'` +
              ` — the constraint appears copy-pasted, leaving '${fc.field.name}' effectively unconstrained.`,
            evidence: quote(ctx.head.lines, fc.attrLine),
          })
        );
      }
    }
    return out;
  },
};

export default rule;
