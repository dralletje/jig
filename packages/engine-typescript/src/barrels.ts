import { basename, isAbsolute, posix, resolve } from "node:path";
import { listFiles, listLines, plural } from "@jig/core";
import type { Action, ActionResult } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { TS_FILE, byString, diagnostics, list as globList, introduced, matchFiles, unavailable } from "./shared.ts";

/**
 * typescript-remove-barrels: imports through a barrel (an `index.ts`/`index.tsx` that only re-exports)
 * import each name from the module that defines it; barrels nothing imports any more are deleted.
 */

const BARREL_NAME = /^index\.tsx?$/;
/** Files other than TypeScript that may import a barrel, so keep it alive. */
const OTHER_SOURCE = /\.((m|c)?jsx?|vue|svelte|astro|mdx)$/;
const CONFIG_JSON = /(^|\/)(package|(ts|js)config[^/]*)\.json$/;

/** Where a name imported through a barrel comes from: a module and its export name (`null`: the module namespace). */
type Resolved = { file: string; name: string | null; typeOnly: boolean };

/** One imported or re-exported name: `imported` is the barrel's export name (`default` for a default import). */
type Binding = { imported: string; local: string; typeOnly: boolean };

type Item = Binding & { target: Resolved };

/** Module resolution and barrel lookups in one project's program. */
class Resolver {
  private readonly t: TsEngine["ts"];
  private readonly checker: ts.TypeChecker;
  private readonly engine: TsEngine;
  private readonly program: ts.Program;
  private readonly folder: string;

  constructor(engine: TsEngine, program: ts.Program, folder: string) {
    this.engine = engine;
    this.program = program;
    this.folder = folder;
    this.t = engine.ts;
    this.checker = program.getTypeChecker();
  }

  rel(abs: string): string {
    return this.engine.relPath(abs);
  }

  /** The source file a module specifier resolves to (absolute), or null (ambient module, unresolved). */
  moduleFile(specifier: ts.Expression): string | null {
    const decl = this.checker.getSymbolAtLocation(specifier)?.valueDeclaration;
    return decl && this.t.isSourceFile(decl) ? decl.fileName : null;
  }

  /** A TypeScript source of this project: not outside it (another package), not in node_modules, not a declaration file. */
  inProject(abs: string): boolean {
    const rel = this.rel(abs);
    if (isAbsolute(rel) || /(^|\/)node_modules\//.test(rel) || /\.d\.[mc]?ts$/.test(rel) || !TS_FILE.test(rel)) {
      return false;
    }
    return this.folder === "." || rel.startsWith(`${this.folder}/`);
  }

  isBarrel(abs: string): boolean {
    const sf = this.program.getSourceFile(abs);
    return sf !== undefined && isBarrelFile(this.t, sf);
  }

  /** Follows `name` from `barrel` to the first module that is not a barrel of this project. Null on a cycle. */
  resolve(barrel: string, name: string, typeOnly: boolean, seen: Set<string>): Resolved | null {
    const t = this.t;
    const key = `${barrel}\0${name}`;
    if (seen.has(key)) return null;
    const visited = new Set([...seen, key]);
    const sf = this.program.getSourceFile(barrel);
    if (!sf) unavailable(`cannot read ${this.rel(barrel)}`);
    const exports = sf.statements.filter(t.isExportDeclaration);

    // Named re-exports win over `export *`, as in TypeScript.
    for (const stmt of exports) {
      const clause = stmt.exportClause;
      if (!clause) continue;
      if (t.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (el.name.text !== name) continue;
          const imported = (el.propertyName ?? el.name).text;
          return this.follow(barrel, stmt, name, imported, typeOnly || stmt.isTypeOnly || el.isTypeOnly, visited);
        }
      } else if (clause.name.text === name) {
        const to = this.moduleFile(stmt.moduleSpecifier as ts.Expression);
        const only = typeOnly || stmt.isTypeOnly;
        if (to === null || !this.inProject(to)) return { file: this.rel(barrel), name, typeOnly: only };
        return { file: this.rel(to), name: null, typeOnly: only };
      }
    }

