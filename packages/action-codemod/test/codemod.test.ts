import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { RefactorError } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { fakePackage } from "./fake-package.ts";

async function rejects(p: Promise<unknown>): Promise<RefactorError> {
  try {
    await p;
  } catch (e) {
    return e as RefactorError;
  }
  throw new Error("expected rejection");
}

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jig-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), text);
  }
  return dir;
}

const SRC = "export const foo = 1;\nexport const keep = foo;\n";

// The cases that change files are in src/rename/test/rename.toml, src/boom/test/boom.toml and
// src/flowy/test/flowy.toml.
describe("codemod", () => {
  test("the report is valid and has the kind of the transform's table entry", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    const report = await main(["rename", "--files", "a.ts"], dir, pkg);
    assertReport(report);
    assert.equal(report.ok && report.kind, "rewrite");
  });

  test("a transform that throws does not fail the run", async () => {
    const pkg = await fakePackage({ boom: "rewrite" }, { boom: `module.exports = () => { throw new Error("cannot handle this\\nsecond line"); };\n` });
    const dir = await workspace({ "a.ts": SRC });
    const report = await main(["boom", "--files", "*.ts"], dir, pkg);
    assert.equal(report.ok, true);
    assert.equal((await readTree(dir))["a.ts"], SRC);
  });
});

describe("codemod arguments", () => {
  test("an unknown action, or none, is UNKNOWN_ACTION", async () => {
    const pkg = await fakePackage({ b: "sweep", a: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["nope", "--files", "a.ts"], dir, pkg))).code, "UNKNOWN_ACTION");
    assert.equal((await rejects(main([], dir, pkg))).code, "UNKNOWN_ACTION");
    assert.equal((await readTree(dir))["a.ts"], SRC);
  });

  test("a name from Object.prototype is not an action", async () => {
    const pkg = await fakePackage({ a: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["constructor", "--files", "a.ts"], dir, pkg))).code, "UNKNOWN_ACTION");
  });
});
