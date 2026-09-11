// Rule registry. Order = brief §4 build order (T1 then T2, then T3).
import { Rule } from '../types';
import discardedCheckedResult from './discarded-checked-result';
import copyPasteConstraint from './copy-paste-constraint';
import disabledConstraint from './disabled-constraint';
import zeroShareConversion from './zero-share-conversion';
import reallocZeroInit from './realloc-zero-init';
import prefundedPdaDos from './prefunded-pda-dos';
import authPrecedence from './auth-precedence';
import earlyReturnSkipsCleanup from './early-return-skips-cleanup';
import missingBoundsGate from './missing-bounds-gate';
import wrongObjectAuthCheck from './wrong-object-auth-check';
import fixedBufferArithmetic from './fixed-buffer-arithmetic';
import uncheckedArithmetic from './unchecked-arithmetic';
import incompleteAccountClose from './incomplete-account-close';
import ixSignerFlag from './ix-signer-flag';
import lossyAsCast from './lossy-as-cast';
import oneSidedBoundSigned from './one-sided-bound-signed';
import subtypeBlindSolvency from './subtype-blind-solvency';
import closedEnumDeserialize from './closed-enum-deserialize';
import unusedStateGate from './unused-state-gate';
import checkedSubOrdering from './checked-sub-ordering';

const RULES: Rule[] = [
  // Tier 1
  discardedCheckedResult,
  copyPasteConstraint,
  disabledConstraint,
  zeroShareConversion,
  reallocZeroInit,
  prefundedPdaDos,
  authPrecedence,
  missingBoundsGate, // promoted to T1 (N=6)
  incompleteAccountClose,
  ixSignerFlag,
  lossyAsCast,
  oneSidedBoundSigned,
  // Tier 2
  earlyReturnSkipsCleanup,
  wrongObjectAuthCheck,
  fixedBufferArithmetic,
  subtypeBlindSolvency,
  closedEnumDeserialize,
  // Tier 3 (summary-only)
  uncheckedArithmetic,
  unusedStateGate,
  checkedSubOrdering,
];

export function allRules(): Rule[] {
  return RULES.slice();
}

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id);
}
