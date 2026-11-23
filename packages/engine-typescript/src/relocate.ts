import { lstatSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import {
  bestWildcardKey,
  byString,
  importSpecifiers,
  importsOf,
  matchesPathsKey,
  namedPaths,
  nearestPackageJson,
  required,
  slashed,
  spelledPath,
  stem,
  styleOf,
  usesExactKey,
} from "./shared.ts";
import type { NotHandled, Reader, Style } from "./shared.ts";

/**
 * The relocate core, shared by duplicate-folder, move-file and rename-files: a group of files
 * goes to new paths (moved, or copied), and every import that has to follow is rewritten.
 *
 * Without a program or a language service: each importer is parsed on its own (`ts.createSourceFile`), and
 * each reference is resolved with `ts.resolveModuleName` under the options of the importer's nearest
 * tsconfig.json. A reference is touched only when its importer or its target moves. The new specifier keeps
 * the style (relative, the same `paths` key, the same package.json `imports` key) and the extension form of
 * the old one, and must resolve to the target's new place in the world after the change. Any reference
 * that cannot follow refuses the whole action, and nothing is written.
 */

export type Relocation = {
  mode: "move" | "duplicate";
  /** Root-relative old path → new path. */
  moves: Map<string, string>;
};

export type Relocated = {
  /** The new paths, sorted. */
  files: string[];
  /** Each rewritten file (at its new path for a moved file) and how many references in it changed. */
  rewritten: { file: string; imports: number }[];
};

/** `ts.matchFiles`: how TypeScript applies a tsconfig's include and exclude to a listing. Not in the public typings. */
type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => { files: readonly string[]; directories: readonly string[] },
  realpath: (path: string) => string,
) => string[];

/** One side of the change: which files exist, what they hold, and module resolution that sees just that. */
type World = Reader & {
  files: string[];
  exists: (rel: string) => boolean;
  host: ts.ModuleResolutionHost;
  /** Absolute folder → the names of the files and folders in it. */
  entries: Map<string, { files: string[]; directories: string[] }>;
};

function makeWorld(engine: TsEngine, files: string[], read: (rel: string) => string | null): World {
  const t = engine.ts;
  const present = new Set(files);
  const folders = new Set<string>();
  const entries = new Map<string, { files: string[]; directories: string[] }>();
  const entry = (folder: string): { files: string[]; directories: string[] } => {
    const abs = engine.absPath(folder === "." ? "" : folder);
    let found = entries.get(abs);
    if (found === undefined) {
      found = { files: [], directories: [] };
      entries.set(abs, found);
    }
    return found;
  };
  for (const file of files) {
    entry(dirname(file)).files.push(basename(file));
    let folder = dirname(file);
    while (folder !== "." && !folders.has(folder)) {
      folders.add(folder);
      entry(dirname(folder)).directories.push(basename(folder));
      folder = dirname(folder);
    }
  }
  /** The root-relative path of a listed place, or null for one outside the root or under node_modules (read from disk). */
  const listed = (abs: string): string | null => {
    const rel = engine.relPath(abs);
    if (rel === abs || rel.split("/").includes("node_modules")) return null;
    return rel;
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (p) => {
      const rel = listed(p);
      return rel === null ? t.sys.fileExists(p) : present.has(rel);
    },
    readFile: (p) => {
      const rel = listed(p);
      if (rel === null) return t.sys.readFile(p);
      return present.has(rel) ? (read(rel) ?? undefined) : undefined;
    },
    directoryExists: (p) => {
      const rel = listed(p);
      return rel === null ? t.sys.directoryExists(p) : folders.has(rel);
    },
    realpath: (p) => (listed(p) === null ? (t.sys.realpath?.(p) ?? p) : p),
    getCurrentDirectory: () => engine.repoRoot,
  };
  return {
    files,
    exists: (rel) => present.has(rel),
    read: (rel) => (present.has(rel) ? read(rel) : null),
    absPath: (file) => engine.absPath(file),
    relPath: (file) => engine.relPath(file),
    host,
    entries,
  };
}

/** A reference to rewrite: the text between `start` and `end` (inside the quotes) becomes `text`. */
type Edit = { start: number; end: number; text: string };

