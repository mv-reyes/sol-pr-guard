// Shared types for sol-pr-guard.

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Tier = 1 | 2 | 3;

/** A single security finding, anchored to a NEW-file line. */
export interface Finding {
  ruleId: string;
  tier: Tier;
  severity: Severity;
  /** POSIX-style repo-relative path (forward slashes, always). */
  file: string;
  /** 1-based NEW-file line number. */
  line: number;
  /** 1-based NEW-file end line (>= line). */
  endLine: number;
  /** Short, one-line message. */
  message: string;
  /** The exact source line(s) quoted as evidence. */
  evidence: string;
  /** Human label for where this rule's authority comes from. */
  provenance: string;
  /** URL backing the provenance (real exploit/fix commit). */
  provenanceUrl: string;
  /** Stable identity for baseline/dedupe/dismiss memory. */
  fingerprint: string;
  /** True when this finding was suppressed by an inline comment. */
  suppressed?: boolean;
}

export type FileStatus = 'added' | 'modified' | 'renamed' | 'deleted';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** Per-file diff result in NEW-file coordinates. */
export interface FileDiff {
  /** NEW path (POSIX). */
  newPath: string;
  /** OLD path (POSIX); differs from newPath on rename. */
  oldPath: string;
  status: FileStatus;
  /** Added or modified NEW-file line numbers (1-based). */
  changedLines: Set<number>;
  /** OLD-file line numbers that were removed (1-based). */
  removedLines: Set<number>;
  hunks: Hunk[];
  /** True if this file's diff was a pure binary marker. */
  binary: boolean;
}

/** A rust source file at a given revision, with its parsed facts. */
export interface SourceFile {
  path: string; // POSIX repo-relative
  text: string;
  lines: string[]; // text split on \n, with \r stripped
  /** `text` with comments + string/char-literal contents masked to spaces
   *  (offset-preserving). Use for ALL matching/suppression; `text` is for
   *  evidence quoting only. */
  textStripped: string;
  /** `textStripped` split into lines (1:1 with `lines`). */
  linesStripped: string[];
}

/** One #[account(...)] attribute on a field. */
export interface AccountAttr {
  text: string;
  startLine: number;
  endLine: number;
  /** constraint = <body> bodies extracted from this attribute. */
  constraints: string[];
  /** raw comma-separated top-level keys/tokens (e.g. mut, seeds, has_one). */
  keys: string[];
}

export interface DocOrLineComment {
  text: string;
  startLine: number;
  endLine: number;
}

export interface AnchorField {
  name: string | null;
  type: string | null;
  startLine: number;
  endLine: number;
  accountAttrs: AccountAttr[];
  /** all preceding attribute_item texts (incl. non-#[account]). */
  allAttrs: { text: string; startLine: number; endLine: number }[];
  /** doc/line comments immediately preceding the field. */
  comments: DocOrLineComment[];
}

export interface AnchorStruct {
  name: string | null;
  isAccounts: boolean;
  startLine: number;
  endLine: number;
  fields: AnchorField[];
}

export interface FnParam {
  name: string | null;
  type: string | null;
  /** For a Context<T> param, the inner T. */
  contextType?: string | null;
}

export interface RustFn {
  name: string | null;
  startLine: number;
  endLine: number;
  /** body text (between the outer braces), or '' if none. */
  bodyText: string;
  /** `bodyText` with comments + string/char literals masked (offset-preserving).
   *  Use for matching/suppression; `bodyText` is for evidence only. */
  bodyStripped: string;
  bodyStartLine: number;
  params: FnParam[];
  /** T from a Context<T> param if present. */
  contextType: string | null;
  /** true if declared inside a `#[program]` module. */
  isHandler: boolean;
}

export interface FileFacts {
  structs: AnchorStruct[];
  fns: RustFn[];
  hasParseError: boolean;
  /** true if the file uses Anchor (#[derive(Accounts)] or #[program]). */
  isAnchor: boolean;
}

export interface MetaNotice {
  file: string;
  message: string;
}

/** Everything a rule needs for one changed file. */
export interface RuleContext {
  file: string; // POSIX repo-relative
  head: SourceFile;
  headFacts: FileFacts;
  /** base revision file (absent for added files). */
  base?: SourceFile;
  baseFacts?: FileFacts;
  /** NEW-file changed line numbers. */
  changed: Set<number>;
  /** removed OLD-file line numbers. */
  removed: Set<number>;
  fileDiff: FileDiff;
  /** true if [startLine,endLine] intersects the propagated in-scope surface
   *  (struct<->handler, cross-file). Use for gathering CONTEXT. */
  inScope: (startLine: number, endLine: number) => boolean;
  /** true if [startLine,endLine] intersects the ACTUAL changed lines. Findings
   *  are EMITTED only when their anchor satisfies this (precision gate). In a
   *  whole-repo scan this is always true. */
  changedIntersects: (startLine: number, endLine: number) => boolean;
  /** cross-file struct lookup by name (lazy). */
  lookupStruct: (name: string) => { file: string; struct: AnchorStruct } | undefined;
  /** whole scan is a whole-repo scan (no diff scoping). */
  wholeRepo: boolean;
}

export interface RuleMeta {
  id: string;
  tier: Tier;
  severity: Severity;
  title: string;
  provenance: string;
  provenanceUrl: string;
  /** 'anchor' | 'rust' | 'both' */
  appliesTo: 'anchor' | 'rust' | 'both';
}

export interface Rule extends RuleMeta {
  run(ctx: RuleContext): Finding[];
}
