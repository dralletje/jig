import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { atText, diagnostics, findAt, introduced, parseAt, required, unavailable } from "./shared.ts";
import type { At } from "./shared.ts";

export type RemoveUnusedVariableParams = At;

// ---- what counts as having no side effects ----

function isLiteral(typescript: typeof ts, e: ts.Expression): boolean {
  return (
    typescript.isStringLiteral(e) ||
    typescript.isNumericLiteral(e) ||
    typescript.isNoSubstitutionTemplateLiteral(e) ||
    typescript.isBigIntLiteral(e) ||
    typescript.isRegularExpressionLiteral(e) ||
    e.kind === typescript.SyntaxKind.TrueKeyword ||
    e.kind === typescript.SyntaxKind.FalseKeyword ||
    e.kind === typescript.SyntaxKind.NullKeyword ||
    (typescript.isPrefixUnaryExpression(e) &&
      (e.operator === typescript.SyntaxKind.MinusToken || e.operator === typescript.SyntaxKind.PlusToken) &&
      typescript.isNumericLiteral(e.operand))
  );
}

/** Only literals, identifiers, functions, and object/array/template literals built from those. */
function sideEffectFree(typescript: typeof ts, e: ts.Expression): boolean {
  if (isLiteral(typescript, e) || typescript.isIdentifier(e)) return true;
  if (typescript.isArrowFunction(e) || typescript.isFunctionExpression(e)) return true;
  if (
    typescript.isParenthesizedExpression(e) ||
    typescript.isAsExpression(e) ||
    typescript.isSatisfiesExpression(e) ||
    typescript.isNonNullExpression(e) ||
    typescript.isTypeAssertionExpression(e)
  ) {
    return sideEffectFree(typescript, e.expression);
  }
  if (typescript.isTemplateExpression(e)) return e.templateSpans.every((s) => sideEffectFree(typescript, s.expression));
  if (typescript.isArrayLiteralExpression(e)) {
    return e.elements.every((el) => typescript.isOmittedExpression(el) || (!typescript.isSpreadElement(el) && sideEffectFree(typescript, el)));
  }
  if (typescript.isObjectLiteralExpression(e)) {
    const nameOk = (n: ts.PropertyName): boolean => !typescript.isComputedPropertyName(n) || isLiteral(typescript, n.expression);
    return e.properties.every((p) => {
      if (typescript.isPropertyAssignment(p)) return nameOk(p.name) && sideEffectFree(typescript, p.initializer);
      if (typescript.isShorthandPropertyAssignment(p)) return true;
      if (typescript.isMethodDeclaration(p) || typescript.isGetAccessorDeclaration(p) || typescript.isSetAccessorDeclaration(p)) {
        return nameOk(p.name);
      }
      return false; // spread
    });
  }
  return false;
}

// ---- text edits ----

type Span = { start: number; end: number };

const isBlank = (s: string): boolean => /^[ \t\r]*$/.test(s);

/** Where `node` starts once the doc comments (JSDoc) directly above it count as part of it. */
function docStart(typescript: typeof ts, sf: ts.SourceFile, node: ts.Node): number {
  const text = sf.text;
  let start = node.getStart(sf);
  const ranges = typescript.getLeadingCommentRanges(text, node.pos) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i] as ts.CommentRange;
    const ownLine = isBlank(text.slice(text.lastIndexOf("\n", r.pos - 1) + 1, r.pos));
    if (!text.startsWith("/**", r.pos) || !ownLine || /\n[ \t]*\r?\n/.test(text.slice(r.end, start))) break;
    start = r.pos;
  }
  return start;
}

/** Start of the line holding `at`. */
const lineStartOf = (text: string, at: number): number => text.lastIndexOf("\n", at - 1) + 1;

