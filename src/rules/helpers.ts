// Shared helpers for detectors.
import { AnchorField, Finding, RuleContext, RuleMeta, RustFn, Severity, Tier } from '../types';
import { shortHash } from '../util';

/** Normalize whitespace for stable comparison/fingerprints. */
export function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 1-based line accessor from a SourceFile's lines array. */
export function lineText(lines: string[], n: number): string {
  return lines[n - 1] ?? '';
}

/** Quote 1..N lines of evidence (trimmed right), joined with \n. */
export function quote(lines: string[], start: number, end?: number): string {
  const e = end ?? start;
  const out: string[] = [];
  for (let l = start; l <= e; l++) out.push((lines[l - 1] ?? '').replace(/\s+$/, ''));
  return out.join('\n');
}

/** The innermost function whose span contains `line`. */
export function fnContaining(facts: { fns: RustFn[] }, line: number): RustFn | undefined {
  let best: RustFn | undefined;
  for (const fn of facts.fns) {
    if (line >= fn.startLine && line <= fn.endLine) {
      if (!best || fn.startLine >= best.startLine) best = fn; // innermost = latest start
    }
  }
  return best;
}

/** Strip line comments and block comments from a logical string (best-effort;
 *  ignores string literals — acceptable for our token scans which never
 *  legitimately match inside a Rust string). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += src[i++];
    }
  }
  return out;
}

/** Build a finding with a stable, line-move-tolerant fingerprint. */
export function makeFinding(
  meta: RuleMeta,
  args: {
    file: string;
    line: number;
    endLine?: number;
    message: string;
    evidence: string;
    severity?: Severity;
    tier?: Tier;
  }
): Finding {
  const severity = args.severity ?? meta.severity;
  const tier = args.tier ?? meta.tier;
  const fingerprint = shortHash(
    [meta.id, args.file, normWs(args.evidence)].join('\0'),
    16
  );
  return {
    ruleId: meta.id,
    tier,
    severity,
    file: args.file,
    line: args.line,
    endLine: args.endLine ?? args.line,
    message: args.message,
    evidence: args.evidence,
    provenance: meta.provenance,
    provenanceUrl: meta.provenanceUrl,
    fingerprint,
  };
}

/** Return the changed lines of ctx as a sorted array. */
export function changedSorted(ctx: RuleContext): number[] {
  return [...ctx.changed].sort((a, b) => a - b);
}

/** True if any of the substrings appears in text. */
export function containsAny(text: string, subs: string[]): boolean {
  return subs.some((s) => text.includes(s));
}

/** Identifier tokens in an expression. */
export function identifiers(expr: string): Set<string> {
  return new Set(expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

/** Map a 0-based char index in `text` to a 1-based line number. */
export function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Strip // line comments from a single physical line (keeps block-comment
 *  markers intact — callers that need block handling use stripComments). */
export function stripLineComment(s: string): string {
  const i = s.indexOf('//');
  return i === -1 ? s : s.slice(0, i);
}

/** Given lines and a 1-based start line, find the first `{` at/after it and
 *  return the [open,close] 1-based line span of the balanced block. Braces in
 *  // line comments are ignored. Returns null if unbalanced. */
export function braceBlockFrom(
  lines: string[],
  startLine1: number
): { open: number; close: number } | null {
  let open = -1;
  let depth = 0;
  for (let ln = startLine1; ln <= lines.length; ln++) {
    const code = stripLineComment(lines[ln - 1] ?? '');
    for (const ch of code) {
      if (ch === '{') {
        if (open === -1) open = ln;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (open !== -1 && depth === 0) return { open, close: ln };
      }
    }
  }
  return null;
}

/** The 1-based start line of the innermost `{` block enclosing `line`. */
export function enclosingBlockStart(lines: string[], line: number): number {
  let depth = 0;
  for (let ln = line; ln >= 1; ln--) {
    const code = stripLineComment(lines[ln - 1] ?? '');
    for (let i = code.length - 1; i >= 0; i--) {
      if (code[i] === '}') depth++;
      else if (code[i] === '{') {
        if (depth === 0) return ln;
        depth--;
      }
    }
  }
  return 1;
}

/** First line of a field's full scope span: a field's preceding attributes and
 *  doc comments count as part of the field. A PR that edits ONLY an attribute
 *  or a `/// CHECK:` comment must still put the field in scope — scoping to the
 *  declaration line alone missed single-line constraint edits (acceptance-audit
 *  finding, fixed here). */
export function fieldScopeStart(f: AnchorField): number {
  let s = f.startLine;
  for (const a of f.allAttrs) s = Math.min(s, a.startLine);
  for (const c of f.comments) s = Math.min(s, c.startLine);
  return s;
}
