import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { writeChanges } from "../src/index.ts";

describe("writeChanges", () => {
  test("applies every deletion before any write, whatever the order of the changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "write-changes-"));
    await writeFile(join(root, "x"), "old");
    await mkdir(join(root, "Dir"));
    await writeFile(join(root, "Dir", "Button.ts"), "button");
    // The write of `x/y` comes first in the list but needs the file `x` gone; the deletion of
    // `Dir/Button.ts` must not run after the write of `Dir/button.ts` (a case-insensitive file
    // system would delete the file just written).
    await writeChanges(root, [
      { path: "x/y", before: null, after: "new" },
      { path: "Dir/button.ts", before: null, after: "button" },
      { path: "x", before: "old", after: null },
      { path: "Dir/Button.ts", before: "button", after: null },
    ]);
    assert.equal(await readFile(join(root, "x", "y"), "utf8"), "new");
    assert.equal(await readFile(join(root, "Dir", "button.ts"), "utf8"), "button");
  });
});
