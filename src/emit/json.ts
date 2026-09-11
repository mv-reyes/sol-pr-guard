import { ScanResult } from '../engine';
import { EmitOptions } from './index';

export function renderJson(result: ScanResult, opts: EmitOptions): string {
  const doc = {
    tool: 'sol-pr-guard',
    version: opts.toolVersion,
    stats: result.stats,
    timings: result.timings,
    findings: result.findings.map((f) => ({
      ruleId: f.ruleId,
      tier: f.tier,
      severity: f.severity,
      file: f.file,
      line: f.line,
      endLine: f.endLine,
      message: f.message,
      evidence: f.evidence,
      provenance: f.provenance,
      provenanceUrl: f.provenanceUrl,
      fingerprint: f.fingerprint,
    })),
    suppressed: opts.showSuppressed
      ? result.suppressed.map((f) => ({ ruleId: f.ruleId, file: f.file, line: f.line }))
      : undefined,
    notices: result.notices,
  };
  return JSON.stringify(doc, null, 2);
}
