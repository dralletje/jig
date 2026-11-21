import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { rejects, workspace } from "./helpers.ts";

const EXAMPLE = "examples/remove-unused-variable";
const ID = "typescript-remove-unused-variable";

/** Writes `source` as src/t.ts into the example, removes the variable at `at`, returns the new text and report. */
async function remove(source: string, at: string): Promise<{ text: string; report: OkReport }> {
  const dir = await workspace(EXAMPLE, { "src/t.ts": source });
  const report = await main([ID, "--at", `src/t.ts:${at}`], dir);
  assertReport(report);
  return { text: (await readTree(dir))["src/t.ts"] as string, report: report as OkReport };
}

async function refused(source: string, at: string, code = "REFACTOR_UNAVAILABLE"): Promise<string> {
  const dir = await workspace(EXAMPLE, { "src/t.ts": source });
  const before = await readTree(dir);
  const err = await rejects(main([ID, "--at", `src/t.ts:${at}`], dir));
  assert.equal(err.code, code, err.message);
  assert.deepEqual(await readTree(dir), before, "nothing is written");
  return err.message;
}

describe(ID, () => {
  test("removes a single declarator and its line, with a summary", async () => {
    const dir = await workspace(EXAMPLE);
    const report = await main([ID, "--at", "src/report.ts:5"], dir);
    assertReport(report);
    assert.deepEqual(report, {
      schema: "urn:jig:report:1",
      ok: true,
      kind: "refactor",
      subject: `refactor(${ID}): src/report.ts:5`,
      summary: "Removed the unused const `unusedLimit` from `src/report.ts#summarize`.",
    });
    assert.equal(
      (await readTree(dir))["src/report.ts"],
      [
        "export const VERSION = 1;",
        "",
        "export function summarize(values: number[]): string {",
        '  const label = "total";',
        "",
        "  const sum = values.reduce((a, b) => a + b, 0);",
        "  return `${label}: ${sum}`;",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("leaves no blank-line debris", async () => {
    const lines = (...l: string[]) => l.join("\n") + "\n";
    // between blank lines: one blank stays
    assert.equal(
      (await remove(lines("export function f() {", "  const a = f;", "", "  const b = 1;", "", "  return a;", "}"), "4")).text,
      lines("export function f() {", "  const a = f;", "", "  return a;", "}"),
    );
    // first in a block, blank after
    assert.equal(
      (await remove(lines("export function f() {", "  const b = 1;", "", "  return f;", "}"), "2")).text,
      lines("export function f() {", "  return f;", "}"),
    );
    // last in a block, blank before
    assert.equal(
      (await remove(lines("export function f() {", "  g();", "", "  const b = 1;", "}", "function g() {}"), "4")).text,
      lines("export function f() {", "  g();", "}", "function g() {}"),
    );
    // touching lines stay touching
    assert.equal(
      (await remove(lines("export function f() {", "  g();", "  const b = 1;", "  g();", "}", "function g() {}"), "3")).text,
      lines("export function f() {", "  g();", "  g();", "}", "function g() {}"),
    );
  });

  test("takes its doc comment and trailing line comment along", async () => {
    const { text } = await remove(
      'export function f() {\n  /** The limit. */\n  const limit = 10; // for later\n  return f;\n}\n',
      "3",
    );
    assert.equal(text, "export function f() {\n  return f;\n}\n");
  });

  test("removes one declarator of several", async () => {
    assert.equal(
      (await remove("export function f() {\n  const a = 1, b = 2, c = 3;\n  return [a, c];\n}\n", "2:16")).text,
      "export function f() {\n  const a = 1, c = 3;\n  return [a, c];\n}\n",
    );
    assert.equal(
      (await remove("export function f() {\n  const a = 1, b = 2;\n  return a;\n}\n", "2:16")).text,
      "export function f() {\n  const a = 1;\n  return a;\n}\n",
    );
    assert.equal(
      (await remove("export function f() {\n  const a = 1, b = 2;\n  return b;\n}\n", "2:9")).text,
      "export function f() {\n  const b = 2;\n  return b;\n}\n",
    );
  });

  test("without a column, several candidates on the line is INVALID_ARGS naming the columns; none is REFACTOR_UNAVAILABLE", async () => {
    const message = await refused("export function f() {\n  const a = 1, b = 2;\n  return 0;\n}\n", "2", "INVALID_ARGS");
    assert.ok(message.includes("column 9") && message.includes("column 16"), message);
    assert.ok((await refused("export const x = 1;\n\nexport const y = 2;\n", "2")).includes("no variable"));
  });

  test("removes one destructured element and keeps the rest", async () => {
    assert.equal(
      (
        await remove(
          "export function f(o: { a: number; b: number; c: number }) {\n  const { a, b, c } = o;\n  return [a, c];\n}\n",
          "2:14",
        )
      ).text,
      "export function f(o: { a: number; b: number; c: number }) {\n  const { a, c } = o;\n  return [a, c];\n}\n",
    );
    assert.equal(
      (
        await remove(
          "export function f(o: { a: number; b: number }) {\n  const { a, b: renamed } = o;\n  return a;\n}\n",
          "2:17",
        )
      ).text,
      "export function f(o: { a: number; b: number }) {\n  const { a } = o;\n  return a;\n}\n",
    );
    // array pattern: the hole keeps the position of what follows
    const first = await remove("export function f(p: number[]) {\n  const [a, b] = p;\n  return b;\n}\n", "2:10");
    assert.equal(first.text, "export function f(p: number[]) {\n  const [, b] = p;\n  return b;\n}\n");
    assert.equal(
      (await remove("export function f() {\n  const [a, b] = [1, 2];\n  return a;\n}\n", "2:13")).text,
      "export function f() {\n  const [a] = [1, 2];\n  return a;\n}\n",
    );
    assert.equal(first.report.summary, "Removed the unused destructured const `a` from `src/t.ts#f`.");
  });

  test("removes the whole declarator when the only destructured element goes", async () => {
    assert.equal(
      (await remove("export function f(o: { a: number }) {\n  const { a } = o;\n  return o;\n}\n", "2")).text,
      "export function f(o: { a: number }) {\n  return o;\n}\n",
    );
  });

  test("a module-level variable that is not exported can go", async () => {
    assert.equal((await remove("const hidden = 1;\nexport const shown = 2;\n", "1")).text, "export const shown = 2;\n");
  });

  test("a function-valued local is removed from the function around it", async () => {
    const { report } = await remove("export function f() {\n  const helper = () => 1;\n  return f;\n}\n", "2");
    assert.equal(report.summary, "Removed the unused const `helper` from `src/t.ts#f`.");
  });

  test("refuses a variable that is referenced, and says where", async () => {
    const message = await refused("export function f() {\n  const a = 1;\n  return a;\n}\n", "2");
    assert.ok(message.includes("`a` is still referenced") && message.includes("src/t.ts:3"), message);
    await refused("export function f() {\n  let a = 1;\n  a = 2;\n}\n", "2"); // a write is a reference
    await refused("export function f() {\n  const a = 1;\n  return { a };\n}\n", "2"); // shorthand property
    await refused("const a = 1;\nexport { a };\n", "1"); // exported by name
  });

  test("refuses an exported variable and a global of a script", async () => {
    assert.ok((await refused("export const a = 1;\n", "1")).includes("exported"));
    assert.ok((await refused("const a = 1;\n", "1")).includes("global"));
  });

  test("refuses a parameter, a catch binding and a loop variable", async () => {
    assert.ok((await refused("export function f(a: number) {\n  return 1;\n}\n", "1:19")).includes("parameter"));
    assert.ok((await refused("export function f() {\n  try {\n    f();\n  } catch (e) {}\n}\n", "4:12")).includes("catch"));
    assert.ok((await refused("export function f(xs: number[]) {\n  for (const x of xs) {}\n}\n", "2:14")).includes("loop"));
  });

  test("refuses an initializer that could have side effects", async () => {
    const message = await refused("export function f() {\n  const a = g();\n}\nfunction g() {\n  return 1;\n}\n", "2");
    assert.ok(message.includes("side effects"), message);
    await refused("export function f() {\n  const a = { b: g() };\n}\nfunction g() {\n  return 1;\n}\n", "2");
    await refused("export function f() {\n  const a = new Date();\n}\n", "2");
    await refused("export function f(o: { a: number; b: number }) {\n  const { a = g(), b } = o;\n  return b;\n}\nfunction g() {\n  return 1;\n}\n", "2:11");
  });

  test("accepts literals, identifiers, functions and literals built from those", async () => {
    for (const init of ['"s"', "-1", "`a${f}`", "[1, f, () => 1]", "{ a: 1, b: f, c() { return 1; } }", "function () {}", "f as unknown"]) {
      await remove(`export function f() {\n  const a = ${init};\n  return f;\n}\n`, "2");
    }
  });

  test("refuses a destructured element that is not safe to drop", async () => {
    // before a rest element: the rest would pick the property up
    await refused("export function f(o: { a: number; b: number }) {\n  const { a, ...rest } = o;\n  return rest;\n}\n", "2:11");
    // only element of a nested pattern
    await refused("export function f(o: { a: { b: number }; c: number }) {\n  const { a: { b }, c } = o;\n  return c;\n}\n", "2:16");
    // array pattern over a call
    await refused("export function f(p: number[]) {\n  const [a] = p;\n}\n", "2:10");
  });

  test("refuses the body of an if, which would be left without one", async () => {
    await refused("export function f(c: boolean) {\n  if (c) var a = 1;\n}\n", "2:14");
  });

  test("a point that is not a variable name is REFACTOR_UNAVAILABLE, a malformed --at INVALID_ARGS", async () => {
    await refused("export function f() {\n  const a = 1;\n  return f;\n}\n", "3:3");
    const dir = await workspace(EXAMPLE);
    assert.equal((await rejects(main([ID, "--at", "src/report.ts"], dir))).code, "INVALID_ARGS");
    assert.equal((await rejects(main([ID], dir))).code, "INVALID_ARGS");
  });

  test("refuses the tail element of an array pattern over a generator", async () => {
    const message = await refused(
      "function* g() {\n  yield 1;\n  yield 2;\n}\nexport function f() {\n  const [a, b] = g();\n  return a;\n}\n",
      "6:13",
    );
    assert.match(message, /iterable/);
    // an array literal is fine
    const { text } = await remove("export function f() {\n  const [a, b] = [1, 2];\n  return a;\n}\n", "2:13");
    assert.match(text, /const \[a\] = \[1, 2\];/);
  });

  test("same-named locals in sibling blocks: the one at --at goes", async () => {
    const source =
      "export function f(a: boolean) {\n  if (a) {\n    const t = 1;\n  } else {\n    const t = 2;\n  }\n  return a;\n}\n";
    assert.equal((await remove(source, "3")).text, "export function f(a: boolean) {\n  if (a) {\n  } else {\n    const t = 2;\n  }\n  return a;\n}\n");
    assert.equal((await remove(source, "5")).text, "export function f(a: boolean) {\n  if (a) {\n    const t = 1;\n  } else {\n  }\n  return a;\n}\n");
  });
});
