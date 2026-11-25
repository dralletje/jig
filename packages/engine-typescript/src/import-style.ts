import { sep } from "node:path";
import { RefactorError, listLines, matchesAnyGlob, plural } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import {
  diagnostics,
  importSpecifiers,
  introduced,
  matchFiles,
  namedPaths,
  notHandled,
  spelledPath,
  styleOf,
  usesExactKey,
} from "./shared.ts";
import type { NotHandled } from "./shared.ts";

/**
 * imports-to-relative, imports-to-alias, imports-to-subpath: import specifiers in `--files` that resolve to
 * a file matching `--targets` are written in another style, each still resolving to the same file:
 * relative (`../lib/date`), a tsconfig `paths` alias (`@/lib/date`) or a package.json `imports` subpath
 * (`#/lib/date`).
 *
 * Specifiers come from `import`/`export … from` (type-only too), `import()`, `import x = require()`,
 * `require()` and `import("…")` types. Each is resolved with TypeScript's module resolution under the
 * importing file's project. The style of a specifier: relative (`./`, `../`), subpath (`#…`), alias (a
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

/** Module resolution that reads files the way the engine does (its overlay, and exact-case names on disk). */
function resolutionHost(engine: TsEngine): ts.ModuleResolutionHost {
  const t = engine.ts;
  const inRoot = (p: string): boolean => engine.relPath(p) !== p;
  return {
    fileExists: (p) => (inRoot(p) ? engine.read(p) !== null : t.sys.fileExists(p)),
    readFile: (p) => (inRoot(p) ? (engine.read(p) ?? undefined) : t.sys.readFile(p)),
    directoryExists: (p) => t.sys.directoryExists(p),
    realpath: (p) => t.sys.realpath?.(p) ?? p,
    getCurrentDirectory: () => engine.repoRoot,
  };
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
  writerFor: (file: string) => (path: string, target: string) => Spelling;
  /** Added to the instructions of a specifier that would not resolve to the same file. */
  resolveHint: string;
};

type Planned = { file: string; edits: Edit[]; before: string[] };

/** The edits for one file's specifiers in other styles that resolve to a target, and the ones left alone. */
function planFile(engine: TsEngine, file: string, targets: string[], to: TargetStyle): { edits: Edit[]; misses: NotHandled[] } {
  const t = engine.ts;
  const { program, sf } = engine.sourceFile(file);
  const options = program.getCompilerOptions();
  const host = resolutionHost(engine);
  const from = engine.absPath(file);
  const edits: Edit[] = [];
  const misses: NotHandled[] = [];
  let writer: ((path: string, target: string) => Spelling) | null = null;
  for (const specifier of importSpecifiers(t, sf)) {
    const style = styleOf(specifier.text, options);
    if (style === "package" || style === to.style) continue;
    const quoted = JSON.stringify(specifier.text);
    const miss = (reason: string, instructions: string): void => {
      const { path, line } = engine.locationAt(file, specifier.getStart(sf));
      misses.push({ path, line, reason, instructions });
    };
    const mode = t.getModeForUsageLocation(sf, specifier, options);
    const resolveName = (name: string): string | undefined =>
      t.resolveModuleName(name, from, options, host, undefined, undefined, mode).resolvedModule?.resolvedFileName;
    const resolvedModule = t.resolveModuleName(specifier.text, from, options, host, undefined, undefined, mode).resolvedModule;
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
    writer ??= to.writerFor(file);
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
export async function sweepImports(engine: TsEngine, files: string[], targets: string[], to: TargetStyle): Promise<{ summary: string }> {
  // Plan everything first, so a refusal (missing configuration) leaves nothing written.
  const planned: Planned[] = [];
  const misses: NotHandled[] = [];
  for (const file of await matchFiles(engine.repoRoot, files)) {
    const found = planFile(engine, file, targets, to);
    misses.push(...found.misses);
    if (found.edits.length > 0) planned.push({ file, edits: found.edits, before: diagnostics(engine, file) });
  }

  // Write every planned file, then check them all at once: one program rebuild instead of one per file.
  // A file that gained errors is put back, and the rest checked again, until no file gains any.
  const originals = new Map<string, string>();
  for (const item of planned) {
    const original = engine.read(item.file) ?? "";
    originals.set(item.file, original);
    let text = original;
    for (const edit of [...item.edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    engine.write(item.file, text);
  }
  let done: Planned[] = planned;
  while (done.length > 0) {
    const failed: { item: Planned; errors: string[] }[] = [];
    for (const item of done) {
      const errors = introduced(item.before, diagnostics(engine, item.file));
      if (errors.length > 0) failed.push({ item, errors });
    }
    if (failed.length === 0) break;
    for (const { item, errors } of failed) {
      // Located in the original text, so the line is the one the edit is on.
      engine.write(item.file, originals.get(item.file) ?? "");
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
