// AI Phase-B calibration gate. Runs the semantic pass over the REPO-tier corpus
// bugs (it must catch >= the gmsol GT over-mint ef7dc2c3d2 to promote Phase B
// out of experimental) and over clean fixtures (publishes the AI FP rate).
// Requires an LLM backend (ANTHROPIC_API_KEY / OPENAI_API_KEY / SPG_AI_PROVIDER).
// With no backend it reports honestly and Phase B stays behind --ai=experimental.
import * as fs from 'fs';
import * as path from 'path';
import { parseSource } from '../../src/parse';
import { buildFacts } from '../../src/anchor';
import { makeSourceFile } from '../../src/util';
import { providerFromEnv } from '../../src/ai/provider';
import { semanticPass, AiFileCtx } from '../../src/ai/semantic';
import { SourceFile } from '../../src/types';

function root(): string {
  let d = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'bench', 'ai-calibration'))) return d;
    d = path.dirname(d);
  }
  return process.cwd();
}

function sf(p: string, text: string): SourceFile {
  return makeSourceFile(p, text);
}

async function ctxFrom(file: string, text: string, changed: Set<number>): Promise<AiFileCtx> {
  const parsed = await parseSource(text);
  return { head: sf(file, text), facts: buildFacts(parsed.tree), changed };
}

async function main() {
  const r = root();
  const provider = providerFromEnv();
  const out: string[] = ['# AI Phase-B calibration', '', `Generated: ${new Date().toISOString()}`, ''];

  if (!provider) {
    out.push(
      'No LLM backend configured in this environment (no ANTHROPIC_API_KEY / OPENAI_API_KEY / Ollama).',
      'Phase B could not be calibrated here and therefore ships behind `--ai=experimental`.',
      'To calibrate: set a backend and re-run `npm run ai-calibration`. The gate to promote Phase B',
      'to `--ai` is: catch >= the gmsol GT over-mint (ef7dc2c3d2) on the REPO-tier set AND keep the',
      'clean-fixture AI false-positive rate acceptable (published here).',
      ''
    );
    fs.writeFileSync(path.join(r, 'bench', 'ai-calibration', 'CALIBRATION.md'), out.join('\n'));
    console.log('AI calibration: no backend configured — Phase B stays experimental. Report written.');
    return;
  }

  // REPO-tier recall.
  const repoDir = path.join(r, 'bench', 'ai-calibration', 'repo-tier');
  const targets = fs.existsSync(repoDir) ? fs.readdirSync(repoDir) : [];
  let caughtKey = false;
  out.push('## REPO-tier recall', '', '| target | file | caught | class |', '| --- | --- | --- | --- |');
  for (const t of targets) {
    const dir = path.join(repoDir, t);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const before = fs.readFileSync(path.join(dir, 'before.rs'), 'utf8');
    const changed = new Set<number>(meta.buggyChanged);
    const ctx = await ctxFrom(meta.file, before, changed);
    const findings = await semanticPass([ctx], () => undefined, provider);
    const hit = findings.find(
      (f) => f.line >= Math.min(...meta.buggyChanged) - 5 && f.line <= Math.max(...meta.buggyChanged) + 5
    );
    if (t.includes('ef7dc2c3d2') && hit) caughtKey = true;
    out.push(`| ${t} | ${meta.file} | ${hit ? '✅ ' + hit.aiClass : '❌'} | ${meta.expectClass} |`);
  }

  // Clean FP rate (reuse corpus fixed files as clean samples).
  const fixDir = path.join(r, 'bench', 'corpus', 'fixtures');
  const cleanIds = fs.existsSync(fixDir) ? fs.readdirSync(fixDir) : [];
  let cleanScanned = 0;
  let cleanFindings = 0;
  for (const id of cleanIds) {
    const after = path.join(fixDir, id, 'after.rs');
    const metaP = path.join(fixDir, id, 'meta.json');
    if (!fs.existsSync(after) || !fs.existsSync(metaP)) continue;
    const meta = JSON.parse(fs.readFileSync(metaP, 'utf8'));
    const text = fs.readFileSync(after, 'utf8');
    const changed = new Set<number>(meta.fixedChanged ?? []);
    if (changed.size === 0) continue;
    const ctx = await ctxFrom(meta.file, text, changed);
    const findings = await semanticPass([ctx], () => undefined, provider);
    cleanScanned++;
    cleanFindings += findings.length;
  }

  out.push(
    '',
    '## Clean-fixture AI false positives',
    '',
    `Scanned ${cleanScanned} fixed (clean) files; AI Phase-B findings: ${cleanFindings}.`,
    '',
    '## Verdict',
    '',
    caughtKey
      ? '✅ Caught the gmsol GT over-mint (ef7dc2c3d2). Phase B may be promoted if the clean FP rate is acceptable.'
      : '❌ Did NOT catch ef7dc2c3d2 — Phase B stays behind `--ai=experimental`.',
    ''
  );
  fs.writeFileSync(path.join(r, 'bench', 'ai-calibration', 'CALIBRATION.md'), out.join('\n'));
  console.log(`AI calibration done. key-bug caught: ${caughtKey}; clean findings: ${cleanFindings}/${cleanScanned}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
