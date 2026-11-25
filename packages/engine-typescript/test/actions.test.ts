import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { RefactorError } from "@jig/core";
import { assertReport, makeRepo, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";

const BIN = join(import.meta.dirname, "..", "src", "bin.ts");

async function rejects(p: Promise<unknown>): Promise<RefactorError> {
  try {
    await p;
  } catch (e) {
    return e as RefactorError;
  }
  throw new Error("expected rejection");
}

// The actions' own cases are in src/<action>/test/<action>.toml; what stays here is the dispatch of
// main (no action to name in a TOML case) and the bin.
describe("main", () => {
  test("an unknown action is UNKNOWN_ACTION", async () => {
    const dir = await makeRepo("simple");
    assert.equal((await rejects(main(["frobnicate"], dir))).code, "UNKNOWN_ACTION");
  });
});

describe("bin", () => {
  function bin(dir: string, args: string[]): Promise<{ code: number | null; last: unknown }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [BIN, ...args], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        try {
          resolve({ code, last: JSON.parse(out.trim().split("\n").at(-1) ?? "") });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  test("runs in the working directory and prints the report as the last line", async () => {
    const dir = await makeRepo("simple");
    const { code, last } = await bin(dir, ["rename", "--file", "a.ts", "--symbol", "foo", "--to", "bar"]);
    assert.equal(code, 0);
    assertReport(last);
    assert.ok((await readTree(dir))["a.ts"]?.includes("export function bar()"));
  });

  test("a failure exits 1 with the error report", async () => {
    const dir = await makeRepo("simple");
    const before = await readTree(dir);
    const { code, last } = await bin(dir, ["rename", "--file", "a.ts", "--symbol", "nope", "--to", "bar"]);
    assert.equal(code, 1);
    assertReport(last);
    assert.equal((last as { ok: boolean }).ok, false);
    assert.equal((last as { code: string }).code, "SYMBOL_NOT_FOUND");
    assert.deepEqual(await readTree(dir), before);
  });
});
