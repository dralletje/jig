import { RefactorError, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type { TsEngine } from "../engine.ts";
import { required } from "../shared.ts";

// The beta image (JIG_TYPESCRIPT=7.1.0-beta) relocates on TypeScript 7.1.0-beta; every other build on TypeScript 6.
const { relocate, withDeclarationFiles } =
  process.env.JIG_TYPESCRIPT === "7.1.0-beta" ? await import("../ts7/relocate.ts") : await import("../relocate.ts");


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
    const moves = withDeclarationFiles(engine, new Map([[from, to]]));
    relocate(engine, { mode: "move", moves });
    const others = engine.changes().filter((c) => !moves.has(c.path) && ![...moves.values()].includes(c.path)).length;
    return {
      summary:
        `Moved ${[...moves].map(([a, b]) => `${a} to ${b}`).join(" and ")}` +
        (others > 0 ? `, updating the imports of ${plural(others, "other file")}.` : "."),
    };
  },
};

// ---------------------------------------------------------------------------------------------
