import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { Project, TsEngine } from "./engine.ts";
import { byString, diagnostics, list as globList, introduced, matchFiles, notHandled, unavailable } from "./shared.ts";
import type { NotHandled } from "./shared.ts";

/**
 * typescript-subpath-imports: imports through a tsconfig `paths` alias (`@/x` with `"@/*": ["./src/*"]`)
 * become Node subpath imports (`#/x`), and the package.json next to the tsconfig gets
 * `"imports": { "#/*": "./src/*" }` (merged with the `imports` it has). The `paths` entry stays.
 *
 * A sweep: an alias specifier that does not resolve, points outside the alias folder, has no spelling the project
 * resolves, or a file that would gain diagnostics, is listed in the summary as not handled; the others proceed. Each specifier
 * keeps the extension style the project can resolve: as written, else `.js`-style, else `.ts` only with
 * `allowImportingTsExtensions`. Not handled: `require("@/x")`, `import x = require(…)`, and `.js` files using the alias.
 */

const DEFAULT_ALIAS = "@/";

/** One specifier rewrite: `from` → `to` (without quotes), replacing `text` at `start`…`end`. */
type Edit = { start: number; end: number; text: string };

/** What one project needs: its alias folder, and the package.json to write (null when it has the mapping). */
type Plan = {
  /** Absolute folder the alias points at. */
  targetDir: string;
  /** Root-relative package.json. */
  packageJson: string;
  /** The package.json text to write, or null when `imports` already maps the key. */
  packageText: string | null;
  key: string;
  value: string;
};

/** `@/` → `#/`, `@app/` → `#app/`, `~/` → `#/`: the subpath prefix an alias becomes. */
function subpathPrefix(alias: string): string {
  return `#${/^[@~]/.test(alias) ? alias.slice(1) : alias}`;
}

/** The module specifiers of imports, re-exports, dynamic `import()`s and `import("…")` types that start with the alias. */
function aliased(t: TsEngine["ts"], sf: ts.SourceFile, alias: string): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if ((t.isImportDeclaration(node) || t.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (t.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier);
    } else if (t.isCallExpression(node) && node.expression.kind === t.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first && t.isStringLiteralLike(first)) out.push(first);
    } else if (t.isImportTypeNode(node) && t.isLiteralTypeNode(node.argument) && t.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal);
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return out.filter((s) => s.text.startsWith(alias) && s.text.length > alias.length);
}

// ---- package.json ----

function propertyName(t: TsEngine["ts"], p: ts.ObjectLiteralElementLike): string | undefined {
  return t.isPropertyAssignment(p) && (t.isStringLiteral(p.name) || t.isIdentifier(p.name)) ? p.name.text : undefined;
}

const line = (json: ts.JsonSourceFile, pos: number): number => json.getLineAndCharacterOfPosition(pos).line;

/** `entry` added as the last property of `obj`, on its own line indented as the others, or inline. */
function addProperty(json: ts.JsonSourceFile, obj: ts.ObjectLiteralExpression, entry: string): string {
  const text = json.text;
  const last = obj.properties.at(-1);
  if (!last) {
    const open = obj.getStart(json);
    const inner = text.slice(open + 1, obj.getEnd() - 1);
    return inner.trim() === ""
      ? `${text.slice(0, open)}{ ${entry} }${text.slice(obj.getEnd())}`
      : `${text.slice(0, open + 1)} ${entry}${text.slice(open + 1)}`;
  }
  const lastStart = last.getStart(json);
  let insert: string;
  if (line(json, obj.getStart(json)) === line(json, lastStart)) {
    insert = `, ${entry}`;
  } else {
    const lineStart = json.getPositionOfLineAndCharacter(line(json, lastStart), 0);
    insert = `,\n${text.slice(lineStart, lastStart).match(/^[ \t]*/)?.[0] ?? ""}${entry}`;
  }
  return text.slice(0, last.getEnd()) + insert + text.slice(last.getEnd());
}

/**
 * The package.json text with `"key": "value"` in its `imports`, null when it is already there. Refuses
 * when `imports` maps the key to something else, or is not an object.
 */
