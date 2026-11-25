import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RefactorError } from "@jig/core";
import { assertReport, makeRepo } from "@jig/test-utils";
import { main } from "../src/index.ts";

async function rejects(p: Promise<unknown>): Promise<RefactorError> {
  try {
    await p;
  } catch (e) {
    return e as RefactorError;
  }
  throw new Error("expected rejection");
}

// The cases that change files are in src/format/test/format.toml.
describe("prettier format", () => {
  test("the report is valid", async () => {
    const dir = await makeRepo("simple");
    await writeFile(join(dir, "ugly.ts"), "export const   x = {a:1,\n  b:'two'}\n");
    const report = await main(["format", "--files", "ugly.ts"], dir);
    assertReport(report);
  });

  test("a plugin the image does not have is dropped: the run is ok", async () => {
    const dir = await makeRepo("simple");
    await writeFile(join(dir, ".prettierrc"), JSON.stringify({ plugins: ["prettier-plugin-nope"], singleQuote: true }));
    await writeFile(join(dir, "q.ts"), 'const a = "x"\n');
    const report = await main(["format", "--files", "q.ts"], dir);
    assert.equal(report.ok, true);
  });

  test("unknown action", async () => {
    const dir = await makeRepo("simple");
    assert.equal((await rejects(main(["lint"], dir))).code, "UNKNOWN_ACTION");
  });
});
