import { RefactorError } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "../engine.ts";
import { diagnostics, introduced, required, unavailable } from "../shared.ts";

/**
 * Replaces the code at `--at` (exactly `--before`) with `--after`, but only when one of the rules below
 * proves the two behave the same. For now there is one rule, `fold-guard`; a rule that does not apply
 * says why, and the action is refused with every rule's reason.
 */
export type ReplaceParams = {
  file: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  before: string;
  after: string;
};

function parseRange(raw: string): Pick<ReplaceParams, "file" | "start" | "end"> {
  const m = /^(.+?):(\d+):(\d+)-(\d+):(\d+)$/.exec(raw);
  const nums = m ? [m[2], m[3], m[4], m[5]].map(Number) : [];
  if (!m || nums.some((n) => n < 1)) {
    throw new RefactorError(
      "INVALID_ARGS",
      `--at must be <path>:<line>:<column>-<line>:<column> with 1-based numbers, not ${JSON.stringify(raw)}. ` +
        `Pass for example --at src/a.ts:12:3-18:5 (the end is the position just after the last character).`,
    );
  }
  const [sl, sc, el, ec] = nums as [number, number, number, number];
  return { file: m[1] as string, start: { line: sl, column: sc }, end: { line: el, column: ec } };
}

/** The old and the new code, each as the statements of one block that the range holds exactly. */
type Side = { sf: ts.SourceFile; checker: ts.TypeChecker; program: ts.Program; statements: ts.Statement[] };

/** Proves that `before` and `after` behave the same, or returns why this rule does not apply. */
type Rule = { id: string; prove(typescript: typeof ts, before: Side, after: Side): string | null };