/** The span to cut to remove a whole statement, leaving no blank-line debris. */
function statementSpan(typescript: typeof ts, sf: ts.SourceFile, stmt: ts.Statement): Span {
  const text = sf.text;
  const start = docStart(typescript, sf, stmt);
  const end = stmt.getEnd();
  const lineStart = lineStartOf(text, start);
  const own = isBlank(text.slice(lineStart, start));
  const nl = text.indexOf("\n", end);
  const lineEnd = nl === -1 ? text.length : nl + 1;
  const rest = text.slice(end, nl === -1 ? text.length : nl);
  const restBlank = /^[ \t\r]*(\/\/.*)?$/.test(rest);
  const spacesAfter = (at: number): number => at + (/^[ \t]*/.exec(text.slice(at)) as RegExpExecArray)[0].length;
  if (!own) {
    // Shares its line with other code: cut just the statement and the gap next to it.
    if (restBlank) return { start: start - (/[ \t]*$/.exec(text.slice(lineStart, start)) as RegExpExecArray)[0].length, end };
    return { start, end: spacesAfter(end) };
  }
  if (!restBlank) return { start, end: spacesAfter(end) };

  let a = lineStart;
  let b = lineEnd;
  // The line that ends just before `at`, without its newline.
  const lineBefore = (at: number): string => text.slice(lineStartOf(text, at - 1), at - 1);
  const prevBlank = a === 0 || isBlank(lineBefore(a));
  const prevOpens = a === 0 || /\{[ \t\r]*$/.test(lineBefore(a));
  const nextBlank = b < text.length && isBlank(text.slice(b, text.indexOf("\n", b) === -1 ? text.length : text.indexOf("\n", b)));
  const nextCloses = b >= text.length || /^[ \t]*\}/.test(text.slice(b));
  if (nextBlank && (prevBlank || prevOpens)) {
    while (b < text.length) {
      const e = text.indexOf("\n", b);
      if (!isBlank(text.slice(b, e === -1 ? text.length : e))) break;
      b = e === -1 ? text.length : e + 1;
    }
  } else if (prevBlank && a > 0 && nextCloses) {
    while (a > 1 && isBlank(lineBefore(a))) a = lineStartOf(text, a - 1);
  }
  return { start: a, end: b };
}

/** Removes `items[index]` from a comma-separated list: with the comma after it when first, else the one before. */
function listItemSpan(sf: ts.SourceFile, items: readonly ts.Node[], index: number): Span {
  const item = items[index] as ts.Node;
  if (index === 0) return { start: item.getStart(sf), end: (items[1] as ts.Node).getStart(sf) };
  return { start: (items[index - 1] as ts.Node).getEnd(), end: item.getEnd() };
}

// ---- the action ----

type Plan = { span: Span; newText: string; whole: boolean };

