import { RefactorError } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { atText, byString, diagnostics, findAt, introduced, parseAt, required, unavailable } from "./shared.ts";
import type { At } from "./shared.ts";

type Ts = typeof ts;
type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type Direction = "arrow" | "function";

export type ConvertFunctionParams = At & { to: Direction };

// ---- finding the function ----

/** The variable a function is the direct initializer of. */
function heldVariable(t: Ts, fn: ts.Node): ts.VariableDeclaration | undefined {
  const parent = fn.parent;
  return t.isVariableDeclaration(parent) && parent.initializer === fn ? parent : undefined;
}

/** What the function is "at": its whole `const` statement when it is the initializer of one, else itself. */
function anchorOf(t: Ts, fn: Fn): ts.Node {
  const held = heldVariable(t, fn);
  const statement = held?.parent.parent;
  return statement !== undefined && t.isVariableStatement(statement) ? statement : fn;
}

function candidates(t: Ts, sf: ts.SourceFile, to: Direction): Fn[] {
  const found: Fn[] = [];
  const visit = (n: ts.Node): void => {
    if (to === "arrow") {
      if (t.isFunctionDeclaration(n) || t.isFunctionExpression(n)) found.push(n);
    } else if ((t.isArrowFunction(n) || t.isFunctionExpression(n)) && heldVariable(t, n)) {
      found.push(n);
    }
    t.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function pick(engine: TsEngine, sf: ts.SourceFile, p: ConvertFunctionParams): Fn {
  const t = engine.ts;
  const file = engine.relPath(p.path);
  const what =
    p.to === "arrow"
      ? "a function declaration or function expression"
      : "a `const name = (…) => …` or `const name = function (…) {…}`";
  return findAt(
    sf,
    file,
    p,
    candidates(t, sf, p.to).map((f) => {
      const anchor = anchorOf(t, f);
      return {
        item: f,
        start: anchor.getStart(sf),
        end: f.end,
        startAlt: f.getStart(sf),
        label: f.name?.getText(sf) ?? heldVariable(t, f)?.name.getText(sf) ?? "an anonymous function",
      };
    }),
    {
      what: `function to convert --to ${p.to}`,
      plural: `functions to convert --to ${p.to}`,
      hint: `It converts ${what}. Pass the line (and column) where the function starts.`,
    },
  );
}

// ---- what a function takes from its surroundings ----

/** `this`, `super`, `new.target` or `arguments` that `fn` uses itself (nested arrows count, other functions do not). */
function lexicalUse(t: Ts, fn: Fn): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node): void => {
    if (found !== null) return;
    if (n.kind === t.SyntaxKind.ThisKeyword) found = "`this`";
    else if (n.kind === t.SyntaxKind.SuperKeyword) found = "`super`";
    else if (t.isMetaProperty(n) && n.keywordToken === t.SyntaxKind.NewKeyword) found = "`new.target`";
    else if (t.isIdentifier(n) && n.text === "this" && t.isParameter(n.parent)) found = "a `this` parameter";
    else if (t.isIdentifier(n) && n.text === "arguments" && !isNamePosition(t, n)) found = "`arguments`";
    if (found !== null) return;
    // These bind their own `this`/`arguments`.
    if (
      t.isFunctionDeclaration(n) ||
      t.isFunctionExpression(n) ||
      t.isClassLike(n) ||
      t.isMethodDeclaration(n) ||
      t.isGetAccessorDeclaration(n) ||
      t.isSetAccessorDeclaration(n) ||
      t.isConstructorDeclaration(n)
    ) {
      return;
    }
    t.forEachChild(n, visit);
  };
  for (const parameter of fn.parameters) visit(parameter);
  if (fn.body) visit(fn.body);
  return found;
}

function isNamePosition(t: Ts, id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (t.isPropertyAccessExpression(p) && p.name === id) ||
    (t.isPropertyAssignment(p) && p.name === id) ||
    (t.isQualifiedName(p) && p.right === id)
  );
}

function nodeAtStart(t: Ts, sf: ts.SourceFile, start: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found || start < n.getStart(sf) || start >= n.getEnd()) return;
    if (t.isIdentifier(n) && n.getStart(sf) === start) found = n;
    else t.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

