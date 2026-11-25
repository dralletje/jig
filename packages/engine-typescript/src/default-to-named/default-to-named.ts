import { RefactorError, listFiles, listLines, matchesAnyGlob, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "../engine.ts";
import { TS_FILE, byString, diagnostics, list as globList, introduced, matchFiles, notHandled } from "../shared.ts";
import type { NotHandled } from "../shared.ts";

/**
 * default-to-named: `export default` of a named function, class, interface or local value
 * becomes a named export of the same name, and every importer switches to a named import (`import { Name
 * as local }` when its local name differs). Anonymous default exports, and modules whose default is
 * loaded with `import()` or through a namespace, are refused per file and listed in the summary as not handled.
 */

type T = TsEngine["ts"];

/** One text replacement in a file: `start`…`end` becomes `text`. */
type Edit = { start: number; end: number; text: string };

/** How a file declares its default export. */
type Form =
  | { kind: "modifier"; name: string; stmts: ts.Statement[] } // export default function Name() {}
  | { kind: "assignment"; name: string; stmt: ts.ExportAssignment; id: ts.Identifier } // export default Name;
  | { kind: "specifier"; name: string; decl: ts.ExportDeclaration; el: ts.ExportSpecifier } // export { Name as default };
  | { kind: "anonymous"; anchor: ts.Node; what: "function" | "class" | "expression" };

function anchorOf(form: Form): ts.Node {
  switch (form.kind) {
    case "modifier":
      return form.stmts[0] as ts.Statement;
    case "assignment":
      return form.stmt;
    case "specifier":
      return form.decl;
    case "anonymous":
      return form.anchor;
  }
}

function modifiersOf(t: T, node: ts.Node): readonly ts.Modifier[] {
  return t.canHaveModifiers(node) ? (t.getModifiers(node) ?? []) : [];
}

function hasModifier(t: T, node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiersOf(t, node).some((m) => m.kind === kind);
}

/** The file's default export, or undefined when it has none of its own (a re-export of another's default is none). */
function findDefault(t: T, sf: ts.SourceFile): Form | undefined {
  const withDefault: ts.Statement[] = [];
  let name: string | undefined;
  for (const stmt of sf.statements) {
    if (t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt) || t.isInterfaceDeclaration(stmt)) {
      if (!hasModifier(t, stmt, t.SyntaxKind.ExportKeyword) || !hasModifier(t, stmt, t.SyntaxKind.DefaultKeyword)) continue;
      if (!stmt.name) {
        return { kind: "anonymous", anchor: stmt, what: t.isClassDeclaration(stmt) ? "class" : "function" };
      }
      name ??= stmt.name.text;
      withDefault.push(stmt);
    } else if (t.isExportAssignment(stmt) && !stmt.isExportEquals) {
      if (t.isIdentifier(stmt.expression)) {
        return { kind: "assignment", name: stmt.expression.text, stmt, id: stmt.expression };
      }
      return { kind: "anonymous", anchor: stmt, what: "expression" };
    } else if (
      t.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      t.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        if (el.name.text === "default") return { kind: "specifier", name: (el.propertyName ?? el.name).text, decl: stmt, el };
      }
    }
  }
  return name === undefined ? undefined : { kind: "modifier", name, stmts: withDefault };
}

// ---- who uses the default ----

/** A place that imports or re-exports the default by name: it is rewritten. */
type Use =
  | { kind: "import"; file: string; decl: ts.ImportDeclaration }
  | { kind: "reexport"; file: string; decl: ts.ExportDeclaration; els: ts.ExportSpecifier[] };

/** A place that needs the default export to stay: the module is left alone. */
type Blocker = { file: string; node: ts.Node; what: string };

/** The source file a module specifier resolves to (absolute path), or null. */
function resolvedFile(checker: ts.TypeChecker, t: T, specifier: ts.Node): string | null {
  const decl = checker.getSymbolAtLocation(specifier)?.valueDeclaration;
  return decl && t.isSourceFile(decl) ? decl.fileName : null;
}

