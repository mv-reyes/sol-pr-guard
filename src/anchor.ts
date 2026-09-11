// Anchor semantics extracted from a tree-sitter Rust CST.
// Ported and hardened from spike/anchor-ast.js. Quirks handled:
//  - attributes are PRECEDING SIBLINGS of the item they annotate;
//  - #[account(...)] arguments are opaque token_tree text -> tokenized from
//    the node's raw text (byte-offset derived), never re-parsed as an AST.
import {
  AccountAttr,
  AnchorField,
  AnchorStruct,
  DocOrLineComment,
  FileFacts,
  FnParam,
  RustFn,
} from './types';
import { startLine, endLine } from './parse';
import { maskNonCode } from './util';

/** Collect attribute_item nodes immediately preceding `node` (siblings). */
function precedingAttributes(node: any): any[] {
  const attrs: any[] = [];
  let sib = node.previousNamedSibling;
  while (sib && sib.type === 'attribute_item') {
    attrs.unshift(sib);
    sib = sib.previousNamedSibling;
  }
  return attrs;
}

/** Collect line/block/doc comments immediately preceding `node` (siblings),
 *  hopping over attribute_items. */
function precedingComments(node: any): DocOrLineComment[] {
  const out: DocOrLineComment[] = [];
  let sib = node.previousNamedSibling;
  while (sib && (sib.type === 'attribute_item')) sib = sib.previousNamedSibling;
  while (
    sib &&
    (sib.type === 'line_comment' ||
      sib.type === 'block_comment' ||
      sib.type === 'doc_comment')
  ) {
    out.unshift({ text: sib.text, startLine: startLine(sib), endLine: endLine(sib) });
    sib = sib.previousNamedSibling;
  }
  return out;
}

/** Extract every `constraint = <body>` from an #[account(...)] attribute text.
 *  Bodies end at a top-level comma or an anchor `@ Error` separator. */
export function extractConstraintBodies(attrText: string): string[] {
  const inner = innerOfAccount(attrText);
  if (inner === null) return [];
  const bodies: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const m = inner.slice(i).match(/\bconstraint\s*=/);
    if (!m || m.index === undefined) break;
    let j = i + m.index + m[0].length;
    let depth = 0;
    const start = j;
    for (; j < inner.length; j++) {
      const ch = inner[j];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) break;
      else if (ch === '@' && depth === 0) break; // error-code separator
    }
    bodies.push(inner.slice(start, j).replace(/\s+/g, ' ').trim());
    i = j + 1;
  }
  return bodies;
}

/** Return the inside of `#[account( ... )]`, or null if not that shape. */
function innerOfAccount(attrText: string): string | null {
  const t = attrText.trim();
  const m = t.match(/^#\s*\[\s*account\s*\(/);
  if (!m) return null;
  const openIdx = t.indexOf('(', m.index);
  // find matching close paren
  let depth = 0;
  for (let k = openIdx; k < t.length; k++) {
    const ch = t[k];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return t.slice(openIdx + 1, k);
    }
  }
  return null;
}

/** Top-level keys inside an #[account(...)] (mut, seeds, has_one, address...). */
export function extractAccountKeys(attrText: string): string[] {
  const inner = innerOfAccount(attrText);
  if (inner === null) return [];
  const keys: string[] = [];
  let depth = 0;
  let seg = '';
  const flush = () => {
    const s = seg.trim();
    if (s) {
      const km = s.match(/^([A-Za-z_][A-Za-z0-9_:]*)/);
      if (km) keys.push(km[1]);
    }
    seg = '';
  };
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      flush();
      continue;
    }
    seg += ch;
  }
  flush();
  return keys;
}

function accountAttr(a: any): AccountAttr {
  return {
    text: a.text,
    startLine: startLine(a),
    endLine: endLine(a),
    constraints: extractConstraintBodies(a.text),
    keys: extractAccountKeys(a.text),
  };
}