type Use = { node: ts.Node; sf: ts.SourceFile; file: string };

/** Every use of the name at `pos` in `file` (not its declaration), across the files of the project. */
function usesOf(engine: TsEngine, file: string, pos: number): Use[] {
  const t = engine.ts;
  const symbols = engine.project(file).service.findReferences(engine.absPath(file), pos) ?? [];
  const sources = new Map<string, ts.SourceFile | null>();
  const out: Use[] = [];
  for (const symbol of symbols) {
    for (const ref of symbol.references) {
      if (ref.isDefinition) continue;
      const rel = engine.relPath(ref.fileName);
      if (!sources.has(rel)) {
        try {
          sources.set(rel, engine.sourceFile(rel).sf);
        } catch {
          sources.set(rel, null);
        }
      }
      const sf = sources.get(rel);
      const node = sf ? nodeAtStart(t, sf, ref.textSpan.start) : undefined;
      if (sf && node) out.push({ node, sf, file: rel });
    }
  }
  return out;
}

function at(engine: TsEngine, use: Use): string {
  return `${use.file}:${engine.location(use.node).line}`;
}

/** The expression a use is the subject of: `ns.f` for the `f` in `ns.f`. */
function subject(t: Ts, node: ts.Node): ts.Node {
  const p = node.parent;
  return t.isPropertyAccessExpression(p) && p.name === node ? p : node;
}

function isConstructedOrPrototyped(t: Ts, use: Use): "new" | "prototype" | null {
  const s = subject(t, use.node);
  if (t.isNewExpression(s.parent) && s.parent.expression === s) return "new";
  if (t.isPropertyAccessExpression(s.parent) && s.parent.expression === s && s.parent.name.text === "prototype") return "prototype";
  return null;
}

function hasModifier(t: Ts, n: ts.Node, kind: ts.SyntaxKind): boolean {
  return t.canHaveModifiers(n) && (t.getModifiers(n) ?? []).some((m) => m.kind === kind);
}

// ---- text ----

/** From the `<` or `(` that starts the type parameters or parameters, up to `end`. */
function headerStart(t: Ts, sf: ts.SourceFile, fn: Fn): number {
  const token = fn.getChildren(sf).find((c) => c.kind === t.SyntaxKind.LessThanToken || c.kind === t.SyntaxKind.OpenParenToken);
  if (token) return token.getStart(sf);
  // `x => …`: a single parameter without parentheses.
  return (fn.parameters[0] as ts.ParameterDeclaration).getStart(sf);
}

const JSX_FILE = /\.(tsx|jsx)$/;

/**
 * The signature text of `fn` (type parameters, parameters, return type) up to `end`, as it is written.
 * Adds the parentheses a bare `x =>` parameter needs, and in `.tsx` files the comma that keeps a single
 * `<T,>` from reading as a JSX tag (or removes it again).
 */
function header(t: Ts, sf: ts.SourceFile, fn: Fn, end: number, file: string, to: Direction): string {
  const start = headerStart(t, sf, fn);
  let text = sf.text.slice(start, end);
  const params = fn.typeParameters;
  if (params && params.length === 1) {
    const only = params[0] as ts.TypeParameterDeclaration;
    const after = only.end - start;
    if (to === "arrow" && JSX_FILE.test(file) && !params.hasTrailingComma && !only.constraint) {
      text = `${text.slice(0, after)},${text.slice(after)}`;
    } else if (to === "function" && params.hasTrailingComma) {
      text = text.slice(0, after) + text.slice(after).replace(/^\s*,/, "");
    }
  }
  text = text.trimEnd();
  if (!text.startsWith("(") && !text.startsWith("<")) text = `(${text})`;
  return text;
}

const lineIndent = (text: string, start: number): string => {
  const before = text.slice(text.lastIndexOf("\n", start - 1) + 1, start);
  return /^[ \t]*$/.test(before) ? before : "";
};