/** Whether the namespace import `ns` is used in a way that may reach `ns.default`. */
function namespaceReachesDefault(t: T, sf: ts.SourceFile, binding: ts.Identifier): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (t.isIdentifier(n) && n.text === binding.text && n !== binding) {
      const p = n.parent;
      const member = (t.isPropertyAccessExpression(p) && p.name === n) || (t.isQualifiedName(p) && p.right === n);
      const safe =
        (t.isPropertyAccessExpression(p) && p.expression === n && p.name.text !== "default") ||
        (t.isQualifiedName(p) && p.left === n && p.right.text !== "default");
      if (!member && !safe) found = n;
    }
    t.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** JavaScript files: not part of the TypeScript programs, so they are read syntactically (never edited, so cached). */
const SCRIPT_FILE = /\.(m|c)?jsx?$/;
const scriptCache = new WeakMap<TsEngine, Map<string, ts.SourceFile>>();

function scriptSource(engine: TsEngine, file: string): ts.SourceFile | undefined {
  let cache = scriptCache.get(engine);
  if (!cache) scriptCache.set(engine, (cache = new Map()));
  let sf = cache.get(file);
  if (!sf) {
    const text = engine.read(file);
    if (text === null) return undefined;
    sf = engine.ts.createSourceFile(engine.absPath(file), text, engine.ts.ScriptTarget.Latest, true);
    cache.set(file, sf);
  }
  return sf;
}

/**
 * Places that need the default export and that the TypeScript import scan does not rewrite: JavaScript
 * files importing it (a default import, namespace, `export { default } from`), `require()` and
 * `import()` of it, and `vi.mock`/`jest.mock` factories that return a `default`. `script`: the file is
 * JavaScript (its imports and `import()` count too; for TypeScript the checker-based scan handles them).
 */
