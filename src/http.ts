// Minimal zero-dep HTTPS client. The ONLY hosts this tool ever contacts are
// github.com, api.github.com, raw.githubusercontent.com and codeload.github.com
// (enforced here — a hard allowlist is a trust feature, see README).
import * as https from 'https';

const ALLOWED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com', // raw redirects here
  'patch-diff.githubusercontent.com', // github.com/*/pull/N.diff|.patch redirects here
]);

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function assertAllowed(url: string): void {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `refusing to contact non-GitHub host '${host}' (sol-pr-guard only talks to GitHub)`
    );
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  token?: string;
  accept?: string;
  body?: string;
  userAgent?: string;
}

export function request(url: string, opts: RequestOptions = {}, redirects = 5): Promise<HttpResponse> {
  assertAllowed(url);
  const u = new URL(url);
  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent ?? 'sol-pr-guard',
    Accept: opts.accept ?? 'application/vnd.github+json',
  };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: opts.method ?? 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers,
        timeout: 30000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          if (redirects <= 0) return reject(new Error('too many redirects'));
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(request(next, opts, redirects - 1));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status, body: data, headers: res.headers }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`request timed out: ${url}`)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export async function getText(url: string, opts: RequestOptions = {}): Promise<string> {
  const r = await request(url, opts);
  if (r.status !== 200) {
    throw new Error(`GET ${url} -> HTTP ${r.status}`);
  }
  return r.body;
}

export async function getJson<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const r = await request(url, opts);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`GET ${url} -> HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body) as T;
}
