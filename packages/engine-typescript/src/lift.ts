import { RefactorError } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import { extractAction } from "./actions.ts";
import type { TsEngine } from "./engine.ts";
import { names, required } from "./shared.ts";

export type LiftParams = { file: string; in: string; symbol: string; to?: string };

function unavailable(instructions: string): RefactorError {
  return new RefactorError("REFACTOR_UNAVAILABLE", instructions);
}

/** The statement to move and the node whose free variables matter. */
type Liftable = { statement: ts.Statement; body: ts.Node };

/** Nested declarations named `name` inside `outer` (any depth). */
function findNested(typescript: typeof ts, outer: ts.Node, name: string): Liftable[] {
  const found: Liftable[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== outer && typescript.isFunctionDeclaration(node) && node.name?.text === name) {
      found.push({ statement: node, body: node });
    } else if (typescript.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (typescript.isIdentifier(d.name) && d.name.text === name) found.push({ statement: node, body: d });
      }
    }
    typescript.forEachChild(node, visit);
  };
  typescript.forEachChild(outer, visit);
  return found;
}

function isLiteral(typescript: typeof ts, e: ts.Expression): boolean {
  return (
    typescript.isStringLiteral(e) ||
    typescript.isNumericLiteral(e) ||
    typescript.isNoSubstitutionTemplateLiteral(e) ||
    typescript.isBigIntLiteral(e) ||
    e.kind === typescript.SyntaxKind.TrueKeyword ||
    e.kind === typescript.SyntaxKind.FalseKeyword ||
    e.kind === typescript.SyntaxKind.NullKeyword ||
    (typescript.isPrefixUnaryExpression(e) && typescript.isNumericLiteral(e.operand))
  );
}

/** Why moving this to module level would change its meaning or timing, or null if it would not. */
function movableProblem(typescript: typeof ts, lift: Liftable): string | null {
  const symbol = nameOf(lift);
  const stmt = lift.statement;
  if (typescript.isFunctionDeclaration(stmt)) return null;
  if (!typescript.isVariableStatement(stmt)) return `${symbol} is not a function or const`;
  if (!(stmt.declarationList.flags & typescript.NodeFlags.Const)) return `${symbol} is not a const`;
  if (stmt.declarationList.declarations.length !== 1) {
    return `${symbol} is declared together with other variables; split the declaration first`;
  }
  const init = (lift.body as ts.VariableDeclaration).initializer;
  const ok =
    init !== undefined &&
    (typescript.isArrowFunction(init) || typescript.isFunctionExpression(init) || isLiteral(typescript, init));
  return ok ? null : `${symbol}'s initializer may have side effects; only functions and literals are lifted`;
}

const inside = (n: ts.Node, container: ts.Node): boolean => n.pos >= container.pos && n.end <= container.end;

/** What `lift` uses from `outer`'s local scope: declarations, or `null` for `this`/`arguments`. */
function captures(
  typescript: typeof ts,
  checker: ts.TypeChecker,
  outer: ts.Node,
  lift: Liftable,
): { name: string; decl: ts.Declaration | null }[] {
  const out = new Map<string, ts.Declaration | null>();
  const isArrow = typescript.isVariableStatement(lift.statement);
  const visit = (node: ts.Node, inOwnFunction: boolean): void => {
    if (isArrow && !inOwnFunction && node.kind === typescript.SyntaxKind.ThisKeyword) out.set("this", null);
    if (typescript.isIdentifier(node)) {
      if (isArrow && !inOwnFunction && node.text === "arguments") out.set("arguments", null);
      const sym = checker.getSymbolAtLocation(node);
      for (const decl of sym?.declarations ?? []) {
        if (inside(decl, outer) && !inside(decl, lift.statement)) out.set(node.text, decl);
      }
    }
    const ownFunction =
      inOwnFunction ||
      typescript.isFunctionDeclaration(node) ||
      typescript.isFunctionExpression(node) ||
      typescript.isClassLike(node);
    typescript.forEachChild(node, (c) => visit(c, ownFunction));
  };
  visit(lift.body, false);
  return [...out].map(([name, decl]) => ({ name, decl }));
}

