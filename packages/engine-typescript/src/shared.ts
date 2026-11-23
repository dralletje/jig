import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { RefactorError, listFiles, matchesAnyGlob } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";

/** Refuses with `REFACTOR_UNAVAILABLE`; `instructions` say why and what to do first. */
export function unavailable(instructions: string): never {
  throw new RefactorError("REFACTOR_UNAVAILABLE", instructions);
}

/** `a`, `a` and `b`, `a`, `b` and `c`, each in backticks: names in a summary. */
export function names(items: string[]): string {
  const quoted = items.map((i) => `\`${i}\``);
  return quoted.length <= 1 ? (quoted[0] ?? "") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** A place a partial result left as it was: where, why, and what the reader should do about it. */
export type NotHandled = { path: string; line: number; reason: string; instructions: string };

/**
 * The block a partial result ends its summary with, every place listed:
 *
 *     Not handled (2):
 *       src/a.ts:3: why it was left
 *         what to do
 */
export function notHandled(places: NotHandled[]): string {
  const lines = [`Not handled (${places.length}):`];
  for (const place of places) {
    lines.push(`  ${place.path}:${place.line}: ${place.reason}`);
    for (const line of place.instructions.split("\n")) lines.push(`    ${line}`);
  }
  return lines.join("\n");
}

export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The file's syntactic and semantic errors, as `TS<code>: <message>`. */
export function diagnostics(engine: TsEngine, file: string): string[] {
  const { program, sf } = engine.sourceFile(file);
  return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map(
    (d) => `TS${d.code}: ${engine.ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
  );
}

/** The errors in `after` that were not in `before` (counted: one of two identical errors is new). */
export function introduced(before: string[], after: string[]): string[] {
  const out = [...after];
  for (const d of before) {
    const at = out.indexOf(d);
    if (at >= 0) out.splice(at, 1);
  }
  return out;
}

/** TypeScript source files: what a project holds. */
export const TS_FILE = /\.(m|c)?tsx?$/;

/** TypeScript files under the root matching any of the globs, sorted. Fails when nothing matches. */
export async function matchFiles(root: string, globs: string[]): Promise<string[]> {
  const files = (await listFiles(root)).filter((f) => TS_FILE.test(f) && matchesAnyGlob(f, globs));
  if (files.length === 0) {
    throw new RefactorError(
      "NO_CHANGES",
      `No TypeScript file matches ${globs.join(", ")}. Globs are matched against the committed files from the repo root (for example "src/**").`,
    );
  }
  return files;
}

export const PREFERENCES: ts.UserPreferences = {
  allowTextChangesInNewFiles: true,
  quotePreference: "auto",
};

export function required(raw: Record<string, string | undefined>, key: string): string {
  const v = raw[key];
  if (v === undefined || v === "") throw new RefactorError("INVALID_ARGS", `Missing --${key}. Pass it and run again.`);
  return v;
}

/** A comma-separated `--key` value as a non-empty list. */
export function list(raw: Record<string, string | undefined>, key: string): string[] {
  const items = required(raw, key)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) throw new RefactorError("INVALID_ARGS", `--${key} is empty. Pass a comma-separated list.`);
  return items;
}

// ---- import specifiers: shared by the imports-to-* sweeps and relocate ----

/** How a specifier is written. `package` is everything that is not one of the three styles. */
export type Style = "relative" | "alias" | "subpath" | "package";

/**
 * What the specifier helpers read files through: the engine, or a view of the world after a change.
 * `read` takes a root-relative path; `absPath` and `relPath` convert as the engine's do.
 */
export type Reader = {
  read: (rel: string) => string | null;
  absPath: (file: string) => string;
  relPath: (file: string) => string;
};

/** The specifier literals of every import form in the file. */
export function importSpecifiers(t: typeof import("typescript"), sf: ts.SourceFile): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if ((t.isImportDeclaration(node) || t.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (t.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier);
    } else if (t.isImportEqualsDeclaration(node) && t.isExternalModuleReference(node.moduleReference)) {
      if (t.isStringLiteral(node.moduleReference.expression)) out.push(node.moduleReference.expression);
    } else if (t.isCallExpression(node) && node.expression.kind === t.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first && t.isStringLiteralLike(first)) out.push(first);
    } else if (
      t.isCallExpression(node) &&
      t.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      const [first] = node.arguments;
      if (first && t.isStringLiteralLike(first)) out.push(first);
    } else if (t.isImportTypeNode(node) && t.isLiteralTypeNode(node.argument) && t.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal);
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Whether a `paths` key (`@/*`, or an exact `@config`) matches the specifier. */
export function matchesPathsKey(key: string, specifier: string): boolean {
  const star = key.indexOf("*");
  if (star === -1) return specifier === key;
  const before = key.slice(0, star);
  const after = key.slice(star + 1);
  return specifier.length >= before.length + after.length && specifier.startsWith(before) && specifier.endsWith(after);
}

/** The wildcard key of `keys` that matches the specifier with the longest part before its `*`, as TypeScript and Node pick it. */
export function bestWildcardKey(keys: string[], specifier: string): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    if (!key.includes("*") || !matchesPathsKey(key, specifier)) continue;
    if (best === undefined || key.indexOf("*") > best.indexOf("*")) best = key;
  }
  return best;
}

/**
 * How the specifier is written. A bare specifier that only a catch-all `"*"` paths key matches is a
 * package, not an alias.
 */
export function styleOf(specifier: string, options: ts.CompilerOptions): Style {
  if (/^\.\.?(\/|$)/.test(specifier)) return "relative";
  if (specifier.startsWith("#")) return "subpath";
  if (Object.keys(options.paths ?? {}).some((key) => key !== "*" && matchesPathsKey(key, specifier))) return "alias";
  return "package";
}

/** The nearest package.json at or above the file, root-relative: the one Node and TypeScript read "imports" from. */
export function nearestPackageJson(reader: Reader, file: string): string | null {
  let folder = dirname(reader.relPath(file));
  while (true) {
    const candidate = folder === "." ? "package.json" : `${folder}/package.json`;
    if (reader.read(candidate) !== null) return candidate;
    if (folder === ".") return null;
    folder = dirname(folder);
  }
}

/** The `imports` object of a package.json, or null when it has none or is not valid JSON. */
export function importsOf(reader: Reader, packageJson: string): Record<string, unknown> | null {
  let json: unknown;
  try {
    json = JSON.parse(reader.read(packageJson) ?? "");
  } catch {
    return null;
  }
  const imports = json !== null && typeof json === "object" ? (json as Record<string, unknown>).imports : undefined;
  return imports !== null && typeof imports === "object" ? (imports as Record<string, unknown>) : null;
}

/** Whether an alias or subpath specifier uses an exact (non-wildcard) key of the tsconfig paths or the package.json imports. */
export function usesExactKey(reader: Reader, file: string, specifier: string, style: Style, options: ts.CompilerOptions): boolean {
  if (style === "alias") return Object.keys(options.paths ?? {}).some((key) => !key.includes("*") && key === specifier);
  if (style !== "subpath") return false;
  const packageJson = nearestPackageJson(reader, file);
  const imports = packageJson === null ? null : importsOf(reader, packageJson);
  return imports !== null && !specifier.includes("*") && Object.hasOwn(imports, specifier);
}

/**
 * The absolute paths the old specifier names, before any file lookup: the relative path from the importer,
 * or the alias's / subpath's wildcard key with its `*` filled in. Null when that cannot be told.
 */
export function namedPaths(reader: Reader, file: string, specifier: string, style: Style, options: ts.CompilerOptions): string[] | null {
  if (style === "relative") return [resolve(dirname(reader.absPath(file)), specifier)];
  if (style === "alias") {
    const key = bestWildcardKey(Object.keys(options.paths ?? {}), specifier);
    const base = options.baseUrl ?? options.pathsBasePath;
    if (key === undefined || typeof base !== "string") return null;
    const star = specifier.slice(key.indexOf("*"), specifier.length - (key.length - key.indexOf("*") - 1));
    return (options.paths?.[key] ?? []).map((target) => resolve(base, target.replace("*", star)));
  }
  if (style === "subpath") {
    const packageJson = nearestPackageJson(reader, file);
    const imports = packageJson === null ? null : importsOf(reader, packageJson);
    if (packageJson === null || imports === null) return null;
    const key = bestWildcardKey(Object.keys(imports), specifier);
    const value = key === undefined ? undefined : imports[key];
    if (key === undefined || typeof value !== "string" || !value.startsWith("./")) return null;
    const star = specifier.slice(key.indexOf("*"), specifier.length - (key.length - key.indexOf("*") - 1));
    return [resolve(reader.absPath(dirname(packageJson)), value.replace("*", star))];
  }
  return null;
}

/** A file name without its extension; `.d.ts`, `.d.mts` and `.d.cts` count as one extension. */
export function stem(name: string): string {
  const declaration = /\.d\.[mc]?ts$/.exec(name);
  if (declaration) return name.slice(0, declaration.index);
  const ext = extname(name);
  return ext === "" ? name : name.slice(0, -ext.length);
}

/**
 * The absolute path the new specifier names, in the form the old `specifier` names its resolved `target`:
 * the file itself, the file without its extension, the file with the specifier's extension (`./a.js` for
 * `a.ts`), the folder of an index file, or the file a `<name>.d.<ext>.ts` declares (`./theme.css` for
 * `theme.d.css.ts`). Null when the form cannot be told (an exact `paths` key).
 */
export function spelledPath(specifier: string, target: string): string | null {
  const last = specifier.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const file = basename(target);
  const folder = dirname(target);
  if (last === file) return target;
  // allowArbitraryExtensions: `theme.d.css.ts` declares `theme.css`, and imports name the CSS file.
  const declared = /^(.+)\.d\.([^.]+)\.ts$/.exec(file);
  if (declared && !["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"].includes(declared[2] ?? "")) {
    const declaredFile = `${declared[1]}.${declared[2]}`;
    if (last === declaredFile) return join(folder, declaredFile);
  }
  if (last === stem(file)) return join(folder, stem(file));
  const ext = extname(last);
  if (ext !== "" && last.slice(0, -ext.length) === stem(file)) return join(folder, `${stem(file)}${ext}`);
  if (stem(file) === "index") return folder;
  return null;
}

/** `/`-separated relative path. */
export function slashed(path: string): string {
  return path.split(sep).join("/");
}

export function outside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/** The place `--at <path>:<line>[:<column>]` names, 1-based. */
export type At = { path: string; line: number; column?: number };

/** `<path>:<line>[:<column>]` as a string, for messages. */
export function atText(file: string, at: { line: number; column?: number }): string {
  return `${file}:${at.line}${at.column === undefined ? "" : `:${at.column}`}`;
}

/** Parses `--at <path>:<line>[:<column>]` (1-based numbers); anything else is `INVALID_ARGS`. */
export function parseAt(raw: string): At {
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(raw);
  const line = match ? Number(match[2]) : 0;
  const column = match?.[3] === undefined ? undefined : Number(match[3]);
  if (!match || line < 1 || (column !== undefined && column < 1)) {
    throw new RefactorError(
      "INVALID_ARGS",
      `--at must be <path>:<line>[:<column>] with 1-based numbers, not ${JSON.stringify(raw)}. Pass for example --at src/a.ts:12 or --at src/a.ts:12:20.`,
    );
  }
  return { path: match[1] as string, line, ...(column === undefined ? {} : { column }) };
}

/** A node `--at` may name: the span `start`…`end` (a column inside it picks it); `label` names it in messages. */
export type AtCandidate<T> = {
  item: T;
  start: number;
  end: number;
  label?: string;
  /** Another offset whose line also counts as a line the candidate starts on. */
  startAlt?: number;
};

/**
 * The candidate `at` names in `file` (root-relative, `sf` its source file):
 * - a line or column outside the file is `INVALID_ARGS`;
 * - with a column: the smallest candidate whose span holds it;
 * - without: the one candidate that starts on the line (`outermost`: candidates inside another candidate
 *   of that line do not count), and several is `INVALID_ARGS` asking for a column;
 * - none is `REFACTOR_UNAVAILABLE`, saying what to point at (`hint`).
 * `what` and `plural` are the noun phrase for one and for several candidates in messages ("variable name", "variable names").
 */
export function findAt<T>(
  sf: ts.SourceFile,
  file: string,
  at: At,
  candidates: AtCandidate<T>[],
  options: { what: string; plural: string; hint: string; outermost?: boolean },
): T {
  const starts = sf.getLineStarts();
  const where = atText(file, at);
  if (at.line > starts.length) {
    throw new RefactorError("INVALID_ARGS", `${file} has ${starts.length} lines, not ${at.line}. Pass a line within the file.`);
  }
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const columnOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).character + 1;
  let found: AtCandidate<T>[];
  if (at.column === undefined) {
    const onLine = candidates.filter((c) => lineOf(c.start) === at.line || (c.startAlt !== undefined && lineOf(c.startAlt) === at.line));
    found = options.outermost
      ? onLine.filter((n) => !onLine.some((o) => o !== n && o.start <= n.start && n.end <= o.end && (o.start < n.start || n.end < o.end)))
      : onLine;
  } else {
    const lineStart = starts[at.line - 1] as number;
    const lineEnd = at.line < starts.length ? (starts[at.line] as number) : sf.end;
    const offset = lineStart + at.column - 1;
    if (offset >= Math.max(lineEnd, lineStart + 1)) {
      throw new RefactorError("INVALID_ARGS", `Line ${file}:${at.line} has no column ${at.column}. Pass a column within the line.`);
    }
    found = candidates.filter((c) => c.start <= offset && offset < c.end).sort((a, b) => a.end - a.start - (b.end - b.start)).slice(0, 1);
  }
  if (found.length === 0) {
    throw new RefactorError(
      "REFACTOR_UNAVAILABLE",
      `There is no ${options.what} ${at.column === undefined ? "starting on line" : "at"} ${where}. ${options.hint}`,
    );
  }
  if (found.length > 1) {
    const labelled = found.every((c) => c.label !== undefined);
    const list = labelled
      ? found.map((c) => `${c.label} at column ${columnOf(c.start)}`).join(", ")
      : `at columns ${found.map((c) => columnOf(c.start)).join(", ")}`;
    throw new RefactorError(
      "INVALID_ARGS",
      `Line ${file}:${at.line} has ${found.length} ${options.plural} (${list}). Pass a column to pick one: --at ${file}:${at.line}:<column>.`,
    );
  }
  return (found[0] as AtCandidate<T>).item;
}
