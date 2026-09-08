import { ScanResult } from '../engine';
import { AiResult } from '../ai';
import { OutputFormat } from './index';

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', magenta: '\x1b[35m', gray: '\x1b[90m' };
function paint(color: boolean, code: string, s: string): string {
  return color ? code + s + C.reset : s;
}

/** Render the AI layer. Human text for terminal; for machine formats the AI
 *  output is emitted to stderr (so stdout stays valid JSON/SARIF) — handled by
 *  the caller writing `notices`. Always labeled AI-assisted; never a gate input. */
export function renderAi(
  result: ScanResult,
  ai: AiResult,
  opts: { color: boolean; format: OutputFormat }
): string {
  for (const n of ai.notices) process.stderr.write(`ai: ${n}\n`);
  if (opts.format !== 'terminal') return '';
  const color = opts.color;
  const lines: string[] = [];
  const header = ai.provider ? `AI layer (${ai.provider}/${ai.model}) — AI-assisted, needs human confirmation` : 'AI layer';
  lines.push('');
  lines.push(paint(color, C.magenta + C.bold, `── ${header} ──`));

  if (ai.explanations.size) {
    for (const f of result.findings) {
      const e = ai.explanations.get(f.fingerprint);
      if (!e) continue;
      lines.push(paint(color, C.bold, `  ${f.file}:${f.line} [${f.ruleId}]`));
      lines.push(`    ${e.explanation}`);
      if (e.fix) lines.push(paint(color, C.dim, `    fix: ${e.fix}`));
    }
  }

  if (ai.aiFindings.length) {
    lines.push('');
    lines.push(paint(color, C.magenta, `  Tier-3 semantic hypotheses (experimental — verify by hand):`));
    for (const a of ai.aiFindings) {
      lines.push(
        paint(color, C.bold, `  ${a.file}:${a.line}`) +
          paint(color, C.gray, `  [${a.aiClass}, confidence ${a.confidence.toFixed(2)}]`)
      );
      lines.push(`    ${a.reasoning}`);
      lines.push(paint(color, C.dim, `    | ${a.evidence}`));
    }
  }

  if (ai.explanations.size === 0 && ai.aiFindings.length === 0 && ai.provider) {
    lines.push(paint(color, C.gray, '  (no AI output)'));
  }
  lines.push(paint(color, C.gray, '  These are advisory only and do not affect the exit code.'));
  return lines.join('\n');
}
