import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { rejects, workspace } from "./helpers.ts";

// The cases that are plain files in, files out (or a refusal) are in src/convert-function/test/convert-function.toml.
// What stays here runs the converted programs with Node, or converts one file twice.

const EXAMPLE = "examples/convert-function";

async function convert(dir: string, at: string, to: "arrow" | "function") {
  return main(["convert-function", "--at", at, "--to", to], dir);
}

async function read(dir: string, file: string): Promise<string> {
  return readFile(join(dir, file), "utf8");
}

async function refused(dir: string, at: string, to: "arrow" | "function", code: string): Promise<void> {
  const before = await readTree(dir);
  const e = await rejects(convert(dir, at, to));
  assert.equal(e.code, code, e.message);
  assert.deepEqual(await readTree(dir), before, "a refusal leaves the files alone");
}

const U = "REFACTOR_UNAVAILABLE";

/** What a file prints when Node runs it (type stripping), or the error it dies with. */
function run(dir: string, file: string): string {
  try {
    return execFileSync(process.execPath, [join(dir, file)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const m = /\b(\w*Error): [^\n]*/.exec(String((e as { stderr?: string }).stderr));
    return m ? m[0] : "crashed";
  }
}

describe("convert-function runtime behaviour", () => {
  test("refuses a use inside a hoisted function declaration that runs before the const (TDZ)", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/t.ts":
        "export const result = run();\nfunction double(n: number) {\n  return n * 2;\n}\nfunction run() {\n  return double(21);\n}\nconsole.log(result);\n",
    });
    assert.equal(run(dir, "src/t.ts"), "42");
    await refused(dir, "src/t.ts:2", "arrow", U);
    assert.equal(run(dir, "src/t.ts"), "42", "the refused file still behaves the same");
  });

  test("a use inside an arrow or in the function itself still converts, with the same output", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/t.ts":
        "function double(n: number): number {\n  return n > 100 ? n : double(n * 2);\n}\nconst run = () => double(21);\nconsole.log(run());\n",
    });
    const before = run(dir, "src/t.ts");
    await convert(dir, "src/t.ts:1", "arrow");
    assert.equal(run(dir, "src/t.ts"), before);
  });

  test("refuses a function expression whose own name differs from its variable (.name would change)", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/n.ts": "const f = function g() {\n  return 1;\n};\nconsole.log(f.name);\n",
      "src/m.ts": "const f = () => 1;\nconsole.log(f.name);\n",
      "src/o.ts": "const f = function f() {\n  return 1;\n};\nconsole.log(f.name);\n",
    });
    assert.equal(run(dir, "src/n.ts"), "g");
    await refused(dir, "src/n.ts:1", "arrow", U);
    await refused(dir, "src/n.ts:1", "function", U);
    assert.equal(run(dir, "src/n.ts"), "g");
    for (const [file, to] of [["src/m.ts", "function"], ["src/o.ts", "arrow"]] as const) {
      const before = run(dir, file);
      await convert(dir, `${file}:1`, to);
      assert.equal(run(dir, file), before, file);
    }
  });
});

describe("convert-function round trip", () => {
  test("--to arrow then --to function restores the original text", async () => {
    const dir = await workspace(EXAMPLE);
    const original = await read(dir, "src/math.ts");
    await convert(dir, "src/math.ts:1", "arrow");
    assert.notEqual(await read(dir, "src/math.ts"), original);
    await convert(dir, "src/math.ts:1", "function");
    assert.equal(await read(dir, "src/math.ts"), original);
  });
});

describe("convert-function two conversions in one file", () => {
  test("an anonymous function expression converts, with parentheses where syntax needs them", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/a.ts": [
        "export function go(xs: number[], f?: () => number) {",
        "  const g = f || function () { return 1; };",
        "  return xs.map(function (x) { return x * g(); });",
        "}",
        "",
      ].join("\n"),
    });
    await convert(dir, "src/a.ts:2", "arrow");
    await convert(dir, "src/a.ts:3", "arrow");
    assert.equal(
      await read(dir, "src/a.ts"),
      [
        "export function go(xs: number[], f?: () => number) {",
        "  const g = f || (() => { return 1; });",
        "  return xs.map((x) => { return x * g(); });",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("--to function keeps a comment between => and an expression body", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/c.ts": "export const f = (n: number) => // keep me\n  n * 2;\nexport const g = (n: number) => /* and me */ n + 1;\n",
    });
    await convert(dir, "src/c.ts:3", "function");
    await convert(dir, "src/c.ts:1", "function");
    assert.equal(
      await read(dir, "src/c.ts"),
      "export function f(n: number) {\n  // keep me\n  return n * 2;\n}\nexport function g(n: number) {\n  /* and me */\n  return n + 1;\n}\n",
    );
  });
});
