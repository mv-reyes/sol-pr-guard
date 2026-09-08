// Context-pack builder for the Phase-B semantic pass. Uses the tool's own AST
// infrastructure (diff + enclosing fns + linked Accounts structs + 1-hop
// same-file callees) so the LLM sees a tight, grounded slice — not the repo.
import { FileFacts, RustFn, SourceFile } from '../types';

// Value-flow signal: only engage Phase B where money can actually move.
const VALUE_FLOW =
  /(transfer|invoke_signed|invoke|\bcpi\b|mint_to|\bmint\b|\bburn\b|withdraw|deposit|\bpayout\b|change_\w*_shares|lamports|realloc|close)/i;

export function hasValueFlow(text: string): boolean {
  return VALUE_FLOW.test(text);
}

export interface ContextPack {
  file: string;
  changedLines: number[];
  text: string;
}

function fnsIntersecting(facts: FileFacts, changed: Set<number>): RustFn[] {
  const out: RustFn[] = [];
  for (const fn of facts.fns) {
    for (const l of changed) {
      if (l >= fn.startLine && l <= fn.endLine) {
        out.push(fn);
        break;
      }
    }
  }
  return out;
}

/** Same-file callees referenced by name inside the given fns (1-hop). */
function oneHopCallees(facts: FileFacts, fns: RustFn[]): RustFn[] {
  const names = new Set(facts.fns.map((f) => f.name).filter((n): n is string => !!n));
  const called = new Set<string>();
  for (const fn of fns) {
    for (const n of names) {
      if (n && new RegExp(`\\b${n}\\s*\\(`).test(fn.bodyText)) called.add(n);
    }
  }
  return facts.fns.filter((f) => f.name && called.has(f.name) && !fns.includes(f));
}

/** Build a bounded context pack for one changed file. `maxChars` caps the pack
 *  so the prompt stays small and cheap. */
export function buildContextPack(
  head: SourceFile,
  facts: FileFacts,
  changed: Set<number>,
  lookupStruct: (name: string) => { file: string; struct: { startLine: number; endLine: number } } | undefined,
  maxChars = 8000
): ContextPack {
  const lines = head.lines;
  const parts: string[] = [];
  const changedArr = [...changed].sort((a, b) => a - b);

  // 1. The changed lines themselves, with line numbers.
  parts.push('# Changed lines (new-file coordinates):');
  for (const l of changedArr) parts.push(`${l}: ${lines[l - 1] ?? ''}`);

  // 2. Enclosing functions (full text).
  const fns = fnsIntersecting(facts, changed);
  for (const fn of fns) {
    parts.push(`\n# Enclosing fn ${fn.name ?? '<anon>'} (lines ${fn.startLine}-${fn.endLine}):`);
    parts.push(quoteRange(lines, fn.startLine, fn.endLine));
    // linked Accounts struct via Context<T>.
    if (fn.contextType) {
      const s = lookupStruct(fn.contextType);
      if (s && s.file === head.path) {
        parts.push(`\n# Linked Accounts struct ${fn.contextType} (lines ${s.struct.startLine}-${s.struct.endLine}):`);
        parts.push(quoteRange(lines, s.struct.startLine, s.struct.endLine));
      }
    }
  }

  // 3. One-hop same-file callees (signatures + bodies, bounded).
  for (const callee of oneHopCallees(facts, fns).slice(0, 4)) {
    parts.push(`\n# Callee ${callee.name} (lines ${callee.startLine}-${callee.endLine}):`);
    parts.push(quoteRange(lines, callee.startLine, callee.endLine));
  }

  let text = parts.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n# ...(truncated)';
  return { file: head.path, changedLines: changedArr, text };
}

function quoteRange(lines: string[], start: number, end: number): string {
  const out: string[] = [];
  for (let l = start; l <= Math.min(end, lines.length); l++) out.push(`${l}: ${lines[l - 1] ?? ''}`);
  return out.join('\n');
}