/** The statement that declares `decl`, if it is a kind we can move at all. */
function liftableOf(typescript: typeof ts, decl: ts.Declaration): Liftable | null {
  if (typescript.isFunctionDeclaration(decl)) return { statement: decl, body: decl };
  if (
    typescript.isVariableDeclaration(decl) &&
    typescript.isVariableDeclarationList(decl.parent) &&
    typescript.isVariableStatement(decl.parent.parent)
  ) {
    return { statement: decl.parent.parent, body: decl };
  }
  return null;
}

function nameOf(lift: Liftable): string {
  const name = (lift.body as ts.FunctionDeclaration | ts.VariableDeclaration).name;
  return name && "text" in name ? name.text : "?";
}

/**
 * `root` plus everything it uses from `outer`, transitively, in source order.
 * Throws with `details.captured` listing what it uses but cannot be moved (parameters, `let`, side effects, …).
 */
function closure(typescript: typeof ts, checker: ts.TypeChecker, outer: ts.Node, root: Liftable, inName: string): Liftable[] {
  const moved = new Map<ts.Statement, Liftable>([[root.statement, root]]);
  const stuck = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const item = queue.shift() as Liftable;
    for (const { name, decl } of captures(typescript, checker, outer, item)) {
      const dep = decl ? liftableOf(typescript, decl) : null;
      if (!dep || inside(root.statement, dep.statement) || movableProblem(typescript, dep) !== null) {
        stuck.add(name);
      } else if (!moved.has(dep.statement)) {
        moved.set(dep.statement, dep);
        queue.push(dep);
      }
    }
  }
  if (stuck.size > 0) {
    const captured = [...stuck].sort();
    throw unavailable(
      `${nameOf(root)} uses ${captured.join(", ")} from ${inName}, which cannot be moved (parameters, let/var, ` +
        `this/arguments in arrow functions, consts with side effects). Pass ${captured.join(", ")} to ` +
        `${nameOf(root)} as parameters first, then run again.`,
    );
  }
  return [...moved.values()].sort((a, b) => a.statement.pos - b.statement.pos);
}

/**
 * Where `node` starts once the comments directly above it are counted as part of it (its JSDoc, say):
 * each on a line of its own, with no blank line between them and the node.
 */
export function attachedStart(typescript: typeof ts, sf: ts.SourceFile, node: ts.Node): number {
  const text = sf.text;
  let start = node.getStart(sf);
  const ranges = typescript.getLeadingCommentRanges(text, node.pos) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i] as ts.CommentRange;
    const ownLine = /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", r.pos - 1) + 1, r.pos));
    if (!ownLine || /\n[ \t]*\r?\n/.test(text.slice(r.end, start))) break;
    start = r.pos;
  }
  return start;
}

/** Start of the statement's first line (if only indentation precedes it) through its trailing newline. */
export function lineSpan(text: string, start: number, end: number): { start: number; end: number; indent: string } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const indent = text.slice(lineStart, start);
  const from = /^[ \t]*$/.test(indent) ? lineStart : start;
  const nl = text.indexOf("\n", end);
  const to = nl !== -1 && /^[ \t]*$/.test(text.slice(end, nl)) ? nl + 1 : end;
  return { start: from, end: to, indent: from === lineStart ? indent : "" };
}

function dedent(block: string, indent: string): string {
  return block
    .split("\n")
    .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
    .join("\n");
}

