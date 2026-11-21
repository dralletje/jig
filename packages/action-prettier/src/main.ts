import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { RefactorError, imageHelp, listFiles, listLines, matchesAnyGlob, okReport, plural } from "@jig/core";
import type { ImageHelp, Report } from "@jig/core";
import * as prettier from "prettier";

function filesFlag(args: string[]): string[] {
  let files: string | undefined;
  try {
    files = parseArgs({ args, options: { files: { type: "string" } } }).values.files;
  } catch (e) {
    throw new RefactorError("INVALID_ARGS", `${(e as Error).message}. format takes only --files <glob,glob>.`);
  }
  const globs = (files ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  if (globs.length === 0) throw new RefactorError("INVALID_ARGS", "Missing --files. Pass --files <glob,glob>.");
  return globs;
}

/** The prettier image's help: its one action, `format`. */
export function help(): ImageHelp {
  return imageHelp(`Formats files with prettier ${prettier.version}.`, [
    {
      name: "format",
      kinds: ["sweep"],
      summary: "Formats the matching files with the repo's own prettier config (prettier's defaults when there is none).",
      flags: [
        {
          name: "--files",
          type: "globs",
          required: true,
          description: "The files to format. Files prettier ignores (.prettierignore) or cannot parse are skipped.",
        },
      ],
    },
  ]);
}

/**
 * The prettier image's entrypoint: `format --files <glob,glob>` formats the matching files under
 * `root` with the repo's own prettier config (defaults when there is none, or it fails to load).
 */
export async function main(argv: string[], root: string): Promise<Report> {
  const [id, ...args] = argv;
  if (id !== "format") {
    throw new RefactorError("UNKNOWN_ACTION", `Unknown action ${JSON.stringify(id ?? "")}. This image has: format.`);
  }
  const globs = filesFlag(args);
  const ignorePath = [join(root, ".prettierignore")];
  const files: string[] = [];
  for (const file of await listFiles(root)) {
    if (!matchesAnyGlob(file, globs)) continue;
    const abs = join(root, file);
    // getFileInfo loads the config too (for plugins); a config that fails to load means defaults.
    let info: Awaited<ReturnType<typeof prettier.getFileInfo>>;
    try {
      info = await prettier.getFileInfo(abs, { ignorePath });
    } catch {
      info = await prettier.getFileInfo(abs, { ignorePath, resolveConfig: false });
    }
    if (info.ignored || info.inferredParser === null) continue;
    let options: prettier.Options | null;
    try {
      options = await prettier.resolveConfig(abs, { editorconfig: true });
    } catch {
      options = null;
    }
    // The image has no plugins: a plugin the config names is dropped and the rest of the config applies.
    const { plugins: _plugins, ...usable } = options ?? {};
    const text = await readFile(abs, "utf8");
    const formatted = await prettier.format(text, { ...usable, filepath: abs });
    if (formatted !== text) {
      await writeFile(abs, formatted);
      files.push(file);
    }
  }
  return okReport("sweep", "format", globs.join(", "), {
    summary: `Formatted ${plural(files.length, "file")} with prettier ${prettier.version}:\n${listLines(files)}`,
  });
}
