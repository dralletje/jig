import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { diagnostics, introduced, matchFiles, notHandled, unavailable, list as globList } from "./shared.ts";
import type { NotHandled } from "./shared.ts";

/**
 * typescript-remove-console: `console.<method>(…)` calls that are whole expression statements are
 * removed (default method: `log`). A call whose result is used (`const x = console.log(…)`, an arrow
 * body, a comma operand) is left and listed in the summary as not handled.
 *
 * Where the statement is the body of something that needs a body (`if (c) console.log(x)`, a loop):
 *  - an `if` with no `else` and a condition without side effects goes away whole;
 *  - otherwise the body becomes `{}`, so the condition (and the `else`) still run as before.
 *
 * Comments: a comment on the same line after the removed statement goes with it, and so does a line
 * that holds only the statement and block comments. Comments on lines of their own are kept.
 */

type Node = ts.Node;

/** One text edit: `[start, end)` replaced by `text` (empty for a deletion of lines or of the statement). */
type Edit = { start: number; end: number; text: string; kind: "delete" | "replace" };

const STATEMENT_LISTS = new Set(["Block", "SourceFile", "ModuleBlock", "CaseClause", "DefaultClause"]);

/** Whether evaluating `node` has no effect worth keeping (so a condition made of it may be dropped). */
function pure(t: TsEngine["ts"], node: ts.Expression): boolean {
  const k = t.SyntaxKind;
  if (
    t.isIdentifier(node) ||
    t.isStringLiteralLike(node) ||
    t.isNumericLiteral(node) ||
    node.kind === k.TrueKeyword ||
    node.kind === k.FalseKeyword ||
    node.kind === k.NullKeyword ||
    node.kind === k.ThisKeyword
  ) {
    return true;
  }
  if (t.isParenthesizedExpression(node) || t.isNonNullExpression(node) || t.isAsExpression(node)) {
    return pure(t, node.expression);
  }
  if (t.isTypeOfExpression(node)) return pure(t, node.expression);
  if (t.isPrefixUnaryExpression(node)) {
    return node.operator !== k.PlusPlusToken && node.operator !== k.MinusMinusToken && pure(t, node.operand);
  }
  // A property read could run a getter; conditions like `options.verbose` are what this is for.
  if (t.isPropertyAccessExpression(node)) return pure(t, node.expression);
  if (t.isElementAccessExpression(node)) return pure(t, node.expression) && pure(t, node.argumentExpression);
  if (t.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const effect =
      (op >= k.FirstAssignment && op <= k.LastAssignment) ||
      op === k.InstanceOfKeyword ||
      op === k.InKeyword ||
      op === k.CommaToken;
    return !effect && pure(t, node.left) && pure(t, node.right);
  }
  if (t.isConditionalExpression(node)) {
    return pure(t, node.condition) && pure(t, node.whenTrue) && pure(t, node.whenFalse);
  }
  return false;
}

/** `console.<method>(…)` for a method in `methods`, `console` being the global. */
function consoleMethod(
  engine: TsEngine,
  checker: ts.TypeChecker,
  node: Node,
  methods: Set<string>,
): { call: ts.CallExpression; method: string } | null {
  const t = engine.ts;
  if (!t.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!t.isPropertyAccessExpression(callee) || !t.isIdentifier(callee.expression)) return null;
  if (callee.expression.text !== "console" || !methods.has(callee.name.text)) return null;
  // A local or imported `console` is somebody's own object.
  const symbol = checker.getSymbolAtLocation(callee.expression);
  if (symbol?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) return null;
  return { call: node, method: callee.name.text };
}

function isStatement(t: TsEngine["ts"], call: ts.CallExpression): boolean {
  return t.isExpressionStatement(call.parent) && call.parent.expression === call;
}

