// Output rendering: terminal (default), JSON, SARIF, reviewdog-efm.
import { Finding } from '../types';
import { ScanResult } from '../engine';
import { renderTerminal } from './terminal';
import { renderJson } from './json';
import { renderSarif } from './sarif';
import { renderEfm } from './efm';

export type OutputFormat = 'terminal' | 'json' | 'sarif' | 'efm';

export interface EmitOptions {
  format: OutputFormat;
  color: boolean;
  showSuppressed: boolean;
  timingMs?: number;
  context?: ScanResult['stats'] & { repo?: string; head?: string };
  toolVersion: string;
}

export function render(result: ScanResult, opts: EmitOptions): string {
  switch (opts.format) {
    case 'json':
      return renderJson(result, opts);
    case 'sarif':
      return renderSarif(result, opts);
    case 'efm':
      return renderEfm(result);
    case 'terminal':
    default:
      return renderTerminal(result, opts);
  }
}

export function tierLabel(t: number): string {
  return t === 1 ? 'T1' : t === 2 ? 'T2' : 'T3';
}

export { Finding };