function withImport(engine: TsEngine, packageJson: string, key: string, value: string): string | null {
  const t = engine.ts;
  const text = engine.read(packageJson) ?? "";
  const json = t.parseJsonText(packageJson, text);
  const root = json.statements[0]?.expression;
  if (t.parseConfigFileTextToJson(packageJson, text).error || !root || !t.isObjectLiteralExpression(root)) {
    unavailable(`${packageJson} is not a JSON object. Fix it, then run again.`);
  }
  const imports = root.properties.find((p) => propertyName(t, p) === "imports");
  const entry = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  if (!imports) {
    const last = root.properties.at(-1);
    const multiline = last !== undefined && line(json, root.getStart(json)) !== line(json, last.getStart(json));
    if (!multiline) return addProperty(json, root, `"imports": { ${entry} }`);
    const lineStart = json.getPositionOfLineAndCharacter(line(json, last.getStart(json)), 0);
    const indent = text.slice(lineStart, last.getStart(json)).match(/^[ \t]*/)?.[0] ?? "";
    return addProperty(json, root, `"imports": {\n${indent}${indent}${entry}\n${indent}}`);
  }
  if (!t.isPropertyAssignment(imports) || !t.isObjectLiteralExpression(imports.initializer)) {
    return unavailable(`${packageJson}: "imports" is not an object. Fix it, then run again.`);
  }
  const existing = imports.initializer.properties.find((p) => propertyName(t, p) === key);
  if (existing) {
    const same = t.isPropertyAssignment(existing) && t.isStringLiteral(existing.initializer) && existing.initializer.text === value;
    if (same) return null;
    return unavailable(
      `${packageJson}: "imports" already maps ${JSON.stringify(key)} to something other than ${JSON.stringify(value)}. ` +
        `Change that mapping or pass another --alias, then run again.`,
    );
  }
  return addProperty(json, imports.initializer, entry);
}

// ---- the project ----

/** The alias's folder and the package.json change for the project, or null when it has no `paths` entry for the alias. */
function planProject(engine: TsEngine, project: Project, alias: string, file: string): Plan | null {
  const options = project.service.getProgram()?.getCompilerOptions() ?? {};
  const pattern = `${alias}*`;
  const targets = options.paths?.[pattern];
  if (!targets) return null;
  if (project.tsconfig === null) return null;
  const tsconfig = project.tsconfig;
  if (targets.length !== 1 || !targets[0]?.endsWith("/*")) {
    unavailable(
      `${tsconfig}: paths ${JSON.stringify(pattern)} must have exactly one target of the form "<folder>/*" (it is ` +
        `${JSON.stringify(targets)}). Change it to one folder, or pass another --alias, then run again.`,
    );
  }
  const base = options.baseUrl ?? options.pathsBasePath;
  if (typeof base !== "string") unavailable(`${tsconfig}: cannot tell what its paths are relative to. Set baseUrl or fix the file, then run again.`);
  const targetDir = resolve(base, (targets[0] as string).slice(0, -2));
  const packageFolder = engine.absPath(project.folder);
  const inside = relative(packageFolder, targetDir);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    unavailable(
      `${file}: ${alias} points at ${engine.relPath(targetDir)}, outside the package folder ${project.folder}, and a ` +
        `subpath import cannot leave its package. Keep the alias for it, or move the folder into the package, then run again.`,
    );
  }
  const packageJson = project.folder === "." ? "package.json" : `${project.folder}/package.json`;
  if (engine.read(packageJson) === null) {
    unavailable(`${tsconfig}: there is no package.json next to it to hold "imports". Add one, then run again.`);
  }
  const key = `${subpathPrefix(alias)}*`;
  const value = `./${inside === "" ? "" : `${inside.split(sep).join("/")}/`}*`;
  return { targetDir, packageJson, packageText: withImport(engine, packageJson, key, value), key, value };
}

/** Module resolution that sees the engine's current files and the package.json texts still to be written. */
function resolutionHost(engine: TsEngine, pending: Map<string, string>): ts.ModuleResolutionHost {
  const t = engine.ts;
  const inRoot = (p: string): boolean => engine.relPath(p) !== p;
  return {
    fileExists: (p) => (inRoot(p) ? (pending.get(engine.relPath(p)) ?? engine.read(p)) !== null : t.sys.fileExists(p)),
    readFile: (p) => (inRoot(p) ? (pending.get(engine.relPath(p)) ?? engine.read(p) ?? undefined) : t.sys.readFile(p)),
    directoryExists: (p) => t.sys.directoryExists(p),
    realpath: (p) => t.sys.realpath?.(p) ?? p,
    getCurrentDirectory: () => engine.repoRoot,
  };
}

