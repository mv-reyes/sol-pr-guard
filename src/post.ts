// Post findings to a PR as a reviewer would: one atomic review with inline
// comments (default), or a Check Run with annotations. Anti-spam: batch into a
// single review, update the tool's own summary comment in place on re-runs, and
// never re-report a finding the user previously dismissed (dismiss memory).
import * as fs from 'fs';
import { ScanInput, ScanResult } from './engine';
import { Finding } from './types';
import {
  createReview,
  createCheckRun,
  findOwnComment,
  upsertIssueComment,
  ReviewComment,
  CheckAnnotation,
} from './github';
import { atomicWrite, ensureDir, stateDir } from './util';
import * as path from 'path';

const MARKER = '<!-- sol-pr-guard:summary -->';

export interface PostOptions {
  token?: string;
  mode: 'review' | 'check';
  toolVersion: string;
  stateFile?: string;
}

interface PostState {
  version: 1;
  dismissed: Record<string, string[]>; // prNumber -> fingerprints
  summaryComment: Record<string, number>; // prNumber -> issue comment id
  postedHead: Record<string, string>; // prNumber -> head sha last posted
}

function defaultStatePath(repo: string): string {
  const safe = repo.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stateDir(), `post-${safe}.json`);
}

function loadState(file: string): PostState {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, dismissed: {}, summaryComment: {}, postedHead: {} };
  }
}

function sevToLevel(sev: Finding['severity']): 'notice' | 'warning' | 'failure' {
  return sev === 'critical' || sev === 'high'
    ? 'failure'
    : sev === 'medium'
    ? 'warning'
    : 'notice';
}

function summaryMarkdown(findings: Finding[], suppressedCount: number, toolVersion: string): string {
  const lines: string[] = [MARKER, '', `## 🛡️ sol-pr-guard review (${findings.length} finding${findings.length === 1 ? '' : 's'})`, ''];
  if (findings.length === 0) {
    lines.push('No security findings on the changed lines. ✅');
  } else {
    lines.push('| sev | rule | location | issue |', '| --- | --- | --- | --- |');
    for (const f of findings) {
      lines.push(
        `| ${f.severity} | \`${f.ruleId}\` | \`${f.file}:${f.line}\` | ${f.message.replace(/\|/g, '\\|')} |`
      );
    }
  }
  if (suppressedCount) lines.push('', `_${suppressedCount} finding(s) suppressed via inline directives._`);
  lines.push('', `<sub>sol-pr-guard ${toolVersion} · diff-scoped · no telemetry</sub>`);
  return lines.join('\n');
}

export async function postToPr(
  input: ScanInput,
  result: ScanResult,
  opts: PostOptions
): Promise<void> {
  const { token } = opts;
  const repo = input.context.repo;
  const prNumber = input.context.prNumber;
  const headSha = input.context.head;
  if (!token) throw new Error('--post requires a token (--token or GITHUB_TOKEN). Scan still ran; posting skipped.');
  if (!repo || !prNumber || !headSha) {
    throw new Error('--post only works on a PR target (owner/repo#N).');
  }
  const [owner, name] = repo.split('/');
  const stateFile = opts.stateFile ?? defaultStatePath(repo);
  ensureDir(path.dirname(stateFile));
  const state = loadState(stateFile);
  const key = String(prNumber);
  const dismissed = new Set(state.dismissed[key] ?? []);

  const active = result.findings.filter((f) => !dismissed.has(f.fingerprint));

  if (opts.mode === 'check') {
    const anns: CheckAnnotation[] = active.map((f) => ({
      path: f.file,
      start_line: f.line,
      end_line: f.endLine,
      annotation_level: sevToLevel(f.severity),
      message: `${f.message}\n\n${f.provenance}: ${f.provenanceUrl}`,
      title: f.ruleId,
    }));
    const conclusion = active.some((f) => f.tier <= 2) ? 'failure' : 'success';
    const res = await createCheckRun(
      owner,
      name,
      headSha,
      'sol-pr-guard',
      conclusion,
      summaryMarkdown(active, result.suppressed.length, opts.toolVersion),
      anns,
      token
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`check-run POST failed (HTTP ${res.status}). Does the token have checks:write? ${res.body.slice(0, 160)}`);
    }
  } else {
    // review mode: one atomic review with inline comments.
    const comments: ReviewComment[] = active.map((f) => ({
      path: f.file,
      line: f.endLine,
      side: 'RIGHT' as const,
      ...(f.endLine > f.line ? { start_line: f.line, start_side: 'RIGHT' as const } : {}),
      body: `**${f.severity} · \`${f.ruleId}\`** — ${f.message}\n\n> ${f.provenance}: ${f.provenanceUrl}`,
    }));
    const summary = summaryMarkdown(active, result.suppressed.length, opts.toolVersion);
    // Update our own summary comment in place (anti-spam).
    const existing = await findOwnComment(owner, name, prNumber, MARKER, token);
    await upsertIssueComment(owner, name, prNumber, existing, summary, token);
    // Only create a review with inline comments when there are findings AND
    // the head changed since we last posted (avoid duplicate inline comments).
    if (comments.length && state.postedHead[key] !== headSha) {
      const res = await createReview(owner, name, prNumber, headSha, '', comments, token);
      if (res.status < 200 || res.status >= 300) {
        // 422 usually = a comment line not in the diff; fall back to summary only.
        process.stderr.write(
          `note: inline review not posted (HTTP ${res.status}); summary comment updated instead.\n`
        );
      }
    }
  }

  state.postedHead[key] = headSha;
  state.dismissed[key] = [...dismissed];
  atomicWrite(stateFile, JSON.stringify(state, null, 2));
}