/** Whether an arrow function can stand where `fn` is, without parentheses. */
function needsParens(t: Ts, fn: ts.Node): boolean {
  const p = fn.parent;
  if (
    t.isVariableDeclaration(p) ||
    t.isPropertyAssignment(p) ||
    t.isPropertyDeclaration(p) ||
    t.isParenthesizedExpression(p) ||
    t.isReturnStatement(p) ||
    t.isArrayLiteralExpression(p) ||
    t.isSpreadElement(p) ||
    t.isExportAssignment(p) ||
    t.isJsxExpression(p) ||
    t.isArrowFunction(p)
  ) {
    return false;
  }
  if (t.isCallExpression(p) || t.isNewExpression(p)) return p.expression === fn;
  if (t.isBinaryExpression(p)) return !(p.right === fn && p.operatorToken.kind === t.SyntaxKind.EqualsToken);
  if (t.isConditionalExpression(p)) return p.condition === fn;
  return true;
}

// ---- the plan: what to write, what to check ----

type Plan = {
  start: number;
  end: number;
  text: string;
  /** Files whose diagnostics must not get worse. */
  files: string[];
  summary: string;
};

function toArrow(engine: TsEngine, file: string, sf: ts.SourceFile, fn: ts.FunctionDeclaration | ts.FunctionExpression): Plan {
  const t = engine.ts;
  const held = heldVariable(t, fn);
  const isDeclaration = t.isFunctionDeclaration(fn);
  const at0 = `${file}:${engine.location(fn).line}`;
  const label = isDeclaration
    ? `\`${fn.name?.text ?? "default"}\``
    : held
      ? `\`${held.name.getText(sf)}\``
      : `the function expression at ${at0}`;
  const refuse = (why: string, fix: string): never => unavailable(`${label} ${why}. ${fix}`);

  if (!fn.body) {
    refuse(
      "has no body (it is an overload signature or an ambient declaration)",
      "Convert the implementation instead, or leave overloaded functions as declarations.",
    );
  }
  if (fn.asteriskToken) refuse("is a generator, and arrow functions cannot be generators", "Keep it as a function.");
  if (isDeclaration && hasModifier(t, fn, t.SyntaxKind.DefaultKeyword)) {
    refuse(
      "is a default export, which `const` cannot declare in one statement",
      "Give it a name and add `export default <name>;` yourself first, then run again.",
    );
  }
  const lexical = lexicalUse(t, fn);
  if (lexical !== null) {
    refuse(
      `uses ${lexical}, which an arrow function takes from its surroundings instead of from the call`,
      "Pass the value in as a parameter (or use rest parameters instead of `arguments`) first, then run again.",
    );
  }
  if (t.isNewExpression(fn.parent) && fn.parent.expression === fn) {
    refuse("is called with `new`, which arrow functions do not support", "Keep it as a function.");
  }

  let files = [file];
  let uses: Use[] = [];
  const target = isDeclaration ? fn.name : held?.name;
  if (target) {
    const program = engine.sourceFile(file).program;
    const symbol = program.getTypeChecker().getSymbolAtLocation(target);
    if (isDeclaration && (symbol?.declarations?.length ?? 1) > 1) {
      refuse(
        "is declared more than once (overloads, or merged with another declaration)",
        "Leave it as a function declaration, or remove the overloads first.",
      );
    }
    uses = usesOf(engine, file, target.getStart(sf));
    for (const use of uses) {
      const how = isConstructedOrPrototyped(t, use);
      if (how === "new") {
        refuse(`is called with \`new\` in ${at(engine, use)}, which arrow functions do not support`, "Keep it as a function.");
      }
      if (how === "prototype") {
        refuse(
          `is used as a constructor through its \`.prototype\` in ${at(engine, use)}, which arrow functions do not have`,
          "Keep it as a function.",
        );
      }
    }
    if (isDeclaration) {
      const early = uses.find((u) => {
        if (u.file !== file || u.node.getStart(u.sf) >= fn.getStart(sf)) return false;
        for (let n: ts.Node | undefined = u.node; n && !t.isStatement(n); n = n.parent) {
          if (t.isExportSpecifier(n) || t.isTypeQueryNode(n)) return false;
        }
        return true;
      });
      if (early) {
        refuse(
          `is used in ${at(engine, early)}, before its declaration; a function declaration is hoisted but a \`const\` is not, so that use would fail`,
          "Move the declaration above its first use, then run again.",
        );
      }
      // Not handled: circular imports where another file calls the function while modules evaluate rely on
      // hoisting too; only uses in this file are checked.
      // A use inside another function declaration may run before the `const` is initialised, because
      // that function is hoisted too (and can be called from code above this declaration).
      const hoisted = uses.find((u) => {
        if (u.file !== file) return false;
        for (let n: ts.Node | undefined = u.node; n && !t.isSourceFile(n); n = n.parent) {
          if (t.isExportSpecifier(n) || t.isTypeQueryNode(n)) return false;
          if (t.isFunctionDeclaration(n) && !(n.pos <= fn.pos && fn.end <= n.end)) return true;
        }
        return false;
      });
      if (hoisted) {
        refuse(
          `is used in ${at(engine, hoisted)}, inside another function declaration; that function is hoisted and may run before the \`const\` is initialised, which would fail`,
          "Convert that function too, or move this declaration above everything that can call it, then run again.",
        );
      }
    }
    files = [...new Set([file, ...uses.map((u) => u.file)])].sort(byString);
  }
  if (fn.name && !isDeclaration && !(held && held.name.getText(sf) === fn.name.text)) {
    refuse(
      `is a function expression with its own name \`${fn.name.text}\`${held ? `, so \`${held.name.getText(sf)}.name\` is "${fn.name.text}"` : ""}; an arrow function would be named differently`,
      "Rename the function expression to match the variable (or drop its name) first, then run again.",
    );
  }

  const body = sf.text.slice((fn.body as ts.Block).getStart(sf), fn.body?.end);
  const head = header(t, sf, fn, (fn.body as ts.Block).getStart(sf), file, "arrow");
  const async = hasModifier(t, fn, t.SyntaxKind.AsyncKeyword) ? "async " : "";
  if (isDeclaration) {
    const name = (fn.name as ts.Identifier).text;
    const exported = hasModifier(t, fn, t.SyntaxKind.ExportKeyword) ? "export " : "";
    return {
      start: fn.getStart(sf),
      end: fn.end,
      text: `${exported}const ${name} = ${async}${head} => ${body};`,
      files,
      summary: `Converted the function declaration \`${name}\` in ${file} to a \`const\` arrow function.`,
    };
  }
  const arrow = `${async}${head} => ${body}`;
  const named = held !== undefined;
  return {
    start: fn.getStart(sf),
    end: fn.end,
    text: needsParens(t, fn) ? `(${arrow})` : arrow,
    files,
    summary: named
      ? `Converted the function expression \`${held.name.getText(sf)}\` in ${file} to an arrow function.`
      : `Converted a function expression in \`${engine.declarationPath(fn)}\` to an arrow function.`,
  };
}

