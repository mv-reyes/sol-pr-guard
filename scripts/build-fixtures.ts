// DEV-ONLY (network). Regenerates bench/corpus/fixtures/<id>/{before.rs,
// after.rs, meta.json} from the corpus manifest + cached patches. Replay then
// runs fully OFFLINE from these fixtures. Never run in CI/replay.
//
// Method: fetch the post-fix file from raw.githubusercontent at the fix SHA,
// then REVERSE-APPLY the patch hunks in pure JS to reconstruct the pre-fix
// file. Every context/added line is validated against the fetched post file;
// any drift throws (we never fabricate a fixture).
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

interface Entry {
  id: string;
  rule: string;
  repo: string;
  patch: string;
  file: string;
  expectTier: number;
  note?: string;
}

interface RawHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: { type: ' ' | '+' | '-'; text: string }[];
}

const TOOL_DIR = path.join(__dirname, '..', '..'); // dist/scripts -> tool
const SRC_TOOL_DIR = path.join(__dirname, '..'); // fallback when run from source
function toolRoot(): string {
  // works whether run from dist/ or ts-node; fixtures live under tool/bench.
  for (const c of [TOOL_DIR, SRC_TOOL_DIR, process.cwd()]) {
    if (fs.existsSync(path.join(c, 'bench', 'corpus', 'manifest.json'))) return c;
  }
  return process.cwd();
}

function get(url: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'sol-pr-guard-fixture-builder' } }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirects <= 0) return reject(new Error('too many redirects'));
          res.resume();
          return resolve(get(res.headers.location, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function fullShaFromPatch(text: string): string | null {
  // Use the LAST commit in the series so the fetched "after" content is the
  // final tree the concatenated hunks produce.
  const all = [...text.matchAll(/^From ([0-9a-f]{40}) /gm)];
  return all.length ? all[all.length - 1][1] : null;
}

/** Extract the raw hunks for one file path (matched by new path b/<file>).
 *  Consumption is COUNT-BOUNDED by the hunk header's old/new line counts, so
 *  blank context lines (rendered as "" by some diff tools) are handled and we
 *  never truncate a hunk or over-read into the trailer. */
function hunksForFile(patch: string, file: string): RawHunk[] {
  const lines = patch.split('\n');
  const hunks: RawHunk[] = [];
  let inFile = false;
  let cur: RawHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const dm = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (dm) {
      inFile = dm[2] === file || dm[1] === file;
      cur = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '').split('\t')[0].trim();
      if (p === file) inFile = true;
      continue;
    }
    if (!inFile) continue;
    const hm = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hm) {
      cur = {
        oldStart: parseInt(hm[1], 10),
        oldLines: hm[2] === undefined ? 1 : parseInt(hm[2], 10),
        newStart: parseInt(hm[3], 10),
        newLines: hm[4] === undefined ? 1 : parseInt(hm[4], 10),
        body: [],
      };
      hunks.push(cur);
      oldLeft = cur.oldLines;
      newLeft = cur.newLines;
      continue;
    }
    if (!cur) continue;
    if (oldLeft <= 0 && newLeft <= 0) {
      cur = null;
      continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) {
      cur.body.push({ type: '+', text: line.slice(1) });
      newLeft--;
    } else if (line.startsWith('-')) {
      cur.body.push({ type: '-', text: line.slice(1) });
      oldLeft--;
    } else {
      // context line: a leading space, OR a genuinely empty line emitted by a
      // diff tool that stripped the space from a blank context line.
      cur.body.push({ type: ' ', text: line.startsWith(' ') ? line.slice(1) : '' });
      oldLeft--;
      newLeft--;
    }
  }
  return hunks;
}

/** New-file line numbers of the ADDED (`+`) lines only — the fix's own edits. */
function addedNewLines(hunks: RawHunk[]): number[] {
  const out: number[] = [];
  for (const h of hunks) {
    let n = h.newStart;
    for (const bl of h.body) {
      if (bl.type === '+') {
        out.push(n);
        n++;
      } else if (bl.type === ' ') {
        n++;
      }
      // '-' consumes no new line
    }
  }
  return out;
}

