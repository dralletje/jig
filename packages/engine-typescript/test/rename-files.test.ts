import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { rejects, workspace } from "./helpers.ts";

// The renames themselves are cases in src/rename-files/test/rename-files.toml. A second run needs two runs,
// which a case cannot say.

const EXAMPLE = "examples/rename-files";
const rename = (dir: string, nameCase: string) => main(["rename-files", "--files", "src/**", "--case", nameCase], dir);

describe("rename-files", () => {
  for (const nameCase of ["kebab", "camel", "pascal", "snake"]) {
    test(`${nameCase}: a second run finds nothing to rename`, async () => {
      const dir = await workspace(EXAMPLE);
      await rename(dir, nameCase);
      const once = await readTree(dir);
      assert.equal((await rejects(rename(dir, nameCase))).code, "NO_CHANGES");
      assert.deepEqual(await readTree(dir), once);
    });
  }
});
