// watch mode: review open PRs whose head changed since we last saw them.
import * as fs from 'fs';
import * as path from 'path';
import { parseRepoSpec, fromPr } from './fetch';
import { listOpenPrs } from './github';
import { runScan, findingsAtGate } from './engine';
import { loadConfig } from './config';
import { render } from './emit';
import { postToPr } from './post';
import { atomicWrite, ensureDir, stateDir } from './util';

export interface WatchOptions {
  token?: string;
  intervalSec: number;
  stateFile?: string;
  post: boolean;
  once: boolean;
}

interface WatchState {
  version: 1;
  reviewedHeads: Record<string, string>; // prNumber -> head sha
}

function defaultStatePath(repo: string): string {
  const safe = repo.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stateDir(), `watch-${safe}.json`);
}

function loadState(file: string): WatchState {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, reviewedHeads: {} };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runWatch(spec: string, opts: WatchOptions): Promise<number> {
  const r = parseRepoSpec(spec);
  if (!r) throw new Error(`watch expects owner/repo, got '${spec}'`);
  const repo = `${r.owner}/${r.repo}`;
  const stateFile = opts.stateFile ?? defaultStatePath(repo);
  ensureDir(path.dirname(stateFile));
  const config = loadConfig(undefined, process.cwd());

  let worst = 0;
  do {
    const state = loadState(stateFile);
    let prs;
    try {
      prs = await listOpenPrs(r.owner, r.repo, opts.token);
    } catch (e) {
      process.stderr.write(`watch: failed to list PRs: ${(e as Error).message}\n`);
      if (opts.once) return 2;
      await sleep(opts.intervalSec * 1000);
      continue;
    }
    const toReview = prs.filter(
      (p) => !p.draft && state.reviewedHeads[String(p.number)] !== p.headSha
    );
    if (toReview.length === 0) {
      process.stdout.write(`watch ${repo}: no un-reviewed open PRs (${prs.length} open).\n`);
    }
    for (const p of toReview) {
      process.stdout.write(`\n=== PR #${p.number}: ${p.title} ===\n`);
      try {
        const input = await fromPr({ owner: r.owner, repo: r.repo, number: p.number }, opts.token);
        const result = await runScan(input, { config });
        process.stdout.write(
          render(result, {
            format: 'terminal',
            color: false,
            showSuppressed: false,
            toolVersion: '',
          }) + '\n'
        );
        if (opts.post) {
          await postToPr(input, result, { token: opts.token, mode: 'review', toolVersion: 'watch' });
        }
        if (findingsAtGate(result.findings, config.failOn).length) worst = 1;
        state.reviewedHeads[String(p.number)] = p.headSha;
        atomicWrite(stateFile, JSON.stringify(state, null, 2));
      } catch (e) {
        process.stderr.write(`watch: PR #${p.number} failed: ${(e as Error).message}\n`);
      }
    }
    if (!opts.once) await sleep(opts.intervalSec * 1000);
  } while (!opts.once);

  return worst;
}
