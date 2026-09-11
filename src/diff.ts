// Unified-diff parser: per-file added/modified line sets in NEW-file coords,
// plus removed OLD-file line sets (for deletion-aware diffing).
// Hardened port of spike/diffparse.js.
import { FileDiff, FileStatus, Hunk } from './types';
import { toPosix } from './util';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip a git diff path prefix ("a/", "b/") if present. */
function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (/^[ab]\//.test(p)) return p.slice(2);
  return p;
}

/** Parse a unified/git diff into per-new-path FileDiff records. */
export function parseUnifiedDiff(patchText: string): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>();
  let current: FileDiff | null = null;
  let newLine = 0;
  let oldLine = 0;
  let sawHunk = false;
  let pendingOldPath: string | null = null;
  let pendingNewPath: string | null = null;

  const commit = () => {
    if (current) files.set(current.newPath, current);
  };

  const lines = patchText.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    let m: RegExpMatchArray | null;

    if ((m = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/))) {
      commit();
      const oldP = toPosix(m[1]);
      const newP = toPosix(m[2]);
      current = {
        newPath: newP,
        oldPath: oldP,
        status: 'modified',
        changedLines: new Set<number>(),
        removedLines: new Set<number>(),
        hunks: [],
        binary: false,
      };
      pendingOldPath = null;
      pendingNewPath = null;
      sawHunk = false;
      continue;
    }

    if (!current) {
      // Support bare patches without "diff --git" (e.g. `git format-patch` body
      // or plain `diff -u`). Start a file on the ---/+++ pair.
      if (line.startsWith('--- ')) {
        pendingOldPath = stripPrefix(line.slice(4).split('\t')[0].trim());
        continue;
      }
      if (line.startsWith('+++ ') && pendingOldPath !== null) {
        pendingNewPath = stripPrefix(line.slice(4).split('\t')[0].trim());
        const newP = pendingNewPath === '/dev/null' ? pendingOldPath : pendingNewPath;
        current = {
          newPath: toPosix(newP),
          oldPath: toPosix(pendingOldPath),
          status: 'modified',
          changedLines: new Set<number>(),
          removedLines: new Set<number>(),
          hunks: [],
          binary: false,
        };
        sawHunk = false;
        continue;
      }
      continue;
    }

    // Header lines inside a file section.
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) continue;
    if (line.startsWith('similarity index')) continue;
    if (line.startsWith('rename from ')) {
      current.oldPath = toPosix(line.slice('rename from '.length).trim());
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = toPosix(line.slice('rename to '.length).trim());
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4).split('\t')[0].trim());
      if (p === '/dev/null') current.status = 'added';
      else current.oldPath = toPosix(p);
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4).split('\t')[0].trim());
      if (p === '/dev/null') current.status = 'deleted';
      else current.newPath = toPosix(p);
      continue;
    }

    if ((m = line.match(HUNK_RE))) {
      const h: Hunk = {
        oldStart: parseInt(m[1], 10),
        oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
      };
      current.hunks.push(h);
      newLine = h.newStart;
      oldLine = h.oldStart;
      sawHunk = true;
      continue;
    }

    if (!sawHunk) continue;

    if (line.startsWith('+')) {
      current.changedLines.add(newLine);
      newLine++;
    } else if (line.startsWith('-')) {
      current.removedLines.add(oldLine);
      oldLine++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — no coordinate consumed.
    } else if (line.startsWith(' ') || line === '') {
      // context line (a truly empty line in a diff is a single-space context
      // line that lost its leading space; treat as context).
      newLine++;
      oldLine++;
    } else {
      // Unknown line inside a hunk: stop consuming this hunk defensively.
      sawHunk = false;
    }
  }
  commit();

  // Finalize statuses that only show via /dev/null on one side.
  for (const f of files.values()) {
    if (f.status === 'modified') {
      if (f.oldPath !== f.newPath) f.status = 'renamed';
    }
  }
  return files;
}

/** Convenience: union of all changed NEW-file lines across a patch. */
export function changedLinesByFile(patchText: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [p, f] of parseUnifiedDiff(patchText)) {
    out.set(p, f.changedLines);
  }
  return out;
}

export { FileDiff, FileStatus } from './types';
