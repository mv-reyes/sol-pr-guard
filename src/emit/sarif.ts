import { ScanResult } from '../engine';
import { allRules } from '../rules';
import { EmitOptions } from './index';

const SEV_TO_SARIF: Record<string, string> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
};

/** SARIF 2.1.0 document for GitHub code scanning / reviewdog. */
export function renderSarif(result: ScanResult, opts: EmitOptions): string {
  const rules = allRules().map((r) => ({
    id: r.id,
    name: r.title.replace(/\s+/g, ''),
    shortDescription: { text: r.title },
    helpUri: r.provenanceUrl,
    defaultConfiguration: { level: SEV_TO_SARIF[r.severity] ?? 'warning' },
    properties: { tier: r.tier, provenance: r.provenance },
  }));

  const results = result.findings.map((f) => ({
    ruleId: f.ruleId,
    level: SEV_TO_SARIF[f.severity] ?? 'warning',
    message: { text: f.message },
    partialFingerprints: { solPrGuard: f.fingerprint },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region: {
            startLine: f.line,
            endLine: f.endLine,
            snippet: { text: f.evidence },
          },
        },
      },
    ],
  }));

  const doc = {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'sol-pr-guard',
            informationUri: 'https://github.com/sol-pr-guard/sol-pr-guard',
            version: opts.toolVersion,
            rules,
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(doc, null, 2);
}
