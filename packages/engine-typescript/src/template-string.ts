import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { PREFERENCES, atText, diagnostics, findAt, introduced, parseAt, required, unavailable } from "./shared.ts";
import type { At } from "./shared.ts";

export type TemplateStringParams = At;

const REFACTOR = "Convert to template string";

/** A `+` chain's top node: a `+` binary expression whose parent is not one (parentheses end a chain). */
function isChainTop(engine: TsEngine, node: ts.Node): node is ts.BinaryExpression {
  const t = engine.ts;
  return (
    t.isBinaryExpression(node) &&
    node.operatorToken.kind === t.SyntaxKind.PlusToken &&
    !(t.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === t.SyntaxKind.PlusToken)
  );
}

function chainTops(engine: TsEngine, sf: ts.SourceFile): ts.BinaryExpression[] {
  const out: ts.BinaryExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (isChainTop(engine, n)) out.push(n);
    engine.ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The `+` chain the position points at; a chain inside another candidate of its line belongs to the outer one. */
function chainAt(engine: TsEngine, at: TemplateStringParams): ts.BinaryExpression {
  const { sf } = engine.sourceFile(at.path);
  const file = engine.relPath(at.path);
  const candidates = chainTops(engine, sf).map((n) => ({ item: n, start: n.getStart(sf), end: n.getEnd() }));
  return findAt(sf, file, at, candidates, {
    what: "string concatenation (a + chain)",
    plural: "string concatenations (a + chain)",
    hint: 'Point --at at a "a" + b + "c" expression: the line where the chain starts, or a column inside it.',
    outermost: true,
  });
}

/** The operands of a `+` chain, left to right (a parenthesised group is one operand). */
function operands(engine: TsEngine, top: ts.BinaryExpression): ts.Expression[] {
  const t = engine.ts;
  const out: ts.Expression[] = [];
  const walk = (n: ts.Expression): void => {
    if (t.isBinaryExpression(n) && n.operatorToken.kind === t.SyntaxKind.PlusToken) {
      walk(n.left);
      walk(n.right);
    } else out.push(n);
  };
  walk(top);
  return out;
}

/** Whether `+` and a template literal convert this type the same way (primitives only; objects differ via `valueOf`). */
function isPrimitiveLike(engine: TsEngine, type: ts.Type): boolean {
  const f = engine.ts.TypeFlags;
  const ok = f.StringLike | f.NumberLike | f.BigIntLike | f.BooleanLike | f.Null | f.Undefined;
  if (type.isUnion()) return type.types.every((m) => isPrimitiveLike(engine, m));
  return (type.flags & ok) !== 0 && (type.flags & ~ok & ~f.EnumLiteral) === 0;
}

/** True when a comment sits between the operands or operators (it would end up inside `${}`). */
function hasCommentInChain(sf: ts.SourceFile, parts: ts.Expression[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as ts.Expression;
    const leading = i === 0 ? "" : sf.text.slice(part.pos, part.getStart(sf));
    const next = parts[i + 1];
    const after = next ? sf.text.slice(part.end, next.pos) : "";
    if (/\/[*/]/.test(leading) || /\/[*/]/.test(after)) return true;
  }
  return false;
}

export const templateStringAction: Action<TemplateStringParams, TsEngine> = {
  id: "typescript-template-string",
  kind: "refactor",
  summary: "Turns a + chain with a string literal into a template literal.",
  flags: [
    { name: "--at", type: "text", required: true, description: "A place in the chain, as <path>:<line>[:<column>] (1-based)." },
  ],
  parseParams(raw) {
    return parseAt(required(raw, "at"));
  },
  describe: (p) => atText(p.path, p),

  async run(engine, p) {
    const file = engine.relPath(p.path);
    const node = chainAt(engine, p);
    const where = atText(file, p);
    const owner = engine.declarationPath(node);
    const { sf } = engine.sourceFile(file);
    const start = node.getStart(sf);
    // The last `+`: its token's parent is the chain's top node, which is what TypeScript looks for.
    const pos = node.operatorToken.getStart(sf);
    const parts = operands(engine, node);
    if (hasCommentInChain(sf, parts)) {
      unavailable(
        `The concatenation at ${where} has a comment inside it, which would end up inside \${...}. Move the comment out of the expression, then run this again.`,
      );
    }
    const checker = engine.sourceFile(file).program.getTypeChecker();
    const odd = parts.filter((e) => !engine.ts.isStringLiteralLike(e) && !isPrimitiveLike(engine, checker.getTypeAtLocation(e)));
    if (odd.length > 0) {
      const names = odd.map((e) => `\`${e.getText(sf)}\` (${checker.typeToString(checker.getTypeAtLocation(e))})`).join(", ");
      unavailable(
        `The concatenation at ${where} has operands that are not string, number, bigint, boolean, null or undefined: ${names}. "+" converts objects with valueOf first and a template literal with toString, so the result could change. Convert those operands yourself (String(x)) or leave the concatenation as it is.`,
      );
    }
    const service = engine.project(file).service;
    const abs = engine.absPath(file);
    const range = { pos, end: pos };
    const offered = service
      .getApplicableRefactors(abs, range, PREFERENCES, undefined, undefined)
      .some((r) => r.name === REFACTOR && r.actions.some((a) => a.name === REFACTOR));
    if (!offered) {
      unavailable(
        `TypeScript does not offer "${REFACTOR}" at ${where}: it needs a + chain with at least one string literal. Point --at at such an expression.`,
      );
    }
    const edit = service.getEditsForRefactor(abs, engine.ts.getDefaultFormatCodeSettings("\n"), range, REFACTOR, REFACTOR, PREFERENCES);
    const changes = edit?.edits ?? [];
    if (changes.length === 0) unavailable(`TypeScript produced no edit for "${REFACTOR}" at ${where}. Leave this concatenation as it is.`);
    const before = diagnostics(engine, file);
    const source = sf.text.slice(start, node.getEnd());
    engine.applyTextChanges(changes);
    const errors = introduced(before, diagnostics(engine, file));
    if (errors.length > 0) {
      unavailable(`Converting the concatenation at ${where} would introduce errors: ${errors.join("; ")}. Leave it as it is.`);
    }
    const replaced = changes.flatMap((c) => c.textChanges).map((t) => t.newText);
    const shown = replaced.length === 1 && !source.includes("\n") && !(replaced[0] as string).includes("\n");
    return {
      summary:
        `Converted a string concatenation in ${owner} to a template literal` +
        (shown ? `: ${source} became ${replaced[0]}.` : "."),
    };
  },
};
