import { dirname, relative } from "node:path";
import type { Action } from "@jig/core";
import type { TsEngine } from "../engine.ts";
import { sweepImports } from "../import-style.ts";
import { list as globList, outside, slashed } from "../shared.ts";

export type ImportsToRelativeParams = { files: string[]; targets: string[] };

export const importsToRelativeAction: Action<ImportsToRelativeParams, TsEngine> = {
  id: "imports-to-relative",
  kind: "sweep",
  summary: "Rewrites alias and subpath imports as relative imports (../lib/date) that resolve to the same file.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The importing files to rewrite, as comma-separated globs from the repo root." },
    {
      name: "--targets",
      type: "globs",
      required: true,
      description: "Only imports that resolve to a file matching these comma-separated globs change; \"**\" for every file.",
    },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files"), targets: globList(raw, "targets") }),
  describe: (p) => `${p.files.join(", ")} importing ${p.targets.join(", ")}`,

  async run(engine, p) {
    return sweepImports(engine, p.files, p.targets, {
      style: "relative",
      label: "relative imports",
      resolveHint: "",
      writerFor: (file) => {
        const from = engine.absPath(file);
        const project = engine.project(file);
        const projectFolder = engine.absPath(project.folder);
        return (path, target) => {
          if (outside(relative(projectFolder, target))) {
            return {
              miss: `${engine.relPath(target)} is outside the project folder ${project.folder}`,
              instructions: `A relative import from ${file} would leave its project. Leave this import as it is.`,
            };
          }
          let specifier = slashed(relative(dirname(from), path));
          if (specifier === "") specifier = ".";
          else if (specifier !== ".." && !specifier.startsWith("../")) specifier = `./${specifier}`;
          return { specifier };
        };
      },
    });
  },
};
