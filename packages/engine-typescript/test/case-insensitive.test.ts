import assert from "node:assert/strict";
import { readdirSync, realpathSync } from "node:fs";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { caseInsensitiveFs } from "./case-insensitive-fs.ts";
import { workspace } from "./helpers.ts";

// A case-only rename on a case-insensitive file system (macOS through Docker Desktop): reading
// `src/footer.ts` finds `src/Footer.ts`, so "does the target exist on disk" must look at the exact name.
describe("case-only renames on a case-insensitive file system", () => {
  let restore = () => {};
  beforeEach(() => {
    restore = () => {};
  });
  afterEach(() => restore());
  after(() => restore());

  const insensitive = async (): Promise<string> => {
    const dir = realpathSync(await workspace("examples/rename-files"));
    restore = caseInsensitiveFs(dir);
    return dir;
  };

  test("rename-files keeps the content under the new name and points the imports at it", async () => {
    const dir = await insensitive();
    const original = (await readTree(dir))["src/Footer.ts"];
    assert.ok(original);
    await main(["rename-files", "--files", "src/Footer.ts", "--case", "kebab"], dir);
    restore();
    const names = readdirSync(`${dir}/src`);
    assert.ok(names.includes("footer.ts"), "footer.ts is written");
    assert.ok(!names.includes("Footer.ts"), "Footer.ts is gone");
    const tree = await readTree(dir);
    assert.equal(tree["src/footer.ts"], original);
    assert.ok(tree["src/main.ts"]?.includes('from "./footer"'));
  });
});
