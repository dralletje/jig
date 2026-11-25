import { RefactorError } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "../engine.ts";
import { attachedStart, lineSpan } from "../lift.ts";
import { diagnostics, introduced, names, required, unavailable } from "../shared.ts";

/**
 * How the call passes values in or gets them back: `a, b` (positional; for returns, one name only),
 * `{ a, b }` (one object) or `[a, b]` (one tuple). The names are checked against what the lines use,
 * never inferred.
 */
export type Shape = { kind: "positional" | "object" | "tuple"; names: string[] };

export type ExtractFunctionParams = {
  file: string;
  from: number;
  to: number;
  name: string;
  params: Shape;
  returns: Shape;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function parseLines(raw: string): { from: number; to: number } {
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw.trim());
  const from = Number(m?.[1]);
  const to = Number(m?.[2] ?? m?.[1]);
  if (!m || from < 1 || to < from) {
    throw new RefactorError("INVALID_ARGS", `--lines ${JSON.stringify(raw)} is not a line or a range of lines. Pass --lines 12 or --lines 12-20.`);
  }
  return { from, to };
}

function parseShape(raw: string, flag: string): Shape {
  const text = raw.trim();
  let kind: Shape["kind"] = "positional";
  let inner = text;
  if (text.startsWith("{") && text.endsWith("}")) {
    kind = "object";
    inner = text.slice(1, -1);
  } else if (text.startsWith("[") && text.endsWith("]")) {
    kind = "tuple";
    inner = text.slice(1, -1);
  }
  const list = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const bad = list.filter((n) => !IDENTIFIER.test(n));
  if (bad.length > 0) {
    throw new RefactorError(
      "INVALID_ARGS",
      `${flag} ${JSON.stringify(raw)} has ${names(bad)}, which are not plain names. Pass names separated by commas: "a, b", "{ a, b }" or "[a, b]".`,
    );
  }
  if (new Set(list).size !== list.length) {
    throw new RefactorError("INVALID_ARGS", `${flag} ${JSON.stringify(raw)} names a value twice.`);
  }
  return { kind, names: list };
}

function sameSet(a: string[], b: string[]): { missing: string[]; extra: string[] } {
  return { missing: b.filter((n) => !a.includes(n)), extra: a.filter((n) => !b.includes(n)) };
}

/** Whether `n` lies within `container`; positions of another file never do. */
const inside = (n: ts.Node, container: { pos: number; end: number }, sf: ts.SourceFile): boolean =>
  n.getSourceFile() === sf && n.pos >= container.pos && n.end <= container.end;

function isFunctionLike(typescript: typeof ts, n: ts.Node): boolean {
  return (
    typescript.isFunctionDeclaration(n) ||
    typescript.isFunctionExpression(n) ||
    typescript.isArrowFunction(n) ||
    typescript.isMethodDeclaration(n) ||
    typescript.isConstructorDeclaration(n) ||
    typescript.isGetAccessorDeclaration(n) ||
    typescript.isSetAccessorDeclaration(n)
  );
}

