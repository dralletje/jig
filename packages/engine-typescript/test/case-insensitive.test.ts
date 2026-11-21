import assert from "node:assert/strict";
import { readdirSync, realpathSync } from "node:fs";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { writeChanges } from "@jig/core";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { TsEngine, main } from "../src/index.ts";
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

  test("typescript-rename-files keeps the content under the new name and points the imports at it", async () => {
    const dir = await insensitive();
    const original = (await readTree(dir))["src/Footer.ts"];
    assert.ok(original);
    const report = (await main(["typescript-rename-files", "--files", "src/Footer.ts", "--case", "kebab"], dir)) as OkReport;
    assertReport(report);
    restore();
    const names = readdirSync(`${dir}/src`);
    assert.ok(names.includes("footer.ts"), "footer.ts is written");
    assert.ok(!names.includes("Footer.ts"), "Footer.ts is gone");
    const tree = await readTree(dir);
    assert.equal(tree["src/footer.ts"], original);
    assert.ok(tree["src/main.ts"]?.includes('from "./footer"'));
  });

  test("engine.changes() has a write for the new name, whose file does not exist under that exact name", async () => {
    const dir = await insensitive();
    const engine = await TsEngine.load(dir);
    const text = engine.read("src/Footer.ts");
    assert.ok(text !== null);
    assert.equal(engine.read("src/footer.ts"), null, "an exact-case read does not see Footer.ts");
    engine.write("src/footer.ts", text);
    engine.write("src/Footer.ts", null);
    const changes = engine.changes();
    assert.deepEqual(
      changes.map((c) => [c.path, c.before === null ? null : "text", c.after === null ? null : "text"]),
      [
        ["src/Footer.ts", "text", null],
        ["src/footer.ts", null, "text"],
      ],
    );
    await writeChanges(dir, changes);
    restore();
    const names = readdirSync(`${dir}/src`);
    assert.ok(names.includes("footer.ts") && !names.includes("Footer.ts"));
    assert.equal((await readTree(dir))["src/footer.ts"], text);
  });
});