/** All matching calls of the file, in source order. */
function consoleCalls(
  engine: TsEngine,
  file: string,
  methods: Set<string>,
): { call: ts.CallExpression; method: string; statement: boolean }[] {
  const { program, sf } = engine.sourceFile(file);
  const checker = program.getTypeChecker();
  const out: { call: ts.CallExpression; method: string; statement: boolean }[] = [];
  const visit = (node: Node): void => {
    const found = consoleMethod(engine, checker, node, methods);
    if (found) out.push({ ...found, statement: isStatement(engine.ts, found.call) });
    engine.ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The statement to remove for an expression statement: grows to the `if` that only held it. */
function removable(engine: TsEngine, statement: Node): { node: Node; list: boolean } {
  const t = engine.ts;
  let node = statement;
  for (;;) {
    const parent = node.parent;
    if (STATEMENT_LISTS.has(t.SyntaxKind[parent.kind])) return { node, list: true };
    if (t.isIfStatement(parent) && parent.thenStatement === node && !parent.elseStatement && pure(t, parent.expression)) {
      node = parent;
      continue;
    }
    return { node, list: false };
  }
}

const HORIZONTAL = /[ \t\r]/;

type Span = { start: number; end: number; own: boolean };

/** The span to delete for one statement `[start, end)`: whole lines when nothing else is on them. */
function statementSpan(text: string, start: number, end: number): Span {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(lineStart, start);
  const skipSpace = (from: number): number => {
    let i = from;
    while (i < text.length && HORIZONTAL.test(text[i] ?? "")) i++;
    return i;
  };
  // After the statement: spaces and comments up to the end of the line.
  let i = skipSpace(end);
  for (;;) {
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) break;
      i = skipSpace(close + 2);
      continue;
    }
    break;
  }
  const atEol = i >= text.length || text[i] === "\n";
  const ownLine = /^\s*(\/\*.*?\*\/\s*)*$/.test(before);
  if (ownLine && atEol) return { start: lineStart, end: Math.min(i + 1, text.length), own: true };
  const rest = skipSpace(end);
  if (text.startsWith("//", rest) || text.startsWith("/*", rest) || rest >= text.length || text[rest] === "\n") {
    // The statement ends its line, after other code: the code stays, the space before goes.
    let s = start;
    while (s > lineStart && HORIZONTAL.test(text[s - 1] ?? "")) s--;
    return { start: s, end, own: false };
  }
  // Other code follows on the line.
  return { start, end: rest, own: false };
}

/** A removed run of whole lines: no stray blank lines are left, doubled or just inside a `{` or `}`. */
function trimBlank(text: string, span: Span): Span {
  let a = span.start;
  let b = span.end;
  const prevStart = a === 0 ? 0 : text.lastIndexOf("\n", a - 2) + 1;
  const prevLine = a === 0 ? "" : text.slice(prevStart, a - 1);
  const nextEnd = text.indexOf("\n", b);
  const nextLine = text.slice(b, nextEnd < 0 ? text.length : nextEnd);
  const nextBlank = b < text.length && nextLine.trim() === "";
  const nextClose = b >= text.length || nextLine.trim().startsWith("}");
  if (a > 0 && prevLine.trim() === "" && (nextBlank || nextClose)) {
    a = prevStart;
  } else if ((a === 0 || prevLine.trimEnd().endsWith("{")) && nextBlank) {
    b = nextEnd < 0 ? text.length : nextEnd + 1;
  }
  return { start: a, end: b, own: true };
}

/** The distinct, non-overlapping edits of one file's removals, largest offsets first. */
function planEdits(engine: TsEngine, text: string, statements: Node[]): Edit[] {
  const sf = statements[0]?.getSourceFile();
  const nodes = statements.map((statement) => {
    const { node, list } = removable(engine, statement);
    return { list, start: node.getStart(sf), end: node.getEnd() };
  });
  nodes.sort((a, b) => a.start - b.start || b.end - a.end);
  const distinct: typeof nodes = [];
  for (const n of nodes) {
    const last = distinct.at(-1);
    if (last && n.start < last.end) continue; // inside (or the same as) the one before
    distinct.push(n);
  }
  // Spans are planned on the original text; runs of whole-line deletions that touch or are only
  // separated by blank lines become one span, so no two edits can share (and fight over) a blank line.
  const edits: Edit[] = [];
  let run: Span | null = null;
  const flush = (): void => {
    if (run) {
      const s = trimBlank(text, run);
      edits.push({ start: s.start, end: s.end, text: "", kind: "delete" });
      run = null;
    }
  };
  for (const n of distinct) {
    if (!n.list) {
      flush();
      edits.push({ start: n.start, end: n.end, text: "{}", kind: "replace" });
      continue;
    }
    const span = statementSpan(text, n.start, n.end);
    if (!span.own) {
      flush();
      edits.push({ start: span.start, end: span.end, text: "", kind: "delete" });
    } else if (run && text.slice((run as Span).end, span.start).trim() === "") {
      (run as Span).end = span.end;
    } else {
      flush();
      run = span;
    }
  }
  flush();
  // Edits of different kinds on one line cannot touch, but a trimmed run may have grown to meet its
  // neighbour: join whatever overlaps, so every planned removal is applied.
  edits.sort((a, b) => a.start - b.start);
  const joined: Edit[] = [];
  for (const e of edits) {
    const last = joined.at(-1);
    if (last && e.start < last.end) last.end = Math.max(last.end, e.end);
    else joined.push({ ...e });
  }
  // Every statement of a line removed: the line goes too, instead of staying behind as only spaces.
  for (const e of joined) {
    if (e.kind !== "delete") continue;
    const lineStart = text.lastIndexOf("\n", e.start - 1) + 1;
    if (lineStart === e.start || !/^[ \t]*$/.test(text.slice(lineStart, e.start))) continue;
    const nl = text.indexOf("\n", e.end);
    const lineEnd = nl < 0 ? text.length : nl;
    if (!/^[ \t\r]*$/.test(text.slice(e.end, lineEnd))) continue;
    e.start = lineStart;
    e.end = nl < 0 ? text.length : nl + 1;
  }
  return joined.reverse();
}