function toFunction(engine: TsEngine, file: string, sf: ts.SourceFile, fn: ts.ArrowFunction | ts.FunctionExpression): Plan {
  const t = engine.ts;
  const decl = heldVariable(t, fn) as ts.VariableDeclaration;
  const list = decl.parent as ts.VariableDeclarationList;
  const statement = list.parent;
  const name = t.isIdentifier(decl.name) ? decl.name.text : decl.name.getText(sf);
  const label = `\`${name}\``;
  const refuse = (why: string, fix: string): never => unavailable(`${label} ${why}. ${fix}`);

  if (!t.isIdentifier(decl.name) || !t.isVariableStatement(statement)) {
    refuse("is not a plain `const name = …` statement", "Only a `const` statement holding one function can become a declaration.");
  }
  const stmt = statement as ts.VariableStatement;
  if (!(list.flags & t.NodeFlags.Const)) {
    refuse("is declared with let or var, so it may be reassigned, which a function declaration would change", "Make it a `const` first, then run again.");
  }
  if (list.declarations.length > 1) {
    refuse("is declared together with other variables in one statement", "Split the declaration into one statement per variable first, then run again.");
  }
  if (decl.type) {
    refuse(
      `has a type annotation (\`${decl.type.getText(sf)}\`) that a function declaration would lose`,
      "Move the types onto the parameters and the return type first, then run again.",
    );
  }
  if (hasModifier(t, stmt, t.SyntaxKind.DeclareKeyword)) refuse("is an ambient declaration", "Leave it as it is.");
  if (t.isArrowFunction(fn)) {
    const lexical = lexicalUse(t, fn);
    if (lexical !== null) {
      refuse(
        `uses ${lexical}, which an arrow function takes from its surroundings and a function declaration would bind itself`,
        "Pass the value in as a parameter first, then run again.",
      );
    }
  } else if (fn.name && fn.name.text !== name) {
    refuse(
      `is a function expression with its own name \`${fn.name.text}\`, so \`${name}.name\` is "${fn.name.text}"; a function declaration would be named \`${name}\``,
      `Rename the function expression to \`${name}\` first, then run again.`,
    );
  }

  const text = sf.text;
  const start = stmt.getStart(sf);
  let body: string;
  if (t.isArrowFunction(fn) && !t.isBlock(fn.body)) {
    let expr = fn.body;
    while (t.isParenthesizedExpression(expr) && t.isObjectLiteralExpression(expr.expression)) expr = expr.expression;
    const indent = lineIndent(text, start);
    const arrowEnd = fn.equalsGreaterThanToken.end;
    // Same-line comments after `=>` are "trailing" for TypeScript, those after a line break "leading".
    const comments = [...(t.getTrailingCommentRanges(text, arrowEnd) ?? []), ...(t.getLeadingCommentRanges(text, arrowEnd) ?? [])];
    const kept = [...new Map(comments.map((c) => [c.pos, c])).values()].sort((a, b) => a.pos - b.pos).map((c) => `${indent}  ${text.slice(c.pos, c.end)}\n`);
    body = `{\n${kept.join("")}${indent}  return ${text.slice(expr.getStart(sf), expr.end)};\n${indent}}`;
  } else {
    const block = fn.body as ts.Block;
    body = text.slice(block.getStart(sf), block.end);
  }
  const endOfHeader = t.isArrowFunction(fn) ? fn.equalsGreaterThanToken.getStart(sf) : (fn.body as ts.Block).getStart(sf);
  const head = header(t, sf, fn, endOfHeader, file, "function");
  const async = hasModifier(t, fn, t.SyntaxKind.AsyncKeyword) ? "async " : "";
  const star = t.isFunctionExpression(fn) && fn.asteriskToken ? "*" : "";
  const exported = hasModifier(t, stmt, t.SyntaxKind.ExportKeyword) ? "export " : "";
  const uses = usesOf(engine, file, decl.name.getStart(sf));
  return {
    start,
    end: stmt.end,
    text: `${exported}${async}function${star} ${name}${head} ${body}`,
    files: [...new Set([file, ...uses.map((u) => u.file)])].sort(byString),
    summary: `Converted \`${name}\` in ${file} from ${t.isArrowFunction(fn) ? "an arrow function" : "a function expression"} to a function declaration.`,
  };
}

