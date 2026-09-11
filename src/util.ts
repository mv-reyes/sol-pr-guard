// Cross-platform utilities. macOS is the primary platform; everything here is
// path.join-based and OS-aware (cache dirs, path normalization, atomic writes).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourceFile } from './types';

// SHA-256 is vendored (vendor/sha256.min.js = the official js-sha256 1.0.0
// minified build, MIT) so the CLI stays zero-registry-dependency and produces
// byte-identical content hashes across runtimes. See vendor/README.md.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vendorSha256 = require(path.join(__dirname, '..', '..', 'vendor', 'sha256.min.js'));

/** Normalize any path to POSIX (forward slash) form for stable output/keys. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** OS-correct per-user cache dir for this tool.
 *  macOS/Linux: $XDG_CACHE_HOME/sol-pr-guard or ~/.cache/sol-pr-guard
 *  Windows: %LOCALAPPDATA%\sol-pr-guard or ~/AppData/Local/sol-pr-guard
 */
export function cacheDir(): string {
  const app = 'sol-pr-guard';
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, app);
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, app);
}

/** OS-correct per-user state dir (watch/dismiss state). */
export function stateDir(): string {
  const app = 'sol-pr-guard';
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, app, 'state');
  }
  const base =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, app);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function sha256(text: string | Buffer): string {
  const h = vendorSha256.sha256.create();
  h.update(text);
  return h.hex();
}

export function shortHash(text: string, n = 12): string {
  return sha256(text).slice(0, n);
}

/** Atomic write: tmp file + rename (survives kill -9 mid-write). */
export function atomicWrite(file: string, data: string | Buffer): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Split source into lines with CRLF/CR normalized away for indexing. */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Offset-preserving mask of everything that is NOT code: line/block comments
 *  (block comments nest, per Rust) and the *contents* of string / byte-string /
 *  raw-string / char literals. Every masked character is replaced by a space,
 *  EXCEPT newlines, which are preserved — so length, line numbers, and column
 *  math are identical to the source. Delimiters (quotes, line comments, and
 *  block-comment markers) are also blanked so a regex cannot match through them.
 *
 *  This is the tool's anti-evasion primitive: ALL suppression / bound / guard
 *  tests must run against the masked text, never the raw text. Because the rules
 *  are public, a rule-aware PR author would otherwise silence a Tier-1 finding
 *  with a one-line comment or an error-message string (acceptance-audit v0.2 §C.12).
 *  Raw text is still used for evidence quoting. */
export function maskNonCode(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // line comment  // ... EOL   (covers ///, //!)
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    // block comment  /* ... */   (nests; covers /** */)
    if (c === '/' && c2 === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
        else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // raw string:  r"..."  r#"..."#  br##"..."##  (optional b prefix, N hashes)
    {
      let k = i;
      if (src[k] === 'b') k++;
      if (src[k] === 'r') {
        let hashes = 0;
        let m = k + 1;
        while (src[m] === '#') { hashes++; m++; }
        if (src[m] === '"') {
          const closer = '"' + '#'.repeat(hashes);
          let j = m + 1;
          while (j < n) {
            if (src[j] === '"' && src.substr(j, 1 + hashes) === closer) { j += 1 + hashes; break; }
            j++;
          }
          blank(i, j);
          i = j;
          continue;
        }
      }
    }
    // normal / byte string:  "..."  b"..."   (with \ escapes)
    if (c === '"' || (c === 'b' && c2 === '"')) {
      let j = c === '"' ? i + 1 : i + 2;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // char literal  'x' / '\n' / '\u{..}'  — NOT a lifetime ('a) or label.
    if (c === "'") {
      if (src[i + 1] === '\\') {
        let j = i + 2;
        if (src[i + 2] === 'u' && src[i + 3] === '{') {
          j = i + 3;
          while (j < n && src[j] !== '}') j++;
          j++;
        }
        if (src[j] === "'") { blank(i, j + 1); i = j + 1; continue; }
      } else if (src[i + 1] !== undefined && src[i + 1] !== "'" && src[i + 2] === "'") {
        blank(i, i + 3);
        i += 3;
        continue;
      }
      i++; // lifetime / stray quote: leave as-is
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Build a SourceFile (raw + offset-preserving masked variants) from text. */
export function makeSourceFile(p: string, text: string): SourceFile {
  const textStripped = maskNonCode(text);
  return {
    path: p,
    text,
    lines: splitLines(text),
    textStripped,
    linesStripped: splitLines(textStripped),
  };
}

function hasControlChar(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Guard against path traversal in diff-supplied file names. */
export function isSafeRelPath(p: string): boolean {
  if (!p) return false;
  const norm = toPosix(p);
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return false; // absolute
  if (norm.split('/').some((seg) => seg === '..')) return false; // traversal
  if (hasControlChar(norm)) return false; // control chars
  return true;
}

/** True when a file path should be excluded by default (tests/benches/gen). */
export function isExcludedPath(p: string): boolean {
  const n = toPosix(p).toLowerCase();
  return (
    /(^|\/)(tests?|benches|__tests__|test-fixtures?)\//.test(n) ||
    /(^|\/)target\//.test(n) ||
    /\.generated\.rs$/.test(n) ||
    /(^|\/)idl\//.test(n)
  );
}

/** Only .rs files are analyzable. */
export function isRustFile(p: string): boolean {
  return toPosix(p).toLowerCase().endsWith('.rs');
}

/** Clamp helper. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** True if any line in [start,end] is in `set`. Iterates the SMALLER of the
 *  range or the set, so it stays fast even when a file has a huge changed set
 *  (pathological "everything changed" inputs) or a node spans many lines. */
export function rangeHitsSet(start: number, end: number, set: Set<number>): boolean {
  const span = end - start + 1;
  if (span <= set.size) {
    for (let l = start; l <= end; l++) if (set.has(l)) return true;
    return false;
  }
  for (const l of set) if (l >= start && l <= end) return true;
  return false;
}
