import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { toml_test } from "@dral/toml-tests";
import { RefactorError } from "@jig/core";
import { workspace } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

type Options = { at: string; before: string; after: string; files?: Record<string, string> };

/**
 * Each case: `input` becomes src/a.ts, `options` are the flags (`at` without the path), `output` is
 * src/a.ts afterwards. `options.files` (not a flag) writes more files next to it, by path.
 * A refusal is thrown again as "<code>: <message>", so a case's `throws` pattern can name the code.
 */
async function replaceSameBehavior(input: string, options: Options): Promise<string> {
  const dir = await workspace("examples/replace-same-behavior", { ...options.files, "src/a.ts": input });
  const flags = ["--at", `src/a.ts:${options.at}`, "--before", options.before, "--after", options.after];
  try {
    await main(["replace-same-behavior", ...flags], dir);
  } catch (e) {
    if (e instanceof RefactorError) throw new Error(`${e.code}: ${e.message}`);
    throw e;
  }
  return readFile(join(dir, "src/a.ts"), "utf8");
}

const source = join(import.meta.dirname, "replace-same-behavior.toml");
toml_test<string, Options, string>(
  await readFile(source, "utf8"),
  replaceSameBehavior,
  { describe, it, equal: assert.deepStrictEqual },
  source,
);
