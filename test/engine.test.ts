import { test } from 'node:test';
import * as assert from 'node:assert';
import { runScan, ScanInput, findingsAtGate } from '../src/engine';

function scan(text: string, changed: number[], extra: Partial<ScanInput['files'][0]> = {}) {
  const input: ScanInput = {
    files: [
      {
        diff: {
          newPath: 'x.rs',
          oldPath: 'x.rs',
          status: 'modified',
          changedLines: new Set(changed),
          removedLines: new Set(),
          hunks: [],
          binary: false,
        },
        headText: text,
        baseText: null,
        ...extra,
      },
    ],
    context: { source: 'patch' },
  };
  return input;
}

const REALLOC = `pub fn grow(l: &AccountLoader<M>, n: usize) -> Result<()> {
    l.as_ref().realloc(n, false)?;
    Ok(())
}`;

test('inline suppression hides the finding but records it', async () => {
  const txt = `pub fn grow(l: &AccountLoader<M>, n: usize) -> Result<()> {
    // sol-pr-guard-ignore-next-line realloc-zero-init
    l.as_ref().realloc(n, false)?;
    Ok(())
}`;
  const r = await runScan(scan(txt, [1, 2, 3, 4]), { includeTests: true });
  assert.strictEqual(r.findings.filter((f) => f.ruleId === 'realloc-zero-init').length, 0);
  assert.ok(r.suppressed.some((f) => f.ruleId === 'realloc-zero-init'));
});

test('cfg(test) region is excluded', async () => {
  const txt = `#[cfg(test)]
mod tests {
    fn grow(l: &AccountLoader<M>, n: usize) {
        l.as_ref().realloc(n, false).unwrap();
    }
}`;
  const r = await runScan(scan(txt, [1, 2, 3, 4, 5]), { includeTests: false });
  assert.strictEqual(r.findings.length, 0);
});

test('baseline filters known fingerprints', async () => {
  const first = await runScan(scan(REALLOC, [1, 2, 3]), { includeTests: true });
  assert.ok(first.findings.length >= 1);
  const fp = new Set(first.findings.map((f) => f.fingerprint));
  const second = await runScan(scan(REALLOC, [1, 2, 3]), {
    includeTests: true,
    baselineFingerprints: fp,
  });
  assert.strictEqual(second.findings.length, 0);
});

test('unparseable file still analyzed best-effort or noticed, never crashes', async () => {
  const broken = `pub fn f( { { { unbalanced ]]] realloc(x, false)`;
  const r = await runScan(scan(broken, [1]), { includeTests: true });
  assert.ok(Array.isArray(r.findings));
});

test('non-rust files are skipped', async () => {
  const input: ScanInput = {
    files: [
      {
        diff: {
          newPath: 'x.ts',
          oldPath: 'x.ts',
          status: 'modified',
          changedLines: new Set([1]),
          removedLines: new Set(),
          hunks: [],
          binary: false,
        },
        headText: 'const x = a.realloc(n, false);',
        baseText: null,
      },
    ],
    context: { source: 'patch' },
  };
  const r = await runScan(input, { includeTests: true });
  assert.strictEqual(r.findings.length, 0);
  assert.strictEqual(r.stats.filesAnalyzed, 0);
});

test('findingsAtGate honors fail-on tier', async () => {
  const r = await runScan(scan(REALLOC, [1, 2, 3]), { includeTests: true });
  assert.ok(findingsAtGate(r.findings, 'T1').length >= 1);
  assert.strictEqual(findingsAtGate(r.findings, 'none').length, 0);
});

test('path traversal in a diff filename is skipped with a notice', async () => {
  const input: ScanInput = {
    files: [
      {
        diff: {
          newPath: '../../etc/evil.rs',
          oldPath: '../../etc/evil.rs',
          status: 'modified',
          changedLines: new Set([1]),
          removedLines: new Set(),
          hunks: [],
          binary: false,
        },
        headText: 'fn f() { a.realloc(n, false); }',
        baseText: null,
      },
    ],
    context: { source: 'patch' },
  };
  const r = await runScan(input, { includeTests: true });
  assert.strictEqual(r.findings.length, 0);
  assert.ok(r.notices.some((n) => /unsafe path/.test(n.message)));
});

test('findings are deduped by fingerprint', async () => {
  const r = await runScan(scan(REALLOC, [1, 2, 3]), { includeTests: true });
  const fps = r.findings.map((f) => f.fingerprint);
  assert.strictEqual(new Set(fps).size, fps.length);
});
