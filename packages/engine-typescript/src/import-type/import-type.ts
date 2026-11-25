import { isAbsolute } from "node:path";
import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { Project, TsEngine } from "../engine.ts";
import { PREFERENCES, byString, diagnostics, list as globList, introduced, matchFiles, moduleName, notHandled, unavailable } from "../shared.ts";
import type { NotHandled } from "../shared.ts";

/**
 * A sweep over the shape of imports: imports and specifiers that are only types become `import type`
 * / `type` specifiers (TypeScript'"'"'s fix-all for type-only imports).
 */

type Ts = TsEngine["ts"];

// ---- import-type ----

const FIX_ID = "convertToTypeOnlyImport";
/** "'X' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled", and the same for a type-only declaration. */
const TYPE_ONLY_ERRORS = [1484, 1485];

/** What an import declaration says about type-only: for each local name, whether it is `type`. */
function typeFlags(t: Ts, statement: ts.Statement): Map<string, boolean> | undefined {
  if (!t.isImportDeclaration(statement) || !statement.importClause) return undefined;
  const clause = statement.importClause;
  const whole = clause.phaseModifier === t.SyntaxKind.TypeKeyword;
  const flags = new Map<string, boolean>();
  if (clause.name) flags.set(clause.name.text, whole);
  const bindings = clause.namedBindings;
  if (bindings && t.isNamespaceImport(bindings)) flags.set(bindings.name.text, whole);
  if (bindings && t.isNamedImports(bindings)) {
    for (const e of bindings.elements) flags.set(e.name.text, whole || e.isTypeOnly);
  }
  return flags;
}

/**
 * A language service over the project's files with `verbatimModuleSyntax` on: its error "X is a type and
 * must be imported using a type-only import" is what TypeScript's fix-all for type-only imports fixes, so
 * it is switched on for the service only, never in the project's tsconfig.
 */
