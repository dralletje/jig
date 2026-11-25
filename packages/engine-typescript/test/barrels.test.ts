import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { workspace } from "./helpers.ts";

// The rewrites are cases in src/remove-barrels/test/remove-barrels.toml. A second run needs two runs,
// which a case cannot say.

describe("remove-barrels on examples/webapp", () => {
  test("a second run changes nothing (NO_CHANGES for the host)", async () => {
    const dir = await workspace("examples/webapp");
    await main(["remove-barrels", "--files", "src/**"], dir);
    const once = await readTree(dir);
    await main(["remove-barrels", "--files", "src/**"], dir);
    assert.deepEqual(await readTree(dir), once);
  });
});
