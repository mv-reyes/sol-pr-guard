// Engine: rule registry, orchestration, scoping, suppression, dedupe, tiering.
import {
  FileDiff,
  FileFacts,
  Finding,
  MetaNotice,
  Rule,
  RuleContext,
  SourceFile,
  AnchorStruct,
  Tier,
} from './types';
import { parseSource } from './parse';
import { buildFacts } from './anchor';
import {
  GlobalScopeIndex,
  computeScope,
  indexChangedSurface,
} from './scope';
import { Config, defaultConfig, globMatch } from './config';
import { isExcludedPath, isRustFile, isSafeRelPath, makeSourceFile, rangeHitsSet, toPosix } from './util';
import { allRules } from './rules';

export interface FileForScan {
  diff: FileDiff;
  headText: string | null;
  baseText: string | null;
}

export interface ScanInput {
  files: FileForScan[];
  context: {
    repo?: string;
    base?: string;
    head?: string;
    prNumber?: number;
    source: 'pr' | 'range' | 'local' | 'patch' | 'whole-repo';
  };
}

export interface ScanOptions {
  config?: Config;
  ruleFilter?: string[];
  baselineFingerprints?: Set<string>;
  wholeRepo?: boolean;
  includeTests?: boolean;
  /** collect per-file AST context (head + facts + changed) for the --ai layer. */
  collectAiContext?: boolean;
}

export interface AiContext {
  files: Array<{ head: SourceFile; facts: FileFacts; changed: Set<number> }>;
  lookupStruct: (name: string) => { file: string; struct: AnchorStruct } | undefined;
}

export interface ScanResult {
  findings: Finding[];
  suppressed: Finding[];
  notices: MetaNotice[];
  timings: { parseMs: number; scanMs: number; totalMs: number };
  stats: { filesAnalyzed: number; filesSkipped: number; rulesRun: number };
  aiContext?: AiContext;
}

interface PreparedFile {
  path: string;
  head: SourceFile;
  headFacts: FileFacts;
  base?: SourceFile;
  baseFacts?: FileFacts;
  diff: FileDiff;
}

function toSourceFile(path: string, text: string): SourceFile {
  return makeSourceFile(path, text);
}

/** Ranges (1-based inclusive) covered by a `#[cfg(test)]`-guarded item. The
 *  guarded item may be a braced block (mod/fn/impl) OR a `;`-terminated
 *  statement (e.g. a const_assert! macro call) — we must NOT over-extend a
 *  `;`-item into the next braced item (that would suppress production code). */
function cfgTestRanges(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const strip = (s: string) => {
    const i = s.indexOf('//');
    return i === -1 ? s : s.slice(0, i);
  };
  for (let i = 0; i < lines.length; i++) {
    if (!/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(lines[i])) continue;
    // Skip following attribute-only / blank lines to reach the guarded item.
    let start = i + 1;
    while (start < lines.length) {
      const t = strip(lines[start]).trim();
      if (t === '' || /^#\s*\[/.test(t)) start++;
      else break;
    }
    // Scan from `start` to find the item terminator.
    let depth = 0;
    let end = start;
    let done = false;
    for (let j = start; j < lines.length && !done; j++) {
      for (const ch of strip(lines[j])) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth <= 0) {
            end = j;
            done = true;
            break;
          }
        } else if (ch === ';' && depth === 0) {
          end = j;
          done = true;
          break;
        }
      }
      if (!done) end = j;
    }
    out.push([i + 1, end + 1]);
  }
  return out;
}

/** Inline suppression directives: line -> set of rule ids (or '*'). */
function suppressionMap(lines: string[]): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  const add = (line: number, id: string) => {
    if (!map.has(line)) map.set(line, new Set());
    map.get(line)!.add(id);
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /sol-pr-guard-ignore-(next-line|line)\s+([A-Za-z0-9_,-]+|\*)?/
    );
    if (!m) continue;
    const target = i + 1;
    const applyTo = m[1] === 'next-line' ? target + 1 : target;
    const ids = (m[2] ?? '*').split(',').map((s) => s.trim());
    for (const id of ids) add(applyTo, id || '*');
  }
  return map;
}

function isSuppressed(
  f: Finding,
  supp: Map<number, Set<string>>,
  cfgTest: Array<[number, number]>
): boolean {
  for (const [lo, hi] of cfgTest) if (f.line >= lo && f.line <= hi) return true;
  const ids = supp.get(f.line);
  if (ids && (ids.has(f.ruleId) || ids.has('*'))) return true;
  return false;
}

