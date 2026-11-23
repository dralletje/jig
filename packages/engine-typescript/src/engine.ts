import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RefactorError, listFiles } from "@jig/core";
import type { Decl, DeclKind, Engine, FileChange } from "@jig/core";
import type ts from "typescript";
import { TS_FILE } from "./shared.ts";

type Ts = typeof import("typescript");

/**
 * The TypeScript files under one folder: the folder of a `tsconfig.json`, or the root when no tsconfig
 * is above a file. Every TS file under the folder is a root file, whatever the tsconfig's include says.
 */
export type Project = {
  /** Root-relative folder, `.` for the root. */
  folder: string;
  /** Root-relative path of the tsconfig, or null for the root without one (TypeScript's default options). */
  tsconfig: string | null;
  service: ts.LanguageService;
};

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class TsEngine implements Engine {
  readonly id = "typescript";
  readonly ts: Ts;
  readonly version: string;
  readonly repoRoot: string;

  /** Files on disk when loaded, root-relative. */
  private readonly files: string[];
  /** Root-relative path → content (`null` = deleted). Shared by every project's host. */
  private readonly overlay = new Map<string, string | null>();
  /**
   * Root-relative path → the file on disk whose bytes it gets: copies made with `copyFile`. The overlay
   * holds their text for reading; `changes()` gives the bytes. A `write` to the path ends the copy.
   */
  private readonly copies = new Map<string, string>();
  /** Root-relative path → script version, bumped on every write. */
  private readonly versions = new Map<string, number>();
  /** Files that exist only in the overlay, and files on disk the overlay deletes. */
  private readonly created = new Set<string>();
  private readonly deleted = new Set<string>();
  /** Bumped whenever `created` or `deleted` changes; projects recompute their root files then. */
  private fileSet = 0;
  /**
   * Bumped on every write. Each project's host reports it as its project version, so TypeScript skips
   * re-checking every file's version when nothing was written since its last look.
   */
  private writes = 0;
  /** Path as TypeScript passes it → `rel` of it. `rel` runs for every file on every version check. */
  private readonly relCache = new Map<string, string | null>();
  /**
   * Absolute folder → the names in it on disk. The disk does not change while the engine runs (writes go
   * to the overlay until the end), so each folder is listed once.
   */
  private readonly listings = new Map<string, Set<string>>();
  /** Folder → its project. */
  private readonly projects = new Map<string, Project>();

  private constructor(repoRoot: string, typescript: Ts, files: string[]) {
    this.repoRoot = repoRoot;
    this.ts = typescript;
    this.version = typescript.version;
    this.files = files;
  }

  static async load(root: string): Promise<TsEngine> {
    const repoRoot = realpathSync(resolve(root));
    return new TsEngine(repoRoot, createRequire(import.meta.url)("typescript") as Ts, await listFiles(repoRoot));
  }

  // ---- paths ----

  /** Root-relative `/` path, or null when the path is outside the root. */
  private rel(file: string): string | null {
    const cached = this.relCache.get(file);
    if (cached !== undefined) return cached;
    const r = relative(this.repoRoot, resolve(this.repoRoot, file));
    const result = r === "" || r.startsWith("..") || isAbsolute(r) ? null : r.split(sep).join("/");
    this.relCache.set(file, result);
    return result;
  }

  /** Absolute form of a root-relative or absolute path. */
  absPath(file: string): string {
    return isAbsolute(file) ? file : join(this.repoRoot, file);
  }

  /** Root-relative `/` form of a path (unchanged if outside the root). */
  relPath(file: string): string {
    return this.rel(file) ?? file;
  }

  // ---- overlay ----

  /**
   * Whether a file with exactly this name (case included) is on disk. A read or `existsSync` cannot tell:
   * on a case-insensitive file system `src/footer.ts` finds `src/Footer.ts`. The parent's listing keeps
   * the case the file was created with.
   */
  existsOnDisk(rel: string): boolean {
    const abs = join(this.repoRoot, rel);
    const folder = dirname(abs);
    let names = this.listings.get(folder);
    if (names === undefined) {
      try {
        names = new Set(readdirSync(folder));
      } catch {
        names = new Set();
      }
      this.listings.set(folder, names);
    }
    return names.has(basename(abs));
  }

  private readDisk(rel: string): string | null {
    if (!this.existsOnDisk(rel)) return null;
    try {
      return readFileSync(join(this.repoRoot, rel), "utf8");
    } catch {
      return null;
    }
  }

  /** Content of an absolute path: the overlay for files under the root, then disk. */
  private readAbs(absPath: string): string | undefined {
    const rel = this.rel(absPath);
    if (rel !== null && this.overlay.has(rel)) return this.overlay.get(rel) ?? undefined;
    return this.ts.sys.readFile(absPath);
  }

  private existsAbs(absPath: string): boolean {
    const rel = this.rel(absPath);
    if (rel !== null && this.overlay.has(rel)) return this.overlay.get(rel) !== null;
    return this.ts.sys.fileExists(absPath);
  }

  /** A directory on disk, or one that only files created in the overlay are in. */
  private directoryExists(absPath: string): boolean {
    if (this.ts.sys.directoryExists(absPath)) return true;
    const rel = this.rel(absPath);
    return rel !== null && [...this.created].some((f) => f.startsWith(`${rel}/`));
  }

  /** Every file as the overlay sees it, root-relative and sorted: the files on disk when loaded, plus created, minus deleted. */
  listFiles(): string[] {
    return [...new Set([...this.files, ...this.created])].filter((f) => !this.deleted.has(f)).sort(byString);
  }

  read(file: string): string | null {
    const rel = this.relPath(file);
    if (this.overlay.has(rel)) return this.overlay.get(rel) ?? null;
    return this.readDisk(rel);
  }

  write(file: string, content: string | null): void {
    const rel = this.relPath(file);
    this.overlay.set(rel, content);
    this.copies.delete(rel);
    this.versions.set(rel, (this.versions.get(rel) ?? 0) + 1);
    this.writes++;
    const onDisk = this.existsOnDisk(rel);
    const created = content !== null && !onDisk;
    const deleted = content === null && onDisk;
    if (created !== this.created.has(rel) || deleted !== this.deleted.has(rel)) this.fileSet++;
    if (created) this.created.add(rel);
    else this.created.delete(rel);
    if (deleted) this.deleted.add(rel);
    else this.deleted.delete(rel);
  }

  /**
   * `to` gets `from`'s content. When `from` is unchanged on disk, `to` gets its bytes exactly as they are
   * there (an image, a file that is not UTF-8), while `read(to)` gives its text; a later `write(to, …)`
   * replaces the copy. Moving a file is `copyFile(a, b)` then `write(a, null)`.
   */
  copyFile(from: string, to: string): void {
    const source = this.relPath(from);
    const target = this.relPath(to);
    const text = this.read(source);
    if (text === null) throw new Error(`copyFile: there is no file ${source}`);
    const bytesFrom = this.copies.get(source) ?? (this.overlay.has(source) ? null : source);
    this.write(target, text);
    if (bytesFrom !== null) this.copies.set(target, bytesFrom);
  }

  applyTextChanges(changes: readonly ts.FileTextChanges[]): void {
    for (const change of changes) {
      const base = change.isNewFile ? "" : (this.read(change.fileName) ?? "");
      // End → start so earlier offsets stay valid. For equal starts, the later edit goes first,
      // which leaves the edits in their given order in the result.
      const ordered = change.textChanges
        .map((c, i) => ({ c, i }))
        .sort((a, b) => b.c.span.start - a.c.span.start || b.i - a.i);
      let text = base;
      for (const { c } of ordered) {
        text = text.slice(0, c.span.start) + c.newText + text.slice(c.span.start + c.span.length);
      }
      this.write(change.fileName, text);
    }
  }

  changes(): FileChange[] {
    const out: FileChange[] = [];
    for (const [path, after] of this.overlay) {
      const before = this.readDisk(path);
      const bytesFrom = this.copies.get(path);
      if (bytesFrom !== undefined) {
        // A pure copy: the source's bytes as on disk, never through a string.
        const bytes = new Uint8Array(readFileSync(join(this.repoRoot, bytesFrom)));
        const old = this.existsOnDisk(path) ? readFileSync(join(this.repoRoot, path)) : null;
        if (old === null || !old.equals(bytes)) out.push({ path, before, after: bytes });
        continue;
      }
      if (before !== after) out.push({ path, before, after });
    }
    return out.sort((a, b) => byString(a.path, b.path));
  }

  // ---- projects ----

  /** The project of the nearest `tsconfig.json` at or above the file's folder and inside the root, else the root. */
  project(file: string): Project {
    const rel = this.rel(file);
    let folder = rel === null ? "." : dirname(rel);
    while (true) {
      const tsconfig = folder === "." ? "tsconfig.json" : `${folder}/tsconfig.json`;
      if (this.read(tsconfig) !== null) return this.projectAt(folder, tsconfig);
      if (folder === ".") return this.projectAt(".", null);
      folder = dirname(folder);
    }
  }

  private projectAt(folder: string, tsconfig: string | null): Project {
    let project = this.projects.get(folder);
    if (!project) {
      project = this.createProject(folder, tsconfig);
      this.projects.set(folder, project);
    }
    return project;
  }

  private createProject(folder: string, tsconfig: string | null): Project {
    const typescript = this.ts;
    const folderAbs = this.absPath(folder);
    // Read again when the tsconfig is written (an action that changes compiler options).
    let optionsFor = -1;
    let options: ts.CompilerOptions = {};
    const settings = (): ts.CompilerOptions => {
      if (tsconfig === null) return options;
      const version = this.versions.get(tsconfig) ?? 0;
      if (version !== optionsFor) {
        optionsFor = version;
        options = this.compilerOptions(tsconfig, folderAbs);
      }
      return options;
    };

    const prefix = folder === "." ? "" : `${folder}/`;
    let rootsFor = -1;
    let rootNames: string[] = [];
    const roots = (): string[] => {
      if (rootsFor !== this.fileSet) {
        rootsFor = this.fileSet;
        const files = new Set([...this.files, ...this.created]);
        rootNames = [...files]
          .filter((f) => f.startsWith(prefix) && TS_FILE.test(f) && !this.deleted.has(f))
          .sort(byString)
          .map((f) => this.absPath(f));
      }
      return rootNames;
    };

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: settings,
      getScriptFileNames: roots,
      getProjectVersion: () => String(this.writes),
      getScriptVersion: (f) => {
        const rel = this.rel(f);
        return String(rel === null ? 0 : (this.versions.get(rel) ?? 0));
      },
      getScriptSnapshot: (f) => {
        const text = this.readAbs(f);
        return text === undefined ? undefined : typescript.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => folderAbs,
      getDefaultLibFileName: (o) => typescript.getDefaultLibFilePath(o),
      fileExists: (p) => this.existsAbs(p),
      readFile: (p) => this.readAbs(p),
      readDirectory: (...args) => typescript.sys.readDirectory(...args),
      directoryExists: (d) => this.directoryExists(d),
      getDirectories: (d) => typescript.sys.getDirectories(d),
      useCaseSensitiveFileNames: () => typescript.sys.useCaseSensitiveFileNames,
    };
    const service = typescript.createLanguageService(host, typescript.createDocumentRegistry());
    return { folder, tsconfig, service };
  }

  /**
   * The tsconfig's compiler options. Its errors are ignored: an `extends` that cannot be resolved (an
   * npm package without node_modules) still leaves the tsconfig's own options. Its include is not read.
   */
  private compilerOptions(tsconfig: string, folderAbs: string): ts.CompilerOptions {
    const host: ts.ParseConfigFileHost = {
      useCaseSensitiveFileNames: this.ts.sys.useCaseSensitiveFileNames,
      readDirectory: () => [],
      fileExists: (p) => this.existsAbs(p),
      readFile: (p) => this.readAbs(p),
      getCurrentDirectory: () => folderAbs,
      onUnRecoverableConfigFileDiagnostic: () => {},
    };
    return this.ts.getParsedCommandLineOfConfigFile(this.absPath(tsconfig), undefined, host)?.options ?? {};
  }

  /** The file's project's program and the file's source file (overlay content). */
  sourceFile(file: string): { program: ts.Program; sf: ts.SourceFile } {
    const rel = this.relPath(file);
    if (this.read(rel) === null) throw new RefactorError("SYMBOL_NOT_FOUND", `There is no file ${rel}. Pass a path relative to the repo root.`);
    const program = this.project(rel).service.getProgram();
    const sf = program?.getSourceFile(this.absPath(rel));
    if (!program || !sf) throw new RefactorError("REFACTOR_UNAVAILABLE", `${rel} is not a TypeScript file. Pass a .ts, .tsx, .mts or .cts file.`);
    return { program, sf };
  }

  // ---- symbols ----

  private topLevelDecls(sf: ts.SourceFile, file: string): Decl[] {
    const typescript = this.ts;
    const decls: Decl[] = [];
    const add = (name: ts.Identifier, kind: DeclKind, stmt: ts.Statement): void => {
      decls.push({
        file,
        name: name.text,
        kind,
        nameStart: name.getStart(sf),
        start: stmt.getStart(sf),
        end: stmt.getEnd(),
      });
    };
    for (const stmt of sf.statements) {
      if (typescript.isFunctionDeclaration(stmt) && stmt.name) {
        const prev = decls.at(-1);
        // Overloads and their implementation are adjacent statements: one declaration.
        if (prev && prev.kind === "function" && prev.name === stmt.name.text && prev.end <= stmt.getStart(sf)) {
          prev.end = stmt.getEnd();
        } else {
          add(stmt.name, "function", stmt);
        }
      } else if (typescript.isClassDeclaration(stmt) && stmt.name) {
        add(stmt.name, "class", stmt);
      } else if (typescript.isInterfaceDeclaration(stmt)) {
        add(stmt.name, "interface", stmt);
      } else if (typescript.isTypeAliasDeclaration(stmt)) {
        add(stmt.name, "type", stmt);
      } else if (typescript.isEnumDeclaration(stmt)) {
        add(stmt.name, "enum", stmt);
      } else if (typescript.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (typescript.isIdentifier(d.name)) add(d.name, "variable", stmt);
        }
      }
    }
    return decls;
  }

  findTopLevel(file: string, name: string, kind?: DeclKind): Decl {
    const rel = this.relPath(file);
    const { sf } = this.sourceFile(rel);
    const matches = this.topLevelDecls(sf, rel).filter((d) => d.name === name && (kind === undefined || d.kind === kind));
    if (matches.length === 0) {
      const what = kind === undefined ? name : `${kind} ${name}`;
      throw new RefactorError(
        "SYMBOL_NOT_FOUND",
        `There is no top-level ${what} in ${rel}. Check the name and the file (only top-level declarations count), then run again.`,
      );
    }
    if (matches.length > 1) {
      const found = matches.map((d) => `${d.kind} at ${rel}:${sf.getLineAndCharacterOfPosition(d.start).line + 1}`);
      throw new RefactorError(
        "AMBIGUOUS_SYMBOL",
        `${name} in ${rel} matches ${matches.length} declarations (${found.join(", ")}). Pass --kind ${[...new Set(matches.map((d) => d.kind))].join("|")} to pick one.`,
      );
    }
    return matches[0] as Decl;
  }

  // ---- names and positions, for summaries and messages ----

  /**
   * The position-free path of the declaration `node` is (or is the name of), or of the nearest named
   * declaration around it: `src/a.ts#processOrder`, `src/a.ts#OrderService.save`,
   * `src/a.ts#outer.helper`. Anonymous functions and blocks are skipped; a node outside any named
   * declaration gives the file path alone (`src/a.ts`). Use it in summaries.
   *
   * Grammar: `<file>#<segment>(.<segment>)*`; a segment is a name (JSON-quoted when it is not an
   * identifier: `api."a.b"`; `#x` for private names; `[expr]` for computed ones), prefixed by
   * `static ` and/or `get `/`set ` for such class members, and suffixed by `#<n>` for the n-th (n ≥ 2)
   * same-named declaration under the same parent in source order (`outer.helper#2`). Overload
   * signatures share the path of their implementation.
   */
  declarationPath(node: ts.Node): string {
    const file = this.relPath(node.getSourceFile().fileName);
    const names: string[] = [];
    for (let n: ts.Node | undefined = node; n && !this.ts.isSourceFile(n); n = n.parent) {
      const name = declarationName(this.ts, n);
      if (name === undefined) continue;
      const index = siblingIndex(this.ts, n, name);
      names.unshift(index > 1 ? `${name}#${index}` : name);
    }
    return names.length > 0 ? `${file}#${names.join(".")}` : file;
  }

  /** The declaration node of a top-level `Decl` (its name's parent) in the file's current text. */
  declarationNode(decl: Decl): ts.Node {
    const { sf } = this.sourceFile(decl.file);
    let found: ts.Node | undefined;
    const visit = (n: ts.Node): void => {
      if (found || decl.nameStart < n.getStart(sf) || decl.nameStart >= n.getEnd()) return;
      if (this.ts.isIdentifier(n) && n.getStart(sf) === decl.nameStart) found = n.parent;
      else this.ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) throw new Error(`no declaration of ${decl.name} at ${decl.file}:${decl.nameStart}`);
    return found;
  }

  /**
   * Where `node` starts (1-based line and column) in the text of the source file the node belongs to.
   * A node from before an edit gives its position before the edit: for a report, take nodes from
   * `engine.sourceFile(file)` after the last edit of that file.
   */
  location(node: ts.Node): { path: string; line: number; column: number } {
    const sf = node.getSourceFile();
    return position(this.relPath(sf.fileName), sf.text, node.getStart(sf));
  }

  /** The 1-based line and column of an offset into the file's current (overlay) text. */
  locationAt(file: string, offset: number): { path: string; line: number; column: number } {
    return position(this.relPath(file), this.read(file) ?? "", offset);
  }
}

