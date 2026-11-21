import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import type { FileChange } from "./types.ts";

const SKIPPED = new Set([".git", "node_modules"]);

// path.matchesGlob never lets `*` or `**` match a name that starts with a dot; in the actions'
// `--files` globs they always have. Matching a second time with every leading dot, in the path and in
// the glob alike, swapped for a character no file name has keeps that meaning.
const DOT = "\u{E000}";
const undot = (path: string): string =>
  path
    .split("/")
    .map((part) => (part.startsWith(".") ? `${DOT}${part.slice(1)}` : part))
    .join("/");

/** Whether `file` (relative, `/` separators) matches any of the globs. `*` and `**` match dotfiles too. */
export function matchesAnyGlob(file: string, globs: string[]): boolean {
  const undotted = undot(file);
  return globs.some((glob) => matchesGlob(file, glob) || matchesGlob(undotted, undot(glob)));
}

/** Every regular file under `root`, relative with `/` separators, sorted. Skips `.git/` and `node_modules/`. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIPPED.has(e.name)) await walk(join(dir, e.name), `${prefix}${e.name}/`);
      } else if (e.isFile()) {
        out.push(`${prefix}${e.name}`);
      }
    }
  };
  await walk(root, "");
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Writes engine changes to disk: every deletion first, then every write, so that on a case-insensitive
 * file system a rename that only changes case (`Button.ts` → `button.ts`) never deletes the file just
 * written. Nothing is undone on a later failure: the changes stay for the caller to inspect.
 */
export async function writeChanges(root: string, changes: FileChange[]): Promise<void> {
  for (const change of changes) {
    if (change.after === null) await rm(join(root, change.path), { force: true });
  }
  for (const change of changes) {
    if (change.after === null) continue;
    const full = join(root, change.path);
    if (change.before === null) await mkdir(dirname(full), { recursive: true });
    await writeFile(full, change.after);
  }
}
