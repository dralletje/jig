import { RefactorError, plural } from "@jig/core";
import type { Action, Decl } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { byString, diagnostics, introduced, required, unavailable } from "./shared.ts";

/**
 * typescript-params-to-object: a top-level function's positional parameters become one destructured
 * object parameter, and every call passes an object. TypeScript's "Convert parameters to destructured
 * object" does the edits; this action refuses what that refactor cannot rewrite safely.
 */

const REFACTOR = "Convert parameters to destructured object";

export type ParamsToObjectParams = { file: string; symbol: string };

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** The innermost identifier starting at `pos`. */
function identifierAt(engine: TsEngine, sf: ts.SourceFile, pos: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (n: ts.Node): void => {
    if (pos < n.getStart(sf) || pos >= n.getEnd()) return;
    if (engine.ts.isIdentifier(n) && n.getStart(sf) === pos) found = n;
    else engine.ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The function `decl` declares: a function declaration, or a `const` holding an arrow or function expression. */
function functionOf(engine: TsEngine, decl: Decl): FunctionLike {
  const t = engine.ts;
  const node = engine.declarationNode(decl);
  if (t.isFunctionDeclaration(node)) return node;
  if (t.isVariableDeclaration(node) && node.initializer) {
    let init = node.initializer;
    while (t.isParenthesizedExpression(init) || t.isAsExpression(init) || t.isSatisfiesExpression(init)) init = init.expression;
    if (t.isArrowFunction(init) || t.isFunctionExpression(init)) return init;
  }
  return unavailable(
    `${decl.name} in ${decl.file} is not a function declaration or a const arrow function, so it has no parameters to convert. Pass the name of a function.`,
  );
}

/** Where `symbol` is declared and every use of it, as `identifier` nodes (imports of it left out). */
function usesOf(engine: TsEngine, decl: Decl): ts.Identifier[] {
  const t = engine.ts;
  const abs = engine.absPath(decl.file);
  const refs = engine.project(decl.file).service.getReferencesAtPosition(abs, decl.nameStart) ?? [];
  const out: ts.Identifier[] = [];
  for (const ref of refs) {
    const { sf } = engine.sourceFile(ref.fileName);
    const id = identifierAt(engine, sf, ref.textSpan.start);
    if (!id) continue;
    const parent = id.parent;
    // The declaration itself, and the import that brings the function into a file, are not uses.
    if (id.getStart(sf) === decl.nameStart && engine.relPath(ref.fileName) === decl.file) continue;
    if (t.isImportSpecifier(parent) || t.isImportClause(parent)) continue;
    // A local `export { f }` keeps pointing at the function; TypeScript's refactor leaves it alone. (`export { f } from "m"` is another module's f.)
    if (t.isExportSpecifier(parent) && !parent.parent.parent.moduleSpecifier) continue;
    out.push(id);
  }
  return out;
}

/** Whether the use is `f(...)` or `ns.f(...)` (the name being the callee). */
function isCall(t: typeof ts, id: ts.Identifier): boolean {
  let callee: ts.Node = id;
  if (t.isPropertyAccessExpression(id.parent) && id.parent.name === id) callee = id.parent;
  return t.isCallExpression(callee.parent) && callee.parent.expression === callee;
}

function describeUse(engine: TsEngine, id: ts.Identifier): string {
  const { path, line } = engine.location(id);
  return `${path}:${line}`;
}

export const paramsToObjectAction: Action<ParamsToObjectParams, TsEngine> = {
  id: "typescript-params-to-object",
  kind: "refactor",
  summary: "Turns a top-level function's positional parameters into one destructured object, at every call too.",
  flags: [],
  parseParams(raw) {
    return { file: required(raw, "file"), symbol: required(raw, "symbol") };
  },
  describe: (p) => `${p.symbol} in ${p.file}`,

  async run(engine, p) {
    const file = engine.relPath(p.file);
    let decl: Decl;
    try {
      decl = engine.findTopLevel(file, p.symbol, "function");
    } catch (e) {
      if (!(e instanceof RefactorError) || e.code !== "SYMBOL_NOT_FOUND") throw e;
      decl = engine.findTopLevel(file, p.symbol, "variable");
    }
    const { sf } = engine.sourceFile(file);
    const fn = functionOf(engine, decl);

    const overloads = sf.statements.filter((s) => engine.ts.isFunctionDeclaration(s) && s.name?.text === p.symbol);
    if (overloads.length > 1) {
      unavailable(
        `\`${p.symbol}\` in ${file} is overloaded (${overloads.length} declarations), and TypeScript cannot convert an overload list. ` +
          `Merge the overloads into one signature (optional or union-typed parameters), then run again.`,
      );
    }
    if (fn.parameters.length === 0) {
      unavailable(`\`${p.symbol}\` in ${file} has no parameters to convert. Pass a function with at least one parameter.`);
    }
    if (fn.parameters.some((param) => param.dotDotDotToken)) {
      unavailable(
        `\`${p.symbol}\` in ${file} has a rest parameter, which cannot become a property of an object without changing how it is called. ` +
          `Change the rest parameter into an array parameter and update its callers by hand, then run again.`,
      );
    }

    if (fn.parameters.some((param) => !engine.ts.isIdentifier(param.name))) {
      unavailable(
        `\`${p.symbol}\` in ${file} has a destructured parameter, and TypeScript's "${REFACTOR}" only converts parameters that are plain names. ` +
          `Replace each destructured parameter with a named one (and destructure it inside the function), then run again.`,
      );
    }

    const blocked = usesOf(engine, decl).filter((id) => !isCall(engine.ts, id));
    if (blocked.length > 0) {
      const where = blocked.map((id) => describeUse(engine, id)).sort(byString);
      unavailable(
        `\`${p.symbol}\` is used other than as a direct call (passed as a value, re-exported or otherwise referenced) at ${where.join(", ")}, ` +
          `and those uses cannot pass an object. Wrap each in an arrow function that calls \`${p.symbol}\` with the same arguments ` +
          `(for example \`(a, b) => ${p.symbol}(a, b)\`), then run again.`,
      );
    }

    const service = engine.project(file).service;
    // The refactor is offered inside the function (not on the name of a `const`): at its first parameter.
    const pos = (fn.parameters[0] as ts.ParameterDeclaration).getStart(sf);
    const offered = service
      .getApplicableRefactors(engine.absPath(file), pos, { allowTextChangesInNewFiles: true }, undefined, undefined, true)
      .some((r) => r.name === REFACTOR);
    const result = offered
      ? service.getEditsForRefactor(
          engine.absPath(file),
          engine.ts.getDefaultFormatCodeSettings("\n"),
          pos,
          REFACTOR,
          REFACTOR,
          { allowTextChangesInNewFiles: true },
        )
      : undefined;
    if (!result || result.edits.length === 0) {
      unavailable(
        `TypeScript's "${REFACTOR}" is not available for \`${p.symbol}\` in ${file}, usually because a call site cannot be rewritten ` +
          `(a spread argument, or an argument list that does not match the parameters). Make every call pass its arguments plainly, then run again.`,
      );
    }

    const paramNames = fn.parameters.map((param) => param.name.getText(sf));
    const calls = usesOf(engine, decl).length;
    const touched = [...new Set(result.edits.map((e) => engine.relPath(e.fileName)))].sort(byString);
    const before = new Map(touched.map((f) => [f, diagnostics(engine, f)]));
    engine.applyTextChanges(result.edits);
    for (const f of touched) {
      const errors = introduced(before.get(f) ?? [], diagnostics(engine, f));
      if (errors.length > 0) {
        unavailable(
          `Converting the parameters of \`${p.symbol}\` would introduce errors in ${f}: ${errors.join("; ")}. ` +
            `Fix the calls in that file by hand so they type-check, then run again.`,
        );
      }
    }

    return {
      summary:
        `Changed \`${p.symbol}\` in ${file} from ${plural(paramNames.length, "positional parameter")} (${paramNames.join(", ")}) ` +
        `to one destructured object parameter, and rewrote ${plural(calls, "call")} to pass an object.`,
    };
  },
};
