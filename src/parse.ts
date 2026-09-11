// web-tree-sitter wrapper: grammar load (bundled asset, dep fallback), a
// process-wide parser singleton, and robust parse with a size cap + timeout.
import * as fs from 'fs';
import * as path from 'path';

// web-tree-sitter >=0.24 exports { Parser, Language }.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WTS = require('web-tree-sitter');
const ParserClass: any = WTS.Parser ?? WTS;
const LanguageClass: any = WTS.Language ?? ParserClass.Language;

/** Files larger than this are not AST-parsed (reported as a meta-notice). */
export const MAX_PARSE_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Parse timeout guard, if the grammar build supports it. */
const PARSE_TIMEOUT_MICROS = 8_000_000; // 8s

let _langPromise: Promise<any> | null = null;

/** Locate the prebuilt tree-sitter-rust grammar wasm, cross-platform. */
export function grammarWasmPath(): string {
  // 1) bundled asset (published package / after build).
  const bundled = path.join(__dirname, '..', '..', 'assets', 'tree-sitter-rust.wasm');
  if (fs.existsSync(bundled)) return bundled;
  // 2) resolve from the tree-sitter-wasms dependency.
  try {
    const pkg = require.resolve('tree-sitter-wasms/package.json');
    const p = path.join(path.dirname(pkg), 'out', 'tree-sitter-rust.wasm');
    if (fs.existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  throw new Error(
    'sol-pr-guard: could not locate tree-sitter-rust.wasm (bundled asset missing and tree-sitter-wasms not resolvable). Re-run `npm install`/`npm run build`.'
  );
}

async function loadLanguage(): Promise<any> {
  if (!_langPromise) {
    _langPromise = (async () => {
      await ParserClass.init();
      const version: string = (() => {
        try {
          return JSON.parse(
            fs.readFileSync(
              require.resolve('web-tree-sitter/package.json'),
              'utf8'
            )
          ).version;
        } catch {
          return 'unknown';
        }
      })();
      // Guard against the known-broken 0.27 ABI break (dylink).
      if (/^0\.(2[7-9]|[3-9]\d)\./.test(version)) {
        throw new Error(
          `sol-pr-guard: web-tree-sitter ${version} is unsupported (>=0.27 breaks grammar loading). Pin 0.25.10.`
        );
      }
      return LanguageClass.load(grammarWasmPath());
    })();
  }
  return _langPromise;
}

export interface ParseResult {
  tree: any | null;
  hasError: boolean;
  skipped: boolean;
  skipReason?: string;
}

let _parser: any | null = null;

/** Get (and memoize) a ready parser. */
export async function getParser(): Promise<any> {
  const lang = await loadLanguage();
  if (!_parser) {
    _parser = new ParserClass();
    _parser.setLanguage(lang);
  }
  return _parser;
}

/** Parse Rust source into a tree-sitter tree. Never throws on user input. */
export async function parseSource(text: string): Promise<ParseResult> {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_PARSE_BYTES) {
    return {
      tree: null,
      hasError: false,
      skipped: true,
      skipReason: `file too large to parse (${bytes} bytes > ${MAX_PARSE_BYTES})`,
    };
  }
  const parser = await getParser();
  if (typeof parser.setTimeoutMicros === 'function') {
    try {
      parser.setTimeoutMicros(PARSE_TIMEOUT_MICROS);
    } catch {
      /* not fatal */
    }
  }
  let tree: any;
  try {
    tree = parser.parse(text);
  } catch (e) {
    return {
      tree: null,
      hasError: true,
      skipped: true,
      skipReason: `parser error: ${(e as Error).message}`,
    };
  }
  if (!tree || !tree.rootNode) {
    return { tree: null, hasError: true, skipped: true, skipReason: 'parse returned no tree (timeout?)' };
  }
  return { tree, hasError: tree.rootNode.hasError, skipped: false };
}

/** 1-based start/end line accessors. */
export const startLine = (n: any): number => n.startPosition.row + 1;
export const endLine = (n: any): number => n.endPosition.row + 1;
