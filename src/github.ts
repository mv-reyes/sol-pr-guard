// GitHub REST helpers for posting/watching. Read-only unless a write method is
// explicitly called (and those require a token).
import { request, getJson } from './http';

const API = 'https://api.github.com';

export interface OpenPr {
  number: number;
  headSha: string;
  title: string;
  draft: boolean;
}

export async function listOpenPrs(owner: string, repo: string, token?: string): Promise<OpenPr[]> {
  const out: OpenPr[] = [];
  for (let page = 1; page <= 10; page++) {
    let arr: any[];
    try {
      arr = await getJson<any[]>(
        `${API}/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
        { token }
      );
    } catch (e) {
      if (token && /HTTP 401/.test((e as Error).message)) {
        token = undefined; // bad token: fall back to unauthenticated (public repo)
        arr = await getJson<any[]>(
          `${API}/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
          {}
        );
      } else throw e;
    }
    for (const p of arr) {
      out.push({ number: p.number, headSha: p.head.sha, title: p.title, draft: !!p.draft });
    }
    if (arr.length < 100) break;
  }
  return out;
}

export interface PrListEntry {
  number: number;
  title: string;
  merged: boolean;
  headSha: string;
  baseSha: string;
  headRepoFull: string;
  baseRepoFull: string;
}

/** List recently CLOSED PRs (for FP burn-in). One API call per page — the list
 *  entries already carry head/base SHAs, so no per-PR API call is needed. */
export async function listClosedPrs(
  owner: string,
  repo: string,
  limit: number,
  token?: string
): Promise<PrListEntry[]> {
  const out: PrListEntry[] = [];
  for (let page = 1; page <= 20 && out.length < limit; page++) {
    let arr: any[];
    try {
      arr = await getJson<any[]>(
        `${API}/repos/${owner}/${repo}/pulls?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`,
        { token }
      );
    } catch (e) {
      if (token && /HTTP 401/.test((e as Error).message)) {
        token = undefined; // bad token: fall back to unauthenticated (public repo)
        arr = await getJson<any[]>(
          `${API}/repos/${owner}/${repo}/pulls?state=closed&per_page=100&page=${page}&sort=updated&direction=desc`,
          {}
        );
      } else throw e;
    }
    for (const p of arr) {
      out.push({
        number: p.number,
        title: p.title,
        merged: !!p.merged_at,
        headSha: p.head?.sha,
        baseSha: p.base?.sha,
        headRepoFull: p.head?.repo?.full_name ?? `${owner}/${repo}`,
        baseRepoFull: p.base?.repo?.full_name ?? `${owner}/${repo}`,
      });
      if (out.length >= limit) break;
    }
    if (arr.length < 100) break;
  }
  return out;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
  start_line?: number;
  start_side?: 'RIGHT';
}

/** Post one atomic review with inline comments (event COMMENT). */
export async function createReview(
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string,
  body: string,
  comments: ReviewComment[],
  token: string
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({ commit_id: commitId, body, event: 'COMMENT', comments });
  const r = await request(`${API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    token,
    body: payload,
  });
  return { status: r.status, body: r.body };
}

/** Find the tool's own prior summary issue-comment (by marker), if any. */
export async function findOwnComment(
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
  token: string
): Promise<number | null> {
  for (let page = 1; page <= 5; page++) {
    const arr = await getJson<any[]>(
      `${API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      { token }
    );
    const found = arr.find((c) => typeof c.body === 'string' && c.body.includes(marker));
    if (found) return found.id;
    if (arr.length < 100) break;
  }
  return null;
}

export async function upsertIssueComment(
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number | null,
  body: string,
  token: string
): Promise<number> {
  if (commentId) {
    await request(`${API}/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify({ body }),
    });
    return commentId;
  }
  const r = await request(`${API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    token,
    body: JSON.stringify({ body }),
  });
  const j = JSON.parse(r.body);
  return j.id;
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
}

/** Create a check run with annotations (batched ≤50 per request by caller). */
export async function createCheckRun(
  owner: string,
  repo: string,
  headSha: string,
  name: string,
  conclusion: 'success' | 'failure' | 'neutral',
  summary: string,
  annotations: CheckAnnotation[],
  token: string
): Promise<{ status: number; body: string }> {
  const first = annotations.slice(0, 50);
  const payload = JSON.stringify({
    name,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    output: { title: name, summary, annotations: first },
  });
  const r = await request(`${API}/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    token,
    body: payload,
  });
  // Remaining annotations via PATCH (≤50 each).
  if (r.status >= 200 && r.status < 300 && annotations.length > 50) {
    const id = JSON.parse(r.body).id;
    for (let i = 50; i < annotations.length; i += 50) {
      await request(`${API}/repos/${owner}/${repo}/check-runs/${id}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ output: { title: name, summary, annotations: annotations.slice(i, i + 50) } }),
      });
    }
  }
  return { status: r.status, body: r.body };
}
