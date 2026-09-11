// Anchor version-drift grammar (research/anchor-drift-and-token2022.md Part A).
// The tool tokenizes `#[account(...)]` from raw attribute text (byte offsets),
// so it is version-agnostic by construction: constraint forms introduced across
// 0.25 -> 1.0 parse without error and their keys/constraints extract. A DSL-AST
// parser built on an older grammar would silently drop these; we don't parse the
// DSL, so there is nothing to drift. These fixtures lock that property.
import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseSource } from '../src/parse';
import { buildFacts, extractAccountKeys } from '../src/anchor';

const DRIFT = `use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AllForms<'info> {
    // 0.25 realloc group
    #[account(mut, realloc = 8 + 32, realloc::payer = payer, realloc::zero = true)]
    pub grown: Account<'info, Data>,
    // 0.28 token_program constraints
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint, token::authority = auth, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    // 0.30 extensions:: namespace
    #[account(
        extensions::transfer_hook::authority = auth,
        extensions::transfer_hook::program_id = hook_program,
        extensions::permanent_delegate::delegate = auth,
    )]
    pub ext_mint: InterfaceAccount<'info, Mint>,
    // classic constraint still parses
    #[account(constraint = a.load()?.x == b.key() @ E::X)]
    pub checked: Account<'info, Mint>,
}

// 0.31 custom (non-8-byte) discriminator + 1.0 dup
#[account(discriminator = 42)]
pub struct CustomDisc {
    pub value: u64,
}
`;

test('anchor 0.25-1.0 constraint forms parse without error', async () => {
  const parsed = await parseSource(DRIFT);
  assert.strictEqual(parsed.hasError, false, 'drift grammar must parse cleanly');
  const facts = buildFacts(parsed.tree);
  const st = facts.structs.find((s) => s.name === 'AllForms')!;
  assert.ok(st.isAccounts);
  assert.strictEqual(st.fields.length, 5);
});

test('extensions::/token_program/realloc keys extract from opaque attr text', () => {
  assert.deepStrictEqual(
    extractAccountKeys('#[account(mut, realloc = 8 + 32, realloc::payer = payer, realloc::zero = true)]'),
    ['mut', 'realloc', 'realloc::payer', 'realloc::zero']
  );
  assert.deepStrictEqual(
    extractAccountKeys('#[account(mint::token_program = token_program)]'),
    ['mint::token_program']
  );
  const extKeys = extractAccountKeys(
    '#[account(extensions::transfer_hook::authority = a, extensions::transfer_hook::program_id = p)]'
  );
  assert.deepStrictEqual(extKeys, ['extensions::transfer_hook::authority', 'extensions::transfer_hook::program_id']);
});

test('constraint body still extracts alongside 0.30 extension constraints', () => {
  // A copy-paste-constraint-style body is still tokenized when extensions:: are present.
  const { extractConstraintBodies } = require('../src/anchor');
  assert.deepStrictEqual(
    extractConstraintBodies('#[account(extensions::transfer_hook::authority = a, constraint = x == y.key() @ E::Z)]'),
    ['x == y.key()']
  );
});