    if (name === "default") unavailable(`${this.rel(barrel)} does not export default`);
    const stars = exports
      .filter((stmt) => stmt.exportClause === undefined)
      .flatMap((stmt) => {
        const module = this.checker.getSymbolAtLocation(stmt.moduleSpecifier as ts.Expression);
        const symbol = module && this.checker.tryGetMemberInModuleExports(name, module);
        if (!symbol) return [];
        return [{ stmt, symbol: symbol.flags & t.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol }];
      });
    if (stars.length === 0) unavailable(`${this.rel(barrel)} does not export ${name}`);
    if (new Set(stars.map((s) => s.symbol)).size > 1) {
      const from = stars.map((s) => JSON.stringify((s.stmt.moduleSpecifier as ts.StringLiteral).text));
      unavailable(
        `${this.rel(barrel)} exports ${name} from more than one module through export * (${from.join(", ")}). ` +
          `Export ${name} by name from the one that is meant, then run again.`,
      );
    }
    // The same definition through several `export *`: the first path that is not a cycle.
    for (const { stmt } of stars) {
      const found = this.follow(barrel, stmt, name, name, typeOnly || stmt.isTypeOnly, visited);
      if (found) return found;
    }
    return null;
  }

  /** The next step of a re-export of `imported` (exported by `barrel` as `exported`). */
  private follow(
    barrel: string,
    stmt: ts.ExportDeclaration,
    exported: string,
    imported: string,
    typeOnly: boolean,
    seen: Set<string>,
  ): Resolved | null {
    const specifier = stmt.moduleSpecifier as ts.Expression;
    const to = this.moduleFile(specifier);
    // Across a package boundary (or into something that is not a source here): left going through this barrel.
    if (to === null || !this.inProject(to)) return { file: this.rel(barrel), name: exported, typeOnly };
    if (this.isBarrel(to)) return this.resolve(to, imported, typeOnly, seen);
    const module = this.checker.getSymbolAtLocation(specifier);
    if (!module || !this.checker.tryGetMemberInModuleExports(imported, module)) {
      unavailable(`${this.rel(to)} does not export ${imported} (re-exported by ${this.rel(barrel)})`);
    }
    return { file: this.rel(to), name: imported, typeOnly };
  }
}

/** `index.ts`/`index.tsx` with only re-exports (`export … from`), at least one. */
function isBarrelFile(t: TsEngine["ts"], sf: ts.SourceFile): boolean {
  return (
    BARREL_NAME.test(basename(sf.fileName)) &&
    sf.statements.length > 0 &&
    sf.statements.every((s) => t.isExportDeclaration(s) && s.moduleSpecifier !== undefined)
  );
}

// ---- writing specifiers and declarations ----

/**
 * The specifier for `target` (root-relative), written the way `original` was: through the same `paths`
 * alias when it used one (else relative), with or without an extension as it had. Must resolve to `target`.
 */
function specifierFor(
  engine: TsEngine,
  importer: string,
  usage: ts.StringLiteral,
  target: string,
  options: ts.CompilerOptions,
  sf: ts.SourceFile,
): string {
  const t = engine.ts;
  const original = usage.text;
  const forms: string[] = [];
  if (/\.[mc]?tsx?$/.test(original) && !/\.d\.[mc]?ts$/.test(original)) {
    forms.push(target);
  } else if (/\.[mc]?jsx?$/.test(original)) {
    forms.push(target.replace(/\.([mc]?)tsx?$/, (_, m: string) => `.${m}js`));
  } else {
    const bare = target.replace(/\.[mc]?tsx?$/, "");
    if (/(^|\/)index$/.test(bare) && !/(^|\/)index$/.test(original)) {
      const folder = bare.replace(/\/?index$/, "");
      if (folder !== "") forms.push(folder);
    }
    forms.push(bare);
  }

  const candidates: string[] = [];
  if (!original.startsWith(".")) {
    const base = options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? engine.absPath(engine.project(importer).folder);
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      const parts = pattern.split("*");
      if (parts.length !== 2) continue;
      const [pre = "", suf = ""] = parts;
      if (!original.startsWith(pre) || !original.endsWith(suf) || original.length < pre.length + suf.length) continue;
      for (const mapped of targets) {
        const mappedParts = resolve(base, mapped).split("*");
        if (mappedParts.length !== 2) continue;
        const [tpre = "", tsuf = ""] = mappedParts;
        for (const form of forms) {
          const abs = engine.absPath(form);
          if (abs.startsWith(tpre) && abs.endsWith(tsuf) && abs.length >= tpre.length + tsuf.length) {
            candidates.push(pre + abs.slice(tpre.length, abs.length - tsuf.length) + suf);
          }
        }
      }
    }
  }
  for (const form of forms) {
    const rel = posix.relative(posix.dirname(importer), form);
    candidates.push(rel.startsWith(".") ? rel : `./${rel}`);
  }

  const mode = t.getModeForUsageLocation(sf, usage, options);
  const wanted = engine.absPath(target);
  for (const candidate of candidates) {
    const resolved = t.resolveModuleName(candidate, engine.absPath(importer), options, t.sys, undefined, undefined, mode);
    if (resolved.resolvedModule?.resolvedFileName === wanted) return candidate;
  }
  return unavailable(
    `No import specifier in ${importer} resolves to ${target} (tried ${candidates.join(", ")}). Import it directly by hand, then run again.`,
  );
}

