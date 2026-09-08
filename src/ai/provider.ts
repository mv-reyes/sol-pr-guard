// Provider-agnostic LLM client for the optional --ai layer. Zero new deps: raw
// HTTPS to one of Anthropic / OpenAI / Ollama (local). Off by default; the
// endpoint is the ONLY extra network destination --ai adds (documented in the
// README). The transport is injectable so request-shaping is unit-tested
// offline without ever sending a request.
import * as https from 'https';
import * as http from 'http';

export type ProviderName = 'anthropic' | 'openai' | 'ollama';

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

export interface HttpCall {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** Transport: given a shaped HTTP call, return the raw response body string. */
export type Transport = (call: HttpCall) => Promise<{ status: number; body: string }>;

export interface Provider {
  name: ProviderName;
  model: string;
  shape(req: LlmRequest): HttpCall;
  parse(responseBody: string): string;
}

const ALLOWED_HOSTS = new Set(['api.anthropic.com', 'api.openai.com', 'localhost', '127.0.0.1']);

/** Default transport: raw HTTPS/HTTP, host-restricted to the LLM allowlist. */
export const realTransport: Transport = (call) =>
  new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(call.url);
    } catch {
      return reject(new Error(`invalid LLM URL: ${call.url}`));
    }
    if (!ALLOWED_HOSTS.has(u.hostname)) {
      return reject(new Error(`--ai: refusing to contact non-LLM host '${u.hostname}'`));
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      { method: call.method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: call.headers, timeout: 60000 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('LLM request timed out')));
    req.on('error', reject);
    req.write(call.body);
    req.end();
  });

export function anthropicProvider(apiKey: string, model: string): Provider {
  return {
    name: 'anthropic',
    model,
    shape: (r) => ({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: r.maxTokens,
        system: r.system,
        messages: [{ role: 'user', content: r.user }],
      }),
    }),
    parse: (b) => {
      const j = JSON.parse(b);
      if (Array.isArray(j.content)) {
        return j.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('');
      }
      throw new Error(`anthropic: unexpected response ${b.slice(0, 200)}`);
    },
  };
}

export function openaiProvider(apiKey: string, model: string): Provider {
  return {
    name: 'openai',
    model,
    shape: (r) => ({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_completion_tokens: r.maxTokens,
        messages: [
          { role: 'system', content: r.system },
          { role: 'user', content: r.user },
        ],
      }),
    }),
    parse: (b) => {
      const j = JSON.parse(b);
      return j.choices?.[0]?.message?.content ?? '';
    },
  };
}

export function ollamaProvider(model: string, host = 'http://localhost:11434'): Provider {
  return {
    name: 'ollama',
    model,
    shape: (r) => ({
      url: `${host}/api/chat`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: r.system },
          { role: 'user', content: r.user },
        ],
      }),
    }),
    parse: (b) => {
      const j = JSON.parse(b);
      return j.message?.content ?? '';
    },
  };
}

/** Select a provider from the environment. Returns null if --ai has no backend
 *  configured (the tool then prints a clear message and skips the AI pass). */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): Provider | null {
  const explicit = env.SPG_AI_PROVIDER as ProviderName | undefined;
  const phaseAModel = env.SPG_AI_MODEL || 'claude-sonnet-5';
  if (explicit === 'ollama' || (!explicit && env.SPG_AI_OLLAMA)) {
    return ollamaProvider(env.SPG_AI_MODEL || 'llama3.1', env.SPG_AI_OLLAMA || undefined);
  }
  if ((explicit === 'anthropic' || !explicit) && env.ANTHROPIC_API_KEY) {
    return anthropicProvider(env.ANTHROPIC_API_KEY, phaseAModel);
  }
  if ((explicit === 'openai' || !explicit) && env.OPENAI_API_KEY) {
    return openaiProvider(env.OPENAI_API_KEY, env.SPG_AI_MODEL || 'gpt-5');
  }
  return null;
}

/** Run one completion through a provider + transport. */
export async function complete(
  provider: Provider,
  req: LlmRequest,
  transport: Transport = realTransport
): Promise<string> {
  const call = provider.shape(req);
  const res = await transport(call);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${provider.name} HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  return provider.parse(res.body);
}