type Planned = { file: string; edits: Edit[]; before: string[] };

/** The extension a specifier uses for a file with extension `ext` when `allowImportingTsExtensions` is off. */
const JS_EXTENSION: Record<string, string> = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };

/** The edits for one file's alias specifiers, and the specifiers that could not be rewritten. */
function planFile(
  engine: TsEngine,
  file: string,
  alias: string,
  plans: Map<string, Plan | null>,
  pending: Map<string, string>,
): { edits: Edit[]; misses: NotHandled[] } {
  const t = engine.ts;
  const { program, sf } = engine.sourceFile(file);
  const specifiers = aliased(t, sf, alias);
  const edits: Edit[] = [];
  const misses: NotHandled[] = [];
  if (specifiers.length === 0) return { edits, misses };
  const project = engine.project(file);
  if (!plans.has(project.folder)) {
    const plan = planProject(engine, project, alias, file);
    plans.set(project.folder, plan);
    if (plan?.packageText != null) pending.set(plan.packageJson, plan.packageText);
  }
  const plan = plans.get(project.folder);
  if (!plan) return { edits, misses };

  const options = program.getCompilerOptions();
  const host = resolutionHost(engine, pending);
  const from = engine.absPath(file);
  const prefix = subpathPrefix(alias);
  for (const specifier of specifiers) {
    const miss = (reason: string, instructions: string): void => {
      const { path, line } = engine.locationAt(file, specifier.getStart(sf));
      misses.push({ path, line, reason, instructions });
    };
    const mode = t.getModeForUsageLocation(sf, specifier, options);
    const resolve = (name: string): string | undefined =>
      t.resolveModuleName(name, from, options, host, undefined, undefined, mode).resolvedModule?.resolvedFileName;
    const target = resolve(specifier.text);
    if (target === undefined) {
      miss(
        `${JSON.stringify(specifier.text)} does not resolve`,
        `Fix or remove the import of ${JSON.stringify(specifier.text)} in ${file}, or leave it as it is.`,
      );
      continue;
    }
    if (relative(plan.targetDir, target).startsWith("..")) {
      miss(
        `${JSON.stringify(specifier.text)} resolves outside ${engine.relPath(plan.targetDir)}`,
        `${JSON.stringify(specifier.text)} in ${file} does not point into the alias folder, so it cannot become a subpath import. Leave it as it is.`,
      );
      continue;
    }
    const rest = specifier.text.slice(alias.length);
    const bare = rest.replace(/\/+$/, "");
    const ext = extname(target);
    // What the project can resolve: as written first (extensionless stays extensionless when it resolves), then
    // the JavaScript extension, then the file's own extension only when the project allows importing it.
    const exts = [JS_EXTENSION[ext] ?? ext];
    if (options.allowImportingTsExtensions && !exts.includes(ext)) exts.push(ext);
    const candidates = [
      ...new Set([`${prefix}${rest}`, ...exts.flatMap((e) => [`${prefix}${bare}${e}`, `${prefix}${bare}/index${e}`])]),
    ];
    const candidate = candidates.find((c) => resolve(c) === target);
    if (candidate === undefined) {
      miss(
        `${JSON.stringify(specifier.text)} would not resolve to the same file as a subpath import`,
        `Tried ${candidates.map((c) => JSON.stringify(c)).join(", ")} with "imports" ${JSON.stringify(plan.key)}: ` +
          `${JSON.stringify(plan.value)}. Subpath imports need moduleResolution "bundler", "node16" or "nodenext", ` +
          `and no nearer package.json between ${file} and ${plan.packageJson}. Fix that, or leave this import as it is.`,
      );
      continue;
    }
    const quote = specifier.getText(sf).charAt(0);
    if (candidate.includes(quote) || candidate.includes("\\") || (quote === "`" && candidate.includes("${"))) {
      miss(
        `${JSON.stringify(candidate)} cannot be written inside ${quote} quotes`,
        `Change the quotes of ${JSON.stringify(specifier.text)} in ${file} by hand, then run again.`,
      );
      continue;
    }
    edits.push({
      start: specifier.getStart(sf),
      end: specifier.getEnd(),
      text: `${quote}${candidate}${quote}`,
    });
  }
  return { edits, misses };
}

