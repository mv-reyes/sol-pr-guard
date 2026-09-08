import { test } from 'node:test';
import * as assert from 'node:assert';
import { toPosix, isSafeRelPath, isExcludedPath, isRustFile, splitLines, cacheDir, stateDir } from '../src/util';

test('toPosix normalizes separators', () => {
  assert.strictEqual(toPosix('a\\b\\c'), 'a/b/c');
});

test('isSafeRelPath rejects traversal and absolute paths', () => {
  assert.ok(isSafeRelPath('programs/src/lib.rs'));
  assert.ok(!isSafeRelPath('../../etc/passwd'));
  assert.ok(!isSafeRelPath('/etc/passwd'));
  assert.ok(!isSafeRelPath('C:\\Windows\\system32'));
  assert.ok(!isSafeRelPath('a/../b'));
  assert.ok(!isSafeRelPath('a/\u0000b'));
});

test('isExcludedPath excludes tests/benches/idl/target', () => {
  assert.ok(isExcludedPath('programs/foo/tests/bar.rs'));
  assert.ok(isExcludedPath('benches/x.rs'));
  assert.ok(isExcludedPath('target/debug/x.rs'));
  assert.ok(isExcludedPath('idl/foo.rs'));
  assert.ok(!isExcludedPath('programs/foo/src/lib.rs'));
});

test('isRustFile', () => {
  assert.ok(isRustFile('a/b.rs'));
  assert.ok(!isRustFile('a/b.ts'));
});

test('splitLines normalizes CRLF and lone CR', () => {
  assert.deepStrictEqual(splitLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']);
});

test('cache/state dirs are absolute and platform-appropriate', () => {
  const c = cacheDir();
  const s = stateDir();
  assert.ok(c.includes('sol-pr-guard'));
  assert.ok(s.includes('sol-pr-guard'));
  // absolute path on all platforms
  assert.ok(/^([A-Za-z]:[\\/]|\/)/.test(c), `cacheDir should be absolute: ${c}`);
});