/** An IdentifierName: what `{ name as local }` accepts without quotes (string export names are refused). */
const IDENTIFIER_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

function checkName(name: string, where: string): void {
  if (!IDENTIFIER_NAME.test(name)) {
    unavailable(`${where}: ${JSON.stringify(name)} is not an identifier`);
  }
}

function element(exportName: string, local: string, typeModifier: boolean): string {
  return `${typeModifier ? "type " : ""}${exportName === local ? local : `${exportName} as ${local}`}`;
}

/** Import declarations for the items of one target module. */
function importText(items: Item[], declType: boolean, from: string, semi: string): string[] {
  const out: string[] = [];
  const named = items.filter((i) => i.target.name !== null);
  if (named.length > 0) {
    if (declType) {
      const only = named[0];
      out.push(
        named.length === 1 && only?.target.name === "default"
          ? `import type ${only.local} from ${from}${semi}`
          : `import type { ${named.map((i) => element(i.target.name ?? "", i.local, false)).join(", ")} } from ${from}${semi}`,
      );
    } else {
      const def = named.find((i) => i.target.name === "default" && !i.typeOnly);
      const rest = named.filter((i) => i !== def);
      const head = [
        ...(def ? [def.local] : []),
        ...(rest.length > 0 ? [`{ ${rest.map((i) => element(i.target.name ?? "", i.local, i.typeOnly)).join(", ")} }`] : []),
      ];
      out.push(`import ${head.join(", ")} from ${from}${semi}`);
    }
  }
  for (const i of items.filter((i) => i.target.name === null)) {
    out.push(`import ${declType || i.typeOnly ? "type " : ""}* as ${i.local} from ${from}${semi}`);
  }
  return out;
}

/** Re-export declarations for the items of one target module. */
function exportText(items: Item[], declType: boolean, from: string, semi: string): string[] {
  const out: string[] = [];
  const named = items.filter((i) => i.target.name !== null);
  if (named.length > 0) {
    const list = named.map((i) => element(i.target.name ?? "", i.local, !declType && i.typeOnly)).join(", ");
    out.push(`export ${declType ? "type " : ""}{ ${list} } from ${from}${semi}`);
  }
  for (const i of items.filter((i) => i.target.name === null)) {
    out.push(`export ${declType || i.typeOnly ? "type " : ""}* as ${i.local} from ${from}${semi}`);
  }
  return out;
}

// ---- one importer ----

/** `bypassed`: how many names the file now imports from the module that defines them. */
type Rewritten = { file: string; barrels: string[]; bypassed: number };

