// Phase A — explainer. For each DETERMINISTIC finding, the LLM writes a
// plain-English explanation + suggested fix, grounded in the finding + evidence
// quote + provenance. Zero FP risk: it never creates or changes a finding, only
// annotates one. Cached by content hash. Always labeled AI-assisted.
import { Finding } from '../types';
import { Provider, Transport, complete, realTransport } from './provider';
import { readCache, writeCache } from './cache';

export interface Explanation {
  fingerprint: string;
  explanation: string;
  fix: string;
}

const SYSTEM = `You are a senior Solana (Rust/Anchor) security reviewer. You are given ONE
finding that a deterministic static analyzer already confirmed, with the exact code it flagged.
Explain, in 2-3 plain sentences, WHY this is a security risk and how an attacker could exploit it,
then give a concrete one-line suggested fix. Do NOT hedge about whether it is a real finding — the
analyzer already confirmed the pattern; your job is to explain and suggest a fix. Be specific to the
code shown. Output strictly as JSON: {"explanation": "...", "fix": "..."}.`;

function userPrompt(f: Finding): string {
  return [
    `Rule: ${f.ruleId} (${f.severity})`,
    `Location: ${f.file}:${f.line}`,
    `Message: ${f.message}`,
    `Derived from real exploit/fix: ${f.provenance} (${f.provenanceUrl})`,
    `Flagged code:`,
    '```rust',
    f.evidence,
    '```',
  ].join('\n');
}

export async function explainFindings(
  findings: Finding[],
  provider: Provider,
  transport: Transport = realTransport
): Promise<Map<string, Explanation>> {
  const out = new Map<string, Explanation>();
  for (const f of findings) {
    const input = userPrompt(f);
    const cached = readCache<Explanation>(provider.name, provider.model, 'explain', input);
    if (cached) {
      out.set(f.fingerprint, cached);
      continue;
    }
    let raw: string;
    try {
      raw = await complete(provider, { system: SYSTEM, user: input, maxTokens: 400, temperature: 0 }, transport);
    } catch {
      continue; // explainer failure is non-fatal; deterministic finding still stands
    }
    let parsed: { explanation?: string; fix?: string } = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    } catch {
      parsed = { explanation: raw.trim().slice(0, 400), fix: '' };
    }
    const exp: Explanation = {
      fingerprint: f.fingerprint,
      explanation: (parsed.explanation ?? '').trim(),
      fix: (parsed.fix ?? '').trim(),
    };
    if (exp.explanation) {
      writeCache(provider.name, provider.model, 'explain', input, exp);
      out.set(f.fingerprint, exp);
    }
  }
  return out;
}
