import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { errors, rejects, workspace } from "./helpers.ts";

const EXAMPLE = "examples/convert-function";

async function convert(dir: string, at: string, to: "arrow" | "function") {
  return main(["typescript-convert-function", "--at", at, "--to", to], dir);
}

async function read(dir: string, file: string): Promise<string> {
  return readFile(join(dir, file), "utf8");
}

async function refused(dir: string, at: string, to: "arrow" | "function", code: string, part: string): Promise<void> {
  const before = await readTree(dir);
  const e = await rejects(convert(dir, at, to));
  assert.equal(e.code, code, e.message);
  assert.ok(e.message.includes(part), `expected ${JSON.stringify(part)} in:\n${e.message}`);
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

describe("typescript-convert-function --to arrow", () => {
  test("a declaration becomes a const arrow, keeping export, types and body", async () => {
    const dir = await workspace(EXAMPLE);
    const report = await convert(dir, "src/math.ts:1", "arrow");
    assertReport(report);
    assert.equal(
      await read(dir, "src/math.ts"),
      [
        "export const add = (a: number, b: number): number => {",
        "  return a + b;",
        "};",
        "",
        "export const double = (n: number): number => n * 2;",
        "",
        "export const first = <T>(items: T[]): T | undefined => items[0];",
        "",
      ].join("\n"),
    );
    assert.deepEqual(report, {
      schema: "urn:jig:report:1",
      ok: true,
      kind: "refactor",
      subject: "refactor(typescript-convert-function): src/math.ts:1 → arrow function",
      summary: "Converted the function declaration `add` in src/math.ts to a `const` arrow function.",
    });
    assert.deepEqual(await errors(dir, "src/math.ts"), []);
  });

  test("async, generics and a doc comment are kept", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/a.ts": "/** Loads. */\nexport async function load<T extends object>(x: T, y = 1): Promise<T> {\n  return x;\n}\n",
    });
    await convert(dir, "src/a.ts:2", "arrow");
    assert.equal(
      await read(dir, "src/a.ts"),
      "/** Loads. */\nexport const load = async <T extends object>(x: T, y = 1): Promise<T> => {\n  return x;\n};\n",
    );
  });

  test("in a .tsx file a single type parameter gets the comma that keeps it from reading as JSX", async () => {
    const dir = await workspace(EXAMPLE, { "src/a.tsx": "export function id<T>(x: T): T {\n  return x;\n}\n" });
    await convert(dir, "src/a.tsx:1", "arrow");
    assert.equal(await read(dir, "src/a.tsx"), "export const id = <T,>(x: T): T => {\n  return x;\n};\n");
    await convert(dir, "src/a.tsx:1", "function");
    assert.equal(await read(dir, "src/a.tsx"), "export function id<T>(x: T): T {\n  return x;\n}\n");
  });

  test("a function expression becomes an arrow; its own name is dropped", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/a.ts": "export const run = function run(a: number) {\n  return a;\n};\n",
    });
    const report = await convert(dir, "src/a.ts:1", "arrow");
    assert.equal(await read(dir, "src/a.ts"), "export const run = (a: number) => {\n  return a;\n};\n");
    assert.equal(report.ok && report.summary, "Converted the function expression `run` in src/a.ts to an arrow function.");
  });

  test("an anonymous function expression is named by its occurrence; parentheses where syntax needs them", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/a.ts": [
        "export function go(xs: number[], f?: () => number) {",
        "  const g = f || function () { return 1; };",
        "  return xs.map(function (x) { return x * g(); });",
        "}",
        "",
      ].join("\n"),
    });
    const report = await convert(dir, "src/a.ts:2", "arrow");
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
    assert.equal(report.ok && report.summary, "Converted a function expression in `src/a.ts#go` to an arrow function.");
  });

  test("the summary does not change when code moves above the function", async () => {
    const plain = await workspace(EXAMPLE);
    const moved = await workspace(EXAMPLE, {
      "src/math.ts": `// one\n// two\n// three\n${await read(await workspace(EXAMPLE), "src/math.ts")}`,
    });
    const a = await convert(plain, "src/math.ts:1", "arrow");
    const b = await convert(moved, "src/math.ts:4", "arrow");
    assert.ok(a.ok && b.ok);
    assert.equal(a.summary, b.summary);
  });

  test("refuses this, arguments, super and new.target, but not inside a nested function", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/t.ts": "export function a(this: Window) {\n  return 1;\n}\n",
      "src/u.ts": "export function b(x: number) {\n  return () => this;\n}\n",
      "src/v.ts": "export function c() {\n  return arguments.length;\n}\n",
      "src/w.ts": "export function d() {\n  return new.target;\n}\n",
      "src/ok.ts": "export function e() {\n  return function () { return this; };\n}\n",
    });
    await refused(dir, "src/t.ts:1", "arrow", U, "a `this` parameter");
    await refused(dir, "src/u.ts:1", "arrow", U, "`this`");
    await refused(dir, "src/v.ts:1", "arrow", U, "`arguments`");
    await refused(dir, "src/w.ts:1", "arrow", U, "`new.target`");
    await convert(dir, "src/ok.ts:1", "arrow");
    assert.equal(await read(dir, "src/ok.ts"), "export const e = () => {\n  return function () { return this; };\n};\n");
  });

  test("refuses a generator", async () => {
    const dir = await workspace(EXAMPLE, { "src/g.ts": "export function* g() {\n  yield 1;\n}\n" });
    await refused(dir, "src/g.ts:1", "arrow", U, "is a generator");
  });

  test("refuses a function called with new, in any file, or used through its prototype", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/ctor.ts": "export function Thing(this: { n: number }) {}\n",
      "src/ctor2.ts": "export function Plain() {}\n",
      "src/use.ts": 'import { Plain } from "./ctor2.ts";\nexport const x = new Plain();\n',
      "src/proto.ts": "export function P() {}\nP.prototype.hello = 1;\n",
    });
    await refused(dir, "src/ctor2.ts:1", "arrow", U, "is called with `new` in src/use.ts:2");
    await refused(dir, "src/proto.ts:1", "arrow", U, "`.prototype`");
  });

  test("refuses an overloaded function", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/o.ts":
        "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any): any {\n  return a;\n}\n",
    });
    await refused(dir, "src/o.ts:3", "arrow", U, "declared more than once");
    await refused(dir, "src/o.ts:1", "arrow", U, "no body");
  });

  test("refuses a default export", async () => {
    const dir = await workspace(EXAMPLE, { "src/d.ts": "export default function named() {\n  return 1;\n}\n" });
    await refused(dir, "src/d.ts:1", "arrow", U, "default export");
  });

  test("refuses a function used before its declaration, but not an export list", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/h.ts": "export const r = later();\nfunction later() {\n  return 1;\n}\n",
      "src/ok.ts": "export { later };\nfunction later() {\n  return 1;\n}\n",
    });
    await refused(dir, "src/h.ts:2", "arrow", U, "src/h.ts:1, before its declaration");
    await convert(dir, "src/ok.ts:2", "arrow");
    assert.equal(await read(dir, "src/ok.ts"), "export { later };\nconst later = () => {\n  return 1;\n};\n");
  });

  test("refuses a function expression that calls itself by a different name", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/s.ts": "export const f = function inner(n: number): number {\n  return n ? inner(n - 1) : 0;\n};\n",
    });
    await refused(dir, "src/s.ts:1", "arrow", U, "its own name `inner`");
  });
});

