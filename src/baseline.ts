// Baseline support: suppress findings already present in a baseline file, and
// write a baseline from a set of findings. Keyed by finding fingerprint.
import * as fs from 'fs';
import { Finding } from './types';
import { atomicWrite } from './util';

export interface BaselineFile {
  version: 1;
  createdAt: string;
  fingerprints: string[];
}

export function readBaseline(file: string): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineFile;
    return new Set(data.fingerprints ?? []);
  } catch {
    return new Set();
  }
}

export function writeBaseline(file: string, findings: Finding[]): void {
  const data: BaselineFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    fingerprints: [...new Set(findings.map((f) => f.fingerprint))].sort(),
  };
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
}

/** Drop findings whose fingerprint is in the baseline. */
export function applyBaseline(findings: Finding[], baseline: Set<string>): Finding[] {
  if (baseline.size === 0) return findings;
  return findings.filter((f) => !baseline.has(f.fingerprint));
}
