import { test } from 'node:test';
import * as assert from 'node:assert';
import { maskNonCode, makeSourceFile } from '../src/util';

// The masker is the anti-evasion foundation: it must blank comment and
// string/char-literal CONTENT while preserving length, newlines, and therefore
// every line/column offset (so a finding's line math is unchanged).

test('maskNonCode preserves total length and newline positions', () => {
  const src = 'let a = 1; // note\nlet b = "hello world";\n/* block */ let c = 2;\n';
  const out = maskNonCode(src);
  assert.strictEqual(out.length, src.length);
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') assert.strictEqual(out[i], '\n', `newline preserved at ${i}`);
  }
});

test('maskNonCode blanks line-comment content but keeps code before it', () => {
  const out = maskNonCode('state.fee = x; // fee <= 10_000 enforced elsewhere');
  assert.match(out, /state\.fee = x;/);
  assert.ok(!/10_000/.test(out), 'comment content is gone');
  assert.ok(!/enforced/.test(out));
});

test('maskNonCode blanks string-literal content (defeats error-string evasion)', () => {
  const out = maskNonCode('#[error("fee value out of bounds")] struct E;');
  assert.ok(!/out of bounds/.test(out), 'string content is gone');
  assert.match(out, /#\[error\(/); // the code structure survives
  assert.match(out, /struct E;/);
});

test('maskNonCode handles nested block comments', () => {
  const out = maskNonCode('a /* outer /* inner */ still */ b');
  assert.ok(!/outer/.test(out));
  assert.ok(!/inner/.test(out));
  assert.ok(!/still/.test(out));
  assert.match(out, /^a /);
  assert.match(out, / b$/);
});

test('maskNonCode blanks raw strings including hashes', () => {
  const out = maskNonCode('let s = r#"a "quoted" realloc(0) bit"#; do_it();');
  assert.ok(!/realloc\(0\)/.test(out), 'raw-string content gone');
  assert.match(out, /do_it\(\);/);
});

test('maskNonCode masks a char literal but NOT a lifetime', () => {
  // char literal content blanked; lifetime `'info` left intact as code.
  const out = maskNonCode(`let c = '/'; fn f<'info>(x: &'info u8) {}`);
  assert.match(out, /'info/, 'lifetime preserved');
  assert.match(out, /fn f</);
  // the char literal's inner slash must not survive as a stray '/'
  assert.ok(out.indexOf("'/'") === -1, 'char-literal content blanked');
});

test('makeSourceFile exposes aligned raw + masked line arrays', () => {
  const sf = makeSourceFile('x.rs', 'let a = 1; // c\nlet b = 2;\n');
  assert.strictEqual(sf.lines.length, sf.linesStripped.length);
  assert.match(sf.lines[0], /\/\/ c/); // raw keeps the comment
  assert.ok(!/c/.test(sf.linesStripped[0].replace('let', ''))); // masked drops it
  assert.strictEqual(sf.lines[0].length, sf.linesStripped[0].length);
});
