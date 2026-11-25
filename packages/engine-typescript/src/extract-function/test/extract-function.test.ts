import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { toml_test } from "@dral/toml-tests";
import { RefactorError } from "@jig/core";
import { workspace } from "../../../test/helpers.ts";
import { main } from "../../main.ts";

type Options = { lines: string; name: string; params: string; returns?: string };

/**
 * Each case: `input` becomes src/a.ts, `options` are the flags, `output` is src/a.ts afterwards.
 * A refusal is thrown again as "<code>: <message>", so a case's `throws` pattern can name the code.
 */
async function extractFunction(input: string, options: Options): Promise<string> {
  const dir = await workspace("examples/extract-function", { "src/a.ts": input });
  const flags = ["--file", "src/a.ts", "--lines", options.lines, "--name", options.name, "--params", options.params];
  if (options.returns !== undefined) flags.push("--returns", options.returns);
  try {
    await main(["extract-function", ...flags], dir);
  } catch (e) {
    if (e instanceof RefactorError) throw new Error(`${e.code}: ${e.message}`);
    throw e;
  }
  return readFile(join(dir, "src/a.ts"), "utf8");
}

const source = join(import.meta.dirname, "extract-function.toml");
toml_test<string, Options, string>(
  await readFile(source, "utf8"),
  extractFunction,
  { describe, it, equal: assert.deepStrictEqual },
  source,
);
