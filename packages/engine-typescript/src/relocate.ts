import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RefactorError, listLines, matchesAnyGlob, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import {
  bestWildcardKey,
  byString,
  list as globList,
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
 * The relocate core, shared by move-files, duplicate-files, move-file and rename-files: a group of files
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

/** The files whose references are read: TypeScript and JavaScript sources, declaration files included. */
const SOURCE = /\.(m|c)?[jt]sx?$/;
const JAVASCRIPT = /\.(m|c)?jsx?$/;

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
      `The files to ${move ? "move" : "copy"} include ${configs.join(", ")}. Moving a tsconfig, jsconfig or package.json changes how ` +
        `everything under it resolves, so it is not done. Leave ${configs.length === 1 ? "it" : "them"} out of --files, then run again.`,
    );
  }
  const taken = sources.map(newOf).filter((to) => engine.read(to) !== null || engine.existsOnDisk(to));
  if (taken.length > 0) {
    throw new RefactorError(
      "INVALID_ARGS",
      `${taken.join(", ")} already ${taken.length === 1 ? "exists" : "exist"}. Pick another --to, or move ${taken.length === 1 ? "that file" : "those files"} away first.`,
    );
  }

  const listing = engine.listFiles();
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
  const matchFiles = (t as unknown as { matchFiles: MatchFiles }).matchFiles;
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
  const importers = move ? listing.filter((f) => SOURCE.test(f)) : sources.filter((f) => SOURCE.test(f));

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
    const literals = [...importSpecifiers(t, sf), ...(JAVASCRIPT.test(file) ? jsDocSpecifiers(t, sf) : [])];
    // The resolution mode after the change: the same file, parsed as the format its new place implies.
    const newFormat = moving
      ? t.getImpliedNodeFormatForFile(newAbs, cacheFor(after, newTsconfig).getPackageJsonInfoCache(), after.host, newOptions)
      : format;
    const newSf =
      newFormat === format ? sf : t.createSourceFile(newAbs, text, { languageVersion: t.ScriptTarget.Latest, impliedNodeFormat: newFormat }, true);
    const newLiterals =
      newSf === sf ? literals : [...importSpecifiers(t, newSf), ...(JAVASCRIPT.test(file) ? jsDocSpecifiers(t, newSf) : [])];

    const edits: Edit[] = [];
    literals.forEach((literal, index) => {
      const specifier = literal.text;
      const start = literal.getStart(sf);
      const quoted = JSON.stringify(specifier);
      const style = styleIn(specifier, options);
      const mode = t.getModeForUsageLocation(sf, literal, options);
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
          const key = bestWildcardKey(Object.keys(options.paths ?? {}), specifier) as string;
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
          const key = bestWildcardKey(Object.keys(importsOf(before, nearestPackageJson(before, file) as string) ?? {}), specifier) as string;
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
    if (!SOURCE.test(file)) continue;
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
      instructions: `Pick a --to that ${newTsconfig ?? tsconfig} includes, or change its include, then run again.`,
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

// ---- move-files and duplicate-files ----

export type GroupParams = { files: string[]; from: string; to: string };

/** The old → new paths `--files`, `--from` and `--to` pick, or INVALID_ARGS. */
function group(engine: TsEngine, p: GroupParams): { from: string; to: string; moves: Map<string, string> } {
  const from = engine.relPath(p.from);
  const to = engine.relPath(p.to);
  for (const [flag, path] of [
    ["--from", from],
    ["--to", to],
  ] as const) {
    if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
      throw new RefactorError("INVALID_ARGS", `${flag} ${path} is outside the repo. Pass a folder relative to the repo root.`);
    }
  }
  if (from === to) {
    throw new RefactorError("INVALID_ARGS", `--from and --to are both ${from}. Pass the folder the files go to as --to.`);
  }
  const matches = engine.listFiles().filter((f) => matchesAnyGlob(f, p.files));
  if (matches.length === 0) {
    throw new RefactorError(
      "INVALID_ARGS",
      `No file matches ${p.files.join(", ")}. Globs are matched against the repo's files from the root (for example "src/old/**").`,
    );
  }
  const under = (f: string): boolean => from === "." || f.startsWith(`${from}/`);
  const strays = matches.filter((f) => !under(f));
  if (strays.length > 0) {
    throw new RefactorError(
      "INVALID_ARGS",
      `${strays.slice(0, 5).join(", ")}${strays.length > 5 ? ` and ${strays.length - 5} more` : ""} ${strays.length === 1 ? "matches" : "match"} --files but ${strays.length === 1 ? "is" : "are"} not under --from ${from}. ` +
        `Every file --files matches must be under --from: narrow --files or pass a wider --from, then run again.`,
    );
  }
  const moves = new Map<string, string>();
  for (const f of matches) {
    const rest = from === "." ? f : f.slice(from.length + 1);
    moves.set(f, to === "." ? rest : `${to}/${rest}`);
  }
  return { from, to, moves };
}

/** `Rewrote 3 imports in 2 files:` and the files, or a line saying none was. */
function rewrittenLines(done: Relocated): string {
  if (done.rewritten.length === 0) return "No import needed rewriting.";
  const imports = done.rewritten.reduce((n, item) => n + item.imports, 0);
  return (
    `Rewrote ${plural(imports, "import")} in ${plural(done.rewritten.length, "file")}:\n` +
    listLines(done.rewritten.map((item) => `${item.file} (${item.imports})`))
  );
}

export const moveFilesAction: Action<GroupParams, TsEngine> = {
  id: "move-files",
  kind: "refactor",
  summary: "Moves the files matching a pattern from one folder to another; every import of and in them follows.",
  flags: [
    {
      name: "--files",
      type: "globs",
      required: true,
      description: "The files to move, as comma-separated globs from the repo root (any type: .ts, .css, images). Every match must be under --from.",
    },
    { name: "--from", type: "path", required: true, description: "The folder the files are in: src/old/x.ts goes to <to>/x.ts." },
    { name: "--to", type: "path", required: true, description: "The folder they go to. No file may exist at a new path." },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files"), from: required(raw, "from"), to: required(raw, "to") }),
  describe: (p) => `${p.files.join(", ")} from ${p.from} to ${p.to}`,

  async run(engine, p) {
    const { from, to, moves } = group(engine, p);
    const done = relocate(engine, { mode: "move", moves });
    return { summary: `Moved ${plural(done.files.length, "file")} from ${from} to ${to}.\n${rewrittenLines(done)}` };
  },
};

export const duplicateFilesAction: Action<GroupParams, TsEngine> = {
  id: "duplicate-files",
  kind: "refactor",
  summary: "Copies the files matching a pattern from one folder to another; the copies' imports are adjusted to their new place.",
  flags: [
    {
      name: "--files",
      type: "globs",
      required: true,
      description: "The files to copy, as comma-separated globs from the repo root (any type: .ts, .css, images). Every match must be under --from.",
    },
    { name: "--from", type: "path", required: true, description: "The folder the files are in: src/old/x.ts is copied to <to>/x.ts." },
    { name: "--to", type: "path", required: true, description: "The folder the copies go to. No file may exist at a new path." },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files"), from: required(raw, "from"), to: required(raw, "to") }),
  describe: (p) => `${p.files.join(", ")} from ${p.from} to ${p.to}`,

  async run(engine, p) {
    const { from, to, moves } = group(engine, p);
    const done = relocate(engine, { mode: "duplicate", moves });
    return {
      summary:
        `Copied ${plural(done.files.length, "file")} from ${from} to ${to}. Files outside the copies still import the originals.\n` +
        rewrittenLines(done),
    };
  },
};