export const removeUnusedVariableAction: Action<RemoveUnusedVariableParams, TsEngine> = {
  id: "typescript-remove-unused-variable",
  kind: "refactor",
  summary: "Removes the unused variable or destructured element at a position.",
  flags: [],
  parseParams(raw) {
    return parseAt(required(raw, "at"));
  },
  describe: (p) => atText(p.path, p),

  async run(engine, p) {
    const typescript = engine.ts;
    const file = engine.relPath(p.path);
    const { program, sf } = engine.sourceFile(file);
    const checker = program.getTypeChecker();
    const at = atText(file, p);

    // The names declared by variables, bindings and parameters.
    const candidates: ts.Identifier[] = [];
    const collect = (n: ts.Node): void => {
      if (
        (typescript.isVariableDeclaration(n) || typescript.isBindingElement(n) || typescript.isParameter(n)) &&
        typescript.isIdentifier(n.name)
      ) {
        candidates.push(n.name);
      }
      typescript.forEachChild(n, collect);
    };
    collect(sf);
    // A column just after the name still counts as being on it.
    const id = findAt(
      sf,
      file,
      p,
      candidates.map((c) => ({ item: c, start: c.getStart(sf), end: c.getEnd() + 1, label: c.text })),
      {
        what: "variable name",
        plural: "variable names",
        hint: `Point --at at the name of the variable to remove: ${file}:<line>[:<column>], 1-based.`,
      },
    );
    const name = id.text;
    const target = id.parent as ts.VariableDeclaration | ts.BindingElement | ts.ParameterDeclaration;

    // Which declaration this is.
    let root: ts.Node = target;
    while (typescript.isBindingElement(root) || typescript.isObjectBindingPattern(root) || typescript.isArrayBindingPattern(root)) {
      root = root.parent;
    }
    if (typescript.isParameter(root)) {
      unavailable(`\`${name}\` is a parameter of a function (${at}). Parameters are not removed by this action; remove it from the function's signature and its callers by hand.`);
    }
    const declarator = root as ts.VariableDeclaration;
    const list = declarator.parent;
    if (typescript.isCatchClause(list)) {
      unavailable(`\`${name}\` is the binding of a catch clause (${at}). Remove the binding from the clause by hand (\`catch {\`).`);
    }
    const stmt = list.parent;
    if (!typescript.isVariableStatement(stmt)) {
      unavailable(`\`${name}\` is declared in a for loop header (${at}). Loop variables are not removed by this action; restructure the loop first.`);
    }
    const statement = stmt as ts.VariableStatement;
    if (list.flags & typescript.NodeFlags.Using) {
      unavailable(`\`${name}\` is a \`using\` declaration (${at}); removing it would drop its disposal. Remove it by hand.`);
    }
    const exported = statement.modifiers?.some((m) => m.kind === typescript.SyntaxKind.ExportKeyword);
    // `declare` on the statement or on a namespace around it.
    let ambient = sf.isDeclarationFile;
    for (let n: ts.Node = statement; !typescript.isSourceFile(n); n = n.parent) {
      if (typescript.canHaveModifiers(n) && typescript.getModifiers(n)?.some((m) => m.kind === typescript.SyntaxKind.DeclareKeyword)) {
        ambient = true;
      }
    }
    if (exported || ambient) {
      unavailable(`\`${name}\` is exported or ambient (${at}), so other files can see it. Remove it by hand after checking its users.`);
    }
    const container = statement.parent;
    if (typescript.isSourceFile(container)) {
      if (!typescript.isExternalModule(container)) {
        unavailable(`\`${name}\` is a global of the script ${file} (${at}); other files can see it. Make ${file} a module or remove it by hand.`);
      }
    } else if (
      !typescript.isBlock(container) &&
      !typescript.isModuleBlock(container) &&
      !typescript.isCaseClause(container) &&
      !typescript.isDefaultClause(container)
    ) {
      unavailable(`\`${name}\` is the only statement of a larger statement (${at}), so removing it would leave that statement without a body. Wrap it in braces first, then run again.`);
    }

    // References: anything else in the file that resolves to this variable, or exports the name.
    const symbol = checker.getSymbolAtLocation(id);
    if (!symbol) unavailable(`TypeScript does not know \`${name}\` at ${at}. Fix the errors in ${file} first, then run again.`);
    const uses: ts.Node[] = [];
    const visit = (n: ts.Node): void => {
      if (typescript.isIdentifier(n) && n !== id && n.text === name) {
        const parent = n.parent;
        const exports = typescript.isExportSpecifier(parent) && !parent.parent.parent.moduleSpecifier && (parent.propertyName ?? parent.name) === n;
        const resolved =
          typescript.isShorthandPropertyAssignment(parent) && parent.name === n
            ? checker.getShorthandAssignmentValueSymbol(parent)
            : checker.getSymbolAtLocation(n);
        if (exports || resolved === symbol) uses.push(n);
      }
      typescript.forEachChild(n, visit);
    };
    visit(sf);
    if (uses.length > 0) {
      const places = uses.slice(0, 3).map((u) => `${file}:${engine.location(u).line}`);
      unavailable(
        `\`${name}\` is still referenced (or redeclared, or exported by name) at ${places.join(", ")}${uses.length > 3 ? ` and ${uses.length - 3} more` : ""}. ` +
          `Remove or inline those uses first, then run again.`,
      );
    }

    // The edit.
    const sideEffects = (what: string, e: ts.Expression | undefined): void => {
      if (e && !sideEffectFree(typescript, e)) {
        unavailable(
          `${what} of \`${name}\` (${at}) may have side effects, and removing it would drop them. ` +
            `Only literals, identifiers, functions and object, array or template literals built from those are removed. ` +
            `Move the expression into its own statement first, then run again.`,
        );
      }
    };
    const element = typescript.isBindingElement(target) ? target : null;
    let wholeDeclarator = element === null;
    let plan: Plan | null = null;
    if (element) {
      sideEffects("The default value", element.initializer);
      if (element.propertyName && typescript.isComputedPropertyName(element.propertyName)) {
        sideEffects("The computed key", element.propertyName.expression);
      }
      const pattern = element.parent;
      const real = pattern.elements.filter(typescript.isBindingElement);
      // Note: dropping the sole element of an object pattern also drops a possible getter call and the
      // TypeError for a null/undefined source; this is accepted and not checked.
      if (real.length === 1) {
        if (pattern.parent !== declarator) {
          unavailable(`\`${name}\` is the only element of a nested pattern (${at}); removing it would leave an empty pattern. Point --at at the enclosing element's name, or edit the pattern by hand.`);
        }
        wholeDeclarator = true;
      } else if (typescript.isObjectBindingPattern(pattern)) {
        const index = pattern.elements.indexOf(element);
        if (!element.dotDotDotToken && pattern.elements.slice(index + 1).some((e) => e.dotDotDotToken)) {
          unavailable(`\`${name}\` (${at}) sits before a \`...rest\` element that would then pick up that property. Remove or rename the rest element first, then run again.`);
        }
        plan = { span: listItemSpan(sf, pattern.elements, index), newText: "", whole: false };
      } else {
        const last = real[real.length - 1] === element;
        if (last) {
          // Dropping the tail element makes the pattern stop iterating sooner, which skips `next()` calls.
          const source = declarator.name === pattern ? declarator.initializer : undefined;
          if (!(source && typescript.isArrayLiteralExpression(source))) {
            unavailable(`Removing \`${name}\` (${at}) would drop the destructuring of an iterable, which can run code. Keep the pattern and rename the element to something unused by hand.`);
          }
          const before = real[real.length - 2] as ts.Node;
          plan = { span: { start: before.getEnd(), end: element.getEnd() }, newText: "", whole: false };
        } else {
          // A hole keeps the position of the elements after it.
          plan = { span: { start: element.getStart(sf), end: element.getEnd() }, newText: "", whole: false };
        }
      }
    }
    if (wholeDeclarator) {
      const init = declarator.initializer;
      sideEffects("The initializer", init);
      if (element && typescript.isArrayBindingPattern(declarator.name) && !(init && typescript.isArrayLiteralExpression(init))) {
        unavailable(`Removing \`${name}\` (${at}) would drop the destructuring of an iterable, which can run code. Keep the pattern and rename the element to something unused by hand.`);
      }
      const declarations = list.declarations;
      if (declarations.length === 1) {
        plan = { span: statementSpan(typescript, sf, statement), newText: "", whole: true };
      } else {
        plan = { span: listItemSpan(sf, declarations, declarations.indexOf(declarator)), newText: "", whole: false };
      }
    }
    const { span, newText } = plan as Plan;

    // The declaration the variable is in, named before anything changes.
    const owner = engine.declarationPath(statement.parent);
    const keyword =
      list.flags & typescript.NodeFlags.Const ? "const" : list.flags & typescript.NodeFlags.Let ? "let" : "var";

    const before = diagnostics(engine, file);
    const text = sf.text;
    engine.write(file, text.slice(0, span.start) + newText + text.slice(span.end));
    const errors = introduced(before, diagnostics(engine, file));
    if (errors.length > 0) {
      unavailable(
        `Removing \`${name}\` (${at}) would introduce errors: ${errors.join("; ")}. ` +
          `Fix them or remove the variable by hand.`,
      );
    }
    const what = element ? `destructured ${keyword}` : keyword;
    return {
      summary: `Removed the unused ${what} \`${name}\` from \`${owner}\`.`,
    };
  },
};