describe("typescript-convert-function runtime behaviour", () => {
  test("refuses a use inside a hoisted function declaration that runs before the const (TDZ)", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/t.ts":
        "export const result = run();\nfunction double(n: number) {\n  return n * 2;\n}\nfunction run() {\n  return double(21);\n}\nconsole.log(result);\n",
    });
    assert.equal(run(dir, "src/t.ts"), "42");
    await refused(dir, "src/t.ts:2", "arrow", U, "inside another function declaration");
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
    await refused(dir, "src/n.ts:1", "arrow", U, "its own name `g`");
    await refused(dir, "src/n.ts:1", "function", U, "its own name `g`");
    assert.equal(run(dir, "src/n.ts"), "g");
    for (const [file, to] of [["src/m.ts", "function"], ["src/o.ts", "arrow"]] as const) {
      const before = run(dir, file);
      await convert(dir, `${file}:1`, to);
      assert.equal(run(dir, file), before, file);
    }
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

describe("typescript-convert-function --to function", () => {
  test("a const arrow becomes a declaration, keeping generics, parameter and return types", async () => {
    const dir = await workspace(EXAMPLE);
    const report = await convert(dir, "src/math.ts:7", "function");
    assertReport(report);
    assert.equal(
      await read(dir, "src/math.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export const double = (n: number): number => n * 2;",
        "",
        "export function first<T>(items: T[]): T | undefined {",
        "  return items[0];",
        "}",
        "",
      ].join("\n"),
    );
    assert.equal(report.ok && report.summary, "Converted `first` in src/math.ts from an arrow function to a function declaration.");
    assert.deepEqual(await errors(dir, "src/math.ts"), []);
  });

  test("an object-literal expression body keeps its braces; async and bare parameters work", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/a.ts": "export const box = (n: number) => ({ n });\nconst inc = async x => x + 1;\n",
    });
    await convert(dir, "src/a.ts:1", "function");
    assert.equal(
      await read(dir, "src/a.ts"),
      "export function box(n: number) {\n  return { n };\n}\nconst inc = async x => x + 1;\n",
    );
  });

  test("a function expression becomes a declaration", async () => {
    const dir = await workspace(EXAMPLE, { "src/a.ts": "export const f = async function* (n: number) {\n  yield n;\n};\n" });
    await convert(dir, "src/a.ts:1", "function");
    assert.equal(await read(dir, "src/a.ts"), "export async function* f(n: number) {\n  yield n;\n}\n");
  });

  test("refuses this, arguments, super and new.target in the arrow", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/t.ts": "export class A {\n  m = () => {\n    return this;\n  };\n}\nexport const k = () => this;\n",
      "src/v.ts": "export const v = () => arguments.length;\n",
      "src/w.ts": "export const w = () => new.target;\n",
    });
    await refused(dir, "src/t.ts:6", "function", U, "uses `this`");
    await refused(dir, "src/v.ts:1", "function", U, "`arguments`");
    await refused(dir, "src/w.ts:1", "function", U, "`new.target`");
  });

  test("refuses a type-annotated variable, multiple declarators, let and var", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/a.ts": "export const typed: (n: number) => number = (n) => n;\n",
      "src/b.ts": "export const one = () => 1, two = () => 2;\n",
      "src/c.ts": "export let mutable = () => 1;\n",
    });
    await refused(dir, "src/a.ts:1", "function", U, "has a type annotation (`(n: number) => number`)");
    await refused(dir, "src/b.ts:1:20", "function", U, "together with other variables");
    await refused(dir, "src/c.ts:1", "function", U, "let or var");
  });

  test("an asserts signature survives the conversion", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/a.ts": "export const assertIt = (x: unknown): asserts x is string => {\n  if (typeof x !== 'string') throw new Error();\n};\n",
    });
    // A function declaration with an asserts signature is fine; this must succeed.
    await convert(dir, "src/a.ts:1", "function");
    assert.deepEqual(await errors(dir, "src/a.ts"), []);
  });
});

