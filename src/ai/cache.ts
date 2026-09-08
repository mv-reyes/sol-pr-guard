// Content-hash cache for AI results — keyed by (provider, model, prompt-version,
// input hash) so re-runs (and CI) are cheap and reproducible. Stored under the
// OS cache dir; never networked.
import * as fs from 'fs';
import * as path from 'path';
import { cacheDir, ensureDir, sha256, atomicWrite } from '../util';

const PROMPT_VERSION = 'v2';

function keyPath(provider: string, model: string, kind: string, input: string): string {
  const h = sha256([PROMPT_VERSION, provider, model, kind, input].join('\0'));
  return path.join(cacheDir(), 'ai', `${h}.json`);
}

export function readCache<T>(provider: string, model: string, kind: string, input: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(keyPath(provider, model, kind, input), 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeCache(provider: string, model: string, kind: string, input: string, value: unknown): void {
  const p = keyPath(provider, model, kind, input);
  ensureDir(path.dirname(p));
  atomicWrite(p, JSON.stringify(value));
}