/** The statements of one block that span exactly [start, end), or null. */
function statementsAt(typescript: typeof ts, sf: ts.SourceFile, start: number, end: number): ts.Statement[] | null {
  let found: ts.Statement[] | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (typescript.isBlock(node) || typescript.isSourceFile(node) || typescript.isCaseClause(node) || typescript.isDefaultClause(node)) {
      const list = node.statements;
      const from = list.findIndex((s) => s.getStart(sf) === start);
      if (from >= 0) {
        const to = list.findIndex((s) => s.getEnd() === end);
        if (to >= from) {
          found = list.slice(from, to + 1);
          return;
        }
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** A node's children, punctuation tokens left out (`forEachChild` order). */
function children(typescript: typeof ts, node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  typescript.forEachChild(
    node,
    (c) => {
      out.push(c);
    },
    (list) => {
      out.push(...list);
    },
  );
  return out;
}

/** The text that tells two leaves apart: an identifier's name, a literal's value. */
function leafText(typescript: typeof ts, node: ts.Node): string | null {
  if (typescript.isIdentifier(node) || typescript.isPrivateIdentifier(node)) return node.text;
  if (typescript.isLiteralExpression(node) || typescript.isTemplateLiteralToken(node)) return node.text;
  return null;
}

/** The same syntax, ignoring whitespace, comments and formatting. */
function same(typescript: typeof ts, a: ts.Node, b: ts.Node): boolean {
  if (a.kind !== b.kind || leafText(typescript, a) !== leafText(typescript, b)) return false;
  const ca = children(typescript, a);
  const cb = children(typescript, b);
  return ca.length === cb.length && ca.every((c, i) => same(typescript, c, cb[i] as ts.Node));
}

/**
 * Where `b` is `a` with one expression replaced by the identifier `name`: that expression of `a`.
 * Null when they differ anywhere else, or nowhere.
 */
function replacedBy(typescript: typeof ts, a: ts.Node, b: ts.Node, name: string): ts.Expression[] | null {
  if (typescript.isIdentifier(b) && b.text === name && typescript.isExpression(a)) return [a];
  if (a.kind !== b.kind || leafText(typescript, a) !== leafText(typescript, b)) return null;
  const ca = children(typescript, a);
  const cb = children(typescript, b);
  if (ca.length !== cb.length) return null;
  const found: ts.Expression[] = [];
  for (let i = 0; i < ca.length; i++) {
    const sub = replacedBy(typescript, ca[i] as ts.Node, cb[i] as ts.Node, name);
    if (sub === null) return null;
    found.push(...sub);
  }
  return found;
}

const skipParens = (typescript: typeof ts, e: ts.Expression): ts.Expression => {
  while (typescript.isParenthesizedExpression(e)) e = e.expression;
  return e;
};

/** `if (C) return R;` or `if (C) { return R; }` without else: C and R (R undefined for a bare `return;`). */
function guardOf(typescript: typeof ts, s: ts.Statement): { condition: ts.Expression; value: ts.Expression | undefined } | null {
  if (!typescript.isIfStatement(s) || s.elseStatement) return null;
  let then = s.thenStatement;
  if (typescript.isBlock(then)) {
    if (then.statements.length !== 1) return null;
    then = then.statements[0] as ts.Statement;
  }
  if (!typescript.isReturnStatement(then)) return null;
  return { condition: s.expression, value: then.expression };
}

/**
 * Why evaluating `e` could do something or read through a getter, or null when it only reads: names,
 * property reads of known non-accessor properties, literals, operators that do not assign, conditionals.
 */
function impurity(typescript: typeof ts, checker: ts.TypeChecker, e: ts.Node): string | null {
  const k = typescript.SyntaxKind;
  // valueOf and toString are assumed to do nothing special (AGENTS.md), so `+`, `<`, `-x` and `${x}` only read.
  if (typescript.isIdentifier(e)) return null;
  if (
    typescript.isStringLiteral(e) ||
    typescript.isNumericLiteral(e) ||
    typescript.isBigIntLiteral(e) ||
    typescript.isNoSubstitutionTemplateLiteral(e) ||
    e.kind === k.TrueKeyword ||
    e.kind === k.FalseKeyword ||
    e.kind === k.NullKeyword
  ) {
    return null;
  }
  if (typescript.isPropertyAccessExpression(e)) {
    const sym = checker.getSymbolAtLocation(e.name);
    if (!sym) return `\`${e.getText()}\` reads a property the checker cannot resolve`;
    if (sym.flags & (typescript.SymbolFlags.GetAccessor | typescript.SymbolFlags.SetAccessor)) return `\`${e.getText()}\` reads a getter`;
    return impurity(typescript, checker, e.expression);
  }
  if (typescript.isParenthesizedExpression(e) || typescript.isAsExpression(e) || typescript.isNonNullExpression(e) || typescript.isSatisfiesExpression(e)) {
    return impurity(typescript, checker, e.expression);
  }
  if (typescript.isPrefixUnaryExpression(e)) {
    if (e.operator === k.PlusPlusToken || e.operator === k.MinusMinusToken) return `\`${e.getText()}\` assigns`;
    return impurity(typescript, checker, e.operand);
  }
  if (typescript.isTypeOfExpression(e)) return impurity(typescript, checker, e.expression);
  if (typescript.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op >= k.FirstAssignment && op <= k.LastAssignment) return `\`${e.getText()}\` assigns`;
    if (op === k.InKeyword || op === k.InstanceOfKeyword) return `\`${e.getText()}\` uses ${typescript.tokenToString(op)}, which can run code`;
    return impurity(typescript, checker, e.left) ?? impurity(typescript, checker, e.right);
  }
  if (typescript.isConditionalExpression(e)) {
    return impurity(typescript, checker, e.condition) ?? impurity(typescript, checker, e.whenTrue) ?? impurity(typescript, checker, e.whenFalse);
  }
  if (typescript.isTemplateExpression(e)) {
    for (const span of e.templateSpans) {
      const r = impurity(typescript, checker, span.expression);
      if (r) return r;
    }
    return null;
  }
  return `\`${e.getText()}\` is not only reading (calls, \`new\`, \`await\`, element access and the like are not supported yet)`;
}

/**
 * Why `e` might not be evaluated exactly once when its statement `stmt` runs, or something evaluated
 * before it in that statement might do something; null when it is evaluated once, after reads only.
 */
function placementProblem(typescript: typeof ts, checker: ts.TypeChecker, stmt: ts.Statement, e: ts.Expression): string | null {
  const k = typescript.SyntaxKind;
  const earlierPure = (earlier: readonly ts.Node[]): string | null => {
    for (const n of earlier) {
      const r = impurity(typescript, checker, n);
      if (r) return `before it, ${r}`;
    }
    return null;
  };
  let child: ts.Node = e;
  for (let parent = e.parent; child !== stmt; child = parent, parent = parent.parent) {
    if (typescript.isExpressionStatement(parent) || typescript.isReturnStatement(parent)) continue;
    if (typescript.isVariableDeclaration(parent) && parent.initializer === child) continue;
    if (typescript.isVariableDeclarationList(parent)) {
      const r = earlierPure(parent.declarations.slice(0, parent.declarations.indexOf(child as ts.VariableDeclaration)).map((d) => d.initializer).filter((i) => i !== undefined));
      if (r) return r;
      continue;
    }
    if (typescript.isVariableStatement(parent)) continue;
    if (typescript.isParenthesizedExpression(parent) || typescript.isAsExpression(parent) || typescript.isNonNullExpression(parent) || typescript.isSatisfiesExpression(parent) || typescript.isAwaitExpression(parent)) continue;
    if (typescript.isCallExpression(parent) || typescript.isNewExpression(parent)) {
      if (typescript.isCallExpression(parent) && (parent.questionDotToken || parent.flags & typescript.NodeFlags.OptionalChain)) {
        return `it is inside an optional call, which may not run`;
      }
      if (child === parent.expression) continue;
      const args = parent.arguments ?? typescript.factory.createNodeArray();
      const r = earlierPure([parent.expression, ...args.slice(0, args.indexOf(child as ts.Expression))]);
      if (r) return r;
      continue;
    }
    if (typescript.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (op === k.AmpersandAmpersandToken || op === k.BarBarToken || op === k.QuestionQuestionToken) {
        if (child === parent.right) return `it is on the right of ${typescript.tokenToString(op)}, which may not run it`;
        continue;
      }
      if (op >= k.FirstAssignment && op <= k.LastAssignment) return `it is part of an assignment`;
      if (child === parent.right) {
        const r = earlierPure([parent.left]);
        if (r) return r;
      }
      continue;
    }
    if (typescript.isPropertyAssignment(parent) && parent.initializer === child) continue;
    if (typescript.isObjectLiteralExpression(parent) || typescript.isArrayLiteralExpression(parent)) {
      const list: readonly ts.Node[] = typescript.isObjectLiteralExpression(parent) ? parent.properties : parent.elements;
      const r = earlierPure(list.slice(0, list.indexOf(child)).map((n) => (typescript.isPropertyAssignment(n) ? n.initializer : n)));
      if (r) return r;
      continue;
    }
    if (typescript.isConditionalExpression(parent)) {
      if (child === parent.condition) continue;
      return `it is in a branch of a conditional, which may not run`;
    }
    return `it is inside ${typescript.SyntaxKind[parent.kind]}, which fold-guard does not handle yet`;
  }
  return null;
}

/**
 * if (C) return R;                  const d = C ? null : E;
 * use(..., E, ...);          →      if (d === null) return R;
 *                                   use(..., d, ...);
 * The same when E is never null, only reads, and runs exactly once right after C is false, with only
 * reads before it in its statement: C is evaluated once in both, R only when C holds, and E only when
 * it does not, with nothing in between that could change what it reads.
 */
const foldGuard: Rule = {
  id: "fold-guard",
  prove(typescript, before, after) {
    const shape = "`if (C) return R;` and one statement using E, becoming `const d = C ? null : E;`, `if (d === null) return R;` and that statement using d";
    if (before.statements.length !== 2 || after.statements.length !== 3) {
      return `it needs ${shape}: 2 statements before, 3 after (here ${before.statements.length} and ${after.statements.length})`;
    }
    const [guard, use] = before.statements as [ts.Statement, ts.Statement];
    const [decl, newGuard, newUse] = after.statements as [ts.Statement, ts.Statement, ts.Statement];
    const g = guardOf(typescript, guard);
    if (!g) return "the first statement before is not `if (C) return R;` (without else)";

    if (!typescript.isVariableStatement(decl) || !(decl.declarationList.flags & typescript.NodeFlags.Const) || decl.declarationList.declarations.length !== 1) {
      return "the first statement after is not one `const d = C ? null : E;`";
    }
    const d = decl.declarationList.declarations[0] as ts.VariableDeclaration;
    if (!typescript.isIdentifier(d.name) || d.type || !d.initializer) return "the first statement after is not `const d = C ? null : E;` (no type, a plain name)";
    const name = d.name.text;
    const init = skipParens(typescript, d.initializer);
    if (!typescript.isConditionalExpression(init) || skipParens(typescript, init.whenTrue).kind !== typescript.SyntaxKind.NullKeyword) {
      return "the first statement after does not set d to `C ? null : E`";
    }
    if (!same(typescript, skipParens(typescript, init.condition), skipParens(typescript, g.condition))) {
      return "its condition is not the guard's condition";
    }

    const ng = guardOf(typescript, newGuard);
    const check = ng && skipParens(typescript, ng.condition);
    const isNullCheck =
      check &&
      typescript.isBinaryExpression(check) &&
      check.operatorToken.kind === typescript.SyntaxKind.EqualsEqualsEqualsToken &&
      typescript.isIdentifier(check.left) &&
      check.left.text === name &&
      check.right.kind === typescript.SyntaxKind.NullKeyword;
    if (!ng || !isNullCheck) return `the second statement after is not \`if (${name} === null) return R;\``;
    if ((ng.value === undefined) !== (g.value === undefined) || (ng.value && g.value && !same(typescript, ng.value, g.value))) {
      return "the new guard does not return what the old one did";
    }

    const replaced = replacedBy(typescript, use, newUse, name);
    if (!replaced || replaced.length !== 1) {
      return `the last statement after is not the statement before with exactly one expression replaced by ${name}`;
    }
    const e = replaced[0] as ts.Expression;
    if (!same(typescript, skipParens(typescript, init.whenFalse), skipParens(typescript, e))) {
      return `the expression replaced by ${name} is not the E of \`${name} = C ? null : E\``;
    }

    // The name must be new: free where the guard was, and not declared anywhere in the old code.
    const inScope = before.checker.getSymbolsInScope(guard, typescript.SymbolFlags.Value | typescript.SymbolFlags.Type | typescript.SymbolFlags.Alias);
    let declaredInside = false;
    for (const s of before.statements) {
      const look = (n: ts.Node): void => {
        if (typescript.isIdentifier(n) && n.text === name) declaredInside = true;
        typescript.forEachChild(n, look);
      };
      look(s);
    }
    if (inScope.some((s) => s.name === name) || declaredInside) return `${name} is already a name there; pick a new one`;

    const opts = before.program.getCompilerOptions();
    if (!(opts.strictNullChecks ?? opts.strict ?? false)) return "strictNullChecks is off, so E's type cannot show that it is never null";
    const type = before.checker.getTypeAtLocation(e);
    const parts = type.isUnion() ? type.types : [type];
    if (parts.some((t) => t.flags & (typescript.TypeFlags.Any | typescript.TypeFlags.Unknown | typescript.TypeFlags.Null))) {
      return `E (\`${e.getText()}\`) can be null as far as the checker knows (${before.checker.typeToString(type)}), so ${name} === null would not mean the guard held`;
    }
    const impure = impurity(typescript, before.checker, e);
    if (impure) return `E does more than read: ${impure}`;
    const placed = placementProblem(typescript, before.checker, use, e);
    if (placed) return `E cannot move up to the guard: ${placed}`;
    return null;
  },
};

const RULES: Rule[] = [foldGuard];

export const replaceSameBehaviorAction: Action<ReplaceParams, TsEngine> = {
  id: "replace-same-behavior",
  kind: "refactor",
  summary: "Replaces exact code with new code, only when a known rule proves they behave the same (for now: fold-guard).",
  flags: [
    {
      name: "--at",
      type: "text",
      required: true,
      description: "The code to replace, as <path>:<line>:<column>-<line>:<column> (1-based; the end is the position just after its last character).",
    },
    { name: "--before", type: "text", required: true, description: "The code at --at, exactly as it is in the file." },
    {
      name: "--after",
      type: "text",
      required: true,
      description:
        "The code to put there instead. It is kept only when a rule proves it behaves the same as --before; the rules so far:\n" +
        "- fold-guard: `if (C) return R;` and the statement after it, which uses an expression E, become\n" +
        "  `const d = C ? null : E;`, `if (d === null) return R;` and that statement with d in place of E.\n" +
        "  It needs: d a new name; strictNullChecks on and E never null; E only reads (names, property reads\n" +
        "  that are not getters, literals, operators that do not assign, conditionals); E runs exactly once\n" +
        "  (not behind &&, ||, ??, ?: or ?.), with only reads before it in its statement.\n" +
        "The result must not introduce type errors (a narrowing the old code had is often what goes).",
    },
  ],
  parseParams(raw) {
    return { ...parseRange(required(raw, "at")), before: required(raw, "before"), after: required(raw, "after") };
  },
  describe: (p) => `${p.file}:${p.start.line}:${p.start.column}-${p.end.line}:${p.end.column}`,

  async run(engine, p) {
    const typescript = engine.ts;
    const at = `${p.file}:${p.start.line}:${p.start.column}-${p.end.line}:${p.end.column}`;
    const old = engine.sourceFile(p.file);
    const lineStarts = old.sf.getLineStarts();
    const offset = (pos: { line: number; column: number }): number => {
      const lineStart = lineStarts[pos.line - 1];
      const nextStart = pos.line < lineStarts.length ? (lineStarts[pos.line] as number) : old.sf.text.length + 1;
      if (lineStart === undefined || lineStart + pos.column - 1 >= nextStart) {
        throw new RefactorError("INVALID_ARGS", `${p.file}:${pos.line}:${pos.column} is outside the file.`);
      }
      return lineStart + pos.column - 1;
    };
    const start = offset(p.start);
    const end = offset(p.end);
    const current = old.sf.text.slice(start, end);
    if (current !== p.before) {
      throw new RefactorError("INVALID_ARGS", `--before is not the code at ${at}, which is:\n${current}\nPass it exactly, or fix --at.`);
    }
    const oldStatements = statementsAt(typescript, old.sf, start, end);
    if (!oldStatements) unavailable(`${at} does not hold whole statements of one block exactly. Start --at at the first statement and end it right after the last.`);

    const errorsBefore = diagnostics(engine, p.file);
    engine.applyTextChanges([{ fileName: p.file, textChanges: [{ span: { start, length: end - start }, newText: p.after }] }]);
    const neu = engine.sourceFile(p.file);
    const newStatements = statementsAt(typescript, neu.sf, start, start + p.after.length);
    if (!newStatements) unavailable(`--after is not whole statements in that place (or does not parse). Pass statements, without leading or trailing whitespace.`);

    const before: Side = { sf: old.sf, program: old.program, checker: old.program.getTypeChecker(), statements: oldStatements };
    const after: Side = { sf: neu.sf, program: neu.program, checker: neu.program.getTypeChecker(), statements: newStatements };
    const reasons: string[] = [];
    let proven: string | null = null;
    for (const rule of RULES) {
      const why = rule.prove(typescript, before, after);
      if (why === null) {
        proven = rule.id;
        break;
      }
      reasons.push(`${rule.id}: ${why}`);
    }
    if (!proven) unavailable(`Cannot show that the code at ${at} and --after behave the same. ${reasons.join(". ")}.`);

    const errors = introduced(errorsBefore, diagnostics(engine, p.file));
    if (errors.length > 0) {
      unavailable(`The replacement behaves the same (${proven}) but introduces type errors: ${errors.join("; ")}. Often a narrowing the old code had is gone.`);
    }
    return { summary: `Replaced ${at}; ${proven} shows it behaves the same.` };
  },
};
