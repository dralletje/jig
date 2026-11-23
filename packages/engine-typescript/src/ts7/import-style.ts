import { dirname, relative, resolve, sep } from "node:path";
import { RefactorError, listLines, matchesAnyGlob, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type * as ast7 from "typescript7/ast";
import { createFileSystemLayer } from "typescript7/fs";
import { API } from "typescript7/sync";
import type {
  CompilerOptions,
  Diagnostic,
  ModuleResolver,
  Program,
  ProjectId,
  ResolutionMode,
  ResolveModuleNameResult,
  Snapshot,
} from "typescript7/sync";
import type { TsEngine } from "../engine.ts";
import {
  list as globList,
  importsOf,
  introduced,
  matchFiles,
  namedPaths,
  nearestPackageJson,
  notHandled,
  outside,
  slashed,
  spelledPath,
  styleOf,
  TS_FILE,
  unavailable,
  usesExactKey,
} from "../shared.ts";
import type { NotHandled, PathsOptions } from "../shared.ts";
import { importSpecifiers7 } from "./shared.ts";

/**
 * imports-to-relative, imports-to-alias, imports-to-subpath: import specifiers in `--files` that resolve to
 * a file matching `--targets` are written in another style, each still resolving to the same file:
 * relative (`../lib/date`), a tsconfig `paths` alias (`@/lib/date`) or a package.json `imports` subpath
 * (`#/lib/date`).
 *
 * Specifiers come from `import`/`export … from` (type-only too), `import()`, `import x = require()`,
 * `require()` and `import("…")` types. Each is resolved with TypeScript's module resolution under the
 * importing file's project. Parsing, resolution and the check for new errors run on TypeScript 7.1's API (the
 * native compiler, see `Sweep7`), not on the engine's TypeScript 6 language service. The style of a specifier: relative (`./`, `../`), subpath (`#…`), alias (a
 * `paths` key of the project other than a catch-all `"*"` matches it), else a package, which never changes;
 * neither does anything that resolves into `node_modules` or as an external library. A specifier already in
 * the target style is left as it is (an alias stays an alias, whatever its prefix). One through an exact
 * (non-wildcard) `paths` or `imports` key is left alone and named.
 *
 * The new specifier keeps the old one's extension form: the file name (`./a.ts`), the name without its
 * extension (`./a`), a JavaScript extension for a TypeScript file (`./a.js`), or a folder for its index file
 * (`./lib`). The old specifier must name that same path (only its prefix changes: a folder whose package.json
 * points TypeScript at a declaration file elsewhere does not qualify), and the new one must resolve to the
 * same file, or the import is left alone and named in the summary, as are
 * imports that do not resolve, whose form is unclear, that point outside the alias/prefix folder (or, for
 * relative imports, outside the importer's project folder), and files that would gain errors.
 *
 * The alias or prefix must already be configured; tsconfig.json and package.json are never changed.
 */

/** One specifier rewrite, replacing the text at `start`…`end` (the quotes included). */
type Edit = { start: number; end: number; text: string };

/** For a path the new specifier should name (a file, a file without extension, or a folder): the specifier, or why it cannot be written. */
type Spelling = { specifier: string } | { miss: string; instructions: string };

/**
 * TypeScript 7's view of the engine for one sweep: a snapshot whose filesystem is the engine's overlay laid over the
 * disk, and per engine project (the folder of a tsconfig.json, or the root) a program of every TypeScript file under
 * it, with the tsconfig's options. Writes go to the engine and, as a new layer, to the snapshot.
 */
class Sweep7 {
  readonly api: API;
  private readonly engine: TsEngine;
  private snapshot: Snapshot;
  /** Project folder → its program's id, its options, and a module resolver with them. */
  private readonly projects = new Map<string, { id: ProjectId; options: CompilerOptions; resolver: ModuleResolver }>();

  constructor(engine: TsEngine) {
    this.engine = engine;
    this.api = new API({ cwd: engine.repoRoot });
    const written: [string, string][] = [];
    const removed: string[] = [];
    for (const [rel, content] of engine.overlayEntries()) {
      if (content === null) removed.push(engine.absPath(rel));
      else written.push([engine.absPath(rel), content]);
    }
    this.snapshot = this.api.createSnapshot({ fileSystem: createFileSystemLayer(written, { removedPaths: removed }) });
  }

  close(): void {
    this.api.close();
  }

  /** The file's project: its program in the current snapshot, its options and its resolver. Created on first use. */
  project(file: string): { program: Program; options: CompilerOptions; resolver: ModuleResolver } {
    const engineProject = this.engine.project(file);
    let found = this.projects.get(engineProject.folder);
    if (found === undefined) {
      let options: CompilerOptions = {};
      if (engineProject.tsconfig !== null) {
        try {
          options = this.api.parseConfigFile(this.engine.absPath(engineProject.tsconfig)).options;
        } catch (e) {
          unavailable(`TypeScript 7 could not read ${engineProject.tsconfig} (${(e as Error).message}). Fix it, then run again.`);
        }
        // TypeScript 7 reads baseUrl but resolves nothing through it: paths are relative to the tsconfig's folder.
        const baseUrl = (options as PathsOptions).baseUrl;
        if (baseUrl !== undefined && baseUrl !== this.engine.absPath(dirname(engineProject.tsconfig))) {
          unavailable(
            `${engineProject.tsconfig} sets baseUrl to another folder than its own. jig resolves imports with TypeScript 7, which no ` +
              `longer resolves through baseUrl, so these imports could resolve differently than in your TypeScript. Remove baseUrl ` +
              `(write its paths relative to the tsconfig's folder, and bare imports through baseUrl as paths aliases), then run again.`,
          );
        }
      }
      const prefix = engineProject.folder === "." ? "" : `${engineProject.folder}/`;
      const rootFiles = this.engine
        .listFiles()
        .filter((f) => f.startsWith(prefix) && TS_FILE.test(f))
        .map((f) => this.engine.absPath(f));
      this.snapshot = this.snapshot.update({ createPrograms: [{ rootFiles, compilerOptions: options }] });
      const program = this.snapshot.operation.createdPrograms?.[0];
      if (program === undefined) throw new Error(`import-style: TypeScript 7 created no program for ${engineProject.folder}`);
      found = { id: program.id, options, resolver: this.api.createModuleResolver(options) };
      this.projects.set(engineProject.folder, found);
    }
    const program = this.snapshot.getProgram(found.id);
    if (program === undefined) throw new Error(`import-style: the program of ${engineProject.folder} is gone`);
    return { program, options: found.options, resolver: found.resolver };
  }

  /** The file's source file in its project's program (the current text). */
  sourceFile(file: string): { program: Program; sf: ast7.SourceFile; options: CompilerOptions; resolver: ModuleResolver } {
    const rel = this.engine.relPath(file);
    const { program, options, resolver } = this.project(rel);
    const sf = program.getSourceFile(this.engine.absPath(rel));
    if (sf === undefined) unavailable(`${rel} is not a TypeScript file. Pass a .ts, .tsx, .mts or .cts file.`);
    return { program, sf, options, resolver };
  }

  /** Resolves `name` from the file's folder as TypeScript would, in the current snapshot. */
  resolve(file: string, name: string, mode: ResolutionMode | undefined): ResolveModuleNameResult {
    const { resolver } = this.project(file);
    return resolver.resolveModuleName(name, dirname(this.engine.absPath(file)), mode, { snapshot: this.snapshot });
  }

  /** The file's syntactic and semantic errors, as `TS<code>: <message>` (chained messages joined by spaces). */
  diagnostics(file: string): string[] {
    const { program } = this.sourceFile(file);
    const abs = this.engine.absPath(file);
    const flatten = (d: Diagnostic): string => [d.text, ...(d.messageChain ?? []).map(flatten)].join(" ");
    return [...program.getSyntacticDiagnostics(abs), ...program.getSemanticDiagnostics(abs)].map((d) => `TS${d.code}: ${flatten(d)}`);
  }

  /** Writes the file to the engine, and to the snapshot as a layer over the current one. */
  write(file: string, text: string): void {
    this.engine.write(file, text);
    this.snapshot = this.snapshot.update({ fileSystem: createFileSystemLayer([[this.engine.absPath(file), text]]) });
  }
}

/** What `sweepImports` needs to know about the target style. */
type TargetStyle = {
  style: "relative" | "alias" | "subpath";
  /** How the summary names the new imports: "relative imports", "`@/` imports". */
  label: string;
  /**
   * For an importing file with an import to rewrite: how to spell a path for it. Refuses (INVALID_ARGS)
   * when the style's configuration is missing for that file.
   */
  writerFor: (file: string, options: CompilerOptions) => (path: string, target: string) => Spelling;
  /** Added to the instructions of a specifier that would not resolve to the same file. */
  resolveHint: string;
};

type Planned = { file: string; edits: Edit[]; before: string[] };

/** The edits for one file's specifiers in other styles that resolve to a target, and the ones left alone. */
function planFile(engine: TsEngine, sweep: Sweep7, file: string, targets: string[], to: TargetStyle): { edits: Edit[]; misses: NotHandled[] } {
  const { program, sf, options } = sweep.sourceFile(file);
  const from = engine.absPath(file);
  const edits: Edit[] = [];
  const misses: NotHandled[] = [];
  let writer: ((path: string, target: string) => Spelling) | null = null;
  for (const specifier of importSpecifiers7(sf)) {
    const style = styleOf(specifier.text, options);
    if (style === "package" || style === to.style) continue;
    const quoted = JSON.stringify(specifier.text);
    const miss = (reason: string, instructions: string): void => {
      const { path, line } = engine.locationAt(file, specifier.getStart(sf));
      misses.push({ path, line, reason, instructions });
    };
    const mode = program.getModeForUsageLocation(from, specifier) as ResolutionMode;
    const resolveName = (name: string): string | undefined => sweep.resolve(file, name, mode).resolvedModule?.resolvedFileName;
    const resolvedModule = sweep.resolve(file, specifier.text, mode).resolvedModule;
    if (resolvedModule === undefined) {
      miss(`${quoted} does not resolve`, `Fix or remove the import of ${quoted} in ${file}, or leave it as it is.`);
      continue;
    }
    const target = resolvedModule.resolvedFileName;
    // A package reached through a key (`"*"` paths, `"#dep": "dep"`): packages never change.
    if (resolvedModule.isExternalLibraryImport === true || target.split(sep).includes("node_modules")) continue;
    const targetRel = engine.relPath(target);
    if (targetRel === target || !matchesAnyGlob(targetRel, targets)) continue;
    if (usesExactKey(engine, file, specifier.text, style, options)) {
      miss(
        `${quoted} uses an exact ${style === "alias" ? "tsconfig paths" : "package.json imports"} key`,
        `An import through an exact (non-wildcard) key is left as it is. Change the import of ${targetRel} in ${file} by hand if it should change.`,
      );
      continue;
    }
    const path = spelledPath(specifier.text, target);
    if (path === null) {
      miss(
        `cannot tell whether ${quoted} names ${targetRel} with or without its extension, or by its folder`,
        `Write the import of ${targetRel} in ${file} as a path to the file by hand, or leave it as it is.`,
      );
      continue;
    }
    // The new specifier names `path`; the old one must name it too, so only the prefix changes. TypeScript can
    // reach a file by another path (a package.json "types", a declaration file) than the runtime would.
    const named = namedPaths(engine, file, specifier.text, style, options);
    if (named === null || !named.includes(path)) {
      miss(
        `${quoted} resolves to ${targetRel} by another path than it names`,
        `TypeScript reaches ${targetRel} through a package.json or a declaration file, so another spelling could resolve to ` +
          `something else at runtime. Leave the import in ${file} as it is, or change it by hand.`,
      );
      continue;
    }
    writer ??= to.writerFor(file, options);
    const spelling = writer(path, target);
    if ("miss" in spelling) {
      miss(spelling.miss, spelling.instructions);
      continue;
    }
    const candidate = spelling.specifier;
    const resolved = resolveName(candidate);
    if (resolved !== target) {
      miss(
        `${JSON.stringify(candidate)} would not resolve to ${targetRel} as ${quoted} does`,
        `TypeScript resolves ${JSON.stringify(candidate)} from ${file} to ${resolved === undefined ? "nothing" : engine.relPath(resolved)}. ` +
          `${to.resolveHint}Leave this import as it is, or change it by hand.`,
      );
      continue;
    }
    const quote = specifier.getText(sf).charAt(0);
    if (candidate.includes(quote) || candidate.includes("\\") || (quote === "`" && candidate.includes("${"))) {
      miss(
        `${JSON.stringify(candidate)} cannot be written inside ${quote} quotes`,
        `Change the quotes of ${quoted} in ${file} by hand, then run again.`,
      );
      continue;
    }
    edits.push({ start: specifier.getStart(sf), end: specifier.getEnd(), text: `${quote}${candidate}${quote}` });
  }
  return { edits, misses };
}

/** Plans every file, writes the rewrites, puts back a file that would gain errors, and reports. */
async function sweepImports(engine: TsEngine, files: string[], targets: string[], to: TargetStyle): Promise<{ summary: string }> {
  const matched = await matchFiles(engine.repoRoot, files);
  const sweep = new Sweep7(engine);
  try {
    return finishSweep(engine, sweep, matched, files, targets, to);
  } finally {
    sweep.close();
  }
}

function finishSweep(engine: TsEngine, sweep: Sweep7, matched: string[], files: string[], targets: string[], to: TargetStyle): { summary: string } {
  // Plan everything first, so a refusal (missing configuration) leaves nothing written.
  const planned: Planned[] = [];
  const misses: NotHandled[] = [];
  for (const file of matched) {
    const found = planFile(engine, sweep, file, targets, to);
    misses.push(...found.misses);
    if (found.edits.length > 0) planned.push({ file, edits: found.edits, before: sweep.diagnostics(file) });
  }

  // Write every planned file, then check them all at once: one program rebuild instead of one per file.
  // A file that gained errors is put back, and the rest checked again, until no file gains any.
  const originals = new Map<string, string>();
  for (const item of planned) {
    const original = engine.read(item.file) ?? "";
    originals.set(item.file, original);
    let text = original;
    for (const edit of [...item.edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    sweep.write(item.file, text);
  }
  let done: Planned[] = planned;
  while (done.length > 0) {
    const failed: { item: Planned; errors: string[] }[] = [];
    for (const item of done) {
      const errors = introduced(item.before, sweep.diagnostics(item.file));
      if (errors.length > 0) failed.push({ item, errors });
    }
    if (failed.length === 0) break;
    for (const { item, errors } of failed) {
      // Located in the original text, so the line is the one the edit is on.
      sweep.write(item.file, originals.get(item.file) ?? "");
      const { path, line } = engine.locationAt(item.file, item.edits[0]?.start ?? 0);
      misses.push({
        path,
        line,
        reason: `rewriting its imports would introduce errors: ${errors.join("; ")}`,
        instructions: `Fix the imports of ${item.file} by hand, or leave the file as it is.`,
      });
    }
    done = done.filter((item) => !failed.some((f) => f.item === item));
  }

  if (done.length === 0) {
    throw new RefactorError(
      "NO_CHANGES",
      misses.length === 0
        ? `No import in ${files.join(", ")} resolving to a file matching ${targets.join(", ")} is written in another style ` +
            `than ${to.label} (packages never change). Check --files and --targets if a change was expected.`
        : `No import in ${files.join(", ")} could be rewritten to ${to.label}. Skipped:\n${misses
            .map((m) => `${m.path}:${m.line}: ${m.reason}. ${m.instructions}`)
            .join("\n")}`,
    );
  }
  const specifiers = done.reduce((n, item) => n + item.edits.length, 0);
  return {
    summary:
      `Rewrote ${plural(specifiers, "import")} to ${to.label} in ${plural(done.length, "file")}:\n${listLines(done.map((x) => x.file))}` +
      (misses.length > 0 ? `\n\n${notHandled(misses)}` : ""),
  };
}

// ---- imports-to-relative ----

export type ImportsToRelativeParams = { files: string[]; targets: string[] };

export const importsToRelativeAction: Action<ImportsToRelativeParams, TsEngine> = {
  id: "imports-to-relative",
  kind: "sweep",
  summary: "Rewrites alias and subpath imports as relative imports (../lib/date) that resolve to the same file.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The importing files to rewrite, as comma-separated globs from the repo root." },
    {
      name: "--targets",
      type: "globs",
      required: true,
      description: "Only imports that resolve to a file matching these comma-separated globs change; \"**\" for every file.",
    },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files"), targets: globList(raw, "targets") }),
  describe: (p) => `${p.files.join(", ")} importing ${p.targets.join(", ")}`,

  async run(engine, p) {
    return sweepImports(engine, p.files, p.targets, {
      style: "relative",
      label: "relative imports",
      resolveHint: "",
      writerFor: (file) => {
        const from = engine.absPath(file);
        const project = engine.project(file);
        const projectFolder = engine.absPath(project.folder);
        return (path, target) => {
          if (outside(relative(projectFolder, target))) {
            return {
              miss: `${engine.relPath(target)} is outside the project folder ${project.folder}`,
              instructions: `A relative import from ${file} would leave its project. Leave this import as it is.`,
            };
          }
          let specifier = slashed(relative(dirname(from), path));
          if (specifier === "") specifier = ".";
          else if (specifier !== ".." && !specifier.startsWith("../")) specifier = `./${specifier}`;
          return { specifier };
        };
      },
    });
  },
};

// ---- imports-to-alias ----

export type ImportsToAliasParams = { files: string[]; targets: string[]; alias: string };

export const importsToAliasAction: Action<ImportsToAliasParams, TsEngine> = {
  id: "imports-to-alias",
  kind: "sweep",
  summary: "Rewrites relative and subpath imports through a tsconfig paths alias (@/lib/date) that resolves to the same file.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The importing files to rewrite, as comma-separated globs from the repo root." },
    {
      name: "--targets",
      type: "globs",
      required: true,
      description: "Only imports that resolve to a file matching these comma-separated globs change; \"**\" for every file.",
    },
    {
      name: "--alias",
      type: "text",
      required: true,
      description:
        "The alias up to its \"*\", ending in \"/\": \"@/\" uses the paths entry \"@/*\". The importer's tsconfig must have that entry, with one target \"<folder>/*\".",
    },
  ],
  parseParams: (raw) => {
    const files = globList(raw, "files");
    const targets = globList(raw, "targets");
    const alias = raw.alias;
    if (alias === undefined || alias === "") throw new RefactorError("INVALID_ARGS", "Missing --alias. Pass the tsconfig paths alias up to its \"*\" (for example @/) and run again.");
    if (!alias.endsWith("/") || alias.startsWith(".") || alias.startsWith("#") || /["'`\\\s*]/.test(alias)) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--alias ${JSON.stringify(alias)} must be the prefix of a tsconfig paths key up to its "*", ending in "/" (for example "@/" for "@/*"); ` +
          `not relative, not starting with "#" (that is imports-to-subpath). Pass it and run again.`,
      );
    }
    return { files, targets, alias };
  },
  describe: (p) => `${p.files.join(", ")} importing ${p.targets.join(", ")} as ${p.alias}`,

  async run(engine, p) {
    const key = `${p.alias}*`;
    /** Project folder → the alias folder (absolute). */
    const folders = new Map<string, string>();
    return sweepImports(engine, p.files, p.targets, {
      style: "alias",
      label: `\`${p.alias}\` imports`,
      resolveHint: "",
      writerFor: (file, projectOptions) => {
        const project = engine.project(file);
        let aliasFolder = folders.get(project.folder);
        if (aliasFolder === undefined) {
          // TypeScript 7 has no baseUrl: paths are relative to the tsconfig's folder, its pathsBasePath (not in its typings).
          const options: PathsOptions = projectOptions;
          const where = project.tsconfig ?? "the repo root (no tsconfig.json above it)";
          const entry = options.paths?.[key];
          if (entry === undefined) {
            const keys = Object.keys(options.paths ?? {});
            throw new RefactorError(
              "INVALID_ARGS",
              `${file}: its project, ${where}, has no compilerOptions.paths entry ${JSON.stringify(key)}` +
                (keys.length > 0 ? ` (it has ${keys.map((k) => JSON.stringify(k)).join(", ")})` : "") +
                `. Add for example "paths": { ${JSON.stringify(key)}: ["./src/*"] } to it, or pass the alias it has, then run again. ` +
                `imports-to-alias does not change tsconfig.json.`,
            );
          }
          if (entry.length !== 1 || !entry[0]?.endsWith("/*")) {
            unavailable(
              `${where}: paths ${JSON.stringify(key)} must have exactly one target of the form "<folder>/*" (it is ${JSON.stringify(entry)}). ` +
                `Change it to one folder, or pass another --alias, then run again.`,
            );
          }
          const base = options.baseUrl ?? options.pathsBasePath;
          if (typeof base !== "string") unavailable(`${where}: cannot tell what its paths are relative to. Set baseUrl or fix the file, then run again.`);
          aliasFolder = resolve(base, (entry[0] as string).slice(0, -2));
          folders.set(project.folder, aliasFolder);
        }
        const folder = aliasFolder;
        return (path, target) => {
          const rest = relative(folder, path);
          if (outside(rest)) {
            return {
              miss: `${engine.relPath(target)} is outside ${engine.relPath(folder)}, the folder of ${key}`,
              instructions: `The import of ${engine.relPath(target)} in ${file} cannot be written with ${p.alias}. Leave it as it is.`,
            };
          }
          if (rest === "") {
            return {
              miss: `the import of ${engine.relPath(target)} names ${engine.relPath(folder)} itself, the folder of ${key}`,
              instructions: `An alias import of the alias folder itself is not written. Leave this import in ${file} as it is.`,
            };
          }
          return { specifier: `${p.alias}${slashed(rest)}` };
        };
      },
    });
  },
};

// ---- imports-to-subpath ----

export type ImportsToSubpathParams = { files: string[]; targets: string[]; prefix: string };

export const importsToSubpathAction: Action<ImportsToSubpathParams, TsEngine> = {
  id: "imports-to-subpath",
  kind: "sweep",
  summary: "Rewrites relative and alias imports as package.json subpath imports (#/lib/date) that resolve to the same file.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The importing files to rewrite, as comma-separated globs from the repo root." },
    {
      name: "--targets",
      type: "globs",
      required: true,
      description: "Only imports that resolve to a file matching these comma-separated globs change; \"**\" for every file.",
    },
    {
      name: "--prefix",
      type: "text",
      required: true,
      description:
        "The subpath prefix up to its \"*\", starting with \"#\" and ending in \"/\": \"#/\" uses the imports entry \"#/*\". The importer's nearest package.json must map it to \"./<folder>/*\".",
    },
  ],
  parseParams: (raw) => {
    const files = globList(raw, "files");
    const targets = globList(raw, "targets");
    const prefix = raw.prefix;
    if (prefix === undefined || prefix === "") throw new RefactorError("INVALID_ARGS", "Missing --prefix. Pass the package.json imports prefix up to its \"*\" (for example #/) and run again.");
    if (!prefix.startsWith("#") || !prefix.endsWith("/") || /["'`\\\s*]/.test(prefix)) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--prefix ${JSON.stringify(prefix)} must be the prefix of a package.json imports key up to its "*", starting with "#" and ending in "/" ` +
          `(for example "#/" for "#/*"). Pass it and run again.`,
      );
    }
    return { files, targets, prefix };
  },
  describe: (p) => `${p.files.join(", ")} importing ${p.targets.join(", ")} as ${p.prefix}`,

  async run(engine, p) {
    const key = `${p.prefix}*`;
    /** package.json → the folder its key maps to (absolute). */
    const folders = new Map<string, string>();
    return sweepImports(engine, p.files, p.targets, {
      style: "subpath",
      label: `\`${p.prefix}\` subpath imports`,
      resolveHint:
        "Subpath imports name files exactly (no extension is added, no index file is found), and need moduleResolution " +
        "\"bundler\", \"node16\" or \"nodenext\". ",
      writerFor: (file) => {
        const packageJson = nearestPackageJson(engine, file);
        if (packageJson === null) {
          throw new RefactorError(
            "INVALID_ARGS",
            `${file}: there is no package.json at or above it to hold "imports" ${JSON.stringify(key)}. ` +
              `Add one with "imports": { ${JSON.stringify(key)}: "./src/*" }, then run again. imports-to-subpath does not change package.json.`,
          );
        }
        let prefixFolder = folders.get(packageJson);
        if (prefixFolder === undefined) {
          try {
            JSON.parse(engine.read(packageJson) ?? "");
          } catch {
            return unavailable(`${packageJson} is not valid JSON. Fix it, then run again.`);
          }
          const value = importsOf(engine, packageJson)?.[key];
          if (value === undefined) {
            throw new RefactorError(
              "INVALID_ARGS",
              `${packageJson}, the nearest package.json to ${file}, has no "imports" entry ${JSON.stringify(key)}. ` +
                `Add for example "imports": { ${JSON.stringify(key)}: "./src/*" } to it, or pass the prefix it has, then run again. ` +
                `imports-to-subpath does not change package.json.`,
            );
          }
          if (typeof value !== "string" || !value.startsWith("./") || !value.endsWith("/*") || value.indexOf("*") !== value.length - 1) {
            return unavailable(
              `${packageJson}: "imports" ${JSON.stringify(key)} must map to one folder, "./<folder>/*" (it is ${JSON.stringify(value)}). ` +
                `Change it, or pass another --prefix, then run again.`,
            );
          }
          prefixFolder = resolve(engine.absPath(dirname(packageJson)), value.slice(0, -2));
          folders.set(packageJson, prefixFolder);
        }
        const mapped = prefixFolder;
        return (path, target) => {
          const rest = relative(mapped, path);
          if (outside(rest)) {
            return {
              miss: `${engine.relPath(target)} is outside ${engine.relPath(mapped)}, the folder of ${key}`,
              instructions: `The import of ${engine.relPath(target)} in ${file} cannot be written with ${p.prefix}. Leave it as it is.`,
            };
          }
          if (rest === "") {
            return {
              miss: `the import of ${engine.relPath(target)} names ${engine.relPath(mapped)} itself, the folder of ${key}`,
              instructions: `A subpath import of the prefix folder itself is not written. Leave this import in ${file} as it is.`,
            };
          }
          return { specifier: `${p.prefix}${slashed(rest)}` };
        };
      },
    });
  },
};