function position(path: string, text: string, offset: number): { path: string; line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return { path, line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

const IDENTIFIER_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

/** A function-like declaration without a body: an overload signature, which shares its implementation's path. */
function isSignature(t: Ts, n: ts.Node): boolean {
  return (
    (t.isFunctionDeclaration(n) || t.isMethodDeclaration(n) || t.isConstructorDeclaration(n)) && n.body === undefined
  );
}

/**
 * Which same-named declaration (by its segment) under the same named parent `n` is, 1-based in source
 * order. Overload signatures are not counted: they get the index of the implementation that follows.
 */
function siblingIndex(t: Ts, n: ts.Node, name: string): number {
  const owner = namedOwner(t, n.parent);
  let before = 0;
  let done = false;
  const visit = (c: ts.Node): void => {
    if (done) return;
    if (c === n) {
      done = true;
      return;
    }
    if (c !== owner && declarationName(t, c) === name && namedOwner(t, c.parent) === owner && !isSignature(t, c)) {
      before++;
    }
    t.forEachChild(c, visit);
  };
  visit(owner);
  return before + 1;
}

/** The name a declaration contributes to a declaration path, or undefined for anything else. */
function declarationName(t: Ts, n: ts.Node): string | undefined {
  if (t.isConstructorDeclaration(n)) return "constructor";
  if ((t.isFunctionDeclaration(n) || t.isClassDeclaration(n)) && !n.name) return "default";
  if (
    t.isFunctionDeclaration(n) ||
    t.isClassDeclaration(n) ||
    t.isInterfaceDeclaration(n) ||
    t.isTypeAliasDeclaration(n) ||
    t.isEnumDeclaration(n) ||
    t.isEnumMember(n) ||
    t.isModuleDeclaration(n) ||
    t.isMethodDeclaration(n) ||
    t.isMethodSignature(n) ||
    t.isPropertyDeclaration(n) ||
    t.isPropertySignature(n) ||
    t.isGetAccessorDeclaration(n) ||
    t.isSetAccessorDeclaration(n) ||
    (t.isPropertyAssignment(n) && definesSomething(t, n.initializer)) ||
    (t.isVariableDeclaration(n) && (isModuleLevel(t, n) || (n.initializer !== undefined && definesSomething(t, n.initializer))))
  ) {
    const name = n.name;
    if (!name) return undefined;
    let text: string;
    if (t.isIdentifier(name) || t.isPrivateIdentifier(name)) text = name.text;
    else if (t.isStringLiteral(name) || t.isNumericLiteral(name)) {
      text = IDENTIFIER_NAME.test(name.text) ? name.text : JSON.stringify(name.text);
    } else if (t.isComputedPropertyName(name)) text = `[${name.expression.getText()}]`;
    else return undefined;
    const accessor = t.isGetAccessorDeclaration(n) ? "get " : t.isSetAccessorDeclaration(n) ? "set " : "";
    const isStatic = t.canHaveModifiers(n) && (t.getModifiers(n) ?? []).some((m) => m.kind === t.SyntaxKind.StaticKeyword);
    return `${isStatic ? "static " : ""}${accessor}${text}`;
  }
  return undefined;
}

/**
 * A function, class or object literal: what makes a local `const` or an object property a named place
 * (`outer.helper`, `api.save`). A plain local value (`const total = sum()`) is not one, so what is in
 * its initializer belongs to the function around it.
 */
function definesSomething(t: Ts, e: ts.Expression): boolean {
  let inner = e;
  while (
    t.isParenthesizedExpression(inner) ||
    t.isAsExpression(inner) ||
    t.isSatisfiesExpression(inner) ||
    t.isTypeAssertionExpression(inner) ||
    t.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return t.isFunctionLike(inner) || t.isClassExpression(inner) || t.isObjectLiteralExpression(inner);
}

/** A variable declared at the top of a file or namespace. */
function isModuleLevel(t: Ts, d: ts.VariableDeclaration): boolean {
  const statement = d.parent.parent;
  return t.isVariableStatement(statement) && (t.isSourceFile(statement.parent) || t.isModuleBlock(statement.parent));
}

/** The nearest node around `node` (itself included) that has a declaration name, else its source file. */
function namedOwner(t: Ts, node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (t.isSourceFile(n) || declarationName(t, n) !== undefined) return n;
  }
  return node.getSourceFile();
}
