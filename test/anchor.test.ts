import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseSource } from '../src/parse';
import { buildFacts, extractConstraintBodies, extractAccountKeys } from '../src/anchor';
import { computeScope, indexChangedSurface } from '../src/scope';

const SRC = `use anchor_lang::prelude::*;

#[program]
pub mod thing {
    use super::*;
    pub fn do_it(ctx: Context<DoIt>, amount: u64) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct DoIt<'info> {
    #[account(
        mut,
        associated_token::mint = some_mint,
        constraint = a.load()?.x == b.key() @ E::X
    )]
    pub token: Box<Account<'info, Mint>>,
    /// CHECK: none, can be anything
    pub sketchy: UncheckedAccount<'info>,
}
`;

test('extractConstraintBodies pulls constraint expressions', () => {
  const bodies = extractConstraintBodies('#[account(mut, constraint = a == b.key() @ E::X, has_one = auth)]');
  assert.deepStrictEqual(bodies, ['a == b.key()']);
});

test('extractAccountKeys lists top-level keys', () => {
  const keys = extractAccountKeys('#[account(mut, seeds = [b"x"], bump, has_one = auth, close = payer)]');
  assert.deepStrictEqual(keys, ['mut', 'seeds', 'bump', 'has_one', 'close']);
});

test('buildFacts finds Accounts struct, fields, program handler, linkage', async () => {
  const parsed = await parseSource(SRC);
  assert.strictEqual(parsed.hasError, false);
  const facts = buildFacts(parsed.tree);
  assert.ok(facts.isAnchor);
  const st = facts.structs.find((s) => s.name === 'DoIt')!;
  assert.ok(st.isAccounts);
  assert.strictEqual(st.fields.length, 2);
  const token = st.fields[0];
  assert.strictEqual(token.name, 'token');
  assert.ok(token.type!.includes('Mint'));
  assert.strictEqual(token.accountAttrs.length, 1);
  assert.deepStrictEqual(token.accountAttrs[0].constraints, ['a.load()?.x == b.key()']);
  // multi-line attribute span
  assert.ok(token.accountAttrs[0].endLine > token.accountAttrs[0].startLine);
  // doc comment captured on the unchecked field
  const sketchy = st.fields[1];
  assert.ok(sketchy.comments.some((c) => /CHECK/.test(c.text)));
  // handler linkage
  const fn = facts.fns.find((f) => f.name === 'do_it')!;
  assert.strictEqual(fn.contextType, 'DoIt');
  assert.ok(fn.isHandler);
});

test('scope propagation: struct field changed -> handler in scope', async () => {
  const parsed = await parseSource(SRC);
  const facts = buildFacts(parsed.tree);
  const st = facts.structs.find((s) => s.name === 'DoIt')!;
  // pretend a field line changed
  const changed = new Set<number>([st.fields[0].startLine]);
  const global = { changedStructNames: new Set<string>(), changedContextTypes: new Set<string>() };
  indexChangedSurface(facts, changed, global);
  assert.ok(global.changedStructNames.has('DoIt'));
  const scope = computeScope(facts, changed, global, false);
  const fn = facts.fns.find((f) => f.name === 'do_it')!;
  assert.ok(scope.inScope(fn.startLine, fn.endLine), 'handler should be in scope when its struct changed');
});