export const convertFunctionAction: Action<ConvertFunctionParams, TsEngine> = {
  id: "typescript-convert-function",
  kind: "refactor",
  summary: "Converts a function declaration or expression to a const arrow function, or the reverse.",
  flags: [],
  parseParams(raw) {
    const to = required(raw, "to");
    if (to !== "arrow" && to !== "function") {
      throw new RefactorError("INVALID_ARGS", `--to must be arrow or function, not ${JSON.stringify(to)}.`);
    }
    return { ...parseAt(required(raw, "at")), to };
  },
  describe: (p) => `${atText(p.path, p)} → ${p.to === "arrow" ? "arrow function" : "function declaration"}`,

  async run(engine, p) {
    const file = engine.relPath(p.path);
    const { sf } = engine.sourceFile(file);
    const fn = pick(engine, sf, p);
    const plan =
      p.to === "arrow"
        ? toArrow(engine, file, sf, fn as ts.FunctionDeclaration | ts.FunctionExpression)
        : toFunction(engine, file, sf, fn as ts.ArrowFunction | ts.FunctionExpression);

    const before = new Map(plan.files.map((f) => [f, diagnostics(engine, f)]));
    engine.write(file, sf.text.slice(0, plan.start) + plan.text + sf.text.slice(plan.end));
    const errors = plan.files.flatMap((f) => introduced(before.get(f) ?? [], diagnostics(engine, f)).map((d) => `${f}: ${d}`));
    if (errors.length > 0) {
      engine.write(file, sf.text);
      unavailable(
        `Converting the function would introduce errors: ${errors.join("; ")}. Fix what those errors point at by hand, or leave the function as it is.`,
      );
    }
    return { summary: plan.summary };
  },
};
