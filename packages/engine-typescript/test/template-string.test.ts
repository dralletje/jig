import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { rejects, workspace } from "./helpers.ts";

const FIXTURE = "examples/template-string";
const run = async (dir: string, at: string) => (await main(["template-string", "--at", at], dir)) as OkReport;

describe("template-string", () => {
  test("`\"Hi \" + name + \"!\"` becomes a template literal; report has a summary", async () => {
    const dir = await workspace(FIXTURE);
    const report = await run(dir, "src/greet.ts:2");
    assertReport(report);
    assert.ok((await readTree(dir))["src/greet.ts"]?.includes("return `Hi ${name}!`;"));
    assert.equal(report.subject, "refactor(template-string): src/greet.ts:2");
    assert.equal(report.kind, "refactor");
    assert.equal(
      report.summary,
      'Converted a string concatenation in src/greet.ts#greet to a template literal: "Hi " + name + "!" became `Hi ${name}!`.',
    );
  });

  test("nested parentheses and a number operand", async () => {
    const dir = await workspace(FIXTURE);
    const report = await run(dir, "src/greet.ts:6");
    assertReport(report);
    const text = (await readTree(dir))["src/greet.ts"] ?? "";
    assert.ok(text.includes("return `User ${name + \" has \"}${count} items`;") || text.includes("return `User ${name} has ${count} items`;"), text);
  });

  test("the summary stays the same when code moves above", async () => {
    const a = await run(await workspace(FIXTURE), "src/greet.ts:2");
    const moved = await workspace(FIXTURE, {
      "src/greet.ts": `// one\n// two\n${(await readTree(await workspace(FIXTURE)))["src/greet.ts"]}`,
    });
    const b = await run(moved, "src/greet.ts:4");
    assert.equal(b.summary, a.summary);
  });

  test("a line with two concatenations needs a column", async () => {
    const dir = await workspace(FIXTURE);
    const error = await rejects(run(dir, "src/greet.ts:10"));
    assert.equal(error.code, "INVALID_ARGS");
    assert.match(error.message, /2 string concatenations/);
    assert.match(error.message, /Pass a column/);
    const report = await run(dir, "src/greet.ts:10:20");
    assertReport(report);
    const text = (await readTree(dir))["src/greet.ts"] ?? "";
    assert.ok(text.includes('["x" + a, `y${b}`]'), text);
    assert.match(report.summary, /^Converted a string concatenation in src\/greet\.ts#twice to a template literal: "y" \+ b became `y\$\{b\}`\.$/);
  });

  test("no concatenation at the position is refused", async () => {
    const dir = await workspace(FIXTURE);
    assert.equal((await rejects(run(dir, "src/greet.ts:1"))).code, "REFACTOR_UNAVAILABLE");
    const error = await rejects(run(dir, "src/greet.ts:1:5"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
  });

  test("a + chain without a string is not offered by TypeScript", async () => {
    const dir = await workspace(FIXTURE);
    const error = await rejects(run(dir, "src/greet.ts:14"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.match(error.message, /does not offer/);
    const tree = await readTree(dir);
    assert.ok(tree["src/greet.ts"]?.includes("return a + b;"));
  });

  test("bad --at values are INVALID_ARGS", async () => {
    const dir = await workspace(FIXTURE);
    for (const at of ["src/greet.ts", "src/greet.ts:x", "src/greet.ts:0", "src/greet.ts:2:0", "src/greet.ts:2:200","src/greet.ts:99"]) {
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
    assert.match(error.message, /valueOf/);
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
    assertReport(await run(dir, "src/prim.ts:3"));
    assert.ok((await readTree(dir))["src/prim.ts"]?.includes("`p${a}${b}${c}${d}`"));
  });

  test("a comment inside the chain is refused, not moved into ${}", async () => {
    const src = 'export function f(x: string): string {\n  return "a" + /* keep */ x + "b";\n}\n';
    const dir = await workspace(FIXTURE, { "src/c.ts": src });
    const error = await rejects(run(dir, "src/c.ts:2"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.match(error.message, /comment/);
    assert.equal((await readTree(dir))["src/c.ts"], src);
  });
});
