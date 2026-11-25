import { RefactorError, plural } from "@jig/core";
import type { Action, ActionResult, DeclKind } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "../engine.ts";
import { PREFERENCES, kindParam, list, names, required } from "../shared.ts";

function usesImportMeta(typescript: typeof ts, node: ts.Node): boolean {
  if (typescript.isMetaProperty(node) && node.keywordToken === typescript.SyntaxKind.ImportKeyword) return true;
  return typescript.forEachChild(node, (child) => usesImportMeta(typescript, child) || undefined) ?? false;
}

export type ExtractParams = { file: string; symbols: string[]; to: string; kind?: DeclKind };

export const extractAction: Action<ExtractParams, TsEngine> = {
  id: "extract",
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