/** Whether `id` is written to: assigned (also inside a destructuring assignment), `++`/`--`, or a for-in/of target. */
function isWrite(typescript: typeof ts, id: ts.Identifier): boolean {
  let child: ts.Node = id;
  let parent = id.parent;
  while (
    typescript.isParenthesizedExpression(parent) ||
    typescript.isArrayLiteralExpression(parent) ||
    typescript.isObjectLiteralExpression(parent) ||
    typescript.isShorthandPropertyAssignment(parent) ||
    (typescript.isPropertyAssignment(parent) && parent.initializer === child) ||
    typescript.isSpreadElement(parent) ||
    typescript.isSpreadAssignment(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (typescript.isBinaryExpression(parent) && parent.left === child) {
    const op = parent.operatorToken.kind;
    return op >= typescript.SyntaxKind.FirstAssignment && op <= typescript.SyntaxKind.LastAssignment;
  }
  if (typescript.isPrefixUnaryExpression(parent) || typescript.isPostfixUnaryExpression(parent)) {
    return parent.operator === typescript.SyntaxKind.PlusPlusToken || parent.operator === typescript.SyntaxKind.MinusMinusToken;
  }
  if ((typescript.isForInStatement(parent) || typescript.isForOfStatement(parent)) && parent.initializer === child) return true;
  return false;
}

/** The value symbol an identifier refers to (for `{ a }` shorthand, the variable `a`, not the property). */
function valueSymbol(typescript: typeof ts, checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  if (typescript.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(id.parent);
  }
  return checker.getSymbolAtLocation(id);
}

/** The innermost block or case clause whose statements (not its braces) hold [start, end). */
function enclosingList(typescript: typeof ts, root: ts.Node, sf: ts.SourceFile, start: number, end: number): ts.Block | ts.CaseOrDefaultClause | null {
  let found: ts.Block | ts.CaseOrDefaultClause | null = null;
  const visit = (node: ts.Node): void => {
    if (typescript.isBlock(node)) {
      const open = node.getStart(sf) + 1;
      const close = node.getEnd() - 1;
      if (open <= start && end <= close) found = node;
    } else if (typescript.isCaseClause(node) || typescript.isDefaultClause(node)) {
      const first = node.statements[0];
      if (first && first.getStart(sf) <= start && end <= node.getEnd()) found = node;
    }
    typescript.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Whether `text` holds only whitespace and comments. */
function onlyTrivia(typescript: typeof ts, text: string): boolean {
  const scanner = typescript.createScanner(typescript.ScriptTarget.Latest, true, typescript.LanguageVariant.Standard, text);
  return scanner.scan() === typescript.SyntaxKind.EndOfFileToken;
}

/** The type to write for `sym`: its annotation as written when it has one, else the checker's. */
function typeText(typescript: typeof ts, checker: ts.TypeChecker, sym: ts.Symbol, sf: ts.SourceFile): string {
  const decl = sym.valueDeclaration;
  if (
    decl &&
    (typescript.isParameter(decl) || typescript.isVariableDeclaration(decl)) &&
    decl.type &&
    !(typescript.isParameter(decl) && decl.questionToken)
  ) {
    return decl.type.getText(sf);
  }
  const type = decl ? checker.getTypeOfSymbolAtLocation(sym, decl) : checker.getDeclaredTypeOfSymbol(sym);
  return checker.typeToString(type, decl, typescript.TypeFormatFlags.NoTruncation);
}

export const extractFunctionAction: Action<ExtractFunctionParams, TsEngine> = {
  id: "extract-function",
  kind: "refactor",
  summary: "Moves whole statements of a function into a new module-level function, with the parameters and return values you name.",
  flags: [
    { name: "--file", type: "path", required: true, description: "The file the statements are in." },
    { name: "--lines", type: "text", required: true, description: "The lines to extract, 12 or 12-20. They must hold whole statements of one block inside a function." },
    { name: "--name", type: "text", required: true, description: "The new function's name; it must be free where the statements are." },
    {
      name: "--params",
      type: "text",
      required: true,
      description:
        'What the statements read from the function around them: "a, b" (positional), "{ a, b }" (one object) or "[a, b]" (one tuple); "" for none. Must name exactly those locals.',
    },
    {
      name: "--returns",
      type: "text",
      required: false,
      description:
        'The locals the statements declare that are used after them: "a" (one value), "{ a, b }" or "[a, b]". Must name exactly those locals; leave it out when there are none.',
    },
  ],
  parseParams(raw) {
    const { from, to } = parseLines(required(raw, "lines"));
    const name = required(raw, "name");
    if (!IDENTIFIER.test(name)) throw new RefactorError("INVALID_ARGS", `--name ${JSON.stringify(name)} is not a plain name.`);
    const rawParams = raw.params;
    if (rawParams === undefined) throw new RefactorError("INVALID_ARGS", `Missing --params. Pass it ("" when the lines read nothing) and run again.`);
    const params = parseShape(rawParams, "--params");
    const returns = parseShape(raw.returns ?? "", "--returns");
    if (returns.kind === "positional" && returns.names.length > 1) {
      throw new RefactorError("INVALID_ARGS", `--returns names ${returns.names.length} values; return them as "{ ${returns.names.join(", ")} }" or "[${returns.names.join(", ")}]".`);
    }
    return { file: required(raw, "file"), from, to, name, params, returns };
  },
  describe: (p) => `lines ${p.from}-${p.to} → ${p.name} in ${p.file}`,

  async run(engine, p) {
    const typescript = engine.ts;
    const { program, sf } = engine.sourceFile(p.file);
    const checker = program.getTypeChecker();
    const text = sf.text;
    const lineStarts = sf.getLineStarts();
    if (p.to > lineStarts.length) unavailable(`${p.file} has ${lineStarts.length} lines; --lines ${p.from}-${p.to} goes past its end.`);
    const rangeStart = lineStarts[p.from - 1] as number;
    const rangeEnd = p.to < lineStarts.length ? (lineStarts[p.to] as number) : text.length;
    const lines = `${p.file}:${p.from}-${p.to}`;

    // The top-level statement the lines are in, and the block whose statements they cover.
    const outer = sf.statements.find((s) => s.getStart(sf) <= rangeStart && rangeEnd <= s.getEnd() + 1);
    if (!outer) unavailable(`${lines} is not inside a top-level function. Only statements inside a function are extracted.`);
    const list = enclosingList(typescript, outer, sf, rangeStart, rangeEnd);
    let fn: ts.Node | undefined = list ?? undefined;
    while (fn && !isFunctionLike(typescript, fn)) fn = fn.parent;
    if (!list || !fn) unavailable(`${lines} is not inside a function body. Only statements inside a function are extracted.`);
    const statements = list.statements.filter((s) => s.getStart(sf) < rangeEnd && s.getEnd() > rangeStart);
    const cut = statements.filter((s) => s.getStart(sf) < rangeStart || s.getEnd() > rangeEnd);
    if (statements.length === 0 || cut.length > 0) {
      const where = cut.map((s) => `${engine.location(s).line}`).join(", ");
      unavailable(
        statements.length === 0
          ? `${lines} holds no statement. Pass the lines of whole statements.`
          : `${lines} cuts through the statement starting on line ${where}. Pass lines that hold whole statements.`,
      );
    }
    const first = statements[0] as ts.Statement;
    const last = statements[statements.length - 1] as ts.Statement;
    if (!onlyTrivia(typescript, text.slice(rangeStart, first.getStart(sf))) || !onlyTrivia(typescript, text.slice(last.getEnd(), rangeEnd))) {
      unavailable(`${lines} holds more than whole statements of one block. Pass lines that hold whole statements.`);
    }
    for (let f: ts.Node | undefined = fn; f && f !== sf; f = f.parent) {
      if (isFunctionLike(typescript, f) && (f as ts.SignatureDeclaration).typeParameters) {
        unavailable(`The function around ${lines} has type parameters; extracting from a generic function is not supported yet.`);
      }
    }
    const range = { pos: first.getStart(sf), end: last.getEnd() };

    // What the lines read and write from outside, and what they cannot take along.
    const reads = new Map<string, ts.Symbol>();
    const writes = new Set<string>();
    const problems: string[] = [];
    const visit = (node: ts.Node, ownFunction: boolean, ownArrow: boolean, loops: number, switches: number, labels: string[]): void => {
      if (!ownFunction) {
        if (typescript.isReturnStatement(node)) problems.push(`a return (line ${engine.location(node).line})`);
        if (typescript.isAwaitExpression(node) || (typescript.isForOfStatement(node) && node.awaitModifier)) problems.push(`await (line ${engine.location(node).line})`);
        if (typescript.isYieldExpression(node)) problems.push(`yield (line ${engine.location(node).line})`);
        if (typescript.isBreakStatement(node) || typescript.isContinueStatement(node)) {
          const ok = node.label
            ? labels.includes(node.label.text)
            : typescript.isBreakStatement(node)
              ? loops + switches > 0
              : loops > 0;
          if (!ok) problems.push(`a ${typescript.isBreakStatement(node) ? "break" : "continue"} out of the lines (line ${engine.location(node).line})`);
        }
      }
      if (!ownFunction || ownArrow) {
        if (node.kind === typescript.SyntaxKind.ThisKeyword) problems.push(`this (line ${engine.location(node).line})`);
        if (node.kind === typescript.SyntaxKind.SuperKeyword) problems.push(`super (line ${engine.location(node).line})`);
        if (typescript.isMetaProperty(node)) problems.push(`${node.getText(sf)} (line ${engine.location(node).line})`);
        if (typescript.isIdentifier(node) && node.text === "arguments" && checker.getSymbolAtLocation(node)?.declarations === undefined) {
          problems.push(`arguments (line ${engine.location(node).line})`);
        }
      }
      if (typescript.isIdentifier(node)) {
        const sym = valueSymbol(typescript, checker, node);
        const decls = sym?.declarations ?? [];
        const local = decls.some((d) => inside(d, outer, sf) && !inside(d, range, sf));
        if (sym && local) {
          if (sym.flags & typescript.SymbolFlags.Type && !(sym.flags & typescript.SymbolFlags.Value)) {
            problems.push(`the local type ${node.text} (line ${engine.location(node).line})`);
          } else if (sym.flags & (typescript.SymbolFlags.Variable | typescript.SymbolFlags.Function | typescript.SymbolFlags.Class | typescript.SymbolFlags.Enum)) {
            reads.set(node.text, sym);
            if (isWrite(typescript, node)) writes.add(node.text);
          }
        }
      }
      const isFn = isFunctionLike(typescript, node) || typescript.isClassLike(node);
      const nextOwn = ownFunction || isFn;
      const nextArrow = isFn ? typescript.isArrowFunction(node) && (!ownFunction || ownArrow) : ownArrow;
      const isLoop = typescript.isIterationStatement(node, false);
      const nextLabels = typescript.isLabeledStatement(node) ? [...labels, node.label.text] : labels;
      typescript.forEachChild(node, (c) =>
        visit(c, nextOwn, nextArrow, isFn ? 0 : loops + (isLoop ? 1 : 0), isFn ? 0 : switches + (typescript.isSwitchStatement(node) ? 1 : 0), isFn ? [] : nextLabels),
      );
    };
    for (const s of statements) visit(s, false, false, 0, 0, []);
    if (problems.length > 0) {
      unavailable(`${lines} uses ${[...new Set(problems)].join(", ")}, which cannot move into another function. Extract other lines, or change these first.`);
    }
    if (writes.size > 0) {
      const w = [...writes].sort();
      unavailable(`${lines} assigns ${names(w)}, declared before them; the new function cannot change ${w.length === 1 ? "it" : "them"}. Extract other lines.`);
    }

    // What later code uses of what the lines declare.
    const outs = new Map<string, ts.VariableDeclaration>();
    const badOuts = new Set<string>();
    const visitAfter = (node: ts.Node): void => {
      if (inside(node, range, sf)) return;
      if (typescript.isIdentifier(node)) {
        const sym = valueSymbol(typescript, checker, node);
        const decl = sym && sym.flags & (typescript.SymbolFlags.Variable | typescript.SymbolFlags.Function | typescript.SymbolFlags.Class | typescript.SymbolFlags.Enum) ? sym.declarations?.find((d) => inside(d, range, sf)) : undefined;
        if (decl) {
          const ok =
            typescript.isVariableDeclaration(decl) &&
            typescript.isIdentifier(decl.name) &&
            typescript.isVariableDeclarationList(decl.parent) &&
            decl.parent.flags & (typescript.NodeFlags.Let | typescript.NodeFlags.Const) &&
            statements.some((s) => s === decl.parent.parent);
          if (ok) outs.set(node.text, decl as ts.VariableDeclaration);
          else badOuts.add(node.text);
        }
      }
      typescript.forEachChild(node, visitAfter);
    };
    visitAfter(outer);
    if (badOuts.size > 0) {
      unavailable(`Code after ${lines} uses ${names([...badOuts].sort())}, declared in them, but only let and const declarations of the lines themselves can be returned.`);
    }

    // The names given must be exactly the ones used.
    const p1 = sameSet(p.params.names, [...reads.keys()]);
    if (p1.missing.length > 0 || p1.extra.length > 0) {
      const parts = [
        ...(p1.missing.length > 0 ? [`they read ${names(p1.missing)} from the function around them, missing from --params`] : []),
        ...(p1.extra.length > 0 ? [`--params names ${names(p1.extra)}, which they do not read from the function around them`] : []),
      ];
      unavailable(`For ${lines}, ${parts.join("; ")}. --params must name exactly: ${[...reads.keys()].sort().join(", ") || "nothing"}.`);
    }
    const r1 = sameSet(p.returns.names, [...outs.keys()]);
    if (r1.missing.length > 0 || r1.extra.length > 0) {
      const parts = [
        ...(r1.missing.length > 0 ? [`code after them uses ${names(r1.missing)}, declared in them, missing from --returns`] : []),
        ...(r1.extra.length > 0 ? [`--returns names ${names(r1.extra)}, which code after them does not use from them`] : []),
      ];
      unavailable(`For ${lines}, ${parts.join("; ")}. --returns must name exactly: ${[...outs.keys()].sort().join(", ") || "nothing"}.`);
    }
    const keywords = new Set([...outs.values()].map((d) => (d.parent.flags & typescript.NodeFlags.Const ? "const" : "let")));
    if (keywords.size > 1) {
      unavailable(`${lines} returns both const and let declarations (${names([...outs.keys()].sort())}); make them the same kind first.`);
    }
    const keyword = [...keywords][0] ?? "const";

    // The name must be free where the call goes (module, globals and the locals in scope there).
    const inScope = checker.getSymbolsInScope(first, typescript.SymbolFlags.Value | typescript.SymbolFlags.Type);
    if (inScope.some((s) => s.name === p.name)) {
      unavailable(`${p.name} is already a name in scope at ${lines}. Pass another --name.`);
    }

    // The new function and its call.
    const paramTypes = p.params.names.map((n) => typeText(typescript, checker, reads.get(n) as ts.Symbol, sf));
    const signature =
      p.params.kind === "object"
        ? p.params.names.length === 0
          ? ""
          : `{ ${p.params.names.join(", ")} }: { ${p.params.names.map((n, i) => `${n}: ${paramTypes[i]}`).join("; ")} }`
        : p.params.kind === "tuple"
          ? `[${p.params.names.join(", ")}]: [${paramTypes.join(", ")}]`
          : p.params.names.map((n, i) => `${n}: ${paramTypes[i]}`).join(", ");
    const args =
      p.params.kind === "object"
        ? p.params.names.length === 0
          ? ""
          : `{ ${p.params.names.join(", ")} }`
        : p.params.kind === "tuple"
          ? `[${p.params.names.join(", ")}]`
          : p.params.names.join(", ");
    const outTypes = p.returns.names.map((n) => {
      const decl = outs.get(n) as ts.VariableDeclaration;
      return decl.type ? decl.type.getText(sf) : checker.typeToString(checker.getTypeAtLocation(decl.name), decl, typescript.TypeFormatFlags.NoTruncation);
    });
    const returnType = p.returns.kind === "tuple" ? `: [${outTypes.join(", ")}]` : "";
    const returnStatement =
      p.returns.names.length === 0
        ? null
        : p.returns.kind === "object"
          ? `return { ${p.returns.names.join(", ")} };`
          : p.returns.kind === "tuple"
            ? `return [${p.returns.names.join(", ")}];`
            : `return ${p.returns.names[0]};`;
    const call = `${p.name}(${args})`;
    const callStatement =
      p.returns.names.length === 0
        ? `${call};`
        : p.returns.kind === "object"
          ? `${keyword} { ${p.returns.names.join(", ")} } = ${call};`
          : p.returns.kind === "tuple"
            ? `${keyword} [${p.returns.names.join(", ")}] = ${call};`
            : `${keyword} ${p.returns.names[0]} = ${call};`;

    // Indentation: the lines lose their own and get one level, the one the function around them uses.
    const indent = text.slice(rangeStart, rangeStart + (/^[ \t]*/.exec(text.slice(rangeStart))?.[0].length ?? 0));
    const bodyOf = (n: ts.Node): ts.Block | undefined => {
      let b: ts.Block | undefined;
      typescript.forEachChild(n, (c) => {
        if (!b && typescript.isBlock(c)) b = c;
      });
      return b;
    };
    const outerBody = bodyOf(fn);
    const firstOfBody = outerBody?.statements[0];
    const fnIndent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", fn.getStart(sf) - 1) + 1))?.[0] ?? "";
    const bodyIndent = firstOfBody ? (/^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", firstOfBody.getStart(sf) - 1) + 1))?.[0] ?? "") : "";
    const unit = bodyIndent.startsWith(fnIndent) && bodyIndent.length > fnIndent.length ? bodyIndent.slice(fnIndent.length) : "  ";
    const moved = text
      .slice(rangeStart, rangeEnd)
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => (l.trim() === "" ? "" : `${unit}${l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()}`));
    // One `const d = E;` (or let) returning d: the function returns E itself.
    const only = statements.length === 1 ? statements[0] : undefined;
    const single =
      only &&
      typescript.isVariableStatement(only) &&
      only.declarationList.declarations.length === 1 &&
      p.returns.kind === "positional" &&
      p.returns.names.length === 1
        ? (only.declarationList.declarations[0] as ts.VariableDeclaration)
        : undefined;
    const direct =
      single && typescript.isIdentifier(single.name) && single.name.text === p.returns.names[0] && !single.type && single.initializer
        ? single.initializer
        : undefined;
    const body = direct
      ? `${unit}return ${text.slice(direct.getStart(sf), direct.getEnd()).split("\n").map((l, i) => (i === 0 ? l : `${unit}${l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()}`)).join("\n")};`
      : [...moved, ...(returnStatement ? [`${unit}${returnStatement}`] : [])].join("\n");
    const declaration = `function ${p.name}(${signature})${returnType} {\n${body}\n}\n\n`;

    const insertAt = lineSpan(text, attachedStart(typescript, sf, outer), outer.getEnd()).start;
    const before = diagnostics(engine, p.file);
    engine.applyTextChanges([
      {
        fileName: p.file,
        textChanges: [
          { span: { start: insertAt, length: 0 }, newText: declaration },
          { span: { start: rangeStart, length: rangeEnd - rangeStart }, newText: `${indent}${callStatement}\n` },
        ],
      },
    ]);
    const errors = introduced(before, diagnostics(engine, p.file));
    if (errors.length > 0) {
      unavailable(`Extracting ${lines} into ${p.name} would introduce type errors: ${errors.join("; ")}. Extract by hand, or other lines.`);
    }

    const counted = statements.length === 1 ? "1 statement" : `${statements.length} statements`;
    return { summary: `Extracted ${counted} from ${lines} into a new function \`${p.name}\` at module level.` };
  },
};
