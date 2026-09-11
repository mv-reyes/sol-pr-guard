// Changed-line -> in-scope-node propagation. Precision comes from only firing
// rules on surface a PR actually touched, while still pulling in the sibling
// fields / linked handler needed to judge the change.
import { FileFacts } from './types';
import { rangeHitsSet } from './util';

export interface GlobalScopeIndex {
  /** Names of Accounts structs that had a changed line (any file). */
  changedStructNames: Set<string>;
  /** Context<T> Ts of handlers that had a changed line (any file). */
  changedContextTypes: Set<string>;
}

export interface Scope {
  /** true if [startLine,endLine] intersects the in-scope surface. */
  inScope: (startLine: number, endLine: number) => boolean;
  /** the raw expanded line intervals (for debugging/tests). */
  ranges: Array<[number, number]>;
}

function intersects(aLo: number, aHi: number, bLo: number, bHi: number): boolean {
  return aLo <= bHi && bLo <= aHi;
}

/** Build the per-file global index contribution. */
export function indexChangedSurface(
  facts: FileFacts,
  changed: Set<number>,
  into: GlobalScopeIndex
): void {
  const has = (s: number, e: number) => rangeHitsSet(s, e, changed);
  for (const st of facts.structs) {
    if (st.isAccounts && st.name && has(st.startLine, st.endLine)) {
      into.changedStructNames.add(st.name);
    }
  }
  for (const fn of facts.fns) {
    if (fn.contextType && has(fn.startLine, fn.endLine)) {
      into.changedContextTypes.add(fn.contextType);
    }
  }
}

/** Compute the in-scope surface for one file. */
export function computeScope(
  facts: FileFacts,
  changed: Set<number>,
  global: GlobalScopeIndex,
  wholeRepo: boolean
): Scope {
  if (wholeRepo) {
    // whole-repo scan: everything is in scope.
    return { inScope: () => true, ranges: [] };
  }
  const ranges: Array<[number, number]> = [];
  const containsChanged = (s: number, e: number): boolean => rangeHitsSet(s, e, changed);

  for (const st of facts.structs) {
    if (!st.name) continue;
    if (containsChanged(st.startLine, st.endLine)) {
      ranges.push([st.startLine, st.endLine]);
    } else if (global.changedContextTypes.has(st.name)) {
      // a handler that uses this struct changed elsewhere.
      ranges.push([st.startLine, st.endLine]);
    }
  }
  for (const fn of facts.fns) {
    if (containsChanged(fn.startLine, fn.endLine)) {
      ranges.push([fn.startLine, fn.endLine]);
    } else if (fn.contextType && global.changedStructNames.has(fn.contextType)) {
      // the Accounts struct this handler uses changed elsewhere.
      ranges.push([fn.startLine, fn.endLine]);
    }
  }

  const inScope = (s: number, e: number): boolean => {
    if (rangeHitsSet(s, e, changed)) return true;
    for (const [lo, hi] of ranges) if (intersects(s, e, lo, hi)) return true;
    return false;
  };

  return { inScope, ranges };
}