/** Rewrites the file's imports and re-exports that go through a barrel of its project. */
function rewriteImporter(engine: TsEngine, file: string): Rewritten {
  const t = engine.ts;
  const { program, sf } = engine.sourceFile(file);
  const resolver = new Resolver(engine, program, engine.project(file).folder);
  if (resolver.isBarrel(sf.fileName)) return { file, barrels: [], bypassed: 0 };
  const options = program.getCompilerOptions();
  const edits: { start: number; end: number; text: string }[] = [];
  const barrels = new Set<string>();
  let bypassed = 0;

  for (const stmt of sf.statements) {
    let bindings: Binding[];
    let declType: boolean;
    let kind: "import" | "export";
    if (t.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      // Side-effect imports, namespace imports and deferred imports stay as they are.
      if (!clause || stmt.attributes || clause.phaseModifier === t.SyntaxKind.DeferKeyword) continue;
      const named = clause.namedBindings;
      if (named && t.isNamespaceImport(named)) continue;
      declType = clause.phaseModifier === t.SyntaxKind.TypeKeyword;
      bindings = [
        ...(clause.name ? [{ imported: "default", local: clause.name.text, typeOnly: declType }] : []),
        ...(named?.elements ?? []).map((el) => ({
          imported: (el.propertyName ?? el.name).text,
          local: el.name.text,
          typeOnly: declType || el.isTypeOnly,
        })),
      ];
      kind = "import";
    } else if (t.isExportDeclaration(stmt) && stmt.exportClause && t.isNamedExports(stmt.exportClause) && !stmt.attributes) {
      // `export *` and `export * as ns` from a barrel stay as they are.
      declType = stmt.isTypeOnly;
      bindings = stmt.exportClause.elements.map((el) => ({
        imported: (el.propertyName ?? el.name).text,
        local: el.name.text,
        typeOnly: declType || el.isTypeOnly,
      }));
      kind = "export";
    } else {
      continue;
    }
    const specifier = stmt.moduleSpecifier;
    if (bindings.length === 0 || !specifier || !t.isStringLiteral(specifier)) continue;
    const barrel = resolver.moduleFile(specifier);
    if (barrel === null || !resolver.inProject(barrel) || !resolver.isBarrel(barrel)) continue;

    const barrelRel = resolver.rel(barrel);
    const items: Item[] = bindings.map((b) => {
      const target = resolver.resolve(barrel, b.imported, b.typeOnly, new Set());
      if (!target) {
        unavailable(`${b.imported} from ${barrelRel} goes round in a cycle of re-exports. Break the cycle first, then run again.`);
      }
      checkName(b.local, file);
      if (target.name !== null) checkName(target.name, target.file);
      return { ...b, target };
    });
    if (items.every((i) => i.target.file === barrelRel)) continue;

    const groups = new Map<string, Item[]>();
    for (const item of items) groups.set(item.target.file, [...(groups.get(item.target.file) ?? []), item]);
    const quote = specifier.getText(sf).charAt(0);
    const semi = stmt.getText(sf).trimEnd().endsWith(";") ? ";" : "";
    const lines: string[] = [];
    for (const [target, group] of groups) {
      const text = target === barrelRel ? specifier.text : specifierFor(engine, file, specifier, target, options, sf);
      const from = `${quote}${text}${quote}`;
      lines.push(...(kind === "import" ? importText(group, declType, from, semi) : exportText(group, declType, from, semi)));
    }
    edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: lines.join("\n") });
    barrels.add(barrelRel);
    bypassed += items.filter((item) => item.target.file !== barrelRel).length;
  }

  if (edits.length === 0) return { file, barrels: [], bypassed: 0 };
  const before = diagnostics(engine, file);
  let text = sf.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  engine.write(file, text);
  const errors = introduced(before, diagnostics(engine, file));
  if (errors.length > 0) {
    unavailable(
      `Rewriting the imports of ${file} would introduce errors: ${errors.join("; ")}. Fix the imports of that ` +
        `file by hand or leave it out of --files, then run again.`,
    );
  }
  return { file, barrels: [...barrels].sort(byString), bypassed };
}

// ---- what still refers to a barrel ----

/**
 * Referrer → the files its quoted module-like strings resolve to, for every TypeScript and JavaScript-like
 * file. Any quoted string counts (imports, `import()`, `require`, `vi.mock("./lib")`, comments): a barrel
 * mentioned anywhere is kept.
 */