/** OLD-file line numbers the fix actually touched. For hunks WITH removals:
 *  the exact REMOVED (`-`) lines only — that is the true edited surface (using
 *  the whole hunk envelope over-scoped the buggy-file replay and masked
 *  detectors that only fire when the exact edited line is in scope — audit
 *  finding). For ADD-ONLY hunks (a missing check was inserted, nothing
 *  removed) the truthful surface is the insertion neighborhood, so the hunk's
 *  old-side context lines are used. */
function removedOldLines(hunks: RawHunk[]): number[] {
  const out: number[] = [];
  for (const h of hunks) {
    let n = h.oldStart;
    let removed = 0;
    const contextLines: number[] = [];
    for (const bl of h.body) {
      if (bl.type === '-') {
        out.push(n);
        removed++;
        n++;
      } else if (bl.type === ' ') {
        contextLines.push(n);
        n++;
      }
      // '+' consumes no old line
    }
    if (removed === 0) out.push(...contextLines);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Reverse-apply hunks to POST content -> PRE content. Validates context. */
function reverseApply(postText: string, hunks: RawHunk[]): string {
  const post = postText.split('\n');
  const endsWithNl = postText.endsWith('\n');
  if (endsWithNl) post.pop(); // drop trailing '' from split
  const pre: string[] = [];
  let idx = 0; // 0-based post index
  const ordered = hunks.slice().sort((a, b) => a.newStart - b.newStart);
  for (const h of ordered) {
    while (idx < h.newStart - 1) {
      pre.push(post[idx]);
      idx++;
    }
    for (const bl of h.body) {
      if (bl.type === ' ') {
        assertMatch(post[idx], bl.text, idx);
        pre.push(post[idx]);
        idx++;
      } else if (bl.type === '+') {
        assertMatch(post[idx], bl.text, idx);
        idx++; // present in POST only: drop from PRE
      } else {
        pre.push(bl.text); // removed line: present in PRE only
      }
    }
  }
  while (idx < post.length) {
    pre.push(post[idx]);
    idx++;
  }
  return pre.join('\n') + (endsWithNl ? '\n' : '');
}

function assertMatch(actual: string | undefined, expected: string, idx: number): void {
  const a = (actual ?? '').replace(/\r$/, '');
  const e = expected.replace(/\r$/, '');
  if (a !== e) {
    throw new Error(
      `context mismatch at post line ${idx + 1}:\n  expected: ${JSON.stringify(e)}\n  actual:   ${JSON.stringify(a)}`
    );
  }
}

async function main() {
  const root = toolRoot();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'bench', 'corpus', 'manifest.json'), 'utf8')
  );
  const entries: Entry[] = manifest.entries;
  const fixturesDir = path.join(root, 'bench', 'corpus', 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  let ok = 0;
  const failures: string[] = [];
  for (const e of entries) {
    try {
      const patchPath = path.resolve(root, e.patch);
      const patch = fs.readFileSync(patchPath, 'utf8');
      const sha = fullShaFromPatch(patch);
      if (!sha) throw new Error('no full SHA in patch From line');
      const hunks = hunksForFile(patch, e.file);
      if (!hunks.length) throw new Error(`no hunks for ${e.file} in patch`);
      const url = `https://raw.githubusercontent.com/${e.repo}/${sha}/${e.file}`;
      const after = await get(url);
      const before = reverseApply(after, hunks);
      const dir = path.join(fixturesDir, e.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'after.rs'), after);
      fs.writeFileSync(path.join(dir, 'before.rs'), before);
      const meta = {
        id: e.id,
        rule: e.rule,
        repo: e.repo,
        sha,
        file: e.file,
        expectTier: e.expectTier,
        note: e.note ?? '',
        buggyChanged: removedOldLines(hunks),
        fixedChanged: addedNewLines(hunks),
      };
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
      console.log(`ok   ${e.id}  (${e.file}) sha=${sha.slice(0, 10)}`);
      ok++;
    } catch (err) {
      console.error(`FAIL ${e.id}: ${(err as Error).message}`);
      failures.push(e.id);
    }
  }
  console.log(`\n${ok}/${entries.length} fixtures built. failures: ${failures.join(', ') || 'none'}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
