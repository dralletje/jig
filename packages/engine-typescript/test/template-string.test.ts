import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { rejects, workspace } from "./helpers.ts";

const FIXTURE = "examples/template-string";
const run = (dir: string, at: string) => main(["template-string", "--at", at], dir);

describe("template-string", () => {
  test("`\"Hi \" + name + \"!\"` becomes a template literal", async () => {
    const dir = await workspace(FIXTURE);
    assertReport(await run(dir, "src/greet.ts:2"));
    assert.ok((await readTree(dir))["src/greet.ts"]?.includes("return `Hi ${name}!`;"));
  });

  test("nested parentheses and a number operand", async () => {
    const dir = await workspace(FIXTURE);
    await run(dir, "src/greet.ts:6");
    const text = (await readTree(dir))["src/greet.ts"] ?? "";
    assert.ok(text.includes("return `User ${name + \" has \"}${count} items`;") || text.includes("return `User ${name} has ${count} items`;"), text);
  });

  test("a line with two concatenations needs a column", async () => {
    const dir = await workspace(FIXTURE);
    const before = await readTree(dir);
    assert.equal((await rejects(run(dir, "src/greet.ts:10"))).code, "INVALID_ARGS");
    assert.deepEqual(await readTree(dir), before);
    await run(dir, "src/greet.ts:10:20");
    const text = (await readTree(dir))["src/greet.ts"] ?? "";
    assert.ok(text.includes('["x" + a, `y${b}`]'), text);
  });

  test("no concatenation at the position, or a + chain without a string, is refused", async () => {
    const dir = await workspace(FIXTURE);
    const before = await readTree(dir);
    assert.equal((await rejects(run(dir, "src/greet.ts:1"))).code, "REFACTOR_UNAVAILABLE");
    assert.equal((await rejects(run(dir, "src/greet.ts:1:5"))).code, "REFACTOR_UNAVAILABLE");
    assert.equal((await rejects(run(dir, "src/greet.ts:14"))).code, "REFACTOR_UNAVAILABLE");
    assert.deepEqual(await readTree(dir), before);
  });

  test("bad --at values are INVALID_ARGS", async () => {
    const dir = await workspace(FIXTURE);
    for (const at of ["src/greet.ts", "src/greet.ts:x", "src/greet.ts:0", "src/greet.ts:2:0", "src/greet.ts:2:200", "src/greet.ts:99"]) {
      assert.equal((await rejects(run(dir, at))).code, "INVALID_ARGS", at);
    }
    await rejects(main(["template-string"], dir));
  });

  const OBJ = [
    "export const o = { toString() { return 'o'; }, valueOf() { return 1; } };",
    "export function f(): string {",
    "  return 'a' + o;",
    "}",
    "",
  ].join("\n");

  test("an object operand (valueOf vs toString) is refused and the output stays the same", async () => {
    const dir = await workspace(FIXTURE, { "src/obj.ts": OBJ });
    const value = async (q: string) => ((await import(`${dir}/src/obj.ts?${q}`)) as { f(): string }).f();
    const before = await value("before");
    assert.equal(before, "a1");
    const error = await rejects(run(dir, "src/obj.ts:3"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.equal(await value("after"), before);
    assert.equal((await readTree(dir))["src/obj.ts"], OBJ);
  });

  test("primitive unions, literals and enums still convert", async () => {
    const src = [
      "enum E { A = 1 }",
      "export function f(a: string | number | null, b: 'x' | 2n, c: boolean | undefined, d: E): string {",
      "  return 'p' + a + b + c + d;",
      "}",
      "",
    ].join("\n");
    const dir = await workspace(FIXTURE, { "src/prim.ts": src });
    await run(dir, "src/prim.ts:3");
    assert.ok((await readTree(dir))["src/prim.ts"]?.includes("`p${a}${b}${c}${d}`"));
  });

  test("a comment inside the chain is refused, not moved into ${}", async () => {
    const src = 'export function f(x: string): string {\n  return "a" + /* keep */ x + "b";\n}\n';
    const dir = await workspace(FIXTURE, { "src/c.ts": src });
    const error = await rejects(run(dir, "src/c.ts:2"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.equal((await readTree(dir))["src/c.ts"], src);
  });
});