/** The `@import` tags and `import("…")` types in the JSDoc of a JavaScript file. */
function jsDocSpecifiers(t: TsEngine["ts"], sf: ts.SourceFile): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const inDoc = (node: ts.Node): void => {
    if (t.isJSDocImportTag(node) && t.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier);
    } else if (t.isImportTypeNode(node) && t.isLiteralTypeNode(node.argument) && t.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal);
    }
    t.forEachChild(node, inDoc);
  };
  const visit = (node: ts.Node): void => {
    for (const doc of (node as { jsDoc?: ts.JSDoc[] }).jsDoc ?? []) inDoc(doc);
    t.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The first argument of each `new URL("…", import.meta.url)`: a plain string (no substitutions), with exactly `import.meta.url` as the base. */
function urlSpecifiers(t: TsEngine["ts"], sf: ts.SourceFile): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (t.isNewExpression(node) && t.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.length === 2) {
      const [first, second] = node.arguments;
      if (
        first !== undefined &&
        second !== undefined &&
        t.isStringLiteralLike(first) &&
        t.isPropertyAccessExpression(second) &&
        t.isMetaProperty(second.expression) &&
        second.expression.keywordToken === t.SyntaxKind.ImportKeyword &&
        second.expression.name.text === "meta" &&
        second.name.text === "url"
      ) {
        out.push(first);
      }
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The declaration file of a file, or the files a declaration file declares, in the same folder (whether they exist
 * or not). `declares` is true when the companion is the declaration file. foo.js and foo.jsx ↔ foo.d.ts, foo.mjs ↔
 * foo.d.mts, foo.cjs ↔ foo.d.cts, and any other extension ↔ foo.d.<ext>.ts (allowArbitraryExtensions). A .ts, .tsx,
 * .mts or .cts file has none. `stem` is the name both share (`foo`).
 */
function declarationCompanions(file: string): { path: string; declares: boolean; stem: string }[] {
  const folder = dirname(file);
  const at = (name: string): string => (folder === "." ? name : `${folder}/${name}`);
  const name = basename(file);
  let m = /^(.+)\.d\.ts$/.exec(name);
  if (m !== null) {
    return [
      { path: at(`${m[1]}.js`), declares: false, stem: `${m[1]}` },
      { path: at(`${m[1]}.jsx`), declares: false, stem: `${m[1]}` },
    ];
  }
  m = /^(.+)\.d\.mts$/.exec(name);
  if (m !== null) return [{ path: at(`${m[1]}.mjs`), declares: false, stem: `${m[1]}` }];
  m = /^(.+)\.d\.cts$/.exec(name);
  if (m !== null) return [{ path: at(`${m[1]}.cjs`), declares: false, stem: `${m[1]}` }];
  m = /^(.+)\.d\.([^.]+)\.ts$/.exec(name);
  if (m !== null) {
    const extension = m[2];
    if (extension === undefined) return [];
    // foo.d.js.ts is not how a JavaScript file is declared: TypeScript looks for foo.d.ts.
    if (/^(m|c)?[jt]sx?$/.test(extension)) return [];
    return [{ path: at(`${m[1]}.${extension}`), declares: false, stem: `${m[1]}` }];
  }
  m = /^(.+)\.jsx?$/.exec(name);
  if (m !== null) return [{ path: at(`${m[1]}.d.ts`), declares: true, stem: `${m[1]}` }];
  m = /^(.+)\.mjs$/.exec(name);
  if (m !== null) return [{ path: at(`${m[1]}.d.mts`), declares: true, stem: `${m[1]}` }];
  m = /^(.+)\.cjs$/.exec(name);
  if (m !== null) return [{ path: at(`${m[1]}.d.cts`), declares: true, stem: `${m[1]}` }];
  if (/\.(m|c)?tsx?$/.test(name)) return [];
  m = /^(.+)\.([^.]+)$/.exec(name);
  if (m !== null) return [{ path: at(`${m[1]}.d.${m[2]}.ts`), declares: true, stem: `${m[1]}` }];
  return [];
}

/**
 * The moves, with the declaration file of each moved file, or the file a moved declaration file declares, added and
 * renamed the same way: src/foo.js → lib/bar.js takes src/foo.d.ts → lib/bar.d.ts along, and x.css → y.css takes
 * x.d.css.ts → y.d.css.ts. A companion already in the moves is left as it is. Refuses (INVALID_ARGS) a companion
 * whose new place is taken, and a new name the companion could not stay paired with (foo.js → foo.ts).
 */
export function withDeclarationFiles(engine: TsEngine, moves: Map<string, string>): Map<string, string> {
  const listed = new Set(engine.listFiles());
  const out = new Map(moves);
  for (const [from, to] of moves) {
    for (const companion of declarationCompanions(from)) {
      if (!listed.has(companion.path) || moves.has(companion.path)) continue;
      const role = companion.declares ? `the declaration file of ${from}` : `the file ${from} declares`;
      const tail = basename(companion.path).slice(companion.stem.length);
      const follow = declarationCompanions(to).find(
        (c) => c.declares === companion.declares && basename(c.path).slice(c.stem.length) === tail,
      );
      if (follow === undefined) {
        throw new RefactorError(
          "INVALID_ARGS",
          `${companion.path} is ${role}, and could not stay paired with it as ${to}: the extension changes. ` +
            `Keep the extension, or move or delete ${companion.path} by hand first, then run again.`,
        );
      }
      // foo.js → foo.jsx: foo.d.ts declares both, so it stays.
      if (follow.path === companion.path) continue;
      const earlier = out.get(companion.path);
      if (earlier !== undefined) {
        if (earlier !== follow.path) {
          throw new RefactorError(
            "INVALID_ARGS",
            `${companion.path} is ${role}, and would have to become both ${earlier} and ${follow.path}. ` +
              `Move these files by hand, then run again.`,
          );
        }
        continue;
      }
      if ([...out.values()].includes(follow.path)) {
        throw new RefactorError(
          "INVALID_ARGS",
          `${companion.path} is ${role}, and would move along to ${follow.path}, which is already the new place of another file. ` +
            `Move these files by hand, then run again.`,
        );
      }
      if (engine.read(follow.path) !== null || engine.existsOnDisk(follow.path)) {
        throw new RefactorError(
          "INVALID_ARGS",
          `${follow.path} already exists, and ${companion.path}, ${role}, would move along to it. ` +
            `Move or remove ${follow.path} first, then run again.`,
        );
      }
      out.set(companion.path, follow.path);
    }
  }
  return out;
}

/** Plans everything, refuses (REFACTOR_UNAVAILABLE) on any doubtful reference, then applies to the engine. */
export function relocate(engine: TsEngine, r: Relocation): Relocated {
  const t = engine.ts;
  const move = r.mode === "move";
  const sources = [...r.moves.keys()].sort(byString);
  /** New path → old path. */
  const origins = new Map<string, string>();
  for (const [from, to] of r.moves) origins.set(to, from);
  const newOf = (rel: string): string => r.moves.get(rel) ?? rel;

  const configs = sources.filter((f) => /^tsconfig.*\.json$/.test(basename(f)) || basename(f) === "jsconfig.json" || basename(f) === "package.json");
  if (configs.length > 0) {
    throw new RefactorError(
      "INVALID_ARGS",
      `${configs.join(", ")} would ${move ? "move" : "be copied"}. jig does not ${move ? "move" : "copy"} a tsconfig, jsconfig or package.json, ` +
        `as that changes how everything under it resolves. ${move ? "Move" : "Copy"} ${configs.length === 1 ? "it" : "them"} by hand` +
        (sources.length > configs.length ? `, and run jig again on the other files.` : "."),
    );
  }
  const listing = engine.listFiles();
  const listed = new Set(listing);
  // A file and its declaration file go together: the one left behind would declare nothing, or the file would lose its types.
  const strays: string[] = [];
  for (const file of sources) {
    for (const companion of declarationCompanions(file)) {
      if (!listed.has(companion.path) || r.moves.has(companion.path)) continue;
      // foo.js → foo.jsx: foo.d.ts stays, and still declares it.
      if (declarationCompanions(newOf(file)).some((c) => c.path === companion.path)) continue;
      strays.push(
        companion.declares
          ? `${file} would ${move ? "move" : "be copied"}, but its declaration file ${companion.path} would not`
          : `${file} would ${move ? "move" : "be copied"}, but ${companion.path}, the file it declares, would not`,
      );
    }
  }
  if (strays.length > 0) {
    throw new RefactorError(
      "INVALID_ARGS",
      `A file and its declaration file ${move ? "move" : "are copied"} together:\n${listLines(strays)}\n` +
        `${move ? "Move" : "Copy"} these files by hand, then run again.`,
    );
  }
  const taken = sources.map(newOf).filter((to) => engine.read(to) !== null || engine.existsOnDisk(to));
  if (taken.length > 0) {
    throw new RefactorError(
      "INVALID_ARGS",
      `${taken.join(", ")} already ${taken.length === 1 ? "exists" : "exist"}. Move or remove ${taken.length === 1 ? "that file" : "those files"} first, then run again.`,
    );
  }

  const before = makeWorld(engine, listing, (rel) => engine.read(rel));
  const after = makeWorld(
    engine,
    [...listing.filter((f) => !(move && r.moves.has(f))), ...origins.keys()].sort(byString),
    (rel) => {
      const origin = origins.get(rel);
      if (origin !== undefined) return engine.read(origin);
      return engine.read(rel);
    },
  );

  // ---- tsconfigs: never moved, so the same in both worlds ----
  const tsconfigs = new Set(listing.filter((f) => basename(f) === "tsconfig.json"));
  const nearest = new Map<string, string | null>();
  /** The nearest tsconfig.json at or above the file, inside the root; null for none. */
  const tsconfigOf = (file: string): string | null => {
    const start = dirname(file);
    const cached = nearest.get(start);
    if (cached !== undefined) return cached;
    let folder = start;
    let found: string | null = null;
    while (true) {
      const candidate = folder === "." ? "tsconfig.json" : `${folder}/tsconfig.json`;
      if (tsconfigs.has(candidate)) {
        found = candidate;
        break;
      }
      if (folder === ".") break;
      folder = dirname(folder);
    }
    nearest.set(start, found);
    return found;
  };
  const parse = (tsconfig: string, world: World, readDirectory: ts.ParseConfigHost["readDirectory"]): ts.ParsedCommandLine | undefined => {
    const host: ts.ParseConfigFileHost = {
      useCaseSensitiveFileNames: t.sys.useCaseSensitiveFileNames,
      readDirectory,
      fileExists: (p) => world.host.fileExists(p),
      readFile: (p) => world.host.readFile(p),
      getCurrentDirectory: () => engine.absPath(dirname(tsconfig)),
      onUnRecoverableConfigFileDiagnostic: () => {},
    };
    return t.getParsedCommandLineOfConfigFile(engine.absPath(tsconfig), undefined, host);
  };
  const optionsCache = new Map<string, ts.CompilerOptions>();
  /** The compiler options of the tsconfig (its errors ignored, as the engine does), or the defaults for none. */
  const optionsOf = (tsconfig: string | null): ts.CompilerOptions => {
    if (tsconfig === null) return {};
    let options = optionsCache.get(tsconfig);
    if (options === undefined) {
      options = parse(tsconfig, before, () => [])?.options ?? {};
      optionsCache.set(tsconfig, options);
    }
    return options;
  };
  const matchFiles = (t as unknown as { matchFiles: MatchFiles | undefined }).matchFiles;
  if (typeof matchFiles !== "function") {
    throw new RefactorError(
      "REFACTOR_UNAVAILABLE",
      `TypeScript ${t.version} lacks ts.matchFiles, the internal jig uses to check a tsconfig's include and files, so nothing was ` +
        `${move ? "moved" : "copied"}. The typescript image needs updating to a jig that supports this TypeScript version.`,
    );
  }
  const coveredCache = new Map<World, Map<string, Set<string>>>();
  /** The absolute paths of the files the tsconfig's include and files take in, in that world. */
  const covered = (world: World, tsconfig: string): Set<string> => {
    let perWorld = coveredCache.get(world);
    if (perWorld === undefined) {
      perWorld = new Map();
      coveredCache.set(world, perWorld);
    }
    let names = perWorld.get(tsconfig);
    if (names === undefined) {
      const parsed = parse(tsconfig, world, (path, extensions, excludes, includes, depth) =>
        matchFiles(
          path,
          extensions,
          excludes,
          includes,
          t.sys.useCaseSensitiveFileNames,
          engine.absPath(dirname(tsconfig)),
          depth,
          (folder) => world.entries.get(resolve(folder)) ?? { files: [], directories: [] },
          (p) => p,
        ),
      );
      names = new Set(parsed?.fileNames ?? []);
      perWorld.set(tsconfig, names);
    }
    return names;
  };
  const caches = new Map<string, ts.ModuleResolutionCache>();
  const cacheFor = (world: World, tsconfig: string | null): ts.ModuleResolutionCache => {
    const key = `${world === before ? "before" : "after"}:${tsconfig ?? ""}`;
    let cache = caches.get(key);
    if (cache === undefined) {
      cache = t.createModuleResolutionCache(
        engine.repoRoot,
        (s) => (t.sys.useCaseSensitiveFileNames ? s : s.toLowerCase()),
        optionsOf(tsconfig),
      );
      caches.set(key, cache);
    }
    return cache;
  };

  /**
   * How a specifier is written, as TypeScript reads it: a tsconfig `paths` key is tried before package.json
   * `imports`, so `#app/x` matching a `"#app/*"` paths key is an alias.
   */
  const styleIn = (specifier: string, options: ts.CompilerOptions): Style => {
    if (specifier.startsWith("#") && Object.keys(options.paths ?? {}).some((key) => key !== "*" && matchesPathsKey(key, specifier))) {
      return "alias";
    }
    return styleOf(specifier, options);
  };

  /**
   * What a specifier in `file` (root-relative, its place in that world) names in a world: the absolute path
   * of the file, "package" for a package (node_modules, an external library), or undefined when it does not
   * resolve. A relative, alias or subpath specifier TypeScript does not resolve that names an existing file
   * exactly (`./styles.css`, `@/assets/logo.svg`) names it.
   */
  const targetOf = (
    world: World,
    specifier: string,
    file: string,
    tsconfig: string | null,
    mode: ts.ResolutionMode,
  ): string | "package" | undefined => {
    const options = optionsOf(tsconfig);
    const fromAbs = engine.absPath(file);
    const found = t.resolveModuleName(specifier, fromAbs, options, world.host, cacheFor(world, tsconfig), undefined, mode).resolvedModule;
    if (found !== undefined) {
      if (found.isExternalLibraryImport === true || found.resolvedFileName.split(sep).includes("node_modules")) return "package";
      return found.resolvedFileName;
    }
    const style = styleIn(specifier, options);
    if (style === "package") return undefined;
    for (const named of namedPaths(world, file, specifier, style, options) ?? []) {
      const rel = engine.relPath(named);
      if (rel !== named && world.exists(rel)) return named;
    }
    return undefined;
  };

  const problems: NotHandled[] = [];
  const planned: { file: string; text: string; imports: number }[] = [];
  // The files whose references are read: TypeScript and JavaScript sources, declaration files included.
  const importers = move ? listing.filter((f) => /\.(m|c)?[jt]sx?$/.test(f)) : sources.filter((f) => /\.(m|c)?[jt]sx?$/.test(f));

  for (const file of importers) {
    const text = engine.read(file);
    if (text === null) continue;
    const moving = r.moves.has(file);
    const newFile = newOf(file);
    const fromAbs = engine.absPath(file);
    const newAbs = engine.absPath(newFile);
    const tsconfig = tsconfigOf(file);
    const newTsconfig = tsconfigOf(newFile);
    const options = optionsOf(tsconfig);
    const newOptions = optionsOf(newTsconfig);
    const problem = (offset: number, reason: string, instructions: string): void => {
      problems.push({ path: file, line: engine.locationAt(file, offset).line, reason, instructions });
    };

    const format = t.getImpliedNodeFormatForFile(fromAbs, cacheFor(before, tsconfig).getPackageJsonInfoCache(), before.host, options);
    const sf = t.createSourceFile(fromAbs, text, { languageVersion: t.ScriptTarget.Latest, impliedNodeFormat: format }, true);
    const literals = [...importSpecifiers(t, sf), ...(/\.(m|c)?jsx?$/.test(file) ? jsDocSpecifiers(t, sf) : [])];
    // The resolution mode after the change: the same file, parsed as the format its new place implies.
    const newFormat = moving
      ? t.getImpliedNodeFormatForFile(newAbs, cacheFor(after, newTsconfig).getPackageJsonInfoCache(), after.host, newOptions)
      : format;
    const newSf =
      newFormat === format ? sf : t.createSourceFile(newAbs, text, { languageVersion: t.ScriptTarget.Latest, impliedNodeFormat: newFormat }, true);
    const newLiterals =
      newSf === sf ? literals : [...importSpecifiers(t, newSf), ...(/\.(m|c)?jsx?$/.test(file) ? jsDocSpecifiers(t, newSf) : [])];

    const edits: Edit[] = [];
    literals.forEach((literal, index) => {
      const specifier = literal.text;
      const start = literal.getStart(sf);
      const quoted = JSON.stringify(specifier);
      const mode = t.getModeForUsageLocation(sf, literal, options);
      // A bundler query import (`./icon.svg?react`): what its path part names decides, and it is not rewritten yet.
      const query = specifier.indexOf("?");
      if (query !== -1) {
        const pathPart = specifier.slice(0, query);
        const pathStyle = styleIn(pathPart, options);
        const named = targetOf(before, pathPart, file, tsconfig, mode);
        if (named === "package") return;
        if (named === undefined && pathStyle === "package") return;
        const namedFile = named === undefined ? undefined : engine.relPath(named);
        if (namedFile !== undefined && r.moves.has(namedFile)) {
          problem(
            start,
            `${quoted} is a query import of ${namedFile}, which ${move ? "moves" : "is copied"}`,
            `jig does not rewrite query imports yet. Move the files by hand, or change the import in ${file} by hand, then run again.`,
          );
          return;
        }
        if (moving) {
          problem(
            start,
            `${quoted} is a query import in ${file}, which ${move ? "moves" : "is copied"}`,
            `jig does not rewrite query imports yet. Move the files by hand, or change the import in ${file} by hand, then run again.`,
          );
        }
        return;
      }
      const style = styleIn(specifier, options);
      const found = targetOf(before, specifier, file, tsconfig, mode);
      if (found === "package") return;
      if (found === undefined) {
        if (moving && style !== "package") {
          problem(start, `${quoted} does not resolve`, `Fix or remove the import of ${quoted} in ${file}, then run again.`);
        }
        return;
      }
      const target = engine.relPath(found);
      const targetMoves = r.moves.has(target);
      if (!moving && !targetMoves) return;
      const newTarget = newOf(target);
      const newTargetAbs = targetMoves ? engine.absPath(newTarget) : found;

      let candidate: string;
      if (style === "package") {
        if (targetMoves) {
          problem(
            start,
            `${quoted} is a package-style import (a bare name, baseUrl or a workspace package) of ${target}, which ${move ? "moves" : "is copied"}`,
            `Only relative, alias and subpath imports are rewritten. Change the import of ${target} in ${file} to one of those (imports-to-relative), then run again.`,
          );
          return;
        }
        candidate = specifier;
      } else if (usesExactKey(before, file, specifier, style, options)) {
        if (targetMoves) {
          problem(
            start,
            `${quoted} uses an exact ${style === "alias" ? "tsconfig paths" : "package.json imports"} key that names ${target}`,
            `tsconfig.json and package.json are never changed. Point the key at ${newTarget} by hand, or import ${target} in ${file} by a relative path, then run again.`,
          );
          return;
        }
        candidate = specifier;
      } else {
        const path = spelledPath(specifier, found);
        if (path === null) {
          problem(
            start,
            `cannot tell whether ${quoted} names ${target} with or without its extension, or by its folder`,
            `Write the import of ${target} in ${file} as a path to the file, then run again.`,
          );
          return;
        }
        const named = namedPaths(before, file, specifier, style, options);
        if (named === null || !named.includes(path)) {
          problem(
            start,
            `${quoted} resolves to ${target} by another path than it names`,
            `TypeScript reaches ${target} through a package.json or a declaration file, so the import cannot be rewritten safely. ` +
              `Change the import in ${file} to name the file, then run again.`,
          );
          return;
        }
        // The same form at the new place: the file, its stem, its stem with the specifier's extension, or its folder.
        let newPath: string;
        if (path === found) {
          newPath = newTargetAbs;
        } else if (path === dirname(found)) {
          if (stem(basename(newTargetAbs)) !== "index") {
            problem(
              start,
              `${quoted} names ${target} by its folder, but its new name ${newTarget} is not an index file`,
              `Import ${target} by its file name in ${file}, then run again.`,
            );
            return;
          }
          newPath = dirname(newTargetAbs);
        } else if (path !== null && /\.d\.[^.]+\.ts$/.test(basename(found)) && !basename(path).startsWith(stem(basename(found)))) {
          // `theme.d.css.ts` named as `theme.css` (spelledPath's declared file): the declared file at the new place.
          newPath = join(dirname(newTargetAbs), basename(newTargetAbs).replace(/\.d\.([^.]+)\.ts$/, ".$1"));
        } else {
          newPath = join(dirname(newTargetAbs), stem(basename(newTargetAbs)) + basename(path).slice(stem(basename(found)).length));
        }

        if (style === "relative") {
          let written = slashed(relative(dirname(newAbs), newPath));
          if (written === "") written = ".";
          else if (written !== ".." && !written.startsWith("../")) written = `./${written}`;
          if (specifier.endsWith("/") && !written.endsWith("/")) written = `${written}/`;
          candidate = written;
        } else if (style === "alias") {
          const key = bestWildcardKey(Object.keys(options.paths ?? {}), specifier);
          if (key === undefined) {
            problem(
              start,
              `cannot tell which paths alias of ${tsconfig ?? "the repo root"} ${quoted} uses`,
              `Import ${target} in ${file} by a relative path (imports-to-relative), then run again.`,
            );
            return;
          }
          const targets = newOptions.paths?.[key];
          const where = newTsconfig ?? "the repo root (no tsconfig.json above it)";
          if (targets === undefined) {
            problem(
              start,
              `${quoted} uses the paths alias ${JSON.stringify(key)}, which ${where}, the project of ${newFile}, does not have`,
              `Add ${JSON.stringify(key)} to its compilerOptions.paths, or import ${target} in ${file} by a relative path (imports-to-relative), then run again.`,
            );
            return;
          }
          const base = newOptions.baseUrl ?? newOptions.pathsBasePath;
          let written: string | undefined;
          for (const entry of targets) {
            const star = entry.indexOf("*");
            if (star === -1 || typeof base !== "string") continue;
            const head = entry.slice(0, star);
            const prefix = resolve(base, head) + (head.endsWith("/") ? sep : "");
            const suffix = entry.slice(star + 1);
            if (newPath.length < prefix.length + suffix.length || !newPath.startsWith(prefix) || !newPath.endsWith(suffix)) continue;
            const middle = slashed(newPath.slice(prefix.length, newPath.length - suffix.length));
            written = key.slice(0, key.indexOf("*")) + middle + key.slice(key.indexOf("*") + 1);
            break;
          }
          if (written === undefined) {
            problem(
              start,
              `${quoted}: ${newTarget}, the new place of ${target}, is outside the folder of the paths alias ${JSON.stringify(key)} in ${where}`,
              `Import ${target} in ${file} by a relative path (imports-to-relative), or pick a --to inside that folder, then run again.`,
            );
            return;
          }
          candidate = written;
        } else {
          const oldPackageJson = nearestPackageJson(before, file);
          const key = oldPackageJson === null ? undefined : bestWildcardKey(Object.keys(importsOf(before, oldPackageJson) ?? {}), specifier);
          if (key === undefined) {
            problem(
              start,
              `cannot tell which package.json imports key ${quoted} uses`,
              `Import ${target} in ${file} by a relative path (imports-to-relative), then run again.`,
            );
            return;
          }
          const packageJson = nearestPackageJson(after, newFile);
          const value = packageJson === null ? undefined : importsOf(after, packageJson)?.[key];
          const where = packageJson ?? "no package.json";
          if (packageJson === null || typeof value !== "string" || !value.startsWith("./") || !value.includes("*")) {
            problem(
              start,
              `${quoted} uses the package.json imports key ${JSON.stringify(key)}, which ${where}, the nearest package.json to ${newFile}, does not map to a folder`,
              `Add ${JSON.stringify(key)} to its "imports", or import ${target} in ${file} by a relative path (imports-to-relative), then run again.`,
            );
            return;
          }
          const star = value.indexOf("*");
          const head = value.slice(0, star);
          const prefix = resolve(engine.absPath(dirname(packageJson)), head) + (head.endsWith("/") ? sep : "");
          const suffix = value.slice(star + 1);
          if (newPath.length < prefix.length + suffix.length || !newPath.startsWith(prefix) || !newPath.endsWith(suffix)) {
            problem(
              start,
              `${quoted}: ${newTarget}, the new place of ${target}, is outside the folder of the package.json imports key ${JSON.stringify(key)} in ${where}`,
              `Import ${target} in ${file} by a relative path (imports-to-relative), or pick a --to inside that folder, then run again.`,
            );
            return;
          }
          const middle = slashed(newPath.slice(prefix.length, newPath.length - suffix.length));
          candidate = key.slice(0, key.indexOf("*")) + middle + key.slice(key.indexOf("*") + 1);
        }
      }

      const newLiteral = newLiterals[index] as ts.StringLiteralLike;
      const newMode = t.getModeForUsageLocation(newSf, newLiteral, newOptions);
      const resolved = targetOf(after, candidate, newFile, newTsconfig, newMode);
      if (resolved !== newTargetAbs) {
        const what = resolved === undefined ? "nothing" : resolved === "package" ? "a package" : engine.relPath(resolved);
        problem(
          start,
          `${JSON.stringify(candidate)} would not resolve to ${newTarget} from ${newFile}`,
          `TypeScript would resolve it to ${what}. Change the import of ${target} in ${file} by hand, then run again.`,
        );
        return;
      }
      if (candidate === specifier) return;
      const quote = sf.text.charAt(start);
      if (candidate.includes(quote) || candidate.includes("\\") || (quote === "`" && candidate.includes("${"))) {
        problem(start, `${JSON.stringify(candidate)} cannot be written inside ${quote} quotes`, `Change the quotes of ${quoted} in ${file} by hand, then run again.`);
        return;
      }
      edits.push({ start: start + 1, end: literal.getEnd() - 1, text: candidate });
    });

    // `/// <reference path="…" />`: a path relative to the file, naming the file exactly.
    for (const reference of sf.referencedFiles) {
      const specifier = reference.fileName;
      const quoted = JSON.stringify(specifier);
      const found = resolve(dirname(fromAbs), specifier);
      const target = engine.relPath(found);
      if (target === found || !before.exists(target)) {
        if (moving) {
          problem(reference.pos, `/// <reference path=${quoted} /> does not name a file`, `Fix or remove the reference in ${file}, then run again.`);
        }
        continue;
      }
      const targetMoves = r.moves.has(target);
      if (!moving && !targetMoves) continue;
      let candidate = slashed(relative(dirname(newAbs), engine.absPath(newOf(target))));
      if (/^\.\.?\//.test(specifier) && !candidate.startsWith("../")) candidate = `./${candidate}`;
      if (candidate === specifier) continue;
      const quote = sf.text.charAt(reference.pos - 1);
      if (candidate.includes(quote) || candidate.includes("\\")) {
        problem(reference.pos, `${JSON.stringify(candidate)} cannot be written inside ${quote} quotes`, `Change the quotes of ${quoted} in ${file} by hand, then run again.`);
        continue;
      }
      edits.push({ start: reference.pos, end: reference.end, text: candidate });
    }

    // `new URL("…", import.meta.url)`: a path relative to the file (`./x`, `../x`, or a bare `x`), naming the file
    // exactly. Another scheme (`https:`, `data:`) or an absolute path is not a reference to a file here, and is left alone.
    for (const literal of urlSpecifiers(t, sf)) {
      const url = literal.text;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith("/") || url.startsWith("\\")) continue;
      const start = literal.getStart(sf);
      const shown = `new URL(${JSON.stringify(url)}, import.meta.url)`;
      const cut = url.search(/[?#]/);
      const path = cut === -1 ? url : url.slice(0, cut);
      const found = resolve(dirname(fromAbs), path);
      const target = engine.relPath(found);
      const inside = target !== found && target !== ".." && !target.startsWith("../");
      const isFile = inside && before.exists(target);
      const targetMoves = isFile && r.moves.has(target);
      // A folder URL (`./assets/`) of a file that stays has to change when the folder goes: every file in it moves.
      const inFolder = inside && !isFile ? listing.filter((f) => target === "" || target === "." || f.startsWith(`${target}/`)) : [];
      const folderMoves = move && inFolder.length > 0 && inFolder.every((f) => r.moves.has(f));
      if (!moving && !targetMoves && !folderMoves) continue;
      if (cut !== -1) {
        problem(
          start,
          `${shown} has a query or hash`,
          `jig does not rewrite a URL with a query or hash yet. Change it in ${file} by hand, or move the files by hand, then run again.`,
        );
        continue;
      }
      if (path.includes("%")) {
        problem(start, `${shown} has a percent-escape`, `jig does not decode URLs yet. Change it in ${file} by hand, or move the files by hand, then run again.`);
        continue;
      }
      if (!isFile) {
        if (inFolder.length > 0) {
          problem(
            start,
            moving ? `${shown} names a folder, not a file` : `${shown} names a folder whose files all move`,
            `jig rewrites a URL only when it names a file. Change it in ${file} to name a file, or move the files by hand, then run again.`,
          );
        } else {
          problem(start, `${shown} does not name a file`, `Fix or remove the URL in ${file}, then run again.`);
        }
        continue;
      }
      const newTarget = newOf(target);
      let candidate = slashed(relative(dirname(newAbs), engine.absPath(newTarget)));
      if (/^\.\.?\//.test(path) && !candidate.startsWith("../")) candidate = `./${candidate}`;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate) || /[?#%]/.test(candidate)) {
        problem(start, `${JSON.stringify(candidate)}, the new path to ${newTarget}, cannot be written as a URL`, `Change ${shown} in ${file} by hand, then run again.`);
        continue;
      }
      if (resolve(dirname(newAbs), candidate) !== engine.absPath(newTarget) || !after.exists(newTarget)) {
        problem(start, `${JSON.stringify(candidate)} would not name ${newTarget} from ${newFile}`, `Change ${shown} in ${file} by hand, then run again.`);
        continue;
      }
      if (candidate === url) continue;
      const quote = sf.text.charAt(start);
      if (candidate.includes(quote) || candidate.includes("\\") || (quote === "`" && candidate.includes("${"))) {
        problem(start, `${JSON.stringify(candidate)} cannot be written inside ${quote} quotes`, `Change the quotes of ${shown} in ${file} by hand, then run again.`);
        continue;
      }
      edits.push({ start: start + 1, end: literal.getEnd() - 1, text: candidate });
    }

    if (edits.length > 0) {
      let rewritten = text;
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
      }
      planned.push({ file: newFile, text: rewritten, imports: edits.length });
    }
  }

  // A moved source file must stay in the include/files of a tsconfig, as it was.
  for (const file of sources) {
    if (!/\.(m|c)?[jt]sx?$/.test(file)) continue;
    const tsconfig = tsconfigOf(file);
    if (tsconfig === null || !covered(before, tsconfig).has(engine.absPath(file))) continue;
    const newFile = newOf(file);
    const newTsconfig = tsconfigOf(newFile);
    if (newTsconfig !== null && covered(after, newTsconfig).has(engine.absPath(newFile))) continue;
    problems.push({
      path: file,
      line: 1,
      reason:
        newTsconfig === null
          ? `${tsconfig} includes ${file}, but no tsconfig.json is above ${newFile}`
          : `${tsconfig} includes ${file}, but ${newTsconfig} would not include ${newFile}`,
      instructions: `Pick a new place that ${newTsconfig ?? tsconfig} includes, or change its include, then run again.`,
    });
  }

  if (problems.length > 0) {
    throw new RefactorError(
      "REFACTOR_UNAVAILABLE",
      `Nothing was ${move ? "moved" : "copied"}: ${plural(problems.length, "reference")} cannot follow. Each needs a change first:\n` +
        problems.map((p) => `${p.path}:${p.line}: ${p.reason}. ${p.instructions}`).join("\n"),
    );
  }

  for (const from of sources) engine.copyFile(from, newOf(from));
  for (const item of planned) engine.write(item.file, item.text);
  if (move) {
    for (const from of sources) engine.write(from, null);
  }
  return {
    files: sources.map(newOf).sort(byString),
    rewritten: planned.map((p) => ({ file: p.file, imports: p.imports })).sort((a, b) => byString(a.file, b.file)),
  };
}

// ---- duplicate-folder ----

export type FolderParams = { from: string; to: string };

/** `Rewrote 3 imports in 2 files:` and the files, or a line saying none was. */
function rewrittenLines(done: Relocated): string {
  if (done.rewritten.length === 0) return "No import needed rewriting.";
  const imports = done.rewritten.reduce((n, item) => n + item.imports, 0);
  return (
    `Rewrote ${plural(imports, "import")} in ${plural(done.rewritten.length, "file")}:\n` +
    listLines(done.rewritten.map((item) => `${item.file} (${item.imports})`))
  );
}

export const duplicateFolderAction: Action<FolderParams, TsEngine> = {
  id: "duplicate-folder",
  kind: "refactor",
  summary: "Copies a folder to a new folder; the copies' imports are adjusted to their new place.",
  flags: [
    {
      name: "--from",
      type: "path",
      required: true,
      description: "The folder to copy. Every file under it is copied byte for byte (any type: .ts, .css, images): src/old/x/y.ts is copied to <to>/x/y.ts.",
    },
    { name: "--to", type: "path", required: true, description: "The new folder the copies go to. It must not exist yet, and must not be inside --from." },
  ],
  parseParams: (raw) => ({ from: required(raw, "from"), to: required(raw, "to") }),
  describe: (p) => `${p.from} to ${p.to}`,

  async run(engine, p) {
    const from = slashed(relative(engine.repoRoot, resolve(engine.repoRoot, p.from))) || ".";
    const to = slashed(relative(engine.repoRoot, resolve(engine.repoRoot, p.to))) || ".";
    if (from === ".." || from.startsWith("../") || isAbsolute(from)) {
      throw new RefactorError("INVALID_ARGS", `--from ${p.from} is outside the repo. Pass a folder relative to the repo root.`);
    }
    if (to === ".." || to.startsWith("../") || isAbsolute(to)) {
      throw new RefactorError("INVALID_ARGS", `--to ${p.to} is outside the repo. Pass a folder relative to the repo root.`);
    }
    if (from === to) {
      throw new RefactorError("INVALID_ARGS", `--from and --to are both ${from}. Pass the new folder the copy goes to as --to.`);
    }
    if (from === "." || to.startsWith(`${from}/`)) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--to ${to} is inside --from ${from}, so the copy would be copied into itself. Pass a --to outside ${from}, then run again.`,
      );
    }
    if (lstatSync(engine.absPath(from), { throwIfNoEntry: false })?.isFile() === true) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--from ${from} is a file, not a folder. Pass the folder to copy as --from (move-file moves a single file).`,
      );
    }
    // Symlinks and node_modules folders are not copied, and leaving them out silently would make a copy that differs.
    const uncopied: string[] = [];
    if (lstatSync(engine.absPath(from), { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      uncopied.push(`${from} (symlink)`);
    }
    const walk = (folder: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(engine.absPath(folder), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of [...entries].sort((a, b) => byString(a.name, b.name))) {
        const path = `${folder}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          uncopied.push(`${path} (symlink)`);
        } else if (entry.isDirectory() && entry.name === "node_modules") {
          uncopied.push(`${path} (node_modules folder)`);
        } else if (entry.isDirectory()) {
          walk(path);
        }
      }
    };
    if (uncopied.length === 0) walk(from);
    if (uncopied.length > 0) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--from ${from} holds symlinks or node_modules folders, which duplicate-folder does not copy:\n` +
          `${listLines(uncopied, 10)}\nRemove them from ${from}, or copy the folder by hand, then run again.`,
      );
    }
    const files = engine.listFiles().filter((f) => f.startsWith(`${from}/`));
    if (files.length === 0) {
      throw new RefactorError(
        "INVALID_ARGS",
        `No file is under --from ${from}: it does not exist or is empty. Pass a folder with files in it, relative to the repo root.`,
      );
    }
    // Parents first, nearest last: a path under a file cannot be looked at (ENOTDIR).
    const parents: string[] = [];
    for (let folder = dirname(to); folder !== "."; folder = dirname(folder)) parents.unshift(folder);
    for (const folder of parents) {
      if (statSync(engine.absPath(folder), { throwIfNoEntry: false })?.isDirectory() === false) {
        throw new RefactorError("INVALID_ARGS", `--to ${to} is under ${folder}, which is a file. Pass a --to whose parent folders are folders.`);
      }
    }
    if (lstatSync(engine.absPath(to), { throwIfNoEntry: false }) !== undefined) {
      throw new RefactorError("INVALID_ARGS", `--to ${to} already exists. The copy goes to a new folder: pass a --to that does not exist yet.`);
    }
    const configs = files.filter((f) => /^tsconfig.*\.json$/.test(basename(f)) || basename(f) === "jsconfig.json" || basename(f) === "package.json");
    if (configs.length > 0) {
      throw new RefactorError(
        "INVALID_ARGS",
        `${configs.join(", ")} ${configs.length === 1 ? "is" : "are"} under --from ${from}. Copying a tsconfig, jsconfig or package.json changes how ` +
          `everything under it resolves, so it is not done. Copy the folder by hand, or move ${configs.length === 1 ? "it" : "them"} out of ${from} first, then run again.`,
      );
    }
    // The nearest package.json at or above each folder (a file name inside it, as nearestPackageJson takes a file).
    const fromPackage = nearestPackageJson(engine, `${from}/x`);
    const toPackage = nearestPackageJson(engine, `${to}/x`);
    if (fromPackage !== toPackage) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--from ${from} is in the package of ${fromPackage ?? "no package.json"}, but --to ${to} is in the package of ${toPackage ?? "no package.json"}. ` +
          `A copy into another package would import across packages without being a dependency. Pass a --to in the same package as ${from}, ` +
          `or copy the folder by hand.`,
      );
    }
    const moves = new Map<string, string>();
    for (const f of files) moves.set(f, `${to}/${f.slice(from.length + 1)}`);
    const done = relocate(engine, { mode: "duplicate", moves });
    return {
      summary:
        `Copied ${plural(done.files.length, "file")} from ${from} to ${to}. Files outside the copies still import the originals.\n` +
        rewrittenLines(done),
    };
  },
};