function fieldInfo(fieldNode: any): AnchorField {
  const name = fieldNode.childForFieldName('name')?.text ?? null;
  const type = fieldNode.childForFieldName('type')?.text ?? null;
  const attrNodes = precedingAttributes(fieldNode);
  const allAttrs = attrNodes.map((a) => ({
    text: a.text,
    startLine: startLine(a),
    endLine: endLine(a),
  }));
  const accountAttrs = attrNodes
    .filter((a) => /^#\s*\[\s*account\b/.test(a.text))
    .map(accountAttr);
  return {
    name,
    type,
    startLine: startLine(fieldNode),
    endLine: endLine(fieldNode),
    accountAttrs,
    allAttrs,
    comments: precedingComments(fieldNode),
  };
}

function contextTypeOf(typeText: string | null): string | null {
  if (!typeText) return null;
  const m = typeText.match(/Context\s*<\s*(?:'[A-Za-z_][A-Za-z0-9_]*\s*,\s*)?([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : null;
}

function fnParams(fnNode: any): FnParam[] {
  const params: FnParam[] = [];
  const plist = fnNode.childForFieldName('parameters');
  if (!plist) return params;
  for (const c of plist.namedChildren) {
    if (c.type !== 'parameter') continue;
    const pat = c.childForFieldName('pattern');
    const ty = c.childForFieldName('type');
    const typeText = ty ? ty.text : null;
    params.push({
      name: pat ? pat.text : null,
      type: typeText,
      contextType: contextTypeOf(typeText),
    });
  }
  return params;
}

/** Extract all Anchor + Rust facts from a parsed tree. */
export function buildFacts(tree: any): FileFacts {
  const structs: AnchorStruct[] = [];
  const fns: RustFn[] = [];
  let isAnchor = false;
  const programModRanges: Array<[number, number]> = [];

  if (!tree || !tree.rootNode) {
    return { structs, fns, hasParseError: true, isAnchor: false };
  }

  // First pass: find #[program] modules (their fn children are handlers).
  (function findPrograms(n: any) {
    if (n.type === 'mod_item') {
      const attrs = precedingAttributes(n);
      if (attrs.some((a) => /#\s*\[\s*program\b/.test(a.text))) {
        programModRanges.push([startLine(n), endLine(n)]);
        isAnchor = true;
      }
    }
    n.children.forEach(findPrograms);
  })(tree.rootNode);

  const inProgramMod = (ln: number): boolean =>
    programModRanges.some(([s, e]) => ln >= s && ln <= e);

  (function walk(n: any) {
    if (n.type === 'struct_item') {
      const attrs = precedingAttributes(n);
      const isAccounts = attrs.some((a) =>
        /#\s*\[\s*derive\s*\([^)]*\bAccounts\b/.test(a.text)
      );
      if (isAccounts) isAnchor = true;
      const nameNode = n.childForFieldName('name');
      const body = n.childForFieldName('body');
      const fields = body
        ? body.namedChildren
            .filter((c: any) => c.type === 'field_declaration')
            .map(fieldInfo)
        : [];
      structs.push({
        name: nameNode ? nameNode.text : null,
        isAccounts,
        startLine: startLine(n),
        endLine: endLine(n),
        fields,
      });
    }
    if (n.type === 'function_item') {
      const nameNode = n.childForFieldName('name');
      const bodyNode = n.childForFieldName('body');
      const params = fnParams(n);
      const ctx = params.map((p) => p.contextType).find((t) => !!t) ?? null;
      const s = startLine(n);
      const bodyText = bodyNode ? bodyNode.text : '';
      fns.push({
        name: nameNode ? nameNode.text : null,
        startLine: s,
        endLine: endLine(n),
        bodyText,
        bodyStripped: maskNonCode(bodyText),
        bodyStartLine: bodyNode ? startLine(bodyNode) : s,
        params,
        contextType: ctx,
        isHandler: inProgramMod(s) || ctx !== null,
      });
    }
    n.children.forEach(walk);
  })(tree.rootNode);

  return { structs, fns, hasParseError: tree.rootNode.hasError, isAnchor };
}

/** smallest named node containing a 1-based line, queried at first non-ws col. */
export function enclosingNode(rootNode: any, line1: number, lines: string[]): any {
  const row = line1 - 1;
  const text = lines[row] ?? '';
  const col = text.search(/\S/);
  let node = rootNode.namedDescendantForPosition({ row, column: col === -1 ? 0 : col });
  while (node && node.namedChildCount === 0 && node.parent) node = node.parent;
  return node;
}
