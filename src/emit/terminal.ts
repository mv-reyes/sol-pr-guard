import { ScanResult } from '../engine';
import { Finding } from '../types';
import { EmitOptions, tierLabel } from './index';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
};

function paint(color: boolean, code: string, s: string): string {
  return color ? code + s + C.reset : s;
}

function sevColor(sev: Finding['severity']): string {
  return sev === 'critical' || sev === 'high' ? C.red : sev === 'medium' ? C.yellow : C.blue;
}

export function renderTerminal(result: ScanResult, opts: EmitOptions): string {
  const color = opts.color;
  const lines: string[] = [];
  const byFile = new Map<string, Finding[]>();
  for (const f of result.findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }

  for (const [file, fs] of byFile) {
    lines.push(paint(color, C.bold, file));
    for (const f of fs) {
      const loc = `${f.line}`;
      const badge = paint(color, sevColor(f.severity) + C.bold, `${tierLabel(f.tier)} ${f.severity}`);
      lines.push(`  ${paint(color, C.gray, loc.padStart(5))}  ${badge}  ${paint(color, C.bold, f.ruleId)}`);
      lines.push(`         ${f.message}`);
      for (const ev of f.evidence.split('\n')) {
        if (ev.trim() === '') continue;
        lines.push(paint(color, C.dim, `           | ${ev.trim()}`));
      }
      lines.push(paint(color, C.gray, `           ↳ ${f.provenance} — ${f.provenanceUrl}`));
    }
    lines.push('');
  }

  // Meta notices (unparseable files, degraded parses).
  if (result.notices.length) {
    lines.push(paint(color, C.magenta, 'notices:'));
    for (const n of result.notices) lines.push(`  ${n.file}: ${n.message}`);
    lines.push('');
  }

  // Suppressed summary (never silent).
  if (opts.showSuppressed && result.suppressed.length) {
    lines.push(paint(color, C.gray, `suppressed (${result.suppressed.length}):`));
    for (const f of result.suppressed) {
      lines.push(paint(color, C.gray, `  ${f.file}:${f.line}  ${f.ruleId}`));
    }
    lines.push('');
  }

  const counts = { 1: 0, 2: 0, 3: 0 } as Record<number, number>;
  for (const f of result.findings) counts[f.tier]++;
  if (result.findings.length === 0) {
    lines.push(paint(color, C.green, '✓ No findings.'));
  } else {
    lines.push(
      paint(color, C.bold, `${result.findings.length} finding(s): `) +
        `${counts[1]} T1 · ${counts[2]} T2 · ${counts[3]} T3` +
        (result.suppressed.length ? paint(color, C.gray, `  (${result.suppressed.length} suppressed)`) : '')
    );
  }
  const t = opts.timingMs ?? result.timings.totalMs;
  lines.push(
    paint(
      color,
      C.gray,
      `scanned ${result.stats.filesAnalyzed} file(s), ${result.stats.rulesRun} rules in ${t}ms` +
        ` (parse ${result.timings.parseMs}ms)`
    )
  );
  return lines.join('\n');
}
