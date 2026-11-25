import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { main } from "../src/index.ts";
import { rejects, workspace } from "./helpers.ts";

// The cases that are files in, files out (or a refusal) are in src/default-to-named/test/default-to-named.toml.
// What stays here runs the action twice on one repository.

const EXAMPLE = "examples/default-to-named";

const run = (dir: string, files: string, keep?: string) =>
  main(["default-to-named", "--files", files, ...(keep ? ["--keep", keep] : [])], dir);

describe("default-to-named on examples/default-to-named", () => {
  test("a second run finds nothing to convert", async () => {
    const dir = await workspace(EXAMPLE);
    await run(dir, "src/**", "src/routes/**");
    // What is left is only the refused files.
    const error = await rejects(run(dir, "src/lib/**,src/models/**,src/config.ts"));
    assert.equal(error.code, "NO_CHANGES");
  });
});
