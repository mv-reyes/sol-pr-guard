import { ScanResult } from '../engine';

/** reviewdog errorformat lines: `path:line:col: [severity] message (rule)`.
 *  Parse with -efm="%f:%l:%c: %m". Column is always 1 (line-anchored). */
export function renderEfm(result: ScanResult): string {
  return result.findings
    .map(
      (f) =>
        `${f.file}:${f.line}:1: [${f.severity}] ${f.message.replace(/\n/g, ' ')} (${f.ruleId})`
    )
    .join('\n');
}
