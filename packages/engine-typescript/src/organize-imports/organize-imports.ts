import { listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type { TsEngine } from "../engine.ts";
import { PREFERENCES, list as globList, matchFiles } from "../shared.ts";

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
