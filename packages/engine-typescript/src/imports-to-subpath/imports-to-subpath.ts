import { dirname, relative, resolve } from "node:path";
import { RefactorError } from "@jig/core";
import type { Action } from "@jig/core";
import type { TsEngine } from "../engine.ts";
import { sweepImports } from "../import-style.ts";
import { list as globList, importsOf, nearestPackageJson, outside, slashed, unavailable } from "../shared.ts";

export type ImportsToSubpathParams = { files: string[]; targets: string[]; prefix: string };

export const importsToSubpathAction: Action<ImportsToSubpathParams, TsEngine> = {
  id: "imports-to-subpath",
  kind: "sweep",
  summary: "Rewrites relative and alias imports as package.json subpath imports (#/lib/date) that resolve to the same file.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The importing files to rewrite, as comma-separated globs from the repo root." },
    {
      name: "--targets",
      type: "globs",
      required: true,
      description: "Only imports that resolve to a file matching these comma-separated globs change; \"**\" for every file.",
    },
    {
      name: "--prefix",
      type: "text",
      required: true,
      description:
        "The subpath prefix up to its \"*\", starting with \"#\" and ending in \"/\": \"#/\" uses the imports entry \"#/*\". The importer's nearest package.json must map it to \"./<folder>/*\".",
    },
  ],
  parseParams: (raw) => {
    const files = globList(raw, "files");
    const targets = globList(raw, "targets");
    const prefix = raw.prefix;
    if (prefix === undefined || prefix === "") throw new RefactorError("INVALID_ARGS", "Missing --prefix. Pass the package.json imports prefix up to its \"*\" (for example #/) and run again.");
    if (!prefix.startsWith("#") || !prefix.endsWith("/") || /["'`\\\s*]/.test(prefix)) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--prefix ${JSON.stringify(prefix)} must be the prefix of a package.json imports key up to its "*", starting with "#" and ending in "/" ` +
          `(for example "#/" for "#/*"). Pass it and run again.`,
      );
    }
    return { files, targets, prefix };
  },
  describe: (p) => `${p.files.join(", ")} importing ${p.targets.join(", ")} as ${p.prefix}`,

  async run(engine, p) {
    const key = `${p.prefix}*`;
    /** package.json → the folder its key maps to (absolute). */
    const folders = new Map<string, string>();
    return sweepImports(engine, p.files, p.targets, {
      style: "subpath",
      label: `\`${p.prefix}\` subpath imports`,
      resolveHint:
        "Subpath imports name files exactly (no extension is added, no index file is found), and need moduleResolution " +
        "\"bundler\", \"node16\" or \"nodenext\". ",
      writerFor: (file) => {
        const packageJson = nearestPackageJson(engine, file);
        if (packageJson === null) {
          throw new RefactorError(
            "INVALID_ARGS",
            `${file}: there is no package.json at or above it to hold "imports" ${JSON.stringify(key)}. ` +
              `Add one with "imports": { ${JSON.stringify(key)}: "./src/*" }, then run again. imports-to-subpath does not change package.json.`,
          );
        }
        let prefixFolder = folders.get(packageJson);
        if (prefixFolder === undefined) {
          try {
            JSON.parse(engine.read(packageJson) ?? "");
          } catch {
            return unavailable(`${packageJson} is not valid JSON. Fix it, then run again.`);
          }
          const value = importsOf(engine, packageJson)?.[key];
          if (value === undefined) {
            throw new RefactorError(
              "INVALID_ARGS",
              `${packageJson}, the nearest package.json to ${file}, has no "imports" entry ${JSON.stringify(key)}. ` +
                `Add for example "imports": { ${JSON.stringify(key)}: "./src/*" } to it, or pass the prefix it has, then run again. ` +
                `imports-to-subpath does not change package.json.`,
            );
          }
          if (typeof value !== "string" || !value.startsWith("./") || !value.endsWith("/*") || value.indexOf("*") !== value.length - 1) {
            return unavailable(
              `${packageJson}: "imports" ${JSON.stringify(key)} must map to one folder, "./<folder>/*" (it is ${JSON.stringify(value)}). ` +
                `Change it, or pass another --prefix, then run again.`,
            );
          }
          prefixFolder = resolve(engine.absPath(dirname(packageJson)), value.slice(0, -2));
          folders.set(packageJson, prefixFolder);
        }
        const mapped = prefixFolder;
        return (path, target) => {
          const rest = relative(mapped, path);
          if (outside(rest)) {
            return {
              miss: `${engine.relPath(target)} is outside ${engine.relPath(mapped)}, the folder of ${key}`,
              instructions: `The import of ${engine.relPath(target)} in ${file} cannot be written with ${p.prefix}. Leave it as it is.`,
            };
          }
          if (rest === "") {
            return {
              miss: `the import of ${engine.relPath(target)} names ${engine.relPath(mapped)} itself, the folder of ${key}`,
              instructions: `A subpath import of the prefix folder itself is not written. Leave this import in ${file} as it is.`,
            };
          }
          return { specifier: `${p.prefix}${slashed(rest)}` };
        };
      },
    });
  },
};
