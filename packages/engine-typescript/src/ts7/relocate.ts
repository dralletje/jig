import { lstatSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import { SyntaxKind } from "typescript7/ast";
import type * as ast7 from "typescript7/ast";
import * as is7 from "typescript7/ast/is";
import { createFileSystemLayer, serverFS } from "typescript7/fs";
import { API } from "typescript7/sync";
import type { CompilerOptions, ModuleResolver, Program, ResolutionMode, ResolveModuleNameResult, Snapshot } from "typescript7/sync";
import type { TsEngine } from "../engine.ts";
import {
  bestWildcardKey,
  byString,
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
} from "../shared.ts";
import type { NotHandled, PathsOptions, Reader, Style } from "../shared.ts";
import { importSpecifiers7 } from "./shared.ts";
import type { StringLiteralLike7 } from "./shared.ts";

/**
 * The relocate core, shared by duplicate-folder, move-file and rename-files: a group of files
 * goes to new paths (moved, or copied), and every import that has to follow is rewritten.
 *
 * On TypeScript 7's API (the native compiler, over a pipe), without a language service. Each side of the change
 * is a snapshot whose filesystem is a layer over the disk: the engine's overlay, plus the copies or moves after.
 * Importers are parsed by small programs that only parse (no resolution, no lib, no checking), one per nearest
 * tsconfig.json, which also give each reference its resolution mode. Each reference is resolved with a module
 * resolver for the options of the importer's nearest tsconfig.json, against the snapshot of that side; the
 * importers' references are resolved in one batch. A reference is touched only when its importer or its target moves. The new specifier keeps
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

/**
 * One side of the change: which files exist and what they hold (for the specifier helpers), and the TypeScript 7
 * snapshot that sees just that, through a filesystem layer over the disk.
 */
type World = Reader & {
  files: string[];
  exists: (rel: string) => boolean;
  snapshot: Snapshot;
  /** Each parsed file (absolute) → the parse-only program that holds it. */
  programs: Map<string, Program>;
  /** Resolutions already asked for, by `resolutionKey`. */
  resolved: Map<string, ResolveModuleNameResult>;
  /** Absolute folder under the root → the names of the files and folders in it. */
  listings: Map<string, { files: string[]; directories: string[] }>;
};

/** A string literal or template without substitutions, as `ts.isStringLiteralLike` checks it. */
function isStringLiteralLike7(node: ast7.Node): node is StringLiteralLike7 {
  return is7.isStringLiteral(node) || is7.isNoSubstitutionTemplateLiteral(node);
}

/** A reference to rewrite: the text between `start` and `end` (inside the quotes) becomes `text`. */
type Edit = { start: number; end: number; text: string };

/** The `@import` tags and `import("…")` types in the JSDoc of a JavaScript file. */
function jsDocSpecifiers7(sf: ast7.SourceFile): StringLiteralLike7[] {
  const out: StringLiteralLike7[] = [];
  const inDoc = (node: ast7.Node): void => {
    if (is7.isJSDocImportTag(node) && isStringLiteralLike7(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier);
    } else if (is7.isImportTypeNode(node) && is7.isLiteralTypeNode(node.argument) && is7.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal);
    }
    node.forEachChild(inDoc);
  };
  const visit = (node: ast7.Node): void => {
    for (const doc of node.jsDoc ?? []) inDoc(doc);
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** The first argument of each `new URL("…", import.meta.url)`: a plain string (no substitutions), with exactly `import.meta.url` as the base. */
function urlSpecifiers7(sf: ast7.SourceFile): StringLiteralLike7[] {
  const out: StringLiteralLike7[] = [];
  const visit = (node: ast7.Node): void => {
    if (is7.isNewExpression(node) && is7.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.length === 2) {
      const [first, second] = node.arguments;
      if (
        first !== undefined &&
        second !== undefined &&
        isStringLiteralLike7(first) &&
        is7.isPropertyAccessExpression(second) &&
        is7.isMetaProperty(second.expression) &&
        second.expression.keywordToken === SyntaxKind.ImportKeyword &&
        is7.isIdentifier(second.expression.name) &&
        second.expression.name.text === "meta" &&
        is7.isIdentifier(second.name) &&
        second.name.text === "url"
      ) {
        out.push(first);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** The key of a resolution in `World.resolved`: what is resolved, from where, how, under which options. */
function resolutionKey(tsconfig: string | null, folderAbs: string, mode: ResolutionMode | undefined, specifier: string): string {
  return `${tsconfig ?? ""}\n${folderAbs}\n${mode ?? ""}\n${specifier}`;
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

/**
 * Plans everything, refuses (REFACTOR_UNAVAILABLE) on any doubtful reference, then applies to the engine. Runs
 * TypeScript 7's compiler for the planning, and stops it again before returning.
 */
export function relocate(engine: TsEngine, r: Relocation): Relocated {
  // While `listing.world` is set, the compiler lists the folders under the root as that world has them (folders
  // nobody listed, node_modules among them, are empty), as a tsconfig's include is matched against them. Every
  // other filesystem call goes to the disk, and snapshots put their layers over that.
  const listing: Listing = { world: null };
  const api = new API({
    cwd: engine.repoRoot,
    fs: {
      directoryExists: (folder) => {
        if (listing.world === null) return serverFS.useOS;
        const abs = folder.replace(/\/+$/, "");
        if (abs !== engine.repoRoot && engine.relPath(abs) === abs) return serverFS.useOS;
        return abs === engine.repoRoot || listing.world.listings.has(abs);
      },
      fileExists: serverFS.useOS,
      readFile: serverFS.useOS,
      realpath: (path) => {
        if (listing.world === null) return serverFS.useOS;
        const abs = path.replace(/\/+$/, "");
        if (abs !== engine.repoRoot && engine.relPath(abs) === abs) return serverFS.useOS;
        return serverFS.identity;
      },
      stat: serverFS.useOS,
      writeFile: serverFS.useOS,
      removeFile: serverFS.useOS,
      getAccessibleEntries: (folder) => {
        if (listing.world === null) return serverFS.useOS;
        const abs = folder.replace(/\/+$/, "");
        if (abs !== engine.repoRoot && engine.relPath(abs) === abs) return serverFS.useOS;
        const found = listing.world.listings.get(abs);
        return { files: found?.files ?? [], directories: found?.directories ?? [], symlinks: [] };
      },
    },
  });
  try {
    return relocateWith(engine, r, api, listing);
  } finally {
    api.close();
  }
}

/** Which world the compiler lists the folders under the root of, while set. */
type Listing = { world: World | null };

function relocateWith(engine: TsEngine, r: Relocation, api: API, worldListing: Listing): Relocated {
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
  // The files whose references are read: TypeScript and JavaScript sources, declaration files included.
  const importers = move ? listing.filter((f) => /\.(m|c)?[jt]sx?$/.test(f)) : sources.filter((f) => /\.(m|c)?[jt]sx?$/.test(f));
  const movingImporters = importers.filter((f) => r.moves.has(f));

  // ---- the two worlds: TypeScript 7 snapshots over filesystem layers ----
  // Before: the disk with the engine's overlay on it. After: that, with the copies (or moves) made.
  const beforeWritten = new Map<string, string>();
  const beforeRemoved = new Set<string>();
  for (const [rel, content] of engine.overlayEntries()) {
    if (content === null) beforeRemoved.add(rel);
    else beforeWritten.set(rel, content);
  }
  const afterWritten = new Map(beforeWritten);
  const afterRemoved = new Set(beforeRemoved);
  for (const [to, from] of origins) {
    const text = engine.read(from);
    if (text === null) throw new Error(`relocate: there is no file ${from}`);
    afterWritten.set(to, text);
    afterRemoved.delete(to);
  }
  if (move) {
    for (const from of sources) {
      afterWritten.delete(from);
      afterRemoved.add(from);
    }
  }
  const layer = (written: Map<string, string>, removed: Set<string>): ReturnType<typeof createFileSystemLayer> =>
    createFileSystemLayer(
      [...written].map(([rel, text]): [string, string] => [engine.absPath(rel), text]),
      { removedPaths: [...removed].map((rel) => engine.absPath(rel)) },
    );
  const optionsCache = new Map<string, CompilerOptions>();
  /**
   * The compiler options of the tsconfig (its errors ignored, as the engine does), or the defaults for none. Read
   * from disk: relocate never changes a tsconfig, and no action writes one before it.
   */
  const optionsOf = (tsconfig: string | null): CompilerOptions => {
    if (tsconfig === null) return {};
    let options = optionsCache.get(tsconfig);
    if (options === undefined) {
      try {
        options = api.parseConfigFile(engine.absPath(tsconfig)).options;
      } catch (e) {
        throw new RefactorError(
          "REFACTOR_UNAVAILABLE",
          `TypeScript 7 could not read ${tsconfig} (${(e as Error).message}), so nothing was ${move ? "moved" : "copied"}. ` +
            `Fix ${tsconfig}, then run again.`,
        );
      }
      // TypeScript 7 reads baseUrl but resolves nothing through it: paths are relative to the tsconfig's folder.
      const baseUrl = (options as PathsOptions).baseUrl;
      if (baseUrl !== undefined && baseUrl !== engine.absPath(dirname(tsconfig))) {
        throw new RefactorError(
          "REFACTOR_UNAVAILABLE",
          `${tsconfig} sets baseUrl to another folder than its own, so nothing was ${move ? "moved" : "copied"}. jig resolves imports ` +
            `with TypeScript 7, which no longer resolves through baseUrl, so imports could resolve differently than in your TypeScript. ` +
            `Remove baseUrl (write its paths relative to the tsconfig's folder, and bare imports through baseUrl as paths aliases), then run again.`,
        );
      }
      optionsCache.set(tsconfig, options);
    }
    return options;
  };

  /**
   * The world of a new snapshot over a filesystem layer, with the files given parsed: one parse-only program per
   * tsconfig (its options, so the same module format, but nothing resolved, no lib, JavaScript allowed).
   */
  const makeWorld = (
    fileSystem: ReturnType<typeof createFileSystemLayer>,
    files: string[],
    read: (rel: string) => string | null,
    parse: { file: string; tsconfig: string | null }[],
  ): World => {
    const groups = new Map<string | null, string[]>();
    for (const item of parse) {
      const group = groups.get(item.tsconfig);
      if (group === undefined) groups.set(item.tsconfig, [engine.absPath(item.file)]);
      else group.push(engine.absPath(item.file));
    }
    const listings = new Map<string, { files: string[]; directories: string[] }>();
    const folders = new Set<string>();
    const listingOf = (folder: string): { files: string[]; directories: string[] } => {
      const abs = engine.absPath(folder === "." ? "" : folder);
      let found = listings.get(abs);
      if (found === undefined) {
        found = { files: [], directories: [] };
        listings.set(abs, found);
      }
      return found;
    };
    for (const file of files) {
      listingOf(dirname(file)).files.push(basename(file));
      let folder = dirname(file);
      while (folder !== "." && !folders.has(folder)) {
        folders.add(folder);
        listingOf(dirname(folder)).directories.push(basename(folder));
        folder = dirname(folder);
      }
    }
    const entries = [...groups];
    const snapshot = api.createSnapshot({
      fileSystem,
      createPrograms: entries.map(([tsconfig, rootFiles]) => ({
        rootFiles,
        compilerOptions: { ...optionsOf(tsconfig), allowJs: true, noResolve: true, noLib: true, types: [] },
      })),
    });
    const programs = new Map<string, Program>();
    const created = snapshot.operation.createdPrograms ?? [];
    entries.forEach(([, rootFiles], index) => {
      const program = created[index];
      if (program === undefined) throw new Error(`relocate: TypeScript 7 created no program for ${rootFiles[0]}`);
      for (const abs of rootFiles) programs.set(abs, program);
    });
    const present = new Set(files);
    return {
      files,
      exists: (rel) => present.has(rel),
      read: (rel) => (present.has(rel) ? read(rel) : null),
      absPath: (file) => engine.absPath(file),
      relPath: (file) => engine.relPath(file),
      snapshot,
      programs,
      resolved: new Map(),
      listings,
    };
  };
  const before = makeWorld(
    layer(beforeWritten, beforeRemoved),
    listing,
    (rel) => engine.read(rel),
    importers.map((file) => ({ file, tsconfig: tsconfigOf(file) })),
  );
  const after = makeWorld(
    layer(afterWritten, afterRemoved),
    [...listing.filter((f) => !(move && r.moves.has(f))), ...origins.keys()].sort(byString),
    (rel) => {
      const origin = origins.get(rel);
      if (origin !== undefined) return engine.read(origin);
      return engine.read(rel);
    },
    movingImporters.map((file) => ({ file: newOf(file), tsconfig: tsconfigOf(newOf(file)) })),
  );

  const coveredCache = new Map<World, Map<string, Set<string>>>();
  /**
   * The absolute paths of the files the tsconfig's include and files take in, in that world: the tsconfig parsed
   * while the compiler lists the root's folders as the world has them (see `listing` in `relocate`).
   */
  const covered = (world: World, tsconfig: string): Set<string> => {
    let perWorld = coveredCache.get(world);
    if (perWorld === undefined) {
      perWorld = new Map();
      coveredCache.set(world, perWorld);
    }
    let names = perWorld.get(tsconfig);
    if (names === undefined) {
      worldListing.world = world;
      try {
        names = new Set(api.parseConfigFile(engine.absPath(tsconfig)).fileNames);
      } finally {
        worldListing.world = null;
      }
      perWorld.set(tsconfig, names);
    }
    return names;
  };

  const resolvers = new Map<string, ModuleResolver>();
  /** A module resolver with the options of the tsconfig (the defaults for none). */
  const resolverOf = (tsconfig: string | null): ModuleResolver => {
    let resolver = resolvers.get(tsconfig ?? "");
    if (resolver === undefined) {
      resolver = api.createModuleResolver(optionsOf(tsconfig));
      resolvers.set(tsconfig ?? "", resolver);
    }
    return resolver;
  };

  /** Each importer parsed in a world: its source file, its reference literals, and the resolution mode of each. */
  type Parsed = { sf: ast7.SourceFile; literals: StringLiteralLike7[]; modes: (ResolutionMode | undefined)[] };
  /** Parses the files (root-relative, as they are in that world) in one batch, and asks their modes in another. */
  const parseIn = (world: World, files: string[]): Map<string, Parsed> => {
    const programOf = (abs: string): Program => {
      const program = world.programs.get(abs);
      if (program === undefined) throw new Error(`relocate: no program parses ${abs}`);
      return program;
    };
    const absFiles = files.map((f) => engine.absPath(f));
    const sfs = api.batch(...absFiles.map((abs) => programOf(abs).getSourceFile.gen(abs)));
    const out = new Map<string, Parsed>();
    const asks: { parsed: Parsed; gen: ReturnType<Program["getModeForUsageLocation"]["gen"]> }[] = [];
    absFiles.forEach((abs, index) => {
      const sf = sfs[index];
      if (sf === undefined) throw new Error(`relocate: TypeScript 7 did not parse ${abs}`);
      const literals = [...importSpecifiers7(sf), ...(/\.(m|c)?jsx?$/.test(abs) ? jsDocSpecifiers7(sf) : [])];
      const parsed: Parsed = { sf, literals, modes: [] };
      out.set(files[index] as string, parsed);
      for (const literal of literals) asks.push({ parsed, gen: programOf(abs).getModeForUsageLocation.gen(abs, literal) });
    });
    const modes = api.batch(...asks.map((a) => a.gen));
    asks.forEach((ask, index) => {
      ask.parsed.modes.push(modes[index] as ResolutionMode | undefined);
    });
    return out;
  };
  const parsedBefore = parseIn(before, importers);
  const parsedAfter = parseIn(
    after,
    movingImporters.map((f) => newOf(f)),
  );

  // Every reference of every importer resolved before the change, in one batch: most are only looked up.
  const asks: { key: string; gen: ReturnType<ModuleResolver["resolveModuleName"]["gen"]> }[] = [];
  const asked = new Set<string>();
  for (const file of importers) {
    const parsed = parsedBefore.get(file);
    if (parsed === undefined) continue;
    const tsconfig = tsconfigOf(file);
    const folderAbs = dirname(engine.absPath(file));
    parsed.literals.forEach((literal, index) => {
      const query = literal.text.indexOf("?");
      const specifier = query === -1 ? literal.text : literal.text.slice(0, query);
      const mode = parsed.modes[index];
      const key = resolutionKey(tsconfig, folderAbs, mode, specifier);
      if (asked.has(key)) return;
      asked.add(key);
      asks.push({ key, gen: resolverOf(tsconfig).resolveModuleName.gen(specifier, folderAbs, mode, { snapshot: before.snapshot }) });
    });
  }
  const results = api.batch(...asks.map((a) => a.gen));
  asks.forEach((ask, index) => {
    before.resolved.set(ask.key, results[index] as ResolveModuleNameResult);
  });

  /**
   * How a specifier is written, as TypeScript reads it: a tsconfig `paths` key is tried before package.json
   * `imports`, so `#app/x` matching a `"#app/*"` paths key is an alias.
   */
  const styleIn = (specifier: string, options: CompilerOptions): Style => {
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
    mode: ResolutionMode | undefined,
  ): string | "package" | undefined => {
    const options = optionsOf(tsconfig);
    const folderAbs = dirname(engine.absPath(file));
    const key = resolutionKey(tsconfig, folderAbs, mode, specifier);
    let result = world.resolved.get(key);
    if (result === undefined) {
      result = resolverOf(tsconfig).resolveModuleName(specifier, folderAbs, mode, { snapshot: world.snapshot });
      world.resolved.set(key, result);
    }
    const found = result.resolvedModule;
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

    const parsed = parsedBefore.get(file);
    if (parsed === undefined) throw new Error(`relocate: ${file} was not parsed`);
    const { sf, literals, modes } = parsed;
    // After the change: the same text, at its new place (its module format can change there).
    const parsedNew = moving ? parsedAfter.get(newFile) : parsed;
    if (parsedNew === undefined) throw new Error(`relocate: ${newFile} was not parsed`);
    const { literals: newLiterals, modes: newModes } = parsedNew;

    const edits: Edit[] = [];
    literals.forEach((literal, index) => {
      const specifier = literal.text;
      const start = literal.getStart(sf);
      const quoted = JSON.stringify(specifier);
      const mode = modes[index];
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
          // TypeScript 7 has no baseUrl: paths are relative to the tsconfig's folder, its pathsBasePath (not in its typings).
          const pathsOptions: PathsOptions = newOptions;
          const base = pathsOptions.baseUrl ?? pathsOptions.pathsBasePath;
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

      if (newLiterals.length !== literals.length) throw new Error(`relocate: ${file} parses differently at ${newFile}`);
      const newMode = newModes[index];
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
    for (const literal of urlSpecifiers7(sf)) {
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

