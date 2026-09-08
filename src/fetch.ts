// Target acquisition: build a ScanInput from a PR, a rev range, or a local repo.
// Read-only. Remote = GitHub .diff URLs + raw.githubusercontent (no API needed,
// though a token raises rate limits and is required for private repos/posting).
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ScanInput, FileForScan } from './engine';
import { parseUnifiedDiff } from './diff';
import { getText, getJson } from './http';
import { isRustFile, toPosix } from './util';

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/** Parse "owner/repo#123" or "owner/repo/pull/123". */
export function parsePrSpec(spec: string): PrRef | null {
  let m = spec.match(/^([^/\s]+)\/([^/#\s]+)#(\d+)$/);
  if (m) return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
  m = spec.match(/^([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/);
  if (m) return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
  m = spec.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (m) return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
  return null;
}

/** Parse "owner/repo". */
export function parseRepoSpec(spec: string): { owner: string; repo: string } | null {
  const m = spec.match(/^([^/\s]+)\/([^/\s]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function rawFile(
  repoFull: string,
  sha: string,
  filePath: string,
  token?: string
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${repoFull}/${sha}/${encodeURI(filePath)}`;
  try {
    return await getText(url, { accept: 'application/vnd.github.raw', token });
  } catch {
    return null;
  }
}

interface DiffFile {
  newPath: string;
  oldPath: string;
  status: string;
  changed: Set<number>;
  removed: Set<number>;
}

function diffToFiles(patch: string): DiffFile[] {
  const out: DiffFile[] = [];
  for (const [, f] of parseUnifiedDiff(patch)) {
    out.push({
      newPath: f.newPath,
      oldPath: f.oldPath,
      status: f.status,
      changed: f.changedLines,
      removed: f.removedLines,
    });
  }
  return out;
}

async function assembleRemote(
  baseRepoFull: string,
  headRepoFull: string,
  baseSha: string,
  headSha: string,
  patch: string,
  token?: string
): Promise<FileForScan[]> {
  const files: FileForScan[] = [];
  for (const f of diffToFiles(patch)) {
    if (!isRustFile(f.newPath) && !isRustFile(f.oldPath)) continue;
    if (f.status === 'deleted') continue;
    const headText = await rawFile(headRepoFull, headSha, f.newPath, token);
    const baseText =
      f.status === 'added' ? null : await rawFile(baseRepoFull, baseSha, f.oldPath, token);
    files.push({
      diff: {
        newPath: f.newPath,
        oldPath: f.oldPath,
        status: f.status as any,
        changedLines: f.changed,
        removedLines: f.removed,
        hunks: [],
        binary: false,
      },
      headText,
      baseText,
    });
  }
  return files;
}

/** Scan an open/merged/closed PR (incl. fork PRs). */
export async function fromPr(pr: PrRef, token?: string): Promise<ScanInput> {
  let meta: any;
  try {
    meta = await getJson<any>(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      { token }
    );
  } catch (e) {
    // A bad/expired token 401s even on public repos; retry unauthenticated.
    if (token && /HTTP 401/.test((e as Error).message)) {
      process.stderr.write('note: token rejected (401); retrying unauthenticated for public repo.\n');
      token = undefined;
      meta = await getJson<any>(
        `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        {}
      );
    } else {
      throw e;
    }
  }
  const headRepoFull: string = meta.head?.repo?.full_name ?? `${pr.owner}/${pr.repo}`;
  const baseRepoFull: string = meta.base?.repo?.full_name ?? `${pr.owner}/${pr.repo}`;
  const headSha: string = meta.head.sha;
  const baseSha: string = meta.base.sha;
  const patch = await getText(
    `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}.diff`,
    { accept: 'application/vnd.github.diff', token }
  );
  const files = await assembleRemote(baseRepoFull, headRepoFull, baseSha, headSha, patch, token);
  return {
    files,
    context: {
      repo: `${pr.owner}/${pr.repo}`,
      base: baseSha,
      head: headSha,
      prNumber: pr.number,
      source: 'pr',
    },
  };
}

/** Scan an explicit base...head range on a repo. */
export async function fromRange(
  owner: string,
  repo: string,
  base: string,
  head: string,
  token?: string
): Promise<ScanInput> {
  const patch = await getText(
    `https://github.com/${owner}/${repo}/compare/${base}...${head}.diff`,
    { accept: 'application/vnd.github.diff', token }
  );
  const full = `${owner}/${repo}`;
  const files = await assembleRemote(full, full, base, head, patch, token);
  return {
    files,
    context: { repo: full, base, head, source: 'range' },
  };
}

/** Build a ScanInput from an already-listed PR (avoids a per-PR API call). */
export async function fromPrEntry(
  owner: string,
  repo: string,
  e: { number: number; headSha: string; baseSha: string; headRepoFull: string; baseRepoFull: string },
  token?: string
): Promise<ScanInput> {
  const patch = await getText(`https://github.com/${owner}/${repo}/pull/${e.number}.diff`, {
    accept: 'application/vnd.github.diff',
    token,
  });
  // Optional perf cap (burn-in): skip atypically huge PRs BEFORE fetching raw
  // file contents (the expensive step).
  const cap = process.env.FP_MAX_FILES ? parseInt(process.env.FP_MAX_FILES, 10) : Infinity;
  if (Number.isFinite(cap)) {
    const rustCount = diffToFiles(patch).filter(
      (f) => (isRustFile(f.newPath) || isRustFile(f.oldPath)) && f.status !== 'deleted'
    ).length;
    if (rustCount > cap) {
      return {
        files: [],
        context: { repo: `${owner}/${repo}`, base: e.baseSha, head: e.headSha, prNumber: e.number, source: 'pr' },
      };
    }
  }
  const files = await assembleRemote(e.baseRepoFull, e.headRepoFull, e.baseSha, e.headSha, patch, token);
  return {
    files,
    context: { repo: `${owner}/${repo}`, base: e.baseSha, head: e.headSha, prNumber: e.number, source: 'pr' },
  };
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Scan a local working tree vs a base ref (or --staged vs HEAD). */
export function fromLocal(
  dir: string,
  opts: { base?: string; staged?: boolean }
): ScanInput {
  const topRes = git(['rev-parse', '--show-toplevel'], dir);
  if (!topRes.ok) throw new Error(`${dir} is not a git repository`);
  const root = topRes.out.trim();
  const base = opts.base ?? (opts.staged ? 'HEAD' : 'HEAD');
  const diffArgs = opts.staged
    ? ['diff', '--no-color', '--cached', base]
    : ['diff', '--no-color', base];
  const patch = git(diffArgs, root).out;
  const files: FileForScan[] = [];
  for (const f of diffToFiles(patch)) {
    if (!isRustFile(f.newPath) && !isRustFile(f.oldPath)) continue;
    if (f.status === 'deleted') continue;
    let headText: string | null = null;
    if (opts.staged) {
      const r = git(['show', `:${f.newPath}`], root);
      headText = r.ok ? r.out : null;
    } else {
      const abs = path.join(root, f.newPath);
      headText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    }
    let baseText: string | null = null;
    if (f.status !== 'added') {
      const r = git(['show', `${base}:${f.oldPath}`], root);
      baseText = r.ok ? r.out : null;
    }
    files.push({
      diff: {
        newPath: toPosix(f.newPath),
        oldPath: toPosix(f.oldPath),
        status: f.status as any,
        changedLines: f.changed,
        removedLines: f.removed,
        hunks: [],
        binary: false,
      },
      headText,
      baseText,
    });
  }
  return { files, context: { base, source: 'local' } };
}

/** Whole-repo scan of a local dir (every .rs file, no diff scoping). */
export function fromWholeRepo(dir: string): ScanInput {
  const root = path.resolve(dir);
  const files: FileForScan[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'target') continue;
        walk(p);
      } else if (isRustFile(ent.name)) {
        const rel = toPosix(path.relative(root, p));
        const text = fs.readFileSync(p, 'utf8');
        files.push({
          diff: {
            newPath: rel,
            oldPath: rel,
            status: 'modified',
            changedLines: new Set(),
            removedLines: new Set(),
            hunks: [],
            binary: false,
          },
          headText: text,
          baseText: null,
        });
      }
    }
  };
  walk(root);
  return { files, context: { source: 'whole-repo' } };
}