async function references(engine: TsEngine): Promise<Map<string, Set<string>>> {
  const t = engine.ts;
  const out = new Map<string, Set<string>>();
  for (const file of await listFiles(engine.repoRoot)) {
    if (!TS_FILE.test(file) && !OTHER_SOURCE.test(file)) continue;
    const text = engine.read(file);
    if (text === null) continue;
    const options = engine.project(file).service.getProgram()?.getCompilerOptions() ?? {};
    const prefixes = Object.keys(options.paths ?? {}).map((p) => p.split("*")[0] ?? p);
    const targets = new Set<string>();
    for (const match of text.matchAll(/(["'`])([^"'`\s]+)\1/g)) {
      const name = match[2] ?? "";
      const local =
        name.startsWith(".") || name.startsWith("/") || options.baseUrl !== undefined || prefixes.some((p) => name.startsWith(p));
      if (!local) continue;
      for (const mode of [undefined, t.ModuleKind.ESNext, t.ModuleKind.CommonJS] as const) {
        const resolved = t.resolveModuleName(name, engine.absPath(file), options, t.sys, undefined, undefined, mode);
        const target = resolved.resolvedModule?.resolvedFileName;
        if (target) targets.add(engine.relPath(target));
      }
    }
    out.set(file, targets);
  }
  return out;
}

/** Files named by a package.json or tsconfig (entry points, `paths` targets, …), root-relative. */
async function entryPoints(engine: TsEngine): Promise<Set<string>> {
  const t = engine.ts;
  const out = new Set<string>();
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value !== null && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];
  for (const file of await listFiles(engine.repoRoot)) {
    if (!CONFIG_JSON.test(file)) continue;
    const text = engine.read(file);
    if (text === null) continue;
    for (const value of strings(t.parseConfigFileTextToJson(file, text).config)) {
      if (value.includes("*")) continue;
      out.add(posix.normalize(posix.join(posix.dirname(file), value)));
    }
  }
  return out;
}

function isEntryPoint(entries: Set<string>, file: string): boolean {
  return entries.has(file) || entries.has(file.replace(/\.[mc]?tsx?$/, "")) || entries.has(posix.dirname(file));
}

// ---- the action ----

export type RemoveBarrelsParams = { files: string[] };

export const removeBarrelsAction: Action<RemoveBarrelsParams, TsEngine> = {
  id: "typescript-remove-barrels",
  kind: "refactor",
  summary: "Imports through barrel files from the defining modules, and deletes barrels nothing imports any more.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files whose imports go through barrels, as comma-separated globs from the repo root." },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files") }),
  describe: (p) => `${p.files.join(", ")}`,

  async run(engine, p) {
    const left = new Set<string>();
    let bypassed = 0;
    const rewritten: string[] = [];
    for (const file of await matchFiles(engine.repoRoot, p.files)) {
      const result = rewriteImporter(engine, file);
      for (const barrel of result.barrels) left.add(barrel);
      bypassed += result.bypassed;
      if (result.bypassed > 0) rewritten.push(file);
    }
    const deleted = new Set<string>();
    const result = (): ActionResult => {
      const gone = [...deleted].sort(byString);
      return {
        summary:
          `Imported ${plural(bypassed, "name")} from the modules that define them instead of through barrels, ` +
          `in ${plural(rewritten.length, "file")}:\n${listLines(rewritten)}` +
          (gone.length > 0 ? `\n\nDeleted ${plural(gone.length, "barrel")} nothing uses any more:\n${listLines(gone)}` : ""),
      };
    };
    if (left.size === 0) return result();

    // Delete the barrels nothing refers to any more; a deleted barrel may free the barrels it re-exported.
    const refs = await references(engine);
    const entries = await entryPoints(engine);
    let queue = [...left].sort(byString);
    while (queue.length > 0) {
      const next = new Set<string>();
      for (const barrel of queue) {
        if (deleted.has(barrel) || isEntryPoint(entries, barrel)) continue;
        if (!isBarrelFile(engine.ts, engine.sourceFile(barrel).sf)) continue;
        const used = [...refs].some(([from, targets]) => from !== barrel && !deleted.has(from) && targets.has(barrel));
        if (used) continue;
        deleted.add(barrel);
        engine.write(barrel, null);
        for (const target of refs.get(barrel) ?? []) next.add(target);
      }
      queue = [...next].sort(byString);
    }
    return result();
  },
};
