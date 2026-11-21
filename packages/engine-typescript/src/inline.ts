import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { atText, diagnostics, findAt, introduced, parseAt, required, unavailable } from "./shared.ts";
import type { At } from "./shared.ts";

/**
 * typescript-inline-function: a call of a top-level function is replaced by the function's code
 * ("unpack"). All or nothing, in two modes:
 * - one call (`--at <path>:<line>[:<column>]`): that call is unpacked, the declaration stays;
 * - definition (no `--at`): every call is unpacked and the declaration is removed.
 * Anything that cannot be unpacked with the same meaning is refused (`REFACTOR_UNAVAILABLE`, nothing written).
 *
 * Known, accepted losses: comments inside the function body are not carried over (only comments attached
 * to its statements are), and the return-type annotation is dropped (it is type-level only).
 */

type Ts = typeof ts;
type Edit = { start: number; end: number; text: string };
export type InlineParams = { file: string; symbol: string; at?: At };

/**
 * The instruction for errors the unpacked code would introduce. Syntax and grammar errors (TS1xxx) are not
 * about types: making the types explicit would not help.
 */
export function explainIntroduced(errors: string[]): string {
  if (errors.some((e) => /^TS1\d{3}:/.test(e))) {
    return "The unpacked code is not valid syntax or grammar at this place, which this action cannot repair. Unpack it by hand, or change the code around the call so that the body fits there, then run again.";
  }
  return "Make the types at the call explicit (or unpack by hand), then run again.";
}

// ---- small helpers ----

const RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async of".split(" "),
);
const STATEMENT_START = /^(\{|function\b|class\b|async\s+function\b|let\s*\[)/;
const ASI_HAZARD = /^[([`+\-/]/;

function within(inner: ts.Node, outer: ts.Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, pos + 1))?.[0] ?? "";
}

type Ctx = {
  engine: TsEngine;
  t: Ts;
  checker: ts.TypeChecker;
  sf: ts.SourceFile;
  file: string;
  text: string;
  eol: string;
  /** Symbols assigned to anywhere in the file (`x = …`, `x++`, destructuring targets, `for (x of …)`). */
  written: Set<ts.Symbol>;
  /** Every identifier spelling in the file: fresh names avoid all of them. */
  identTexts: Set<string>;
  /** Multi-line string/template literals: their lines are never re-indented. */
  literals: [number, number][];
};

function symOf(c: Ctx, id: ts.Identifier): ts.Symbol | undefined {
  const p = id.parent;
  if (c.t.isShorthandPropertyAssignment(p) && p.name === id) return c.checker.getShorthandAssignmentValueSymbol(p);
  if (c.t.isExportSpecifier(p)) return c.checker.getExportSpecifierLocalTargetSymbol(p);
  return c.checker.getSymbolAtLocation(id);
}

/** Whether an identifier is a name looked up in scope (not a property name, label, …). */
function isReference(t: Ts, id: ts.Identifier): boolean {
  const p = id.parent;
  if (t.isPropertyAccessExpression(p) && p.name === id) return false;
  if (t.isQualifiedName(p) && p.right === id) return false;
  if (
    (t.isPropertyAssignment(p) ||
      t.isMethodDeclaration(p) ||
      t.isPropertyDeclaration(p) ||
      t.isGetAccessorDeclaration(p) ||
      t.isSetAccessorDeclaration(p) ||
      t.isPropertySignature(p) ||
      t.isMethodSignature(p) ||
      t.isEnumMember(p) ||
      t.isNamedTupleMember(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (t.isBindingElement(p) && p.propertyName === id) return false;
  if ((t.isBreakStatement(p) || t.isContinueStatement(p) || t.isLabeledStatement(p)) && p.label === id) return false;
  if (t.isMetaProperty(p)) return false;
  if (t.isTypePredicateNode(p) && p.parameterName === id) return false;
  if (t.isImportTypeNode(p)) return false;
  return true;
}

/** Whether the node is (part of) a type annotation. */
function insideType(t: Ts, n: ts.Node): boolean {
  for (let a: ts.Node | undefined = n.parent; a; a = a.parent) {
    if (t.isTypeNode(a)) return true;
    if (t.isStatement(a) || t.isSourceFile(a)) return false;
  }
  return false;
}

/** Type position (a type or namespace name) rather than a value: decides which meaning to look up. */
function typeMeaning(t: Ts, id: ts.Identifier): boolean {
  for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
    if (t.isTypeQueryNode(p)) return false;
    if (t.isTypeNode(p)) return true;
    if (!t.isQualifiedName(p)) return false;
  }
  return false;
}

function bindingIdentifiers(t: Ts, name: ts.BindingName, out: ts.Identifier[]): void {
  if (t.isIdentifier(name)) out.push(name);
  else for (const el of name.elements) if (!t.isOmittedExpression(el)) bindingIdentifiers(t, el.name, out);
}

function hasExport(t: Ts, statement: ts.Statement): boolean {
  return (
    t.canHaveModifiers(statement) &&
    (t.getModifiers(statement) ?? []).some((m) => m.kind === t.SyntaxKind.ExportKeyword || m.kind === t.SyntaxKind.DefaultKeyword)
  );
}

function sameSymbol(a: ts.Symbol, b: ts.Symbol): boolean {
  if (a === b) return true;
  const da = a.declarations?.[0];
  const db = b.declarations?.[0];
  return da !== undefined && da === db;
}

function makeCtx(engine: TsEngine, file: string): Ctx {
  const t = engine.ts;
  const { program, sf } = engine.sourceFile(file);
  const text = sf.text;
  const checker = program.getTypeChecker();
  const c: Ctx = {
    engine,
    t,
    checker,
    sf,
    file,
    text,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    written: new Set(),
    identTexts: new Set(),
    literals: [],
  };
  const markTargets = (e: ts.Node): void => {
    if (t.isParenthesizedExpression(e) || t.isNonNullExpression(e) || t.isAsExpression(e) || t.isSatisfiesExpression(e)) {
      markTargets(e.expression);
    } else if (t.isIdentifier(e)) {
      const s = symOf(c, e);
      if (s) c.written.add(s);
    } else if (t.isArrayLiteralExpression(e)) {
      for (const el of e.elements) markTargets(t.isSpreadElement(el) ? el.expression : el);
    } else if (t.isObjectLiteralExpression(e)) {
      for (const prop of e.properties) {
        if (t.isPropertyAssignment(prop)) markTargets(prop.initializer);
        else if (t.isShorthandPropertyAssignment(prop)) markTargets(prop.name);
        else if (t.isSpreadAssignment(prop)) markTargets(prop.expression);
      }
    } else if (t.isBinaryExpression(e) && e.operatorToken.kind === t.SyntaxKind.EqualsToken) {
      markTargets(e.left);
    }
  };
  const visit = (n: ts.Node): void => {
    if (t.isIdentifier(n)) c.identTexts.add(n.text);
    if (
      (t.isNoSubstitutionTemplateLiteral(n) || t.isTemplateExpression(n) || t.isStringLiteral(n)) &&
      text.slice(n.getStart(sf), n.getEnd()).includes("\n")
    ) {
      c.literals.push([n.getStart(sf), n.getEnd()]);
    }
    if (
      t.isBinaryExpression(n) &&
      n.operatorToken.kind >= t.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= t.SyntaxKind.LastAssignment
    ) {
      markTargets(n.left);
    } else if (
      (t.isPrefixUnaryExpression(n) || t.isPostfixUnaryExpression(n)) &&
      (n.operator === t.SyntaxKind.PlusPlusToken || n.operator === t.SyntaxKind.MinusMinusToken)
    ) {
      markTargets(n.operand);
    } else if ((t.isForInStatement(n) || t.isForOfStatement(n)) && !t.isVariableDeclarationList(n.initializer)) {
      markTargets(n.initializer);
    }
    t.forEachChild(n, visit);
  };
  visit(sf);
  return c;
}

/** Replacements (all inside [start, end)) applied to the text of the range. */
function render(text: string, start: number, end: number, edits: Edit[]): string {
  const inside = edits.filter((e) => e.start >= start && e.end <= end).sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = start;
  for (const e of inside) {
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos, end);
}

/** Edits that move the lines of [start, end) (after its first) from indentation `base` to `to`. */
function reindent(c: Ctx, start: number, end: number, base: string, to: string): Edit[] {
  if (base === to) return [];
  const edits: Edit[] = [];
  let nl = c.text.indexOf("\n", start);
  while (nl !== -1 && nl + 1 < end) {
    const lineStart = nl + 1;
    nl = c.text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? c.text.length : nl;
    if (c.literals.some(([a, b]) => lineStart > a && lineStart < b)) continue;
    if (/^[ \t]*\r?$/.test(c.text.slice(lineStart, lineEnd))) continue;
    if (!c.text.startsWith(base, lineStart)) continue;
    edits.push({ start: lineStart, end: lineStart + base.length, text: to });
  }
  return edits;
}

/** Start of a node including the comments directly above it (each on its own line, no blank line between). */
function attachedStart(c: Ctx, node: ts.Node): number {
  const text = c.text;
  let start = node.getStart(c.sf);
  const ranges = c.t.getLeadingCommentRanges(text, node.pos) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i] as ts.CommentRange;
    const ownLine = /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", r.pos - 1) + 1, r.pos));
    if (!ownLine || /\n[ \t]*\r?\n/.test(text.slice(r.end, start))) break;
    start = r.pos;
  }
  return start;
}

/** The end of a statement plus a `// comment` after it on the same line. */
function endWithTrailing(c: Ctx, node: ts.Node): number {
  const end = node.getEnd();
  const nl = c.text.indexOf("\n", end);
  const rest = c.text.slice(end, nl === -1 ? c.text.length : nl);
  const m = /^[ \t]*\/\/[^\r\n]*/.exec(rest);
  return m ? end + m[0].trimEnd().length : end;
}

// ---- the function ----

type Param = { name: string; symbol: ts.Symbol; typeText: string | null };
type FreeRef = { name: string; symbol: ts.Symbol; meaning: "value" | "type" };
type Shape =
  | { kind: "expr"; expr: ts.Expression }
  | { kind: "stmts"; statements: ts.Statement[]; ret: ts.Expression | null; locals: { name: string; symbol: ts.Symbol }[] };
type FunctionNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

type Fn = {
  name: string;
  /** The declaration (function declaration, or the variable declaration of a const). */
  declaration: ts.Node;
  statement: ts.Statement;
  node: FunctionNode;
  nameId: ts.Identifier;
  symbol: ts.Symbol;
  exported: boolean;
  params: Param[];
  shape: Shape;
  freeRefs: FreeRef[];
  /** Names declared inside (nested parameters and locals), not the function's own parameters. */
  inside: Set<string>;
  /** Why no call of it can be unpacked (empty when the function itself is fine). */
  problems: string[];
};

function analyze(c: Ctx, declaration: ts.Node, name: string): Fn {
  const t = c.t;
  const kinds = "Only function declarations and consts holding an arrow or function expression can be unpacked.";
  let node: FunctionNode;
  let statement: ts.Statement;
  let nameId: ts.Identifier;
  if (t.isFunctionDeclaration(declaration)) {
    if (!declaration.body || !declaration.name) {
      unavailable(`\`${name}\` in ${c.file} has no body here (an overload or an ambient declaration). ${kinds}`);
    }
    node = declaration;
    statement = declaration;
    nameId = declaration.name;
  } else if (t.isVariableDeclaration(declaration) && t.isIdentifier(declaration.name)) {
    const list = declaration.parent;
    const init = declaration.initializer;
    if (!t.isVariableDeclarationList(list) || !t.isVariableStatement(list.parent)) unavailable(`\`${name}\` in ${c.file} is not a top-level declaration. ${kinds}`);
    if (!(list.flags & t.NodeFlags.Const)) {
      unavailable(`\`${name}\` is declared with let or var in ${c.file}, so it may be reassigned. Make it a const first, then run again.`);
    }
    if (list.declarations.length !== 1) {
      unavailable(`\`${name}\` is declared together with other variables in ${c.file}. Split the declaration first, then run again.`);
    }
    if (!init || !(t.isArrowFunction(init) || t.isFunctionExpression(init))) {
      unavailable(`\`${name}\` in ${c.file} is not a function. ${kinds}`);
    }
    node = init;
    statement = list.parent;
    nameId = declaration.name;
  } else {
    unavailable(`\`${name}\` in ${c.file} is not a function. ${kinds}`);
  }

  const symbol = c.checker.getSymbolAtLocation(nameId);
  if (!symbol) unavailable(`TypeScript cannot resolve \`${name}\` in ${c.file}.`);
  const problems: string[] = [];
  if ((symbol.declarations?.length ?? 0) !== 1) problems.push("has several declarations (overloads or merged declarations)");
  if (node.typeParameters && node.typeParameters.length > 0) problems.push("is generic (it has type parameters)");
  if ((node.modifiers ?? []).some((m) => m.kind === t.SyntaxKind.AsyncKeyword)) {
    problems.push("is async (inlining await is not supported)");
  }
  if (node.asteriskToken) problems.push("is a generator");

  const params: Param[] = [];
  const ownParams = new Set<ts.Symbol>();
  for (const p of node.parameters) {
    const label = t.isIdentifier(p.name) ? `parameter \`${p.name.text}\`` : "a destructured parameter";
    if (!t.isIdentifier(p.name)) {
      problems.push("has a destructured parameter");
      continue;
    }
    if (p.name.text === "this") problems.push("declares a `this` parameter");
    if (p.dotDotDotToken) problems.push(`has a rest ${label}`);
    if (p.questionToken) problems.push(`has an optional ${label}`);
    if (p.initializer) problems.push(`has a default value for ${label}`);
    const sym = c.checker.getSymbolAtLocation(p.name);
    if (!sym) continue;
    ownParams.add(sym);
    params.push({
      name: p.name.text,
      symbol: sym,
      typeText: p.type ? c.text.slice(p.type.getStart(c.sf), p.type.getEnd()) : null,
    });
  }

  // Shape of the body.
  const body = node.body as ts.ConciseBody;
  let shape: Shape = { kind: "stmts", statements: [], ret: null, locals: [] };
  if (!t.isBlock(body)) {
    shape = { kind: "expr", expr: body };
  } else {
    const returns: ts.ReturnStatement[] = [];
    const findReturns = (n: ts.Node): void => {
      if (t.isFunctionLike(n) || t.isClassLike(n)) return;
      if (t.isReturnStatement(n)) returns.push(n);
      t.forEachChild(n, findReturns);
    };
    for (const s of body.statements) findReturns(s);
    const last = body.statements.at(-1);
    const early = returns.filter((r) => r !== last);
    if (early.length > 0) problems.push("has an early return (a return that is not its last statement)");
    if (body.statements.length === 0) {
      problems.push("has an empty body");
    } else if (early.length === 0) {
      if (last && t.isReturnStatement(last)) {
        for (const r of t.getLeadingCommentRanges(c.text, last.pos) ?? []) {
          const m = /@ts-(ignore|expect-error)/.exec(c.text.slice(r.pos, r.end));
          if (m) {
            problems.push(
              `has a \`@ts-${m[1]}\` comment above its final return, which would be lost because the return becomes part of another statement. Move the comment into a statement of its own or remove it first`,
            );
          }
        }
        const rest = body.statements.slice(0, -1);
        if (rest.length === 0 && last.expression) shape = { kind: "expr", expr: last.expression };
        else if (rest.length === 0) problems.push("has an empty body");
        else shape = { kind: "stmts", statements: rest, ret: last.expression ?? null, locals: [] };
      } else {
        shape = { kind: "stmts", statements: [...body.statements], ret: null, locals: [] };
      }
    }
    if (shape.kind === "stmts") {
      for (const s of shape.statements) {
        if (!t.isVariableStatement(s)) continue;
        const ids: ts.Identifier[] = [];
        for (const d of s.declarationList.declarations) bindingIdentifiers(t, d.name, ids);
        for (const id of ids) {
          const sym = c.checker.getSymbolAtLocation(id);
          if (sym) shape.locals.push({ name: id.text, symbol: sym });
        }
      }
    }
  }

  // Everything the function mentions: forbidden constructs, free variables, names declared inside.
  const freeRefs: FreeRef[] = [];
  const inside = new Set<string>();
  const ownName =
    t.isFunctionExpression(node) && node.name ? c.checker.getSymbolAtLocation(node.name) : undefined;
  let recursive = false;
  const flagged = new Set<string>();
  const flag = (why: string): void => {
    if (!flagged.has(why)) {
      flagged.add(why);
      problems.push(why);
    }
  };
  const visit = (n: ts.Node, inParamType: boolean): void => {
    if (n.kind === t.SyntaxKind.ThisKeyword) flag("uses `this`");
    else if (n.kind === t.SyntaxKind.SuperKeyword) flag("uses `super`");
    else if (t.isMetaProperty(n) && n.keywordToken === t.SyntaxKind.NewKeyword) flag("uses `new.target`");
    else if (t.isVariableDeclarationList(n)) {
      if (!(n.flags & t.NodeFlags.BlockScoped)) flag("declares a `var` (use let or const)");
      else if (n.flags & t.NodeFlags.Using) flag("declares a `using` variable (its disposal would move)");
    } else if (
      t.isFunctionDeclaration(n) ||
      t.isClassDeclaration(n) ||
      t.isEnumDeclaration(n) ||
      t.isInterfaceDeclaration(n) ||
      t.isTypeAliasDeclaration(n) ||
      t.isModuleDeclaration(n)
    ) {
      flag("declares a function, class or type inside its body (move it out first)");
    } else if (t.isJsxElement(n) || t.isJsxSelfClosingElement(n) || t.isJsxFragment(n)) {
      flag("contains JSX");
    } else if (t.isAwaitExpression(n) || t.isYieldExpression(n)) {
      flag("uses await or yield");
    }
    if (t.isIdentifier(n)) {
      if (n.text === "arguments") flag("uses `arguments`");
      if (isReference(t, n)) {
        const sym = symOf(c, n);
        if (!sym) {
          flag(`mentions \`${n.text}\`, which TypeScript cannot resolve`);
        } else if (sym === symbol || (ownName && sym === ownName)) {
          recursive = true;
        } else if (ownParams.has(sym)) {
          if (inParamType) flag("has a parameter type that refers to another parameter");
        } else if (sym.declarations && sym.declarations.length > 0 && sym.declarations.every((d) => within(d, node))) {
          inside.add(n.text);
        } else {
          freeRefs.push({ name: n.text, symbol: sym, meaning: typeMeaning(t, n) ? "type" : "value" });
        }
      }
    }
    t.forEachChild(n, (child) => visit(child, inParamType));
  };
  for (const p of node.parameters) if (p.type) visit(p.type, true);
  visit(body, false);
  if (recursive) problems.unshift("is recursive (it calls itself)");
  for (const p of params) {
    if (c.written.has(p.symbol)) problems.push(`assigns to its parameter \`${p.name}\``);
  }

  return {
    name,
    declaration,
    statement,
    node,
    nameId,
    symbol,
    exported: hasExport(t, statement),
    params,
    shape,
    freeRefs,
    inside,
    problems,
  };
}

// ---- uses ----

type Use = { id: ts.Identifier; call: ts.CallExpression | null; why: string; line: number; column: number };

function collectUses(c: Ctx, fn: Fn): Use[] {
  const t = c.t;
  const uses: Use[] = [];
  const visit = (n: ts.Node): void => {
    if (t.isIdentifier(n) && n.text === fn.name && n !== fn.nameId && isReference(t, n) && !within(n, fn.statement)) {
      const sym = symOf(c, n);
      if (sym && sameSymbol(sym, fn.symbol)) {
        const p = n.parent;
        const lc = c.sf.getLineAndCharacterOfPosition(n.getStart(c.sf));
        let call: ts.CallExpression | null = null;
        let why = "is used as a value (passed, stored or compared), not called directly. Call it directly, or remove this use by hand";
        if (t.isCallExpression(p) && p.expression === n) {
          if (p.questionDotToken) why = "is called with `?.`. Make it a plain call first";
          else if (p.typeArguments && p.typeArguments.length > 0) why = "is called with explicit type arguments. Remove them first";
          else call = p;
        } else if (t.isExportSpecifier(p) || t.isExportAssignment(p)) {
          why = "is exported here. Remove the export (and fix its importers) first";
        } else if (insideType(t, n)) {
          why = "is referenced in a type (`typeof`). Replace that type by hand first";
        } else if (t.isNewExpression(p) && p.expression === n) {
          why = "is used with `new`. Call it directly, or remove this use by hand";
        } else if (t.isTaggedTemplateExpression(p) && p.tag === n) {
          why = "is used as a template tag. Call it directly, or remove this use by hand";
        }
        uses.push({ id: n, call, why, line: lc.line + 1, column: lc.character + 1 });
      }
    }
    t.forEachChild(n, visit);
  };
  visit(c.sf);
  return uses;
}

// ---- call-site analysis ----

type Site = { kind: "expr" | "decl" | "return"; stmt: ts.Statement };

const NOT_HOISTABLE =
  "the call is not a whole expression statement, the initializer of a const/let with one declarator, or the expression of a return (the only places where it is the first thing evaluated)";

function hoistSite(c: Ctx, call: ts.CallExpression): Site | string {
  const t = c.t;
  const p = call.parent;
  let stmt: ts.Statement | undefined;
  let kind: Site["kind"] | undefined;
  if (t.isExpressionStatement(p)) {
    stmt = p;
    kind = "expr";
  } else if (t.isReturnStatement(p)) {
    stmt = p;
    kind = "return";
  } else if (
    t.isVariableDeclaration(p) &&
    p.initializer === call &&
    t.isVariableDeclarationList(p.parent) &&
    p.parent.declarations.length === 1 &&
    t.isVariableStatement(p.parent.parent)
  ) {
    stmt = p.parent.parent;
    kind = "decl";
  }
  if (!stmt || !kind) return NOT_HOISTABLE;
  const holder = stmt.parent;
  if (!(t.isSourceFile(holder) || t.isBlock(holder) || t.isModuleBlock(holder) || t.isCaseClause(holder) || t.isDefaultClause(holder))) {
    return "the call's statement is the unbraced body of an if/else/loop/label (add braces around it first)";
  }
  return { kind, stmt };
}

/** The scope the statement's new names land in. */
function scopeContainer(t: Ts, stmt: ts.Statement): ts.Node {
  const holder = stmt.parent;
  return t.isCaseClause(holder) || t.isDefaultClause(holder) ? holder.parent : holder;
}

const related = (a: ts.Node, b: ts.Node): boolean => within(a, b) || within(b, a);

/** Whether the call is the leftmost part of an expression statement (`statement`) or of an arrow body. */
function startOf(t: Ts, call: ts.CallExpression): { atStart: boolean; statement: ts.ExpressionStatement | null } {
  let n: ts.Node = call;
  while (true) {
    const p = n.parent;
    if (t.isExpressionStatement(p)) return { atStart: true, statement: p };
    if (t.isArrowFunction(p) && p.body === n) return { atStart: true, statement: null };
    const leftmost =
      (t.isPropertyAccessExpression(p) || t.isElementAccessExpression(p) || t.isCallExpression(p) || t.isNonNullExpression(p) || t.isAsExpression(p)) &&
      p.expression === n;
    const left =
      (t.isBinaryExpression(p) && p.left === n) ||
      (t.isConditionalExpression(p) && p.condition === n) ||
      (t.isTaggedTemplateExpression(p) && p.tag === n) ||
      (t.isPostfixUnaryExpression(p) && p.operand === n);
    if (!leftmost && !left) return { atStart: false, statement: null };
    n = p;
  }
}

/** Whether the node sits in the initializer of a `for (;;)` (where an unparenthesized `in` does not parse). */
function inForInitializer(t: Ts, node: ts.Node): boolean {
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    if (t.isForStatement(n.parent) && n.parent.initializer === n) return true;
    if (t.isBlock(n) || t.isStatement(n)) return false;
  }
  return false;
}

function containsIn(t: Ts, node: ts.Node): boolean {
  if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.InKeyword) return true;
  return t.forEachChild(node, (child) => (containsIn(t, child) ? true : undefined)) === true;
}

/** Labels declared in a function body (not in functions nested in it). */
function bodyLabels(t: Ts, body: ts.Node, out = new Set<string>()): Set<string> {
  if (t.isLabeledStatement(body)) out.add(body.label.text);
  t.forEachChild(body, (child) => {
    if (!t.isFunctionLike(child) && !t.isClassLike(child)) bodyLabels(t, child, out);
  });
  return out;
}

/** Whether another statement can come before this one (so that its end could swallow what follows). */
function inStatementList(t: Ts, statement: ts.Statement): boolean {
  const h = statement.parent;
  return t.isSourceFile(h) || t.isBlock(h) || t.isModuleBlock(h) || t.isCaseClause(h) || t.isDefaultClause(h);
}

/**
 * Whether the statement before this one could swallow a `(`, `[` or template that starts it. Decided from the
 * previous statement's last token, never from the raw text (a comment may end in `;`, `{` or `:`).
 */
function previousMayContinue(t: Ts, statement: ts.Statement): boolean {
  const h = statement.parent;
  if (!(t.isCaseClause(h) || t.isDefaultClause(h) || t.isSourceFile(h) || t.isBlock(h) || t.isModuleBlock(h))) return true;
  const i = h.statements.indexOf(statement);
  if (i <= 0) return false; // first in its list: the previous token is `{`, `:` or nothing
  const prev = h.statements[i - 1];
  if (!prev) return true;
  const last = statement.getSourceFile().text[prev.getEnd() - 1];
  if (last === ";") return false;
  const blockLike =
    t.isBlock(prev) ||
    t.isFunctionDeclaration(prev) ||
    t.isClassDeclaration(prev) ||
    t.isInterfaceDeclaration(prev) ||
    t.isEnumDeclaration(prev) ||
    t.isModuleDeclaration(prev);
  return !(blockLike && last === "}");
}

/** Whether a statement that is just a string literal here would be read as a directive (`'use strict'`). */
function inDirectivePrologue(t: Ts, statement: ts.Statement): boolean {
  const h = statement.parent;
  if (!(t.isSourceFile(h) || t.isModuleBlock(h) || (t.isBlock(h) && t.isFunctionLike(h.parent)))) return false;
  for (const s of h.statements) {
    if (s === statement) return true;
    if (!(t.isExpressionStatement(s) && t.isStringLiteral(s.expression))) return false;
  }
  return false;
}

function isLoose(t: Ts, node: ts.Node): boolean {
  const p = node.parent;
  return (
    t.isExpressionStatement(p) ||
    t.isReturnStatement(p) ||
    (t.isVariableDeclaration(p) && p.initializer === node) ||
    ((t.isCallExpression(p) || t.isNewExpression(p)) && p.expression !== node) ||
    t.isArrayLiteralExpression(p) ||
    (t.isPropertyAssignment(p) && p.initializer === node) ||
    t.isTemplateSpan(p) ||
    t.isSpreadElement(p) ||
    t.isParenthesizedExpression(p) ||
    (t.isArrowFunction(p) && p.body === node)
  );
}

/** Whether an expression can be an operand of anything without parentheses. */
function atomic(t: Ts, e: ts.Expression): boolean {
  if (e.flags & t.NodeFlags.OptionalChain) return false;
  if (t.isNonNullExpression(e)) return atomic(t, e.expression);
  if (t.isNewExpression(e)) return e.arguments !== undefined;
  return (
    t.isIdentifier(e) ||
    t.isStringLiteral(e) ||
    t.isNoSubstitutionTemplateLiteral(e) ||
    t.isTemplateExpression(e) ||
    t.isRegularExpressionLiteral(e) ||
    e.kind === t.SyntaxKind.TrueKeyword ||
    e.kind === t.SyntaxKind.FalseKeyword ||
    e.kind === t.SyntaxKind.NullKeyword ||
    e.kind === t.SyntaxKind.ThisKeyword ||
    t.isParenthesizedExpression(e) ||
    t.isArrayLiteralExpression(e) ||
    t.isObjectLiteralExpression(e) ||
    t.isCallExpression(e) ||
    t.isPropertyAccessExpression(e) ||
    t.isElementAccessExpression(e)
  );
}

function isLiteralArg(t: Ts, e: ts.Expression): boolean {
  return (
    t.isStringLiteral(e) ||
    t.isNumericLiteral(e) ||
    t.isBigIntLiteral(e) ||
    t.isNoSubstitutionTemplateLiteral(e) ||
    e.kind === t.SyntaxKind.TrueKeyword ||
    e.kind === t.SyntaxKind.FalseKeyword ||
    e.kind === t.SyntaxKind.NullKeyword ||
    (t.isPrefixUnaryExpression(e) &&
      (e.operator === t.SyntaxKind.MinusToken || e.operator === t.SyntaxKind.PlusToken) &&
      (t.isNumericLiteral(e.operand) || t.isBigIntLiteral(e.operand)))
  );
}

/** An identifier whose value cannot change between the call and any later use inside the unpacked code. */
/** Whether a declaration sits in an ambient context: `declare` on it or an enclosing declaration, `declare global`, a .d.ts. */
function inAmbientContext(t: Ts, node: ts.Node): boolean {
  if (node.getSourceFile().isDeclarationFile) return true;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (t.isSourceFile(n)) break;
    if (t.isVariableDeclaration(n) || t.isVariableDeclarationList(n) || t.isVariableStatement(n) || t.isModuleDeclaration(n) || t.isModuleBlock(n) || t.isClassDeclaration(n) || t.isFunctionDeclaration(n)) {
      if (t.isModuleDeclaration(n) && (n.flags & t.NodeFlags.GlobalAugmentation || n.name.kind === t.SyntaxKind.Identifier && n.name.text === "global" && n.modifiers?.some((m) => m.kind === t.SyntaxKind.DeclareKeyword))) return true;
      if (t.isVariableDeclaration(n) || t.isVariableStatement(n) || t.isModuleDeclaration(n) || t.isClassDeclaration(n) || t.isFunctionDeclaration(n)) {
        if (t.getCombinedModifierFlags(n as ts.Declaration) & t.ModifierFlags.Ambient) return true;
      }
    }
  }
  return false;
}

function isStableIdentifier(c: Ctx, id: ts.Identifier): boolean {
  const t = c.t;
  const sym = symOf(c, id);
  if (!sym) return false;
  if (sym.name === "undefined" && (sym.declarations?.length ?? 0) === 0) return true;
  let target = sym;
  if (sym.flags & t.SymbolFlags.Alias) target = c.checker.getAliasedSymbol(sym);
  const decls = target.declarations ?? [];
  if (decls.length === 0) return false;
  if (c.written.has(sym) || c.written.has(target)) return false;
  for (const d of decls) {
    let a: ts.Node | undefined = d;
    while (a && !t.isVariableDeclarationList(a) && !t.isSourceFile(a) && !t.isFunctionLike(a)) a = a.parent;
    if (a && t.isVariableDeclarationList(a) && !(a.flags & t.NodeFlags.Const)) {
      // let/var: only the writes of this file are known. A binding imported from elsewhere, exported, ambient
      // (`declare var`) or global (declared in a script file or another file) may change behind our back.
      if (target !== sym) return false;
      const declFile = d.getSourceFile();
      if (declFile !== c.sf || !t.isExternalModule(declFile) || declFile.isDeclarationFile || inAmbientContext(t, d)) return false;
      if (t.isVariableStatement(a.parent) && hasExport(t, a.parent)) return false;
    }
  }
  return true;
}

type Repl = { kind: "rename"; to: string } | { kind: "subst"; text: string; node: ts.Expression };

type State = {
  /** Names earlier plans of this run put into a scope. */
  intro: { container: ts.Node; names: Set<string> }[];
  /** Fresh names chosen so far. */
  fresh: Set<string>;
};

type Plan = { edits: Edit[]; container: ts.Node | null; names: Set<string> };

/** Plans one call: the edits unpacking it, or why it cannot be unpacked. */
function planCall(c: Ctx, fn: Fn, call: ts.CallExpression, state: State): Plan | string {
  const t = c.t;
  const sf = c.sf;
  const args = [...call.arguments];
  if (args.length !== fn.params.length) {
    return `it passes ${plural(args.length, "argument")} but \`${fn.name}\` takes ${fn.params.length}. Pass exactly one argument per parameter first`;
  }
  if (args.some((a) => t.isSpreadElement(a))) return "it spreads an argument (`...x`). Pass the arguments one by one first";

  // Free variables must mean the same thing here.
  const scopeCache = new Map<string, readonly ts.Symbol[]>();
  const inScope = (meaning: "value" | "type"): readonly ts.Symbol[] => {
    let list = scopeCache.get(meaning);
    if (!list) {
      const f = t.SymbolFlags;
      list = c.checker.getSymbolsInScope(call, meaning === "value" ? f.Value | f.Alias : f.Type | f.Namespace | f.Alias);
      scopeCache.set(meaning, list);
    }
    return list;
  };
  const checked = new Set<string>();
  for (const r of fn.freeRefs) {
    const key = `${r.meaning}:${r.name}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const here = inScope(r.meaning).find((s) => s.name === r.name);
    if (!here || !sameSymbol(here, r.symbol)) {
      return `\`${r.name}\`, which \`${fn.name}\` uses, means something else at this call (another \`${r.name}\` shadows it here). Rename the local \`${r.name}\` around this call first`;
    }
  }

  // A label inside the body must not repeat a label around the call.
  const labels = bodyLabels(t, fn.node.body as ts.Node);
  if (labels.size > 0) {
    for (let n: ts.Node = call; n.parent && !t.isFunctionLike(n); n = n.parent) {
      if (t.isLabeledStatement(n) && labels.has(n.label.text)) {
        return `\`${fn.name}\` has a label \`${n.label.text}\` and the call is inside a statement with the same label. Rename one of the labels first`;
      }
    }
  }

  // Which parameters are substituted and which are bound to a const.
  const expr = fn.shape.kind === "expr" ? fn.shape.expr : null;
  const bound: number[] = [];
  const repl = new Map<ts.Symbol, Repl>();
  const argText = (a: ts.Expression): string => c.text.slice(a.getStart(sf), a.getEnd());
  const substituted = new Map<ts.Symbol, ts.Expression>();
  for (const [i, param] of fn.params.entries()) {
    const arg = args[i] as ts.Expression;
    const simple = expr !== null && (isLiteralArg(t, arg) || (t.isIdentifier(arg) && isStableIdentifier(c, arg)));
    if (simple) {
      if (t.isIdentifier(arg) && fn.inside.has(arg.text)) {
        return `its argument \`${arg.text}\` would be captured by a variable named \`${arg.text}\` inside \`${fn.name}\`. Rename one of them first`;
      }
      substituted.set(param.symbol, arg);
    } else {
      bound.push(i);
    }
  }
  const needsPre = bound.length > 0 || fn.shape.kind === "stmts";
  let site: Site | null = null;
  if (needsPre) {
    const found = hoistSite(c, call);
    if (typeof found === "string") {
      if (fn.shape.kind === "stmts") {
        return `\`${fn.name}\` has several statements and ${found}. Put the call in a statement of its own first`;
      }
      const names = bound.map((i) => `\`${argText(args[i] as ts.Expression)}\``).join(", ");
      return `its argument ${names} is not a plain identifier or literal, so it must be evaluated first, in a statement of its own, but ${found}. Move the argument into a const above the statement first`;
    }
    site = found;
    if (fn.shape.kind === "stmts" && site.kind !== "expr" && fn.shape.ret === null) {
      return `\`${fn.name}\` returns nothing but its result is used here. Use the call as a statement of its own first`;
    }
  }

  // Names: those already in scope here are taken, so clashing parameters and locals are renamed.
  const f = t.SymbolFlags;
  const taken = new Set(c.checker.getSymbolsInScope(call, f.Value | f.Type | f.Namespace | f.Alias).map((s) => s.name));
  const container = site ? scopeContainer(t, site.stmt) : null;
  if (container) {
    for (const e of state.intro) if (related(e.container, container)) for (const n of e.names) taken.add(n);
  }
  const mine = new Set<string>();
  const pick = (name: string): string => {
    let chosen = name;
    if (taken.has(name)) {
      for (let i = 2; ; i++) {
        const cand = `${name}${i}`;
        if (!taken.has(cand) && !c.identTexts.has(cand) && !state.fresh.has(cand) && !RESERVED.has(cand)) {
          chosen = cand;
          break;
        }
      }
      state.fresh.add(chosen);
    }
    taken.add(chosen);
    mine.add(chosen);
    return chosen;
  };
  const bindingName = new Map<number, string>();
  for (const [i, param] of fn.params.entries()) {
    const sub = substituted.get(param.symbol);
    if (sub) repl.set(param.symbol, { kind: "subst", text: argText(sub), node: sub });
    else {
      const to = pick(param.name);
      bindingName.set(i, to);
      repl.set(param.symbol, { kind: "rename", to });
    }
  }
  if (fn.shape.kind === "stmts") {
    for (const local of fn.shape.locals) repl.set(local.symbol, { kind: "rename", to: pick(local.name) });
  }

  // Identifier edits inside the body.
  const idEdits: Edit[] = [];
  let problem: string | null = null;
  const shorthand = (id: ts.Identifier): boolean =>
    (t.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) ||
    (t.isBindingElement(id.parent) &&
      id.parent.name === id &&
      !id.parent.propertyName &&
      t.isObjectBindingPattern(id.parent.parent));
  const visit = (n: ts.Node): void => {
    if (t.isIdentifier(n) && isReference(t, n)) {
      const sym = symOf(c, n);
      const r = sym ? repl.get(sym) : undefined;
      if (r) {
        let text: string;
        if (r.kind === "rename") {
          text = r.to === n.text ? "" : shorthand(n) ? `${n.text}: ${r.to}` : r.to;
        } else {
          if (insideType(t, n)) {
            problem ??= `\`${fn.name}\` uses its parameter \`${n.text}\` in a type, which an argument cannot replace. Bind the argument to a const first`;
          }
          const arg = r.node;
          let wrap = false;
          if (t.isPrefixUnaryExpression(arg) && !isLoose(t, n)) wrap = true;
          else if (t.isNumericLiteral(arg) || t.isBigIntLiteral(arg)) {
            const p = n.parent;
            wrap =
              ((t.isPropertyAccessExpression(p) || t.isElementAccessExpression(p) || t.isCallExpression(p) || t.isNonNullExpression(p)) &&
                p.expression === n) ||
              (t.isTaggedTemplateExpression(p) && p.tag === n);
          }
          const value = wrap ? `(${r.text})` : r.text;
          text = shorthand(n) ? `${n.text}: ${value}` : value;
        }
        if (text !== "") idEdits.push({ start: n.getStart(sf), end: n.getEnd(), text });
      }
    }
    t.forEachChild(n, visit);
  };
  visit(fn.node.body as ts.Node);
  if (problem) return problem;

  // Texts of the pieces.
  const callStart = call.getStart(sf);
  const callEnd = call.getEnd();
  const anchor = site ? site.stmt.getStart(sf) : callStart;
  const callIndent = lineIndent(c.text, anchor);
  const effective = (e: ts.Expression): ts.Expression => {
    if (t.isIdentifier(e)) {
      const sym = symOf(c, e);
      const r = sym ? repl.get(sym) : undefined;
      if (r?.kind === "subst") return r.node;
    }
    return e;
  };
  const pieces: string[] = [];
  for (const i of bound) {
    const param = fn.params[i] as Param;
    const type = param.typeText ? `: ${param.typeText}` : "";
    pieces.push(`const ${bindingName.get(i)}${type} = ${argText(args[i] as ts.Expression)};`);
  }
  let value: string | null = null;
  let valueNode: ts.Expression | null = null;
  const shape = fn.shape;
  if (shape.kind === "expr") {
    const start = shape.expr.getStart(sf);
    const end = shape.expr.getEnd();
    const base = lineIndent(c.text, start);
    value = render(c.text, start, end, [...idEdits, ...reindent(c, start, end, base, callIndent)]);
    valueNode = effective(shape.expr);
  } else {
    const first = shape.statements[0] as ts.Statement;
    const base = lineIndent(c.text, attachedStart(c, first));
    for (const s of shape.statements) {
      const start = attachedStart(c, s);
      const end = endWithTrailing(c, s);
      pieces.push(render(c.text, start, end, [...idEdits, ...reindent(c, start, end, base, callIndent)]));
    }
    if (shape.ret) {
      const start = shape.ret.getStart(sf);
      const end = shape.ret.getEnd();
      value = render(c.text, start, end, [...idEdits, ...reindent(c, start, end, base, callIndent)]);
      valueNode = effective(shape.ret);
    }
  }

  // Where the call's value goes: `this` binding and `delete` change meaning when the call is replaced by a member access.
  if (valueNode) {
    let outer: ts.Node = call;
    while ((t.isParenthesizedExpression(outer.parent) || t.isNonNullExpression(outer.parent)) && outer.parent.expression === outer) {
      outer = outer.parent;
    }
    const q = outer.parent;
    let inner: ts.Expression = valueNode;
    while (t.isParenthesizedExpression(inner) || t.isNonNullExpression(inner)) inner = inner.expression;
    const access = t.isPropertyAccessExpression(inner) || t.isElementAccessExpression(inner);
    if (((t.isCallExpression(q) && q.expression === outer) || (t.isTaggedTemplateExpression(q) && q.tag === outer)) && access) {
      return `its result is called directly, and the unpacked expression is a property access: calling it would pass a different \`this\`. Store the result in a const first`;
    }
    if (t.isDeleteExpression(q)) return "its result is the operand of `delete`. Store the result in a const first";
  }

  const parenthesize = (text: string, node: ts.Expression): string => {
    let wrap: boolean;
    if (isLoose(t, call)) wrap = t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.CommaToken;
    else wrap = !atomic(t, node);
    // The call starts a statement (or an arrow body): `{`, `function`, … would parse differently.
    if (startOf(t, call).atStart && STATEMENT_START.test(text)) wrap = true;
    // In a `for` initializer an unparenthesized `in` would turn the loop into a for-in.
    if (inForInitializer(t, call) && containsIn(t, node)) wrap = true;
    return wrap ? `(${text})` : text;
  };
  const guard = (piece: string): string => (ASI_HAZARD.test(piece) ? `;${piece}` : piece);

  const edits: Edit[] = [];
  if (pieces.length === 0) {
    let replacement = parenthesize(value as string, valueNode as ts.Expression);
    const lead = startOf(t, call).statement;
    if (lead && inStatementList(t, lead)) {
      if (lead.expression === call && valueNode && t.isStringLiteral(valueNode) && inDirectivePrologue(t, lead)) {
        replacement = `(${replacement})`;
      }
      if (ASI_HAZARD.test(replacement) && previousMayContinue(t, lead)) {
        // The previous statement may have no semicolon: `a\n(1 + 1)` would be a call of `a`.
        replacement = `;${replacement}`;
      }
    }
    edits.push({ start: callStart, end: callEnd, text: replacement });
  } else if (!site) {
    return "internal: no place for the statements";
  } else if (site.kind === "expr") {
    const list = [...pieces];
    if (value !== null && valueNode && !isLiteralArg(t, valueNode) && !t.isIdentifier(valueNode)) {
      list.push(`${STATEMENT_START.test(value) ? `(${value})` : value};`);
    }
    edits.push({ start: site.stmt.getStart(sf), end: site.stmt.getEnd(), text: list.map(guard).join(c.eol + callIndent) });
  } else {
    const first = attachedStart(c, site.stmt);
    const lineStart = c.text.lastIndexOf("\n", first - 1) + 1;
    if (/^[ \t]*$/.test(c.text.slice(lineStart, first))) {
      edits.push({ start: lineStart, end: lineStart, text: pieces.map((p) => callIndent + guard(p) + c.eol).join("") });
    } else {
      edits.push({ start: first, end: first, text: pieces.map(guard).join(c.eol + callIndent) + c.eol + callIndent });
    }
    edits.push({ start: callStart, end: callEnd, text: parenthesize(value as string, valueNode as ts.Expression) });
  }
  return { edits, container, names: mine };
}

// ---- finding the declaration ----

function findFunction(engine: TsEngine, file: string, name: string): ReturnType<TsEngine["findTopLevel"]> {
  for (const kind of ["function", "variable"] as const) {
    try {
      return engine.findTopLevel(file, name, kind);
    } catch (e) {
      if (!(e instanceof RefactorError) || e.code !== "SYMBOL_NOT_FOUND") throw e;
    }
  }
  throw new RefactorError(
    "SYMBOL_NOT_FOUND",
    `There is no top-level function or const ${name} in ${file}. Check --symbol and --file (only top-level declarations count), then run again.`,
  );
}

export const inlineFunctionAction: Action<InlineParams, TsEngine> = {
  id: "typescript-inline-function",
  kind: "refactor",
  summary: "Inlines one call, or every call, of a top-level function.",
  flags: [],
  parseParams(raw) {
    return {
      file: required(raw, "file"),
      symbol: required(raw, "symbol"),
      ...(raw.at ? { at: parseAt(raw.at) } : {}),
    };
  },
  describe: (p) =>
    p.at
      ? `unpack ${p.symbol} at ${atText(p.at.path, p.at)}`
      : `unpack ${p.symbol} everywhere in ${p.file} and remove it`,

  async run(engine, p) {
    const t = engine.ts;
    const file = engine.relPath(p.file);
    const decl = findFunction(engine, file, p.symbol);
    const c = makeCtx(engine, file);
    const fn = analyze(c, engine.declarationNode(decl), p.symbol);
    const name = fn.name;
    const lc = (pos: number): string => {
      const x = c.sf.getLineAndCharacterOfPosition(pos);
      return `${file}:${x.line + 1}:${x.character + 1}`;
    };
    const tail = "Nothing was changed.";
    const functionProblems = fn.problems.map((why) => `- \`${name}\` ${why}.`);
    const uses = collectUses(c, fn);
    const calls = uses.filter((u) => u.call !== null);

    // Which calls, and their problems.
    const state: State = { intro: [], fresh: new Set() };
    const plans: { use: Use; plan: Plan }[] = [];
    const chosen: Use[] = [];
    if (p.at) {
      if (engine.relPath(p.at.path) !== file) {
        unavailable(
          `--at is in ${engine.relPath(p.at.path)} but \`${name}\` is declared in ${file}. Only calls in the same module can be unpacked (the body's names must mean the same thing): pass --at inside ${file}.`,
        );
      }
      if (functionProblems.length > 0) {
        unavailable(`\`${name}\` cannot be unpacked at all:\n${functionProblems.join("\n")}\nChange the function so that none of these apply, then run again. ${tail}`);
      }
      const here = uses.filter((u) => u.line === p.at?.line);
      const where = calls.map((u) => `${file}:${u.line}:${u.column}`);
      const nonCall = here.filter((u) => u.call === null).map((u) => `${file}:${u.line}:${u.column} (${u.why.split(". ")[0]})`);
      const use = findAt(
        c.sf,
        file,
        p.at,
        calls.map((u) => ({ item: u, start: u.id.getStart(c.sf), end: u.id.getEnd() })),
        {
          what: `call to \`${name}\``,
          plural: `calls to \`${name}\``,
          hint:
            (where.length > 0 ? `Its calls are at ${where.join(", ")}. ` : `${name} is never called in ${file}. `) +
            (nonCall.length > 0 ? `Other uses on that line: ${nonCall.join(", ")}. ` : "") +
            "Pass --at <path>:<line>[:<column>] for one of the calls.",
        },
      );
      chosen.push(use);
      const planned = planCall(c, fn, use.call as ts.CallExpression, state);
      if (typeof planned === "string") {
        unavailable(`Cannot unpack the call to \`${name}\` at ${lc(use.id.getStart(c.sf))}: ${planned}. ${tail}`);
      }
      plans.push({ use, plan: planned });
    } else {
      const blockers: string[] = [];
      if (fn.exported) {
        blockers.push(`- ${file}: \`${name}\` is exported, so other files may use it. Remove the export (and fix its importers) first.`);
      } else if (!t.isExternalModule(c.sf)) {
        blockers.push(`- ${file}: \`${name}\` is declared in a script (the file has no import or export), so other files may use it. Make the file a module first.`);
      }
      blockers.push(...functionProblems);
      for (const u of uses) if (u.call === null) blockers.push(`- ${lc(u.id.getStart(c.sf))}: \`${name}\` ${u.why}.`);
      if (calls.length === 0 && uses.length === 0 && blockers.length === 0) {
        blockers.push(`- \`${name}\` has no calls in ${file}, so there is nothing to unpack. Delete it by hand if it is unused.`);
      }
      const callNodes = calls.map((u) => u.call as ts.CallExpression);
      if (functionProblems.length === 0) {
        for (const u of calls) {
          const node = u.call as ts.CallExpression;
          const outer = callNodes.find((o) => o !== node && o.arguments.some((a) => within(node, a)));
          if (outer) {
            blockers.push(
              `- ${lc(u.id.getStart(c.sf))}: this call is inside the arguments of another call to \`${name}\`. Unpack the outer call first with --at, then run again.`,
            );
            continue;
          }
          const planned = planCall(c, fn, node, state);
          if (typeof planned === "string") blockers.push(`- ${lc(u.id.getStart(c.sf))}: cannot unpack this call: ${planned}.`);
          else plans.push({ use: u, plan: planned });
          if (typeof planned !== "string" && planned.container) state.intro.push({ container: planned.container, names: planned.names });
        }
      }
      if (blockers.length > 0) {
        unavailable(
          `Cannot unpack \`${name}\` everywhere and remove it (${plural(blockers.length, "blocking problem")}):\n${blockers.join("\n")}\n` +
            `Resolve each item by hand, then run again. To unpack just one call that is safe, pass --at <path>:<line>[:<column>]. ${tail}`,
        );
      }
    }
    // One-call mode: names introduced are tracked per run, not across modes.
    // Where each unpacked call is: the declaration it is in, read before the edits.
    const places = plans.map(({ use }) => engine.declarationPath(use.call as ts.CallExpression));

    // Edits.
    const edits: Edit[] = plans.flatMap(({ plan }) => plan.edits);
    if (!p.at) {
      const start = attachedStart(c, fn.statement);
      const lineStart = c.text.lastIndexOf("\n", start - 1) + 1;
      const from = /^[ \t]*$/.test(c.text.slice(lineStart, start)) ? lineStart : start;
      const nl = c.text.indexOf("\n", fn.statement.getEnd());
      let to = nl !== -1 && /^[ \t]*\r?$/.test(c.text.slice(fn.statement.getEnd(), nl)) ? nl + 1 : fn.statement.getEnd();
      // Do not leave two blank lines behind.
      const before = c.text.slice(0, from);
      if ((from === 0 || /\n\r?\n$/.test(before)) && /^\r?\n/.test(c.text.slice(to))) to += c.text.slice(to).startsWith("\r\n") ? 2 : 1;
      edits.push({ start: from, end: to, text: "" });
    }
    edits.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < edits.length; i++) {
      if ((edits[i] as Edit).start < (edits[i - 1] as Edit).end) {
        unavailable(`The unpacked calls of \`${name}\` overlap each other. Unpack them one at a time with --at. ${tail}`);
      }
    }

    const before = diagnostics(engine, file);
    engine.applyTextChanges([
      {
        fileName: file,
        textChanges: edits.map((e) => ({ span: { start: e.start, length: e.end - e.start }, newText: e.text })),
      },
    ]);
    const errors = introduced(before, diagnostics(engine, file));
    if (errors.length > 0) {
      unavailable(
        `Unpacking ${p.at ? "that call" : `\`${name}\``} would introduce TypeScript errors in ${file}: ${errors.join("; ")}. ` +
          `${explainIntroduced(errors)} ${tail}`,
      );
    }

    let summary: string;
    if (p.at) {
      summary = `Unpacked a call to \`${name}\` in ${places[0] as string}. \`${name}\` stays declared.`;
    } else {
      const perPlace = new Map<string, number>();
      for (const place of places) perPlace.set(place, (perPlace.get(place) ?? 0) + 1);
      const lines = [...perPlace].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([place, n]) => (n === 1 ? place : `${place} (${n} calls)`));
      summary = `Unpacked ${plural(places.length, "call")} to \`${name}\` and removed its declaration:\n${listLines(lines)}`;
    }
    return { summary };
  },
};
