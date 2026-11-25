import { relative, resolve } from "node:path";
import { RefactorError } from "@jig/core";
import type { Action } from "@jig/core";
import type { TsEngine } from "../engine.ts";
import { sweepImports } from "../import-style.ts";
import { list as globList, outside, slashed, unavailable } from "../shared.ts";

export type ImportsToAliasParams = { files: string[]; targets: string[]; alias: string };

export const importsToAliasAction: Action<ImportsToAliasParams, TsEngine> = {
  id: "imports-to-alias",
  kind: "sweep",
  summary: "Rewrites relative and subpath imports through a tsconfig paths alias (@/lib/date) that resolves to the same file.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The importing files to rewrite, as comma-separated globs from the repo root." },
    {
      name: "--targets",
      type: "globs",
      required: true,
      description: "Only imports that resolve to a file matching these comma-separated globs change; \"**\" for every file.",
    },
    {
      name: "--alias",
      type: "text",
      required: true,
      description:
        "The alias up to its \"*\", ending in \"/\": \"@/\" uses the paths entry \"@/*\". The importer's tsconfig must have that entry, with one target \"<folder>/*\".",
    },
  ],
  parseParams: (raw) => {
    const files = globList(raw, "files");
    const targets = globList(raw, "targets");
    const alias = raw.alias;
    if (alias === undefined || alias === "") throw new RefactorError("INVALID_ARGS", "Missing --alias. Pass the tsconfig paths alias up to its \"*\" (for example @/) and run again.");
    if (!alias.endsWith("/") || alias.startsWith(".") || alias.startsWith("#") || /["'`\\\s*]/.test(alias)) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--alias ${JSON.stringify(alias)} must be the prefix of a tsconfig paths key up to its "*", ending in "/" (for example "@/" for "@/*"); ` +
          `not relative, not starting with "#" (that is imports-to-subpath). Pass it and run again.`,
      );
    }
    return { files, targets, alias };
  },
  describe: (p) => `${p.files.join(", ")} importing ${p.targets.join(", ")} as ${p.alias}`,

  async run(engine, p) {
    const key = `${p.alias}*`;
    /** Project folder → the alias folder (absolute). */
    const folders = new Map<string, string>();
    return sweepImports(engine, p.files, p.targets, {
      style: "alias",
      label: `\`${p.alias}\` imports`,
      resolveHint: "",
      writerFor: (file) => {
        const project = engine.project(file);
        let aliasFolder = folders.get(project.folder);
        if (aliasFolder === undefined) {
          const options = project.service.getProgram()?.getCompilerOptions() ?? {};
          const where = project.tsconfig ?? "the repo root (no tsconfig.json above it)";
          const entry = options.paths?.[key];
          if (entry === undefined) {
            const keys = Object.keys(options.paths ?? {});
            throw new RefactorError(
              "INVALID_ARGS",
              `${file}: its project, ${where}, has no compilerOptions.paths entry ${JSON.stringify(key)}` +
                (keys.length > 0 ? ` (it has ${keys.map((k) => JSON.stringify(k)).join(", ")})` : "") +
                `. Add for example "paths": { ${JSON.stringify(key)}: ["./src/*"] } to it, or pass the alias it has, then run again. ` +
                `imports-to-alias does not change tsconfig.json.`,
            );
          }
          if (entry.length !== 1 || !entry[0]?.endsWith("/*")) {
            unavailable(
              `${where}: paths ${JSON.stringify(key)} must have exactly one target of the form "<folder>/*" (it is ${JSON.stringify(entry)}). ` +
                `Change it to one folder, or pass another --alias, then run again.`,
            );
          }
          const base = options.baseUrl ?? options.pathsBasePath;
          if (typeof base !== "string") unavailable(`${where}: cannot tell what its paths are relative to. Set baseUrl or fix the file, then run again.`);
          aliasFolder = resolve(base, (entry[0] as string).slice(0, -2));
          folders.set(project.folder, aliasFolder);
        }
        const folder = aliasFolder;
        return (path, target) => {
          const rest = relative(folder, path);
          if (outside(rest)) {
            return {
              miss: `${engine.relPath(target)} is outside ${engine.relPath(folder)}, the folder of ${key}`,
              instructions: `The import of ${engine.relPath(target)} in ${file} cannot be written with ${p.alias}. Leave it as it is.`,
            };
          }
          if (rest === "") {
            return {
              miss: `the import of ${engine.relPath(target)} names ${engine.relPath(folder)} itself, the folder of ${key}`,
              instructions: `An alias import of the alias folder itself is not written. Leave this import in ${file} as it is.`,
            };
          }
          return { specifier: `${p.alias}${slashed(rest)}` };
        };
      },
    });
  },
};