export const liftOutAction: Action<LiftParams, TsEngine> = {
  id: "lift-out",
  kind: "refactor",
  summary: "Lifts a nested function or const to module level, with the locals it uses.",
  flags: [
    { name: "--file", type: "path", required: true, description: "The file the nested declaration is in." },
    { name: "--in", type: "text", required: true, description: "The top-level function it is nested in." },
    { name: "--symbol", type: "text", required: true, description: "The nested function or const to lift out." },
    { name: "--to", type: "path", required: false, description: "Another file to move it to, the way extract does. Without it, it stays in --file at module level." },
  ],
  parseParams(raw) {
    return {
      file: required(raw, "file"),
      in: required(raw, "in"),
      symbol: required(raw, "symbol"),
      ...(raw.to ? { to: raw.to } : {}),
    };
  },
  describe: (p) => `${p.in} › ${p.symbol} → ${p.to ?? "module level"} in ${p.file}`,

  async run(engine, p) {
    const typescript = engine.ts;
    const outerDecl = engine.findTopLevel(p.file, p.in);
    const { program, sf } = engine.sourceFile(p.file);
    const checker = program.getTypeChecker();
    const outer = sf.statements.find((s) => s.getStart(sf) === outerDecl.start);
    if (!outer) throw unavailable(`Cannot locate ${p.in} in ${p.file}.`);

    const matches = findNested(typescript, outer, p.symbol);
    if (matches.length === 0) {
      throw new RefactorError(
        "SYMBOL_NOT_FOUND",
        `There is no function or const ${p.symbol} nested inside ${p.in} in ${p.file}. Check --symbol and --in.`,
      );
    }
    if (matches.length > 1) {
      const lines = matches.map((m) => `${p.file}:${engine.location(m.statement).line}`);
      throw new RefactorError(
        "AMBIGUOUS_SYMBOL",
        `${p.symbol} is declared ${matches.length} times inside ${p.in} (${lines.join(", ")}). Rename all but one first, then run again.`,
      );
    }
    const lift = matches[0] as Liftable;
    const problem = movableProblem(typescript, lift);
    if (problem) throw unavailable(problem);

    // The symbol plus every local it uses (transitively), in source order.
    const moved = closure(typescript, checker, outer, lift, p.in);
    const atModule = new Set(
      checker.getSymbolsInScope(sf, typescript.SymbolFlags.Value | typescript.SymbolFlags.Type).map((s) => s.name),
    );
    const clashes = moved.map(nameOf).filter((n) => atModule.has(n));
    if (clashes.length > 0) {
      throw unavailable(
        `${clashes.join(", ")} already exist(s) at module level (or as a global) in ${p.file}. Rename the nested ` +
          `declaration first (rename only renames top-level ones, so by hand), then run again.`,
      );
    }
    const file = engine.relPath(p.file);

    const text = sf.text;
    const blocks: string[] = [];
    const removals: ts.TextChange[] = [];
    for (const item of moved) {
      // Each moved statement takes its own doc comment along.
      const start = attachedStart(typescript, sf, item.statement);
      const span = lineSpan(text, start, item.statement.getEnd());
      blocks.push(dedent(text.slice(start, item.statement.getEnd()), span.indent));
      removals.push({ span: { start: span.start, length: span.end - span.start }, newText: "" });
    }
    // Above the outer declaration's doc comment, so that comment stays on the declaration it describes.
    const insertAt = lineSpan(text, attachedStart(typescript, sf, outer), outer.getEnd()).start;
    engine.applyTextChanges([
      {
        fileName: p.file,
        textChanges: [{ span: { start: insertAt, length: 0 }, newText: `${blocks.join("\n\n")}\n\n` }, ...removals],
      },
    ]);

    const movedNames = moved.map(nameOf);
    const target = p.to ? engine.relPath(p.to) : file;
    if (p.to) await extractAction.run(engine, { file: p.file, symbols: movedNames, to: p.to });

    const others = movedNames.filter((n) => n !== p.symbol);
    const along = others.length > 0 ? `, together with ${names(others)}, which it uses` : "";
    return {
      summary: p.to
        ? `Lifted \`${p.symbol}\` out of \`${p.in}\` in ${file} and moved it to ${target}${along}.`
        : `Lifted \`${p.symbol}\` out of \`${p.in}\` to module level in ${file}${along}.`,
    };
  },
};
