import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { toml_test } from "@dral/toml-tests";
import type { TomlValue } from "@dral/toml-tests";
import { makeRepo, readTree } from "./index.ts";

/**
 * How a package runs one action: `argv` is `[<action>, ...flags]`, `dir` the repo it works in. It
 * resolves on success and throws an error with a `code` (a RefactorError) to refuse.
 */
export type RunAction = (argv: string[], dir: string) => Promise<unknown>;

/** The type errors of the project around `file` (repo-relative) in `dir`, for the `typecheck` option. */
export type TypeErrors = (dir: string, file: string) => Promise<string[]>;

/** Options of a case that are not flags. */
const NOT_FLAGS = ["fixture", "extra_files", "typecheck"];

/**
 * Registers the cases of one action's TOML file with node:test. Every case has the same shape:
 *
 * - `input`: a string, which becomes `src/a.ts`; or a table of files by path (`{}` for none).
 * - `options`: the flags, in order: `lines = "2-3"` passes `--lines 2-3`, a list is comma-separated.
 *   Not flags: `fixture` (the example folder to start from instead of `defaults.fixture`), `extra_files`
 *   (more files by path, written before `input`; not `files`, which is a flag of many actions), `typecheck = true` (the changed TypeScript files must
 *   have no type errors afterwards).
 * - `output`: for a string `input`, `src/a.ts` afterwards; for a table, every file that changed, by
 *   path (`false` for one that was deleted).
 * - `throws`: a pattern for "<code>: <message>" of the refusal. A refusal that changed files fails.
 */
export async function actionToml(
  tomlFile: string,
  action: string,
  run: RunAction,
  defaults: { fixture: string; typeErrors?: TypeErrors },
): Promise<void> {
  const runCase = async (input: TomlValue, options: Record<string, TomlValue>): Promise<TomlValue> => {
    const dir = await makeRepo(typeof options.fixture === "string" ? options.fixture : defaults.fixture);
    const written = {
      ...(options.extra_files as Record<string, string> | undefined),
      ...(typeof input === "string" ? { "src/a.ts": input } : (input as Record<string, string>)),
    };
    for (const [path, content] of Object.entries(written)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    const flags = Object.entries(options)
      .filter(([key]) => !NOT_FLAGS.includes(key))
      .flatMap(([key, value]) => [`--${key}`, Array.isArray(value) ? value.join(",") : String(value)]);

    const before = await readTree(dir);
    try {
      await run([action, ...flags], dir);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code !== "string") throw e;
      const after = await readTree(dir);
      const changed = Object.keys({ ...before, ...after }).filter((p) => before[p] !== after[p]);
      if (changed.length > 0) throw new Error(`refused with ${code}, but changed ${changed.join(", ")}`);
      throw new Error(`${code}: ${(e as Error).message}`);
    }
    const after = await readTree(dir);
    const changed = Object.keys({ ...before, ...after })
      .filter((p) => before[p] !== after[p])
      .sort();

    if (options.typecheck === true) {
      if (!defaults.typeErrors) throw new Error("typecheck = true, but this package's cases give no typeErrors");
      for (const path of changed.filter((p) => /\.(m|c)?tsx?$/.test(p) && after[p] !== undefined)) {
        assert.deepEqual(await defaults.typeErrors(dir, path), [], `type errors in ${path}`);
      }
    }
    if (typeof input === "string") return after["src/a.ts"] ?? false;
    // A table as toml-tests parses it: without a prototype, or deepStrictEqual never matches.
    return Object.assign(Object.create(null), Object.fromEntries(changed.map((p) => [p, after[p] ?? false])));
  };

  toml_test(await readFile(tomlFile, "utf8"), runCase, { describe, it, equal: assert.deepStrictEqual }, tomlFile);
}
