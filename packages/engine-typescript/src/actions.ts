import { RefactorError, plural } from "@jig/core";
import type { Action, ActionResult, DeclKind } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { PREFERENCES, list, names, required } from "./shared.ts";

const KINDS: DeclKind[] = ["function", "class", "interface", "type", "enum", "variable"];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const RENAME_PREFERENCES: ts.UserPreferences = { ...PREFERENCES, providePrefixAndSuffixTextForRename: true };

function kindParam(raw: Record<string, string | undefined>): { kind?: DeclKind } {
  const kind = raw.kind;
  if (kind === undefined) return {};
  if (!KINDS.includes(kind as DeclKind)) {
    throw new RefactorError("INVALID_ARGS", `--kind must be one of ${KINDS.join("|")}, not ${JSON.stringify(kind)}.`);
  }
  return { kind: kind as DeclKind };
}

export type RenameParams = { file: string; symbol: string; to: string; kind?: DeclKind };

export const renameAction: Action<RenameParams, TsEngine> = {
  id: "typescript-rename",
  kind: "refactor",
  summary: "Renames a top-level declaration and all its references in the project.",
  flags: [
    { name: "--file", type: "path", required: true, description: "The file that declares the symbol." },
    { name: "--symbol", type: "text", required: true, description: "The top-level declaration to rename." },
    { name: "--to", type: "text", required: true, description: "The new name. It must be an identifier." },
    {
      name: "--kind",
      type: "choice",
      choices: [
        { name: "function", description: "A function declaration." },
        { name: "class", description: "A class declaration." },
        { name: "interface", description: "An interface declaration." },
        { name: "type", description: "A type alias." },
        { name: "enum", description: "An enum declaration." },
        { name: "variable", description: "A variable declared with const, let or var." },
      ],
      required: false,
      description: "Which declaration to rename, when several in the file have the name.",
    },
  ],
  parseParams(raw) {
    const to = required(raw, "to");
    if (!IDENTIFIER.test(to)) {
      throw new RefactorError("INVALID_ARGS", `--to must be an identifier, not ${JSON.stringify(to)}.`);
    }
    return { file: required(raw, "file"), symbol: required(raw, "symbol"), to, ...kindParam(raw) };
  },
  describe: (p) => `${p.symbol} → ${p.to} in ${p.file}`,

  async run(engine, p) {
    const decl = engine.findTopLevel(p.file, p.symbol, p.kind);
    const abs = engine.absPath(p.file);
    const { service } = engine.project(p.file);
    const info = service.getRenameInfo(abs, decl.nameStart, RENAME_PREFERENCES);
    if (!info.canRename) {
      throw new RefactorError("REFACTOR_UNAVAILABLE", `TypeScript cannot rename ${p.symbol}: ${info.localizedErrorMessage}`);
    }
    const found = service.findRenameLocations(abs, decl.nameStart, false, false, RENAME_PREFERENCES) ?? [];
    // One entry per file, so its offsets all refer to the same text.
    const byFile = new Map<string, ts.TextChange[]>();
    for (const loc of found) {
      const edits = byFile.get(loc.fileName) ?? [];
      edits.push({ span: loc.textSpan, newText: `${loc.prefixText ?? ""}${p.to}${loc.suffixText ?? ""}` });
      byFile.set(loc.fileName, edits);
    }
    engine.applyTextChanges([...byFile].map(([fileName, textChanges]) => ({ fileName, textChanges })));
    const file = engine.relPath(p.file);
    return {
      summary: `Renamed \`${p.symbol}\` to \`${p.to}\` in ${file} (${plural(found.length, "place")} in ${plural(byFile.size, "file")}).`,
    };
  },
};

function usesImportMeta(typescript: typeof ts, node: ts.Node): boolean {
  if (typescript.isMetaProperty(node) && node.keywordToken === typescript.SyntaxKind.ImportKeyword) return true;
  return typescript.forEachChild(node, (child) => usesImportMeta(typescript, child) || undefined) ?? false;
}

export type ExtractParams = { file: string; symbols: string[]; to: string; kind?: DeclKind };

export const extractAction: Action<ExtractParams, TsEngine> = {
  id: "typescript-extract",
  kind: "refactor",
  summary: "Moves top-level declarations to another file; their imports follow.",
  flags: [
    { name: "--file", type: "path", required: true, description: "The file that declares the symbols." },
    { name: "--symbols", type: "text", required: true, description: "The top-level declarations to move, comma-separated (foo,keep)." },
    { name: "--to", type: "path", required: true, description: "The file they move to; it is created when it does not exist." },
    {
      name: "--kind",
      type: "choice",
      choices: [
        { name: "function", description: "Function declarations." },
        { name: "class", description: "Class declarations." },
        { name: "interface", description: "Interface declarations." },
        { name: "type", description: "Type aliases." },
        { name: "enum", description: "Enum declarations." },
        { name: "variable", description: "Variables declared with const, let or var." },
      ],
      required: false,
      description: "Which declarations to move, when several in the file have a name.",
    },
  ],
  parseParams(raw) {
    return { file: required(raw, "file"), symbols: list(raw, "symbols"), to: required(raw, "to"), ...kindParam(raw) };
  },
  describe: (p) => `${p.symbols.join(", ")} → ${p.to} from ${p.file}`,

  async run(engine, p) {
    const from = engine.relPath(p.file);
    const to = engine.relPath(p.to);
    if (to === from) throw new RefactorError("REFACTOR_UNAVAILABLE", `--to is the source file ${from}. Pass another file.`);
    const existed = engine.read(to) !== null;
    const format = engine.ts.getDefaultFormatCodeSettings("\n");
    // Every symbol is looked up before anything moves: a missing or ambiguous one refuses with the lines on disk.
    for (const symbol of p.symbols) engine.findTopLevel(from, symbol, p.kind);
    for (const symbol of p.symbols) {
      const decl = engine.findTopLevel(from, symbol, p.kind);
      const { sf } = engine.sourceFile(from);
      const statement = sf.statements.find((s) => s.getStart(sf) === decl.start);
      if (statement && usesImportMeta(engine.ts, statement)) {
        throw new RefactorError(
          "REFACTOR_UNAVAILABLE",
          `${symbol} uses import.meta, which means something else in another file. Pass the value in from ${from} instead, then run again.`,
        );
      }
      const result = engine
        .project(from)
        .service.getEditsForRefactor(
          engine.absPath(from),
          format,
          { pos: decl.start, end: decl.end },
          "Move to file",
          "Move to file",
          PREFERENCES,
          { targetFile: engine.absPath(to) },
        );
      if (!result || result.edits.length === 0) {
        throw new RefactorError("REFACTOR_UNAVAILABLE", `TypeScript's "Move to file" is not available for ${symbol} in ${from}.`);
      }
      engine.applyTextChanges(result.edits);
    }
    const others = engine.changes().filter((c) => c.path !== from && c.path !== to).length;
    return {
      summary:
        `Moved ${names(p.symbols)} from ${from} to ${to}${existed ? "" : " (a new file)"}` +
        (others > 0 ? `, updating the imports of ${plural(others, "other file")}.` : "."),
    } satisfies ActionResult;
  },
};