function looseBlockers(
  engine: TsEngine,
  resolve: (specifier: string, from: string) => string | undefined,
  abs: string,
  file: string,
  sf: ts.SourceFile,
  script: boolean,
): Blocker[] {
  const t = engine.ts;
  const out: Blocker[] = [];
  const points = (spec: ts.Node | undefined): boolean =>
    spec !== undefined && t.isStringLiteralLike(spec) && resolve(spec.text, file) === abs;
  const visit = (node: ts.Node): void => {
    if (script && t.isImportDeclaration(node) && points(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      const reads =
        node.importClause?.name !== undefined ||
        (bindings !== undefined && t.isNamespaceImport(bindings)) ||
        (bindings !== undefined && t.isNamedImports(bindings) && bindings.elements.some((e) => (e.propertyName ?? e.name).text === "default"));
      if (reads) out.push({ file, node, what: "JavaScript import" });
    } else if (script && t.isExportDeclaration(node) && points(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (
        (clause && t.isNamedExports(clause) && clause.elements.some((e) => (e.propertyName ?? e.name).text === "default")) ||
        (clause && t.isNamespaceExport(clause))
      ) {
        out.push({ file, node, what: "JavaScript re-export" });
      }
    } else if (t.isCallExpression(node)) {
      const callee = node.expression;
      const [first, second] = node.arguments;
      if (t.isIdentifier(callee) && callee.text === "require" && points(first)) {
        out.push({ file, node, what: "require()" });
      } else if (script && callee.kind === t.SyntaxKind.ImportKeyword && points(first)) {
        out.push({ file, node, what: "dynamic import()" });
      } else if (
        t.isPropertyAccessExpression(callee) &&
        t.isIdentifier(callee.expression) &&
        (callee.expression.text === "vi" || callee.expression.text === "jest") &&
        (callee.name.text === "mock" || callee.name.text === "doMock") &&
        points(first) &&
        second !== undefined &&
        /\bdefault\b/.test(second.getText(sf))
      ) {
        out.push({ file, node, what: `${callee.expression.text}.${callee.name.text} factory returning default` });
      }
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function findUses(
  engine: TsEngine,
  target: string,
  files: string[],
  scripts: string[],
): { uses: Use[]; blockers: Blocker[] } {
  const t = engine.ts;
  const abs = engine.absPath(target);
  const uses: Use[] = [];
  const blockers: Blocker[] = [];
  const options = engine.project(target).service.getProgram()?.getCompilerOptions() ?? {};
  const resolve = (specifier: string, from: string): string | undefined =>
    t.resolveModuleName(specifier, engine.absPath(from), options, t.sys).resolvedModule?.resolvedFileName;
  for (const file of scripts) {
    const sf = scriptSource(engine, file);
    if (sf) blockers.push(...looseBlockers(engine, resolve, abs, file, sf, true));
  }
  for (const file of files) {
    const { program, sf } = engine.sourceFile(file);
    blockers.push(...looseBlockers(engine, resolve, abs, file, sf, false));
    const checker = program.getTypeChecker();
    const points = (specifier: ts.Node): boolean => resolvedFile(checker, t, specifier) === abs;
    const visit = (node: ts.Node): void => {
      if (t.isImportDeclaration(node) && t.isStringLiteral(node.moduleSpecifier) && points(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const defaultElement =
          bindings !== undefined &&
          t.isNamedImports(bindings) &&
          bindings.elements.some((e) => (e.propertyName ?? e.name).text === "default");
        if (clause?.name || defaultElement) uses.push({ kind: "import", file, decl: node });
        if (bindings && t.isNamespaceImport(bindings)) {
          const reach = namespaceReachesDefault(t, sf, bindings.name);
          if (reach) blockers.push({ file, node: reach, what: `namespace import \`${bindings.name.text}\`` });
        }
      } else if (t.isExportDeclaration(node) && node.moduleSpecifier && t.isStringLiteral(node.moduleSpecifier) && points(node.moduleSpecifier)) {
        const clause = node.exportClause;
        if (clause && t.isNamedExports(clause)) {
          const els = clause.elements.filter((e) => (e.propertyName ?? e.name).text === "default");
          if (els.length > 0) uses.push({ kind: "reexport", file, decl: node, els });
        } else if (clause && t.isNamespaceExport(clause)) {
          blockers.push({ file, node, what: `namespace re-export \`${clause.name.text}\`` });
        }
      } else if (t.isCallExpression(node) && node.expression.kind === t.SyntaxKind.ImportKeyword) {
        const [first] = node.arguments;
        if (first && t.isStringLiteralLike(first) && points(first)) blockers.push({ file, node, what: "dynamic import()" });
      } else if (t.isImportTypeNode(node) && t.isLiteralTypeNode(node.argument) && points(node.argument.literal)) {
        blockers.push({ file, node, what: "import() type" });
      } else if (
        t.isImportEqualsDeclaration(node) &&
        t.isExternalModuleReference(node.moduleReference) &&
        points(node.moduleReference.expression)
      ) {
        blockers.push({ file, node, what: "import = require()" });
      }
      t.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { uses, blockers };
}

// ---- edits ----

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return text.slice(lineStart, offset).match(/^[ \t]*/)?.[0] ?? "";
}

/** `start`…`end` of a whole statement, with its line when nothing else is on it. */
function wholeLine(text: string, start: number, end: number): { start: number; end: number } {
  const before = text.lastIndexOf("\n", start - 1) + 1;
  const after = text.slice(end).match(/^[ \t]*(\r?\n|$)/);
  if (text.slice(before, start).trim() === "" && after) return { start: before, end: end + after[0].length };
  return { start, end };
}

function skipSpace(text: string, from: number): number {
  return from + (text.slice(from).match(/^\s*/)?.[0].length ?? 0);
}

/** Whether the module already exports `name` as another entry for the same thing as its default. */
function namedExport(engine: TsEngine, file: string, name: string): "none" | "same" | "different" {
  const { program, sf } = engine.sourceFile(file);
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(sf);
  if (!module) return "none";
  const exports = checker.getExportsOfModule(module);
  const named = exports.find((s) => s.name === name);
  const def = exports.find((s) => s.name === "default");
  if (!named) return "none";
  if (!def) return "different";
  const target = (s: ts.Symbol): ts.Symbol => (s.flags & engine.ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const a = target(named);
  const b = target(def);
  return a === b || (a.declarations ?? []).some((d) => (b.declarations ?? []).includes(d)) ? "same" : "different";
}

/** The edits of the file that declares the default export. `named`: it already exports the name another way. */
function declarationEdits(engine: TsEngine, file: string, form: Form, named: boolean): Edit[] {
  const t = engine.ts;
  const text = engine.read(file) ?? "";
  const { program, sf } = engine.sourceFile(file);
  switch (form.kind) {
    case "anonymous":
      return [];
    case "modifier":
      return form.stmts.map((stmt) => {
        const mods = modifiersOf(t, stmt);
        const def = mods.find((m) => m.kind === t.SyntaxKind.DefaultKeyword) as ts.Modifier;
        const exp = mods.find((m) => m.kind === t.SyntaxKind.ExportKeyword) as ts.Modifier;
        const start = named ? exp.getStart(sf) : def.getStart(sf);
        return { start, end: skipSpace(text, def.getEnd()), text: "" };
      });
    case "assignment": {
      const start = form.stmt.getStart(sf);
      if (named) return [{ ...wholeLine(text, start, form.stmt.getEnd()), text: "" }];
      const symbol = program.getTypeChecker().getSymbolAtLocation(form.id);
      const target =
        symbol && symbol.flags & t.SymbolFlags.Alias ? program.getTypeChecker().getAliasedSymbol(symbol) : symbol;
      const typeOnly = target !== undefined && (target.flags & t.SymbolFlags.Value) === 0;
      return [{ start, end: form.stmt.getEnd(), text: `export ${typeOnly ? "type " : ""}{ ${form.name} };` }];
    }
    case "specifier": {
      const { el, decl } = form;
      const elements = (decl.exportClause as ts.NamedExports).elements;
      if (!named) return [{ start: el.getStart(sf), end: el.getEnd(), text: `${el.isTypeOnly ? "type " : ""}${form.name}` }];
      if (elements.length === 1) return [{ ...wholeLine(text, decl.getStart(sf), decl.getEnd()), text: "" }];
      const at = elements.indexOf(el);
      const next = elements[at + 1];
      const prev = elements[at - 1];
      if (next) return [{ start: el.getStart(sf), end: next.getStart(sf), text: "" }];
      return [{ start: (prev as ts.ExportSpecifier).getEnd(), end: el.getEnd(), text: "" }];
    }
  }
}

/** `Name` or `Name as local`, with `type ` when the element is type-only. */
function specifierText(name: string, local: string, typeOnly: boolean): string {
  return `${typeOnly ? "type " : ""}${name === local ? name : `${name} as ${local}`}`;
}

/** The edits of an importing or re-exporting file for one use. */
function useEdits(engine: TsEngine, use: Use, name: string): Edit[] {
  const t = engine.ts;
  const text = engine.read(use.file) ?? "";
  const { sf } = engine.sourceFile(use.file);
  const edits: Edit[] = [];

  if (use.kind === "reexport") {
    for (const el of use.els) {
      // `export { default }` keeps exporting `default` (the file's own API stays); `default as X` becomes `Name as X`.
      const exported = el.name.text;
      edits.push({ start: el.getStart(sf), end: el.getEnd(), text: specifierText(name, exported, el.isTypeOnly) });
    }
    return edits;
  }

  const decl = use.decl;
  const clause = decl.importClause as ts.ImportClause;
  const bindings = clause.namedBindings;
  const namedImports = bindings && t.isNamedImports(bindings) ? bindings : undefined;
  for (const el of namedImports?.elements ?? []) {
    if ((el.propertyName ?? el.name).text !== "default") continue;
    edits.push({ start: el.getStart(sf), end: el.getEnd(), text: specifierText(name, el.name.text, el.isTypeOnly) });
  }
  if (clause.name) {
    const local = clause.name.text;
    const spec = specifierText(name, local, false);
    if (!bindings) {
      edits.push({ start: clause.name.getStart(sf), end: clause.name.getEnd(), text: `{ ${spec} }` });
    } else if (namedImports) {
      const first = namedImports.elements[0];
      if (first) {
        edits.push({ start: clause.name.getStart(sf), end: bindings.getStart(sf), text: "" });
        edits.push({ start: first.getStart(sf), end: first.getStart(sf), text: `${spec}, ` });
      } else {
        edits.push({ start: clause.name.getStart(sf), end: bindings.getEnd(), text: `{ ${spec} }` });
      }
    } else {
      // `import local, * as ns from "m"` cannot hold both: two statements.
      const module = decl.moduleSpecifier.getText(sf);
      const ns = (bindings as ts.NamespaceImport).name.text;
      const indent = lineIndent(text, decl.getStart(sf));
      const semi = decl.getText(sf).endsWith(";") ? ";" : "";
      edits.push({
        start: decl.getStart(sf),
        end: decl.getEnd(),
        text: `import * as ${ns} from ${module}${semi}\n${indent}import { ${spec} } from ${module}${semi}`,
      });
    }
  }
  return edits;
}

function apply(text: string, edits: Edit[]): string {
  let out = text;
  // End first so earlier offsets stay valid; at the same start the replacement goes before the insertion.
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

// ---- the action ----

export type DefaultToNamedParams = { files: string[]; keep: string[] };

type MissKind =
  | { kind: "anonymous" }
  | { kind: "blocked" }
  | { kind: "different"; name: string }
  | { kind: "errors"; errors: string[] };

export const defaultToNamedAction: Action<DefaultToNamedParams, TsEngine> = {
  id: "default-to-named",
  kind: "sweep",
  summary: "Turns default exports into named exports, and switches their importers.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files whose default exports change, as comma-separated globs from the repo root." },
    { name: "--keep", type: "globs", required: false, description: "Files that keep their default export, as comma-separated globs." },
  ],
  parseParams: (raw) => ({
    files: globList(raw, "files"),
    keep: raw.keep === undefined || raw.keep === "" ? [] : globList(raw, "keep"),
  }),
  describe: (p) => p.files.join(", ") + (p.keep.length > 0 ? ` (keeping ${p.keep.join(", ")})` : ""),

  async run(engine, p) {
    const t = engine.ts;
    const candidates = (await matchFiles(engine.repoRoot, p.files)).filter(
      (f) => !/\.d\.[mc]?ts$/.test(f) && !matchesAnyGlob(f, p.keep),
    );
    const all = await listFiles(engine.repoRoot);
    const everything = all.filter((f) => TS_FILE.test(f)).sort(byString);
    const scripts = all.filter((f) => SCRIPT_FILE.test(f)).sort(byString);

    const converted: { file: string; name: string }[] = [];
    const importers = new Set<string>();
    const missed: { file: string; why: MissKind }[] = [];

    for (const file of candidates) {
      const form = findDefault(t, engine.sourceFile(file).sf);
      if (!form) continue;
      if (form.kind === "anonymous") {
        missed.push({ file, why: { kind: "anonymous" } });
        continue;
      }
      const { uses, blockers } = findUses(engine, file, everything, scripts);
      if (blockers.length > 0) {
        missed.push({ file, why: { kind: "blocked" } });
        continue;
      }
      const state = namedExport(engine, file, form.name);
      if (state === "different") {
        missed.push({ file, why: { kind: "different", name: form.name } });
        continue;
      }

      // Plan the edits of every touched file, write them, and keep them only if no file gains errors.
      const plans = new Map<string, Edit[]>();
      const add = (path: string, edits: Edit[]): void => {
        plans.set(path, [...(plans.get(path) ?? []), ...edits]);
      };
      add(file, declarationEdits(engine, file, form, state === "same"));
      for (const use of uses) add(use.file, useEdits(engine, use, form.name));
      const touched = [...plans.keys()].sort(byString);
      const originals = new Map(touched.map((f) => [f, engine.read(f) ?? ""]));
      const before = new Map(touched.map((f) => [f, diagnostics(engine, f)]));
      for (const path of touched) engine.write(path, apply(originals.get(path) as string, plans.get(path) as Edit[]));
      const errors = touched.flatMap((f) =>
        introduced(before.get(f) as string[], diagnostics(engine, f)).map((e) => `${f}: ${e}`),
      );
      if (errors.length > 0) {
        for (const [path, text] of originals) engine.write(path, text);
        missed.push({ file, why: { kind: "errors", errors } });
        continue;
      }
      converted.push({ file, name: form.name });
      for (const use of uses) importers.add(use.file);
    }

    const misses = missed.map(({ file, why }) => missFor(engine, file, why, everything, scripts));

    if (converted.length === 0) {
      if (misses.length === 0) {
        throw new RefactorError(
          "NO_CHANGES",
          `No file matching ${p.files.join(", ")}${p.keep.length > 0 ? ` (outside ${p.keep.join(", ")})` : ""} has a default export to convert.`,
        );
      }
      // Nothing convertible is left (a rerun after a partial result lands here): like the other sweeps, NO_CHANGES.
      throw new RefactorError(
        "NO_CHANGES",
        `No default export can be converted; these files were skipped:\n${misses
          .map((m) => `- ${m.path}: ${m.reason}. ${m.instructions}`)
          .join("\n")}`,
      );
    }

    const lines = converted.map((c) => `${c.file}: \`${c.name}\``);
    const s = converted.length === 1 ? "" : "s";
    const done =
      `Converted the default export${s} of ${plural(converted.length, "file")} to named export${s}` +
      `${importers.size > 0 ? ` and updated ${plural(importers.size, "importing file")}` : ""}:\n${listLines(lines)}`;
    return { summary: misses.length > 0 ? `${done}\n\n${notHandled(misses)}` : done };
  },
};

/** A file left alone, with positions read from the files as they are after all edits. */
function missFor(engine: TsEngine, file: string, why: MissKind, everything: string[], scripts: string[]): NotHandled {
  const t = engine.ts;
  const form = findDefault(t, engine.sourceFile(file).sf) as Form;
  const { path, line } = engine.location(anchorOf(form));
  switch (why.kind) {
    case "anonymous": {
      const how =
        form.kind === "anonymous" && form.what === "expression"
          ? "Assign it to a named const first (`const name = …; export default name;`)"
          : `Give the ${form.kind === "anonymous" ? form.what : "export"} a name (\`export default ${form.kind === "anonymous" && form.what === "class" ? "class" : "function"} name\`)`;
      return {
        path,
        line,
        reason: "the default export has no name to give a named export",
        instructions: `${how} in ${file}, then run again.`,
      };
    }
    case "blocked": {
      const name = (form as { name: string }).name;
      const { blockers } = findUses(engine, file, everything, scripts);
      const places = blockers.map((b) => {
        const l = engine.location(b.node);
        return `- ${l.path}:${l.line} (${b.what})`;
      });
      return {
        path,
        line,
        reason: "the default export is still needed where it is loaded (import(), a namespace, JavaScript or a mock)",
        instructions:
          `${file} stays as it is because these places need its default export:\n${places.join("\n")}\n` +
          `Change each to use the named export \`${name}\` by hand (for a lazy import: ` +
          `\`import("…").then((m) => ({ default: m.${name} }))\`), then run again.`,
      };
    }
    case "different":
      return {
        path,
        line,
        reason: `${file} already exports a different \`${why.name}\``,
        instructions: `Rename one of the two \`${why.name}\` exports in ${file}, then run again.`,
      };
    case "errors":
      return {
        path,
        line,
        reason: "converting it would introduce type errors",
        instructions:
          `Converting ${file} and its importers would introduce:\n${why.errors.map((e) => `- ${e}`).join("\n")}\n` +
          `Fix the cause by hand or leave ${file} out of --files, then run again.`,
      };
  }
}
