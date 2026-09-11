import { test } from 'node:test';
import * as assert from 'node:assert';
import { runScan, ScanInput, ScanResult } from '../src/engine';
import { render } from '../src/emit';

const REALLOC = `pub fn grow(l: &AccountLoader<M>, n: usize) -> Result<()> {
    l.as_ref().realloc(n, false)?;
    Ok(())
}`;

function scan(): ScanInput {
  return {
    files: [
      {
        diff: {
          newPath: 'programs/x/src/lib.rs',
          oldPath: 'programs/x/src/lib.rs',
          status: 'modified',
          changedLines: new Set([1, 2, 3]),
          removedLines: new Set(),
          hunks: [],
          binary: false,
        },
        headText: REALLOC,
        baseText: null,
      },
    ],
    context: { source: 'patch' },
  };
}

async function result(): Promise<ScanResult> {
  return runScan(scan(), { includeTests: true });
}

test('sarif output is valid and well-formed', async () => {
  const r = await result();
  const out = render(r, { format: 'sarif', color: false, showSuppressed: false, toolVersion: '1.2.3' });
  const doc = JSON.parse(out);
  assert.strictEqual(doc.version, '2.1.0');
  assert.strictEqual(doc.runs[0].tool.driver.name, 'sol-pr-guard');
  assert.ok(doc.runs[0].tool.driver.rules.length >= 12);
  assert.ok(doc.runs[0].results.length >= 1);
  const res = doc.runs[0].results[0];
  assert.strictEqual(res.locations[0].physicalLocation.artifactLocation.uri, 'programs/x/src/lib.rs');
  assert.strictEqual(res.locations[0].physicalLocation.region.startLine, 2);
});

test('json output includes findings with provenance', async () => {
  const r = await result();
  const out = render(r, { format: 'json', color: false, showSuppressed: true, toolVersion: '1.2.3' });
  const doc = JSON.parse(out);
  assert.strictEqual(doc.tool, 'sol-pr-guard');
  assert.ok(doc.findings[0].provenanceUrl.startsWith('https://github.com/'));
  assert.strictEqual(doc.findings[0].file, 'programs/x/src/lib.rs');
});

test('efm output is path:line:col: message (rule)', async () => {
  const r = await result();
  const out = render(r, { format: 'efm', color: false, showSuppressed: false, toolVersion: '1' });
  assert.match(out, /^programs\/x\/src\/lib\.rs:2:1: .*\(realloc-zero-init\)$/m);
});

test('terminal output reports a clean run clearly', async () => {
  const empty = await runScan(
    {
      files: [
        {
          diff: {
            newPath: 'a.rs',
            oldPath: 'a.rs',
            status: 'modified',
            changedLines: new Set([1]),
            removedLines: new Set(),
            hunks: [],
            binary: false,
          },
          headText: 'pub fn ok() -> u8 { 1 }',
          baseText: null,
        },
      ],
      context: { source: 'patch' },
    },
    { includeTests: true }
  );
  const out = render(empty, { format: 'terminal', color: false, showSuppressed: true, toolVersion: '1' });
  assert.match(out, /No findings/);
});