describe("typescript-convert-function round trip and --at", () => {
  test("--to arrow then --to function restores the original text", async () => {
    const dir = await workspace(EXAMPLE);
    const original = await read(dir, "src/math.ts");
    await convert(dir, "src/math.ts:1", "arrow");
    assert.notEqual(await read(dir, "src/math.ts"), original);
    await convert(dir, "src/math.ts:1", "function");
    assert.equal(await read(dir, "src/math.ts"), original);
  });

  test("a column picks one of several functions on a line; without it the refusal asks for one", async () => {
    const two = await workspace(EXAMPLE, {
      "src/a.ts": "export function a() { return 1; } export function b() { return 2; }\n",
    });
    const several = await rejects(convert(two, "src/a.ts:1", "arrow"));
    assert.equal(several.code, "INVALID_ARGS");
    assert.ok(several.message.includes("--at src/a.ts:1:<column>"), several.message);
    await convert(two, "src/a.ts:1:40", "arrow");
    assert.equal(await read(two, "src/a.ts"), "export function a() { return 1; } export const b = () => { return 2; };\n");
  });

  test("bad --at values are INVALID_ARGS, a line without a function is REFACTOR_UNAVAILABLE", async () => {
    const dir = await workspace(EXAMPLE);
    for (const at of ["src/math.ts", "src/math.ts:0", "src/math.ts:x", ":3"]) {
      assert.equal((await rejects(convert(dir, at, "arrow"))).code, "INVALID_ARGS", at);
    }
    assert.equal((await rejects(convert(dir, "src/math.ts:2", "arrow"))).code, "REFACTOR_UNAVAILABLE");
    assert.equal((await rejects(convert(dir, "src/math.ts:99", "arrow"))).code, "INVALID_ARGS");
    const to = await rejects(main(["typescript-convert-function", "--at", "src/math.ts:1", "--to", "class"], dir));
    assert.equal(to.code, "INVALID_ARGS");
    const missing = await rejects(main(["typescript-convert-function", "--to", "arrow"], dir));
    assert.equal(missing.code, "INVALID_ARGS");
  });
});
