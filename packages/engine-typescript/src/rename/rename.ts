import { RefactorError, plural } from "@jig/core";
import type { Action, DeclKind } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "../engine.ts";
import { PREFERENCES, kindParam, required } from "../shared.ts";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const RENAME_PREFERENCES: ts.UserPreferences = { ...PREFERENCES, providePrefixAndSuffixTextForRename: true };

export type RenameParams = { file: string; symbol: string; to: string; kind?: DeclKind };

export const renameAction: Action<RenameParams, TsEngine> = {
  id: "rename",
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
