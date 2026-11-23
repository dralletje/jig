import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type { TsEngine } from "./engine.ts";
import { relocate } from "./relocate.ts";
import { PREFERENCES, list as globList, matchFiles, required } from "./shared.ts";

// ---------------------------------------------------------------------------------------------

export type MoveFileParams = { file: string; to: string };

export const moveFileAction: Action<MoveFileParams, TsEngine> = {
  id: "move-file",
  kind: "refactor",
  summary: "Moves or renames a file, rewriting the imports of and in it.",
  flags: [
    { name: "--file", type: "path", required: true, description: "The file to move." },
    { name: "--to", type: "path", required: true, description: "Where it goes. It must be free." },
  ],
  parseParams: (raw) => ({ file: required(raw, "file"), to: required(raw, "to") }),
  describe: (p) => `${p.file} → ${p.to}`,

  async run(engine, p) {
    const from = engine.relPath(p.file);
    const to = engine.relPath(p.to);
    const content = engine.read(from);
    if (content === null) {
      throw new RefactorError("SYMBOL_NOT_FOUND", `There is no file ${from}. Pass a path relative to the repo root.`);
    }
    if (engine.read(to) !== null || engine.existsOnDisk(to)) {
      throw new RefactorError("REFACTOR_UNAVAILABLE", `${to} already exists. Pick another --to, or move that file away first.`);
    }
    relocate(engine, { mode: "move", moves: new Map([[from, to]]) });
    const others = engine.changes().filter((c) => c.path !== from && c.path !== to).length;
    return {
      summary:
        `Moved ${from} to ${to}` + (others > 0 ? `, updating the imports of ${plural(others, "other file")}.` : "."),
    };
  },
};

// ---------------------------------------------------------------------------------------------

export type OrganizeImportsParams = { files: string[] };

export const organizeImportsAction: Action<OrganizeImportsParams, TsEngine> = {
  id: "organize-imports",
  kind: "sweep",
  summary: "Merges, sorts and drops unused imports.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files to organize, as comma-separated globs from the repo root." },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files") }),
  describe: (p) => p.files.join(", "),

  async run(engine, p) {
    const format = engine.ts.getDefaultFormatCodeSettings("\n");
    for (const file of await matchFiles(engine.repoRoot, p.files)) {
      const edits = engine
        .project(file)
        .service.organizeImports({ type: "file", fileName: engine.absPath(file) }, format, PREFERENCES);
      engine.applyTextChanges(edits);
    }
    const files = engine.changes().map((c) => c.path);
    return { summary: `Organized the imports of ${plural(files.length, "file")}:\n${listLines(files)}` };
  },
};
