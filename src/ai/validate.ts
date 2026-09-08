// Mechanical validation of Phase-B AI claims. Every claim the LLM returns is
// checked against the actual source BEFORE it is ever surfaced; a failed check
// drops the claim silently. This is the software analog of the fork-RUN gate:
// the model proposes, a deterministic check disposes. No LLM here — pure checks.
import { SourceFile } from '../types';

export interface AiClaim {
  class: string;
  file: string;
  line: number;
  evidence_quote: string;
  reasoning: string;
  confidence: number; // 0..1
}

export interface ValidationResult {
  ok: boolean;
  reason: string;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A claim is valid iff:
 *  (1) its line is inside the file, and within the changed set when scoped;
 *  (2) its evidence_quote actually occurs in the source (whitespace-normalized);
 *  (3) the quote occurs at/near the claimed line (±3), i.e. the anchor resolves.
 */
export function validateClaim(
  claim: AiClaim,
  head: SourceFile,
  changed: Set<number>,
  opts: { requireChanged?: boolean } = {}
): ValidationResult {
  const lines = head.lines;
  if (!Number.isInteger(claim.line) || claim.line < 1 || claim.line > lines.length) {
    return { ok: false, reason: `line ${claim.line} out of range 1..${lines.length}` };
  }
  if (opts.requireChanged && changed.size > 0 && !changed.has(claim.line)) {
    // allow ±1 so an anchor on an adjacent context line still counts
    if (!changed.has(claim.line - 1) && !changed.has(claim.line + 1)) {
      return { ok: false, reason: `line ${claim.line} not in changed set` };
    }
  }
  const quote = norm(claim.evidence_quote);
  if (quote.length < 4) return { ok: false, reason: 'evidence_quote too short' };
  const src = norm(head.text);
  if (!src.includes(quote)) {
    return { ok: false, reason: 'evidence_quote not found in source (hallucinated)' };
  }
  // anchor resolves: the quote appears within a small window around the line.
  const lo = Math.max(1, claim.line - 3);
  const hi = Math.min(lines.length, claim.line + 3);
  const window = norm(lines.slice(lo - 1, hi).join('\n'));
  if (!window.includes(quote.slice(0, Math.min(quote.length, 40)))) {
    return { ok: false, reason: `evidence_quote does not resolve near line ${claim.line}` };
  }
  if (typeof claim.confidence !== 'number' || claim.confidence < 0 || claim.confidence > 1) {
    return { ok: false, reason: 'confidence out of range' };
  }
  return { ok: true, reason: 'validated' };
}

/** Parse a model response into claims. Accepts a JSON array or an object with a
 *  `findings`/`claims` array; tolerant of ```json fences. Returns [] on garbage. */
export function parseClaims(raw: string): AiClaim[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // find the first [ or { to tolerate leading prose.
  const start = text.search(/[[{]/);
  if (start > 0) text = text.slice(start);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const arr = Array.isArray(data)
    ? data
    : (data as any)?.findings ?? (data as any)?.claims ?? [];
  if (!Array.isArray(arr)) return [];
  const out: AiClaim[] = [];
  for (const c of arr) {
    if (c && typeof c === 'object' && typeof c.evidence_quote === 'string' && typeof c.line !== 'undefined') {
      out.push({
        class: String(c.class ?? 'unknown'),
        file: String(c.file ?? ''),
        line: Number(c.line),
        evidence_quote: String(c.evidence_quote),
        reasoning: String(c.reasoning ?? ''),
        confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
      });
    }
  }
  return out;
}