// ---- the action ----

export type RemoveConsoleParams = { files: string[]; methods: string[] };

export const removeConsoleAction: Action<RemoveConsoleParams, TsEngine> = {
  id: "typescript-remove-console",
  kind: "rewrite",
  summary: "Removes console.<method>(...) statements.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files to remove the calls from, as comma-separated globs from the repo root." },
    { name: "--methods", type: "text", required: false, description: "The console methods, comma-separated (log,debug). Default log." },
  ],
  parseParams: (raw) => {
    const methods = raw.methods === undefined ? ["log"] : globList(raw, "methods");
    for (const m of methods) {
      if (!/^[A-Za-z_$][\w$]*$/.test(m)) {
        throw new RefactorError("INVALID_ARGS", `--methods: ${JSON.stringify(m)} is not a method name. Pass for example --methods log,debug.`);
      }
    }
    return { files: globList(raw, "files"), methods: [...new Set(methods)] };
  },
  describe: (p) => `${p.methods.map((m) => `console.${m}`).join(", ")} in ${p.files.join(", ")}`,

  async run(engine, p) {
    const methods = new Set(p.methods);
    const planned: { file: string; edits: Edit[]; before: string[] }[] = [];
    let removed = 0;

    // Plan everything before writing.
    const files = await matchFiles(engine.repoRoot, p.files);
    for (const file of files) {
      const calls = consoleCalls(engine, file, methods).filter((c) => c.statement);
      if (calls.length === 0) continue;
      const text = engine.read(file) ?? "";
      const edits = planEdits(engine, text, calls.map((c) => c.call.parent));
      planned.push({ file, edits, before: diagnostics(engine, file) });
      removed += calls.length;
    }

    for (const { file, edits } of planned) {
      let text = engine.read(file) ?? "";
      for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
      engine.write(file, text);
    }
    for (const { file, before } of planned) {
      const errors = introduced(before, diagnostics(engine, file));
      if (errors.length > 0) {
        unavailable(
          `Removing the console calls of ${file} would introduce errors: ${errors.join("; ")}. Fix that file by hand ` +
            `or leave it out of --files, then run again.`,
        );
      }
    }

    // What is left, read from the files as they are now: positions in the result tree.
    const misses: NotHandled[] = [];
    for (const file of files) {
      const left = consoleCalls(engine, file, methods).filter((c) => !c.statement);
      for (const { call, method } of left) {
        const { path, line } = engine.location(call);
        misses.push({
          path,
          line,
          reason: `console.${method}(…) is used as a value here, so it was left`,
          instructions:
            `Its result is used, so deleting the call would change the code around it.\n` +
            `Rewrite that code by hand, then remove the call.`,
        });
      }
    }

    if (removed === 0) {
      throw new RefactorError(
        "NO_CHANGES",
        misses.length === 0
          ? `No ${p.methods.map((m) => `console.${m}`).join(" or ")} statement in the files matching ${p.files.join(", ")}.`
          : `The ${plural(misses.length, "console call")} in the files matching ${p.files.join(", ")} ${misses.length === 1 ? "is" : "are"} all used as values, so none was removed:\n` +
            `${misses.map((m) => `  ${m.path}:${m.line}: ${m.reason}`).join("\n")}\n` +
            `Rewrite that code by hand, then remove the calls.`,
      );
    }

    const paths = engine.changes().map((c) => c.path);
    return {
      summary:
        `Removed ${plural(removed, "console call")} from ${plural(paths.length, "file")}` +
        (misses.length > 0
          ? `, and left ${plural(misses.length, "call")} used as ${misses.length === 1 ? "a value" : "values"}`
          : "") +
        `:\n${listLines(paths)}` +
        (misses.length > 0 ? `\n\n${notHandled(misses)}` : ""),
    };
  },
};
