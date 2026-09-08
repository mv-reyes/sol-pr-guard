// Phase B — Tier-3 semantic pass (experimental). Targets the REPO-context bug
// classes the deterministic detectors cannot see (stale precomputed values
// across short-circuiting pipelines, business-invariant gaps). It is a
// HYPOTHESIS GENERATOR gated three ways: (1) only runs on diffs with value-flow
// signal; (2) the LLM must return structured claims with an evidence quote;
// (3) EVERY claim is mechanically validated against the real source before it is
// surfaced — a claim whose quote/line does not resolve is dropped silently.
// Output is always Tier 3, labeled "AI-assisted — needs human confirmation",
// and never affects the exit code.
import { FileFacts, SourceFile } from '../types';
import { Provider, Transport, complete, realTransport } from './provider';
import { buildContextPack, hasValueFlow } from './context';
import { parseClaims, validateClaim, AiClaim } from './validate';
import { readCache, writeCache } from './cache';

export interface AiFinding {
  ruleId: 'ai-semantic';
  tier: 3;
  aiClass: string;
  file: string;
  line: number;
  evidence: string;
  reasoning: string;
  confidence: number;
  label: 'AI-assisted — needs human confirmation';
}

export interface AiFileCtx {
  head: SourceFile;
  facts: FileFacts;
  changed: Set<number>;
}

const SYSTEM = `You are a Solana (Rust/Anchor) security auditor hunting REPO-CONTEXT bugs that
line-level linters miss. Focus ONLY on these classes:
- stale precomputed value consumed after a short-circuiting multi-step pipeline (e.g. a fee/borrowing
  value computed up front that survives an insolvent-close/early-exit and then drives a mint/payout —
  an unbacked mint);
- a business invariant (solvency, backing, health, cap) enforced on sibling paths but NOT on this one;
- a value read/computed before a state-mutating step (accrue/settle/CPI) then used as if still fresh.
You are given a diff slice with enclosing functions, linked Accounts structs, and 1-hop callees.
Return ONLY a JSON array. Each element:
{"class": "<one of the classes>", "file": "<path>", "line": <int, a line number shown in the slice>,
 "evidence_quote": "<a VERBATIM substring copied from the slice at that line>", "reasoning": "<1-2 sentences>",
 "confidence": <0.0-1.0>}.
Rules: the evidence_quote MUST be copied verbatim from a line shown in the slice (it will be checked).
If you find nothing in these classes, return []. Do not invent code. Prefer [] over a weak guess.`;

function userPrompt(file: string, pack: string): string {
  return `File: ${file}\n\n${pack}`;
}

export async function semanticPass(
  files: AiFileCtx[],
  lookupStruct: (name: string) => { file: string; struct: { startLine: number; endLine: number } } | undefined,
  provider: Provider,
  transport: Transport = realTransport,
  minConfidence = 0.5
): Promise<AiFinding[]> {
  const out: AiFinding[] = [];
  for (const f of files) {
    const changedText = [...f.changed].map((l) => f.head.lines[l - 1] ?? '').join('\n');
    if (!hasValueFlow(changedText) && !hasValueFlow(f.head.text)) continue; // gate 1
    const pack = buildContextPack(f.head, f.facts, f.changed, lookupStruct);
    if (!pack.text.trim()) continue;
    const input = userPrompt(f.head.path, pack.text);

    let raw = readCache<string>(provider.name, provider.model, 'semantic', input);
    if (raw === null) {
      try {
        raw = await complete(provider, { system: SYSTEM, user: input, maxTokens: 1200, temperature: 0 }, transport);
      } catch {
        continue;
      }
      writeCache(provider.name, provider.model, 'semantic', input, raw);
    }

    const claims: AiClaim[] = parseClaims(raw);
    for (const c of claims) {
      if (c.confidence < minConfidence) continue;
      const v = validateClaim(c, f.head, f.changed, { requireChanged: false });
      if (!v.ok) continue; // gate 3: hallucinated / unresolvable → dropped silently
      out.push({
        ruleId: 'ai-semantic',
        tier: 3,
        aiClass: c.class,
        file: f.head.path,
        line: c.line,
        evidence: (f.head.lines[c.line - 1] ?? c.evidence_quote).trim(),
        reasoning: c.reasoning,
        confidence: c.confidence,
        label: 'AI-assisted — needs human confirmation',
      });
    }
  }
  return out;
}
