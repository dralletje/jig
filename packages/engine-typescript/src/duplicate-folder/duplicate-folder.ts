import { lstatSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type { TsEngine } from "../engine.ts";
import { relocate } from "../relocate.ts";
import type { Relocated } from "../relocate.ts";
import { byString, nearestPackageJson, required, slashed } from "../shared.ts";

export type FolderParams = { from: string; to: string };

/** `Rewrote 3 imports in 2 files:` and the files, or a line saying none was. */
function rewrittenLines(done: Relocated): string {
  if (done.rewritten.length === 0) return "No import needed rewriting.";
  const imports = done.rewritten.reduce((n, item) => n + item.imports, 0);
  return (
    `Rewrote ${plural(imports, "import")} in ${plural(done.rewritten.length, "file")}:\n` +
    listLines(done.rewritten.map((item) => `${item.file} (${item.imports})`))
  );
}

export const duplicateFolderAction: Action<FolderParams, TsEngine> = {
  id: "duplicate-folder",
  kind: "refactor",
  summary: "Copies a folder to a new folder; the copies' imports are adjusted to their new place.",
  flags: [
    {
      name: "--from",
      type: "path",
      required: true,
      description: "The folder to copy. Every file under it is copied byte for byte (any type: .ts, .css, images): src/old/x/y.ts is copied to <to>/x/y.ts.",
    },
    { name: "--to", type: "path", required: true, description: "The new folder the copies go to. It must not exist yet, and must not be inside --from." },
  ],
  parseParams: (raw) => ({ from: required(raw, "from"), to: required(raw, "to") }),
  describe: (p) => `${p.from} to ${p.to}`,

  async run(engine, p) {
    const from = slashed(relative(engine.repoRoot, resolve(engine.repoRoot, p.from))) || ".";
    const to = slashed(relative(engine.repoRoot, resolve(engine.repoRoot, p.to))) || ".";
    if (from === ".." || from.startsWith("../") || isAbsolute(from)) {
      throw new RefactorError("INVALID_ARGS", `--from ${p.from} is outside the repo. Pass a folder relative to the repo root.`);
    }
    if (to === ".." || to.startsWith("../") || isAbsolute(to)) {
      throw new RefactorError("INVALID_ARGS", `--to ${p.to} is outside the repo. Pass a folder relative to the repo root.`);
    }
    if (from === to) {
      throw new RefactorError("INVALID_ARGS", `--from and --to are both ${from}. Pass the new folder the copy goes to as --to.`);
    }
    if (from === "." || to.startsWith(`${from}/`)) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--to ${to} is inside --from ${from}, so the copy would be copied into itself. Pass a --to outside ${from}, then run again.`,
      );
    }
    if (lstatSync(engine.absPath(from), { throwIfNoEntry: false })?.isFile() === true) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--from ${from} is a file, not a folder. Pass the folder to copy as --from (move-file moves a single file).`,
      );
    }
    // Symlinks and node_modules folders are not copied, and leaving them out silently would make a copy that differs.
    const uncopied: string[] = [];
    if (lstatSync(engine.absPath(from), { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      uncopied.push(`${from} (symlink)`);
    }
    const walk = (folder: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(engine.absPath(folder), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of [...entries].sort((a, b) => byString(a.name, b.name))) {
        const path = `${folder}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          uncopied.push(`${path} (symlink)`);
        } else if (entry.isDirectory() && entry.name === "node_modules") {
          uncopied.push(`${path} (node_modules folder)`);
        } else if (entry.isDirectory()) {
          walk(path);
        }
      }
    };
    if (uncopied.length === 0) walk(from);
    if (uncopied.length > 0) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--from ${from} holds symlinks or node_modules folders, which duplicate-folder does not copy:\n` +
          `${listLines(uncopied, 10)}\nRemove them from ${from}, or copy the folder by hand, then run again.`,
      );
    }
    const files = engine.listFiles().filter((f) => f.startsWith(`${from}/`));
    if (files.length === 0) {
      throw new RefactorError(
        "INVALID_ARGS",
        `No file is under --from ${from}: it does not exist or is empty. Pass a folder with files in it, relative to the repo root.`,
      );
    }
    // Parents first, nearest last: a path under a file cannot be looked at (ENOTDIR).
    const parents: string[] = [];
    for (let folder = dirname(to); folder !== "."; folder = dirname(folder)) parents.unshift(folder);
    for (const folder of parents) {
      if (statSync(engine.absPath(folder), { throwIfNoEntry: false })?.isDirectory() === false) {
        throw new RefactorError("INVALID_ARGS", `--to ${to} is under ${folder}, which is a file. Pass a --to whose parent folders are folders.`);
      }
    }
    if (lstatSync(engine.absPath(to), { throwIfNoEntry: false }) !== undefined) {
      throw new RefactorError("INVALID_ARGS", `--to ${to} already exists. The copy goes to a new folder: pass a --to that does not exist yet.`);
    }
    const configs = files.filter((f) => /^tsconfig.*\.json$/.test(basename(f)) || basename(f) === "jsconfig.json" || basename(f) === "package.json");
    if (configs.length > 0) {
      throw new RefactorError(
        "INVALID_ARGS",
        `${configs.join(", ")} ${configs.length === 1 ? "is" : "are"} under --from ${from}. Copying a tsconfig, jsconfig or package.json changes how ` +
          `everything under it resolves, so it is not done. Copy the folder by hand, or move ${configs.length === 1 ? "it" : "them"} out of ${from} first, then run again.`,
      );
    }
    // The nearest package.json at or above each folder (a file name inside it, as nearestPackageJson takes a file).
    const fromPackage = nearestPackageJson(engine, `${from}/x`);
    const toPackage = nearestPackageJson(engine, `${to}/x`);
    if (fromPackage !== toPackage) {
      throw new RefactorError(
        "INVALID_ARGS",
        `--from ${from} is in the package of ${fromPackage ?? "no package.json"}, but --to ${to} is in the package of ${toPackage ?? "no package.json"}. ` +
          `A copy into another package would import across packages without being a dependency. Pass a --to in the same package as ${from}, ` +
          `or copy the folder by hand.`,
      );
    }
    const moves = new Map<string, string>();
    for (const f of files) moves.set(f, `${to}/${f.slice(from.length + 1)}`);
    const done = relocate(engine, { mode: "duplicate", moves });
    return {
      summary:
        `Copied ${plural(done.files.length, "file")} from ${from} to ${to}. Files outside the copies still import the originals.\n` +
        rewrittenLines(done),
    };
  },
};
