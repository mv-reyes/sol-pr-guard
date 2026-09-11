// AI layer orchestrator (optional, off by default). Never affects the exit code
// or the deterministic findings; it only annotates them (Phase A) and adds
// separate, clearly-labeled Tier-3 hypotheses (Phase B, experimental).
import { ScanResult } from '../engine';
import { Provider, Transport, providerFromEnv, realTransport } from './provider';
import { explainFindings, Explanation } from './explain';
import { semanticPass, AiFinding } from './semantic';

export interface AiOptions {
  mode: 'off' | 'on' | 'experimental';
  provider?: Provider | null;
  transport?: Transport;
}

export interface AiResult {
  explanations: Map<string, Explanation>;
  aiFindings: AiFinding[];
  notices: string[];
  provider?: string;
  model?: string;
}

export async function runAi(result: ScanResult, opts: AiOptions): Promise<AiResult> {
  const notices: string[] = [];
  if (opts.mode === 'off') return { explanations: new Map(), aiFindings: [], notices };
  const provider = opts.provider ?? providerFromEnv();
  if (!provider) {
    notices.push(
      '--ai requested but no backend configured (set ANTHROPIC_API_KEY / OPENAI_API_KEY, or SPG_AI_PROVIDER=ollama). Deterministic results are unaffected.'
    );
    return { explanations: new Map(), aiFindings: [], notices };
  }
  const transport = opts.transport ?? realTransport;

  // Phase A — explainer (always, when --ai is on).
  const explanations = await explainFindings(result.findings, provider, transport);

  // Phase B — semantic pass (experimental only).
  let aiFindings: AiFinding[] = [];
  if (opts.mode === 'experimental' && result.aiContext) {
    aiFindings = await semanticPass(
      result.aiContext.files,
      result.aiContext.lookupStruct,
      provider,
      transport
    );
  } else if (opts.mode === 'experimental' && !result.aiContext) {
    notices.push('Phase B needs AST context — re-run with collectAiContext (the CLI sets this under --ai=experimental).');
  }

  return { explanations, aiFindings, notices, provider: provider.name, model: provider.model };
}

export { AiFinding } from './semantic';
export { Explanation } from './explain';
