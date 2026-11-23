import { basename, dirname } from "node:path";
import { listFiles, listLines, plural, RefactorError } from "@jig/core";
import type { Action } from "@jig/core";
import type { TsEngine } from "./engine.ts";
import { byString, list as globList, matchFiles, notHandled, required, unavailable } from "./shared.ts";
import type { NotHandled } from "./shared.ts";

// The beta image (JIG_TYPESCRIPT=7.1.0-beta) relocates on TypeScript 7.1.0-beta; every other build on TypeScript 6.
const { relocate, withDeclarationFiles } =
  process.env.JIG_TYPESCRIPT === "7.1.0-beta" ? await import("./ts7/relocate.ts") : await import("./relocate.ts");

/**
 * rename-files: the TypeScript files matching `--files` whose base name is not in the
 * `--case` get renamed (the part before the first dot: `orderService.test.ts` → `order-service.test.ts`),
 * with move-file's rewriting of the imports. Files it will not rename are listed in the summary as not handled.
 */

const CASES = ["kebab", "camel", "pascal", "snake"] as const;
type NameCase = (typeof CASES)[number];

export type RenameFilesParams = { files: string[]; case: NameCase };

/** Letters, digits, and `-`/`_` between them: names whose words can be told apart. */
const CONVERTIBLE = /^[A-Za-z0-9]+([-_][A-Za-z0-9]+)*$/;

const capitalized = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/** `stem` written in `nameCase`; the words are split at `-`, `_` and lower-to-upper changes. */
export function convertStem(stem: string, nameCase: NameCase): string {
  const words = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[-_ ]+/)
    .map((w) => w.toLowerCase());
  switch (nameCase) {
    case "kebab":
      return words.join("-");
    case "snake":
      return words.join("_");
    case "pascal":
      return words.map(capitalized).join("");
    case "camel":
      return words.map((w, i) => (i === 0 ? w : capitalized(w))).join("");
  }
}

type Rename = { from: string; to: string };
type Skip = { file: string; reason: string; instructions: string };

/** What to rename and what to leave alone, from the committed files; nothing is written. */
function plan(files: string[], all: string[], nameCase: NameCase): { renames: Rename[]; skipped: Skip[] } {
  const lower = new Map<string, string[]>();
  for (const f of all) lower.set(f.toLowerCase(), [...(lower.get(f.toLowerCase()) ?? []), f]);
  const candidates: Rename[] = [];
  const skipped: Skip[] = [];

  for (const file of files) {
    const name = basename(file);
    const dot = name.indexOf(".");
    const stem = dot < 0 ? name : name.slice(0, dot);
    const suffix = dot < 0 ? "" : name.slice(dot);
    if (stem === "") continue; // a dotfile
    if (!CONVERTIBLE.test(stem)) {
      skipped.push({
        file,
        reason: "its name has characters other than letters, digits, - and _",
        instructions: `Rename ${file} by hand if it should follow the convention.`,
      });
      continue;
    }
    const converted = convertStem(stem, nameCase);
    if (converted === stem) continue;
    if (stem === "index") {
      skipped.push({
        file,
        reason: "index files keep their name",
        instructions: `${file} is resolved by its directory, so it is left as it is.`,
      });
      continue;
    }
    const dir = dirname(file);
    candidates.push({ from: file, to: dir === "." ? `${converted}${suffix}` : `${dir}/${converted}${suffix}` });
  }

  const targets = new Map<string, Rename[]>();
  for (const c of candidates) targets.set(c.to.toLowerCase(), [...(targets.get(c.to.toLowerCase()) ?? []), c]);
  const renames: Rename[] = [];
  for (const c of candidates) {
    const existing = (lower.get(c.to.toLowerCase()) ?? []).filter((f) => f !== c.from);
    const sameTarget = (targets.get(c.to.toLowerCase()) ?? []).filter((o) => o.from !== c.from);
    if (existing.length > 0) {
      const exact = existing.includes(c.to);
      skipped.push({
        file: c.from,
        reason: exact
          ? `${c.to} already exists`
          : `${c.to} would differ only by case from the existing ${existing[0]}`,
        instructions: `Rename or remove one of ${c.from} and ${existing[0]} by hand, then run again.`,
      });
    } else if (sameTarget.length > 0) {
      skipped.push({
        file: c.from,
        reason: `${c.to} is also the new name of ${sameTarget[0]?.from}`,
        instructions: `Rename one of ${c.from} and ${sameTarget[0]?.from} by hand, then run again.`,
      });
    } else {
      renames.push(c);
    }
  }
  return { renames, skipped };
}

export const renameFilesAction: Action<RenameFilesParams, TsEngine> = {
  id: "rename-files",
  kind: "sweep",
  summary: "Renames files to a case (kebab, camel, pascal or snake), rewriting their imports.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files to rename, as comma-separated globs from the repo root." },
    {
      name: "--case",
      type: "choice",
      choices: [
        { name: "kebab", description: "kebab-case: my-file.ts." },
        { name: "camel", description: "camelCase: myFile.ts." },
        { name: "pascal", description: "PascalCase: MyFile.ts." },
        { name: "snake", description: "snake_case: my_file.ts." },
      ],
      required: true,
      description: "The case of the new names (the part before the first dot).",
    },
  ],
  parseParams: (raw) => {
    const nameCase = required(raw, "case");
    if (!(CASES as readonly string[]).includes(nameCase)) {
      throw new RefactorError("INVALID_ARGS", `--case ${nameCase} is not known. Pass --case ${CASES.join("|")}.`);
    }
    return { files: globList(raw, "files"), case: nameCase as NameCase };
  },
  describe: (p) => `${p.files.join(", ")} to ${p.case} case`,

  async run(engine, p) {
    const files = await matchFiles(engine.repoRoot, p.files);
    const { renames, skipped } = plan(files, await listFiles(engine.repoRoot), p.case);
    if (renames.length === 0) {
      throw new RefactorError(
        "NO_CHANGES",
        `No file matching ${p.files.join(", ")} needs renaming to ${p.case} case` +
          (skipped.length > 0
            ? `; skipped:\n${listLines(skipped.map((s) => `${s.file}: ${s.reason}`))}`
            : "."),
      );
    }
    // A renamed file's declaration file, or the file a renamed declaration file declares, is renamed with it.
    const moves = withDeclarationFiles(engine, new Map(renames.map((r) => [r.from, r.to])));
    for (const from of moves.keys()) {
      if (engine.read(from) === null) unavailable(`${from} cannot be read. Run again on a clean checkout.`);
    }
    relocate(engine, { mode: "move", moves });
    const touched = new Set([...moves].flat());
    const others = engine.changes().filter((c) => !touched.has(c.path)).length;
    const sorted = [...moves].map(([from, to]) => ({ from, to })).sort((a, b) => byString(a.from, b.from));
    const misses: NotHandled[] = skipped
      .sort((a, b) => byString(a.file, b.file))
      .map((s) => ({ path: s.file, line: 1, reason: s.reason, instructions: s.instructions }));
    return {
      summary:
        `Renamed ${plural(moves.size, "file")} to ${p.case} case` +
        (others > 0 ? `, updating the imports of ${plural(others, "other file")}` : "") +
        `:\n${listLines(sorted.map((r) => `${r.from} → ${r.to}`))}` +
        (misses.length > 0 ? `\n\n${notHandled(misses)}` : ""),
    };
  },
};
