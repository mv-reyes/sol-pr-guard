import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseUnifiedDiff } from '../src/diff';

test('single-hunk new-file coordinates', () => {
  const patch = `diff --git a/x.rs b/x.rs
--- a/x.rs
+++ b/x.rs
@@ -51,7 +51,7 @@ pub struct S {
 a
 b
 c
-old
+new
 d
 e
 f`;
  const files = parseUnifiedDiff(patch);
  const f = files.get('x.rs')!;
  // context: 51,52,53; change at 54; then 55,56,57
  assert.ok(f.changedLines.has(54), 'changed line should be 54');
  assert.strictEqual(f.changedLines.size, 1);
  assert.ok(f.removedLines.has(54));
});

test('multi-line addition maps to consecutive new lines', () => {
  const patch = `diff --git a/y.rs b/y.rs
--- a/y.rs
+++ b/y.rs
@@ -472,7 +472,9 @@ fn f() {
 ctx
 line
 more
-removed
+addedA
+addedB
+addedC
 tail
 tail2
 tail3`;
  const f = parseUnifiedDiff(patch).get('y.rs')!;
  assert.deepStrictEqual([...f.changedLines].sort((a, b) => a - b), [475, 476, 477]);
});

test('new file uses @@ -0,0 and marks added', () => {
  const patch = `diff --git a/new.rs b/new.rs
new file mode 100644
--- /dev/null
+++ b/new.rs
@@ -0,0 +1,3 @@
+one
+two
+three`;
  const f = parseUnifiedDiff(patch).get('new.rs')!;
  assert.strictEqual(f.status, 'added');
  assert.deepStrictEqual([...f.changedLines].sort((a, b) => a - b), [1, 2, 3]);
});

test('rename is detected', () => {
  const patch = `diff --git a/old.rs b/new.rs
similarity index 90%
rename from old.rs
rename to new.rs
--- a/old.rs
+++ b/new.rs
@@ -1,2 +1,2 @@
-a
+b
 c`;
  const f = parseUnifiedDiff(patch).get('new.rs')!;
  assert.strictEqual(f.status, 'renamed');
  assert.strictEqual(f.oldPath, 'old.rs');
});

test('deleted file marked, no new lines', () => {
  const patch = `diff --git a/gone.rs b/gone.rs
deleted file mode 100644
--- a/gone.rs
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b`;
  const f = parseUnifiedDiff(patch).get('gone.rs')!;
  assert.strictEqual(f.status, 'deleted');
  assert.strictEqual(f.changedLines.size, 0);
});

test('no trailing newline marker is ignored', () => {
  const patch = `diff --git a/z.rs b/z.rs
--- a/z.rs
+++ b/z.rs
@@ -1,1 +1,1 @@
-a
+b
\\ No newline at end of file`;
  const f = parseUnifiedDiff(patch).get('z.rs')!;
  assert.ok(f.changedLines.has(1));
});

test('two hunks in same file both mapped', () => {
  const patch = `diff --git a/m.rs b/m.rs
--- a/m.rs
+++ b/m.rs
@@ -1,1 +1,1 @@
-a
+b
@@ -10,1 +10,1 @@
-c
+d`;
  const f = parseUnifiedDiff(patch).get('m.rs')!;
  assert.deepStrictEqual([...f.changedLines].sort((a, b) => a - b), [1, 10]);
});