/** Full scan pipeline. Pure (no I/O), so it is trivially testable. */
export async function runScan(input: ScanInput, opts: ScanOptions = {}): Promise<ScanResult> {
  const t0 = Date.now();
  const config = opts.config ?? defaultConfig();
  const includeTests = opts.includeTests ?? config.includeTests;
  const wholeRepo = opts.wholeRepo ?? input.context.source === 'whole-repo';
  const notices: MetaNotice[] = [];
  let filesSkipped = 0;

  const rules: Rule[] = allRules().filter((r) => {
    if (opts.ruleFilter && opts.ruleFilter.length) return opts.ruleFilter.includes(r.id);
    if (config.ruleEnabled[r.id] === false) return false;
    return true;
  });

  // 1. Prepare files (parse head + base).
  const prepared: PreparedFile[] = [];
  let parseMs = 0;
  for (const f of input.files) {
    const p = toPosix(f.diff.newPath);
    if (!isSafeRelPath(p)) {
      notices.push({ file: p, message: 'unsafe path (traversal/absolute/control chars) — skipped.' });
      filesSkipped++;
      continue;
    }
    if (!isRustFile(p)) {
      filesSkipped++;
      continue;
    }
    if (!includeTests && isExcludedPath(p)) {
      filesSkipped++;
      continue;
    }
    if (config.exclude.some((g) => globMatch(g, p))) {
      filesSkipped++;
      continue;
    }
    if (f.diff.status === 'deleted' || f.headText === null) {
      filesSkipped++;
      continue;
    }
    const head = toSourceFile(p, f.headText);
    const tp = Date.now();
    const parsed = await parseSource(f.headText);
    parseMs += Date.now() - tp;
    if (parsed.skipped) {
      notices.push({ file: p, message: `not analyzed: ${parsed.skipReason}` });
      filesSkipped++;
      continue;
    }
    const headFacts = buildFacts(parsed.tree);
    if (headFacts.hasParseError) {
      notices.push({
        file: p,
        message: 'file has parse errors; analyzed best-effort (per-item degrade).',
      });
    }
    let base: SourceFile | undefined;
    let baseFacts: FileFacts | undefined;
    if (f.baseText !== null && f.baseText !== undefined) {
      base = toSourceFile(p, f.baseText);
      const bp = await parseSource(f.baseText);
      if (!bp.skipped && bp.tree) baseFacts = buildFacts(bp.tree);
    }
    prepared.push({ path: p, head, headFacts, base, baseFacts, diff: f.diff });
  }

  // 2. Global scope index + struct index for cross-file linkage.
  const global: GlobalScopeIndex = {
    changedStructNames: new Set(),
    changedContextTypes: new Set(),
  };
  const structIndex = new Map<string, { file: string; struct: AnchorStruct }>();
  for (const pf of prepared) {
    indexChangedSurface(pf.headFacts, pf.diff.changedLines, global);
    for (const st of pf.headFacts.structs) {
      if (st.name && !structIndex.has(st.name)) {
        structIndex.set(st.name, { file: pf.path, struct: st });
      }
    }
  }
  const lookupStruct = (name: string) => structIndex.get(name);

  // 3. Run rules per file.
  const raw: Finding[] = [];
  const ts = Date.now();
  for (const pf of prepared) {
    const scope = computeScope(pf.headFacts, pf.diff.changedLines, global, wholeRepo);
    const changedSet = pf.diff.changedLines;
    const changedIntersects = (s: number, e: number): boolean =>
      wholeRepo ? true : rangeHitsSet(s, e, changedSet);
    const ctx: RuleContext = {
      file: pf.path,
      head: pf.head,
      headFacts: pf.headFacts,
      base: pf.base,
      baseFacts: pf.baseFacts,
      changed: pf.diff.changedLines,
      removed: pf.diff.removedLines,
      fileDiff: pf.diff,
      inScope: scope.inScope,
      changedIntersects,
      lookupStruct,
      wholeRepo,
    };
    for (const rule of rules) {
      let found: Finding[] = [];
      try {
        found = rule.run(ctx);
      } catch (e) {
        notices.push({
          file: pf.path,
          message: `rule ${rule.id} errored (skipped for this file): ${(e as Error).message}`,
        });
        continue;
      }
      for (const fnd of found) raw.push(applySeverityOverride(fnd, config));
    }
  }
  const scanMs = Date.now() - ts;

  // 4. Suppression (inline directives + cfg(test) regions).
  const suppressed: Finding[] = [];
  const kept0: Finding[] = [];
  const suppCache = new Map<string, { supp: Map<number, Set<string>>; cfg: Array<[number, number]> }>();
  for (const pf of prepared) {
    suppCache.set(pf.path, {
      supp: suppressionMap(pf.head.lines),
      cfg: cfgTestRanges(pf.head.lines),
    });
  }
  for (const f of raw) {
    const c = suppCache.get(f.file);
    if (c && isSuppressed(f, c.supp, c.cfg)) {
      suppressed.push({ ...f, suppressed: true });
    } else {
      kept0.push(f);
    }
  }

  // 5. Baseline filter.
  let kept = kept0;
  if (opts.baselineFingerprints && opts.baselineFingerprints.size) {
    kept = kept.filter((f) => !opts.baselineFingerprints!.has(f.fingerprint));
  }

  // 6. Dedupe by fingerprint (keep first / most severe).
  const seen = new Map<string, Finding>();
  for (const f of kept) {
    const prev = seen.get(f.fingerprint);
    if (!prev || sevRank(f.severity) > sevRank(prev.severity)) seen.set(f.fingerprint, f);
  }
  const findings = [...seen.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.tier - b.tier ||
      a.ruleId.localeCompare(b.ruleId)
  );

  const result: ScanResult = {
    findings,
    suppressed,
    notices,
    timings: { parseMs, scanMs, totalMs: Date.now() - t0 },
    stats: {
      filesAnalyzed: prepared.length,
      filesSkipped,
      rulesRun: rules.length,
    },
  };
  if (opts.collectAiContext) {
    result.aiContext = {
      files: prepared.map((pf) => ({ head: pf.head, facts: pf.headFacts, changed: pf.diff.changedLines })),
      lookupStruct,
    };
  }
  return result;
}

function applySeverityOverride(f: Finding, config: Config): Finding {
  const ov = config.severityOverride[f.ruleId];
  return ov ? { ...f, severity: ov } : f;
}

export function sevRank(s: Finding['severity']): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s];
}

/** Findings at or above the fail gate (for exit code). */
export function findingsAtGate(findings: Finding[], failOn: Config['failOn']): Finding[] {
  if (failOn === 'none') return [];
  const maxTier: Tier = failOn === 'T1' ? 1 : failOn === 'T2' ? 2 : 3;
  return findings.filter((f) => f.tier <= maxTier);
}

export { allRules } from './rules';