function verbatimService(engine: TsEngine, project: Project): ts.LanguageService {
  const t = engine.ts;
  const program = project.service.getProgram();
  const options: ts.CompilerOptions = { ...(program?.getCompilerOptions() ?? {}), verbatimModuleSyntax: true };
  const roots = [...(program?.getRootFileNames() ?? [])];
  const text = (file: string): string | undefined => {
    const rel = engine.relPath(file);
    return isAbsolute(rel) ? t.sys.readFile(file) : (engine.read(rel) ?? undefined);
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => roots,
    getScriptVersion: () => "0",
    getScriptSnapshot: (f) => {
      const content = text(f);
      return content === undefined ? undefined : t.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => engine.absPath(project.folder),
    getDefaultLibFileName: (o) => t.getDefaultLibFilePath(o),
    fileExists: (f) => text(f) !== undefined,
    readFile: text,
    readDirectory: (...args) => t.sys.readDirectory(...args),
    directoryExists: (d) => t.sys.directoryExists(d),
    getDirectories: (d) => t.sys.getDirectories(d),
    useCaseSensitiveFileNames: () => t.sys.useCaseSensitiveFileNames,
  };
  return t.createLanguageService(host, t.createDocumentRegistry());
}

/** A default import that is only a type but shares its declaration with named imports: statement index and name. */
type Unsafe = { index: number; name: string };

/** The import clause whose default name `pos` is at, if any. */
function defaultClauseAt(t: Ts, sf: ts.SourceFile, pos: number): ts.ImportClause | undefined {
  for (const statement of sf.statements) {
    if (!t.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.name && clause.name.getStart(sf) === pos) return clause;
  }
  return undefined;
}

/**
 * The text changes of TypeScript's "convertToTypeOnlyImport" fix for every error of the file, one
 * diagnostic at a time (its combined fix-all asserts "Changes overlap" on an import whose names are all
 * types). Each error's first fix is the whole `import type` when the declaration allows it, else the
 * single `type` specifier; identical changes of several errors count once.
 */
function typeOnlyFixes(
  engine: TsEngine,
  service: ts.LanguageService,
  file: string,
  format: ts.FormatCodeSettings,
): { changes: ts.FileTextChanges[]; unsafe: Unsafe[] } {
  const t = engine.ts;
  const abs = engine.absPath(file);
  const program = service.getProgram();
  const sf = program?.getSourceFile(abs);
  if (!program || !sf) return { changes: [], unsafe: [] };
  const unsafe: Unsafe[] = [];
  const unique = new Map<string, ts.TextChange>();
  for (const d of program.getSemanticDiagnostics(sf)) {
    if (!TYPE_ONLY_ERRORS.includes(d.code) || d.start === undefined) continue;
    const fixes = service.getCodeFixesAtPosition(abs, d.start, d.start + (d.length ?? 0), [d.code], format, PREFERENCES);
    const fix = fixes.find((f) => f.fixName === FIX_ID);
    if (!fix) {
      // TypeScript offers no fix for a default import. `import type D from "m"` is ours to write when the
      // default is all the declaration imports; `import type D, { a }` is not valid, so that one is left.
      const clause = defaultClauseAt(t, sf, d.start);
      if (clause && !clause.phaseModifier) {
        if (clause.namedBindings) {
          const index = sf.statements.indexOf(clause.parent as ts.Statement);
          unsafe.push({ index, name: (clause.name as ts.Identifier).text });
        } else {
          const start = (clause.name as ts.Identifier).getStart(sf);
          const change = { span: { start, length: 0 }, newText: "type " };
          unique.set(`${start}:0:type `, change);
        }
      }
    }
    for (const change of fix?.changes ?? []) {
      if (engine.relPath(change.fileName) !== file) {
        unavailable(`TypeScript's type-only import fix wants to change files other than ${file}. Leave ${file} out of --files.`);
      }
      for (const c of change.textChanges) unique.set(`${c.span.start}:${c.span.length}:${c.newText}`, c);
    }
  }
  const ordered = [...unique.values()].sort((a, b) => a.span.start - b.span.start);
  ordered.forEach((c, i) => {
    const next = ordered[i + 1];
    if (next && c.span.start + c.span.length > next.span.start) {
      unavailable(`${file}: TypeScript's type-only import fixes overlap. Leave ${file} out of --files.`);
    }
  });
  return { changes: ordered.length > 0 ? [{ fileName: abs, textChanges: ordered }] : [], unsafe };
}

export type ImportTypeParams = { files: string[] };

export const importTypeAction: Action<ImportTypeParams, TsEngine> = {
  id: "import-type",
  kind: "sweep",
  summary: "Turns imports used only as types into import type.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files whose imports change, as comma-separated globs from the repo root." },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files") }),
  describe: (p) => p.files.join(", "),

  async run(engine, p) {
    const t = engine.ts;
    const format = t.getDefaultFormatCodeSettings("\n");
    const files = await matchFiles(engine.repoRoot, p.files);

    // Plan everything (from the files as they are) before writing anything.
    const services = new Map<string, ts.LanguageService>();
    const planned: { file: string; changes: readonly ts.FileTextChanges[]; unsafe: Unsafe[] }[] = [];
    for (const file of files) {
      const project = engine.project(file);
      let service = services.get(project.folder);
      if (!service) {
        service = verbatimService(engine, project);
        services.set(project.folder, service);
      }
      const { changes, unsafe } = typeOnlyFixes(engine, service, file, format);
      if (changes.length > 0 || unsafe.length > 0) planned.push({ file, changes, unsafe });
    }

    let count = 0;
    const changedFiles: string[] = [];
    const misses: NotHandled[] = [];
    // The import declaration at `index` of the file as it is now, not handled.
    const miss = (file: string, index: number, reason: string, instructions: string): void => {
      const declaration = engine.sourceFile(file).sf.statements[index] as ts.ImportDeclaration;
      const module = moduleName(declaration);
      const { path, line } = engine.location(declaration);
      misses.push({
        path,
        line,
        reason,
        instructions: instructions.replaceAll("{module}", module),
      });
    };
    for (const { file, changes, unsafe } of planned) {
      const original = engine.read(file) ?? "";
      const old = engine.sourceFile(file).sf;
      const errorsBefore = diagnostics(engine, file);
      engine.applyTextChanges(changes);
      const now = engine.sourceFile(file).sf;
      if (old.statements.length !== now.statements.length) {
        unavailable(`${file}: TypeScript's type-only import fix changed the number of statements. Leave ${file} out of --files.`);
      }
      const indexes: number[] = [];
      old.statements.forEach((statement, i) => {
        const was = typeFlags(t, statement);
        const is = typeFlags(t, now.statements[i] as ts.Statement);
        if (!was || !is) return;
        const converted = [...is].filter(([name, flag]) => flag && was.get(name) === false);
        if (converted.length === 0) return;
        indexes.push(i);
      });
      // A file that would gain errors is put back as it was and is not handled; the run goes on.
      const errors = introduced(errorsBefore, diagnostics(engine, file));
      if (errors.length > 0) {
        engine.write(file, original);
        for (const i of indexes) {
          miss(
            file,
            i,
            `making it type-only would introduce errors: ${errors.join("; ")}`,
            `Left the import of "{module}" in ${file} as it is, because making it type-only would introduce errors ` +
              `(${errors.join("; ")}). Fix that by hand, then run again.`,
          );
        }
      } else if (indexes.length > 0) {
        count += indexes.length;
        changedFiles.push(file);
      }
      for (const u of unsafe) {
        miss(
          file,
          u.index,
          `the default import \`${u.name}\` is only a type but shares its declaration with named imports`,
          `Left the import of "{module}" in ${file} as it is: \`import type ${u.name}, { … }\` is not valid. Split it into ` +
            `\`import type ${u.name} from "{module}"\` and an import of the named imports, then run again.`,
        );
      }
    }

    if (changedFiles.length === 0) {
      throw new RefactorError(
        "NO_CHANGES",
        misses.length === 0
          ? `No import in ${p.files.join(", ")} is used only as a type and still lacks \`type\`.`
          : `No import was made type-only. Skipped:\n${misses.map((m) => `${m.path}:${m.line}: ${m.reason}\n  ${m.instructions.split("\n").join("\n  ")}`).join("\n")}`,
      );
    }
    const sorted = changedFiles.sort(byString);
    return {
      summary:
        `Made ${plural(count, "import")} type-only in ${plural(sorted.length, "file")}:\n${listLines(sorted)}` +
        (misses.length > 0 ? `\n\n${notHandled(misses)}` : ""),
    };
  },
};
