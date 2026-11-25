import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { errors, workspace } from "./helpers.ts";

const EXAMPLE = "examples/inline-function";

const inline = (dir: string, ...args: string[]) => main(["inline-function", ...args], dir);

/** Source files for the edge cases: one function per file keeps the expectations small. */
async function edge(source: string, ...args: string[]) {
  const dir = await workspace(EXAMPLE, { "src/edge.ts": source });
  return { dir, run: () => inline(dir, "--file", "src/edge.ts", ...args) };
}

// ---- review fixes: behaviour is compared by running the code before and after ----

/** Runs `run()` exported by a workspace file (Node strips the types) with two globals the sources may declare. */
async function runExport(dir: string, file: string): Promise<unknown> {
  const url = pathToFileURL(join(dir, file)).href;
  const script =
    "globalThis.counter = 1; globalThis.bump = () => { globalThis.counter = 10; return 5; };" +
    `const m = await import(${JSON.stringify(url)}); console.log(JSON.stringify(m.run()));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
  return JSON.parse(stdout);
}

/** Unpacks and checks that `run()` returns the same before and after, and equals `expected`. */
async function sameBehaviour(source: string, expected: unknown, ...args: string[]): Promise<string> {
  const { dir, run } = await edge(source, ...args);
  assert.deepEqual(await runExport(dir, "src/edge.ts"), expected, "the original behaves as expected");
  assertReport(await run());
  assert.deepEqual(await errors(dir, "src/edge.ts"), []);
  assert.deepEqual(await runExport(dir, "src/edge.ts"), expected, "the unpacked code behaves the same");
  return (await readTree(dir))["src/edge.ts"] as string;
}

describe("inline-function: a call that starts a statement (ASI)", () => {
  test("a replacement starting with ( does not join the previous line", async () => {
    const text = await sameBehaviour(
      [
        "const log: number[] = [];",
        "const g = (n: number) => { log.push(n); return n; };",
        "const f = (x: number) => (x + 1) * 2;",
        "export function run() {",
        "  g",
        "  f(1)",
        "  return log;",
        "}",
        "",
      ].join("\n"),
      [],
      "--symbol",
      "f",
    );
    assert.match(text, /\n {2};\(1 \+ 1\) \* 2\n/);
  });

  test("[ and a backtick are guarded too", async () => {
    await sameBehaviour(
      [
        "const log: string[] = [];",
        "const g = { get 1() { log.push('hit'); return 0; } };",
        "const f = (x: number) => [x];",
        "export function run() {",
        "  g",
        "  f(1)",
        "  return log;",
        "}",
        "",
      ].join("\n"),
      [],
      "--symbol",
      "f",
    );
    await sameBehaviour(
      [
        "const log: string[] = [];",
        "const g = (s: TemplateStringsArray) => { log.push(s[0] as string); };",
        "const f = (x: number) => `v${x}`;",
        "export function run() {",
        "  g",
        "  f(1)",
        "  return log;",
        "}",
        "",
      ].join("\n"),
      [],
      "--symbol",
      "f",
    );
  });

  const afterComment = async (comment: string, fn: string, probe: string) => {
    const text = await sameBehaviour(
      [
        "const log: unknown[] = [];",
        "const g: any = { get 1() { log.push('get1'); return (n: number) => { log.push(['called', n]); return n; }; } };",
        `const f = ${fn};`,
        "export function run() {",
        `  g ${comment}`,
        probe === "" ? "  f(1)" : probe,
        "  return log;",
        "}",
        "",
      ].join("\n"),
      [],
      "--symbol",
      "f",
    );
    assert.match(text, /\n {2};[(\[]/);
  };
  const paren = "(x: number) => (x + 1) * 2";
  const bracket = "(x: number) => [x]";

  test("a comment ending in ;, { or : on the previous line does not count as a statement end", async () => {
    await afterComment("// note:", paren, "");
    await afterComment("// done;", bracket, "");
    await afterComment("// see {", bracket, "");
    await afterComment("// see }", bracket, "");
    await afterComment("/* a; */", bracket, "");
    await afterComment("/* b: */", paren, "");
  });

  test("a directive-prologue string without a semicolon gets both the wrap and the guard", async () => {
    const text = await sameBehaviour(
      [
        "const label = () => 'use strict';",
        "export function run() {",
        "  'use foo'",
        "  label()",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      1,
      "--symbol",
      "label",
    );
    assert.match(text, /'use foo'\n {2};\('use strict'\)/);
  });

  test("no guard for the first statement of a block or after a block statement", async () => {
    const text = await sameBehaviour(
      [
        "const f = (x: number) => (x + 1) * 2;",
        "export function run() {",
        "  // note;",
        "  f(1);",
        "  {",
        "    f(2)",
        "  }",
        "  f(3)",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      1,
      "--symbol",
      "f",
    );
    assert.doesNotMatch(text, /;\s*;\(|\{\n\s*;\(|\}\n\s*;\(/);
  });

  test("no guard after a semicolon or as the body of an if", async () => {
    const text = await sameBehaviour(
      [
        "const f = (x: number) => (x + 1) * 2;",
        "export function run() {",
        "  const r = 1;",
        "  f(1);",
        "  if (r) f(2)",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      1,
      "--symbol",
      "f",
    );
    assert.doesNotMatch(text, /;\s*;\(|if \(r\) ;/);
    assert.match(text, /\n {2}\(1 \+ 1\) \* 2;\n/);
  });
});

describe("inline-function: stability of identifier arguments", () => {
  test("a global declared with `declare var` is not treated as unchangeable", async () => {
    const text = await sameBehaviour(
      [
        "declare var counter: number;",
        "declare function bump(): number;",
        "const f = (n: number) => bump() + n;",
        "export function run() {",
        "  return f(counter);",
        "}",
        "",
      ].join("\n"),
      6,
      "--symbol",
      "f",
    );
    assert.match(text, /const n: number = counter;\n {2}return bump\(\) \+ n;/);
  });

  test("a var inside `declare global` is not treated as unchangeable", async () => {
    const text = await sameBehaviour(
      [
        "export {};",
        "declare global {",
        "  var counter: number;",
        "}",
        "declare function bump(): number;",
        "const f = (n: number) => bump() + n;",
        "export function run() {",
        "  return f(counter);",
        "}",
        "",
      ].join("\n"),
      6,
      "--symbol",
      "f",
    );
    assert.match(text, /const n: number = counter;/);
  });
});

describe("inline-function: syntax and grammar at the call", () => {
  test("`in` in a for initializer is parenthesized", async () => {
    const text = await sameBehaviour(
      [
        "const has = (k: string, o: object) => k in o;",
        "export function run() {",
        "  const o = { a: 1 };",
        "  let n = 0;",
        "  for (let b = has('a', o); n < 1; n++) {",
        "    if (!b) return 'no';",
        "  }",
        "  return 'ok';",
        "}",
        "",
      ].join("\n"),
      "ok",
      "--symbol",
      "has",
    );
    assert.match(text, /let b = \('a' in o\)/);
  });
});