// ---- the action ----

export type SubpathImportsParams = { files: string[]; alias: string };

export const subpathImportsAction: Action<SubpathImportsParams, TsEngine> = {
  id: "typescript-subpath-imports",
  kind: "sweep",
  parseParams: (raw) => {
    const files = globList(raw, "files");
    const alias = raw.alias === undefined || raw.alias === "" ? DEFAULT_ALIAS : raw.alias;
    if (!alias.endsWith("/") || /["'`\\\s]/.test(alias)) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--alias ${JSON.stringify(alias)} must be the prefix of the tsconfig paths pattern up to its "*", ending in "/" (for example "@/"). Pass it and run again.`,
      );
    }
    return { files, alias };
  },
  describe: (p) => p.files.join(", ") + (p.alias === DEFAULT_ALIAS ? "" : ` (${p.alias})`),

  async run(engine, p) {
    // Plan everything first; a specifier or file that cannot be rewritten is not handled, the others proceed.
    const plans = new Map<string, Plan | null>();
    const pending = new Map<string, string>();
    const planned: Planned[] = [];
    const misses: NotHandled[] = [];
    for (const file of await matchFiles(engine.repoRoot, p.files)) {
      const found = planFile(engine, file, p.alias, plans, pending);
      misses.push(...found.misses);
      if (found.edits.length > 0) planned.push({ file, edits: found.edits, before: diagnostics(engine, file) });
    }

    // package.json first: the files are checked against it.
    const originalPackages = new Map<string, string | null>();
    for (const plan of plans.values()) {
      if (!plan || plan.packageText === null) continue;
      originalPackages.set(plan.packageJson, engine.read(plan.packageJson));
      engine.write(plan.packageJson, plan.packageText);
    }
    const done: Planned[] = [];
    const originals = new Map<string, string>();
    for (const item of planned) {
      const { file, edits } = item;
      const original = engine.read(file) ?? "";
      originals.set(file, original);
      let text = original;
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      engine.write(file, text);
      const errors = introduced(item.before, diagnostics(engine, file));
      if (errors.length === 0) {
        done.push(item);
        continue;
      }
      engine.write(file, original);
      const { path, line } = engine.locationAt(file, edits[0]?.start ?? 0);
      misses.push({
        path,
        line,
        reason: `rewriting the alias imports would introduce errors: ${errors.join("; ")}`,
        instructions: `Fix the imports of ${file} by hand, or leave the file as it is.`,
      });
    }

    const packages: string[] = [];
    const used = new Set(done.map((x) => engine.project(x.file).folder));
    const mappings: string[] = [];
    for (const folder of [...plans.keys()].sort(byString)) {
      const plan = plans.get(folder);
      if (!plan || plan.packageText === null) continue;
      if (!used.has(folder)) {
        engine.write(plan.packageJson, originalPackages.get(plan.packageJson) ?? "");
        continue;
      }
      packages.push(plan.packageJson);
      mappings.push(`\`${plan.key}\`: \`${plan.value}\``);
    }
    if (done.length === 0 && misses.length > 0) {
      throw new RefactorError(
        "NO_CHANGES",
        `No \`${p.alias}\` import could be rewritten in ${p.files.join(", ")}. Skipped:\n${misses
          .map((m) => `${m.path}:${m.line}: ${m.reason}. ${m.instructions}`)
          .join("\n")}`,
      );
    }
    const specifiers = done.reduce((n, plan) => n + plan.edits.length, 0);
    return {
      summary:
        `Rewrote ${plural(specifiers, `\`${p.alias}\` import`)} to subpath imports in ${plural(done.length, "file")}` +
        (mappings.length > 0 ? `, and added ${mappings.join(", ")} to "imports" in ${packages.join(", ")}` : "") +
        `:\n${listLines(done.map((x) => x.file))}` +
        (misses.length > 0 ? `\n\n${notHandled(misses)}` : ""),
    };
  },
};
