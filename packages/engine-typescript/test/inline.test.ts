import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { errors, rejects, workspace } from "./helpers.ts";

const EXAMPLE = "examples/inline-function";

const inline = (dir: string, ...args: string[]) => main(["inline-function", ...args], dir);

/** The (1-based) line of the first line of `file` that contains `needle`. */
function lineOf(text: string | undefined, needle: string): number {
  const i = (text ?? "").split("\n").findIndex((l) => l.includes(needle));
  assert.ok(i >= 0, `no line with ${needle}`);
  return i + 1;
}

/** Runs the action on a copy of the example; returns the new text of `file`. */
async function unpack(file: string, ...args: string[]) {
  const dir = await workspace(EXAMPLE);
  const report = await inline(dir, "--file", file, ...args);
  assertReport(report);
  const tree = await readTree(dir);
  assert.deepEqual(await errors(dir, file), []);
  return { dir, text: tree[file] as string, tree };
}

/** Expects a refusal: REFACTOR_UNAVAILABLE, nothing written. */
async function refused(dir: string, ...args: string[]): Promise<void> {
  const before = await readTree(dir);
  const err = await rejects(inline(dir, ...args));
  assert.equal(err.code, "REFACTOR_UNAVAILABLE", err.message);
  assert.deepEqual(await readTree(dir), before, "a refusal writes nothing");
}

describe("inline-function: single-expression functions", () => {
  test("definition mode unpacks every call, adds parentheses where needed, and removes the declaration", async () => {
    const { text } = await unpack("src/single.ts", "--symbol", "square");
    assert.equal(
      text,
      [
        "const area = (width: number, height: number) => {",
        "  return width * height;",
        "};",
        "",
        "const plus = (a: number, b: number) => a + b;",
        "",
        "export function describe(side: number, w: number, h: number): string {",
        "  const s = side * side;",
        "  const a = area(w, h);",
        "  return `${s + (w * w)}:${a}`;",
        "}",
        "",
        "export const scaled = (v: number) => 1 + (v * v) * 2;",
        "",
        "export const doubled = (w: number) => plus(w, 1) * 2;",
        "",
      ].join("\n"),
    );
  });

  test("a block with only a return is a single expression; a sum becomes (w + 1) * 2", async () => {
    const area = await unpack("src/single.ts", "--symbol", "area");
    assert.match(area.text, /const a = w \* h;/);
    assert.doesNotMatch(area.text, /const area/);
    const plus = await unpack("src/single.ts", "--symbol", "plus");
    assert.match(plus.text, /export const doubled = \(w: number\) => \(w \+ 1\) \* 2;/);
  });

  test("one call: only that call is unpacked and the declaration stays", async () => {
    const source = await workspace(EXAMPLE);
    const line = lineOf((await readTree(source))["src/single.ts"], "const s = square(side)");
    const { text } = await unpack("src/single.ts", "--symbol", "square", "--at", `src/single.ts:${line}`);
    assert.match(text, /const square = \(n: number\) => n \* n;/);
    assert.match(text, /const s = side \* side;/);
    assert.match(text, /s \+ square\(w\)/);
    assert.match(text, /1 \+ square\(v\) \* 2/);
  });
});

describe("inline-function: multi-statement functions", () => {
  test("unpacked at const x = f(...), an expression statement and return f(...); every local clash is renamed", async () => {
    const { text } = await unpack("src/multi.ts", "--symbol", "summarize");
    assert.equal(
      text,
      [
        "function logSize(items: number[]): void {",
        "  const size = items.length;",
        "  sizes.push(size);",
        "}",
        "",
        "const sizes: number[] = [];",
        "",
        "export function report(items: number[]): string {",
        "  const items2: number[] = items;",
        '  const label: string = "average";',
        "  const total = items2.reduce((a, b) => a + b, 0);",
        "  const average = total / items2.length;",
        "  const first = `${label}: ${average}`;",
        "  logSize(items);",
        "  const items3: number[] = items;",
        "  const label2: string = first;",
        "  const total2 = items3.reduce((a, b) => a + b, 0);",
        "  const average2 = total2 / items3.length;",
        "  return `${label2}: ${average2}`;",
        "}",
        "",
      ].join("\n"),
    );

    const stmt = await unpack("src/multi.ts", "--symbol", "logSize");
    assert.match(stmt.text, /  const items2: number\[\] = items;\n  const size = items2\.length;\n  sizes\.push\(size\);\n  return summarize/);
    assert.doesNotMatch(stmt.text, /function logSize/);
  });

  test("body locals and parameters that clash at the call site are renamed", async () => {
    const { text } = await unpack("src/clash.ts", "--symbol", "normalize");
    assert.equal(
      text,
      [
        "export function shares(values: number[], total: number): number[] {",
        "  const values2: number[] = values;",
        "  const total2 = values2.reduce((a, b) => a + b, 0);",
        "  const parts = values2.map((v) => v / total2);",
        "  return parts.map((p) => p * total);",
        "}",
        "",
      ].join("\n"),
    );
  });
});

describe("inline-function: argument evaluation", () => {
  test("a side-effecting argument used twice is hoisted into one const", async () => {
    const { text } = await unpack("src/hoist.ts", "--symbol", "twice");
    assert.match(text, /export function ids\(\): number \{\n  const n: number = next\(\);\n  return n \+ n;\n\}/);
    assert.equal(text.match(/next\(\)/g)?.length, 2); // the declaration and the one call
  });

  test("a call in a + f(b()) with a non-simple argument is refused", async () => {
    const dir = await workspace(EXAMPLE);
    await refused(dir, "--file", "src/hoist.ts", "--symbol", "bump");
    const line = lineOf((await readTree(dir))["src/hoist.ts"], "return a() + bump(b())");
    await refused(dir, "--file", "src/hoist.ts", "--symbol", "bump", "--at", `src/hoist.ts:${line}`);
  });

  test("an argument that a variable inside the body would capture is refused", async () => {
    const dir = await workspace(EXAMPLE);
    await refused(dir, "--file", "src/capture.ts", "--symbol", "addAll");
  });
});

describe("inline-function: free variables", () => {
  test("a call where a free variable is shadowed is refused; the other call can be unpacked on its own", async () => {
    const dir = await workspace(EXAMPLE);
    await refused(dir, "--file", "src/shadow.ts", "--symbol", "withTax");
    const text = (await readTree(dir))["src/shadow.ts"];
    await refused(dir, "--file", "src/shadow.ts", "--symbol", "withTax", "--at", `src/shadow.ts:${lineOf(text, "withTax(price) + rate")}`);
    const ok = await unpack("src/shadow.ts", "--symbol", "withTax", "--at", `src/shadow.ts:${lineOf(text, "return withTax(price);")}`);
    assert.match(ok.text, /export function net\(price: number\): number \{\n  return price \* \(1 \+ rate\);\n\}/);
    assert.match(ok.text, /function withTax/);
  });
});

describe("inline-function: refusals", () => {
  const cases: [string, string][] = [
    ["fact", "const f = fact(5)"],
    ["whoAmI", "const w = whoAmI()"],
    ["count", "const c = count()"],
    ["sign", "const s = sign(-3)"],
    ["load", 'const l = load("a")'],
    ["gen", "const g = gen()"],
  ];
  for (const [symbol, needle] of cases) {
    test(`${symbol}: one call and definition mode both refuse`, async () => {
      const dir = await workspace(EXAMPLE);
      const line = lineOf((await readTree(dir))["src/refusals.ts"], needle);
      await refused(dir, "--file", "src/refusals.ts", "--symbol", symbol, "--at", `src/refusals.ts:${line}`);
      await refused(dir, "--file", "src/refusals.ts", "--symbol", symbol);
    });
  }

  test("exported: definition mode refuses, one call works", async () => {
    const dir = await workspace(EXAMPLE);
    await refused(dir, "--file", "src/shared.ts", "--symbol", "format");
    const line = lineOf((await readTree(dir))["src/shared.ts"], "export const label");
    const ok = await unpack("src/shared.ts", "--symbol", "format", "--at", `src/shared.ts:${line}`);
    assert.match(ok.text, /export const label = \(n: number\) => `#\$\{n\}` \+ pad\(n\);/);
    assert.match(ok.text, /export function format/);
  });

  test("used as a value: definition mode refuses, one call works", async () => {
    const dir = await workspace(EXAMPLE);
    await refused(dir, "--file", "src/shared.ts", "--symbol", "pad");
    const line = lineOf((await readTree(dir))["src/shared.ts"], "export const label");
    const ok = await unpack("src/shared.ts", "--symbol", "pad", "--at", `src/shared.ts:${line}`);
    assert.match(ok.text, /format\(n\) \+ String\(n\)\.padStart\(3, "0"\);/);
  });

  test("--at errors: no call there, ambiguous line, another file, bad syntax", async () => {
    const dir = await workspace(EXAMPLE);
    const text = (await readTree(dir))["src/shared.ts"];
    await refused(dir, "--file", "src/shared.ts", "--symbol", "pad", "--at", "src/shared.ts:1");
    await refused(dir, "--file", "src/shared.ts", "--symbol", "pad", "--at", `src/shared.ts:${lineOf(text, "handlers")}`);
    const two = await workspace(EXAMPLE, { "src/two.ts": "const id = (n: number) => n;\nexport const x = [id(1), id(2)];\n" });
    const ambiguous = await rejects(inline(two, "--file", "src/two.ts", "--symbol", "id", "--at", "src/two.ts:2"));
    assert.equal(ambiguous.code, "INVALID_ARGS");
    const picked = await inline(two, "--file", "src/two.ts", "--symbol", "id", "--at", "src/two.ts:2:26");
    assertReport(picked);
    assert.equal((await readTree(two))["src/two.ts"], "const id = (n: number) => n;\nexport const x = [id(1), 2];\n");
    await refused(dir, "--file", "src/shared.ts", "--symbol", "format", "--at", "src/main.ts:3");
    const bad = await rejects(inline(dir, "--file", "src/shared.ts", "--symbol", "pad", "--at", "nope"));
    assert.equal(bad.code, "INVALID_ARGS");
  });
});

/** Source files for the edge cases: one function per file keeps the expectations small. */
async function edge(source: string, ...args: string[]) {
  const dir = await workspace(EXAMPLE, { "src/edge.ts": source });
  return { dir, run: () => inline(dir, "--file", "src/edge.ts", ...args) };
}

async function edgeText(source: string, ...args: string[]): Promise<string> {
  const { dir, run } = await edge(source, ...args);
  const report = await run();
  assertReport(report);
  assert.deepEqual(await errors(dir, "src/edge.ts"), []);
  return (await readTree(dir))["src/edge.ts"] as string;
}

describe("inline-function: precedence and meaning at the call site", () => {
  test("optional chains are wrapped so the chain does not swallow the rest", async () => {
    const text = await edgeText(
      "const pick = (o: { a?: { b: number } }) => o.a?.b;\nexport const f = (o: { a?: { b: number } }) => pick(o)?.toFixed();\n",
      "--symbol",
      "pick",
    );
    assert.match(text, /\(o\.a\?\.b\)\?\.toFixed\(\)/);
  });

  test("a result that is called directly is refused when it is a property access (this would change)", async () => {
    const { dir } = await edge(
      "const obj = { m() { return 1; } };\nconst get = () => obj.m;\nexport const r = get()();\n",
      "--symbol",
      "get",
    );
    await refused(dir, "--file", "src/edge.ts", "--symbol", "get");
  });

  test("an object literal at the start of a statement, a comma and a ternary are parenthesized", async () => {
    const text = await edgeText(
      [
        "declare function sink(x: unknown): void;",
        "const make = (n: number) => ({ n });",
        "const both = (a: number, b: number) => (sink(a), b);",
        "const pick = (c: boolean, a: number, b: number) => (c ? a : b);",
        "export function run(c: boolean, x: number) {",
        "  make(x);",
        "  sink(both(x, 2));",
        "  return pick(c, x, 1) + 1;",
        "}",
        "",
      ].join("\n"),
      "--symbol",
      "make",
    );
    assert.match(text, /\n  \(\{ n: x \}\);\n/);
    const comma = await edgeText(
      "declare function sink(x: unknown): void;\nconst both = (a: number, b: number) => (sink(a), b);\nexport function run(x: number) {\n  return both(x, 2) * 2;\n}\n",
      "--symbol",
      "both",
    );
    assert.match(comma, /return \(\(sink\(x\), 2\)\) \* 2;|return \(sink\(x\), 2\) \* 2;/);
    const ternary = await edgeText(
      "const pick = (c: boolean, a: number, b: number) => (c ? a : b);\nexport function run(c: boolean, x: number) {\n  return pick(c, x, 1) + 1;\n}\n",
      "--symbol",
      "pick",
    );
    assert.match(ternary, /return \(\(c \? x : 1\)\) \+ 1;|return \(c \? x : 1\) \+ 1;/);
  });

  test("a numeric literal argument is parenthesized as an object; a negative one as an operand", async () => {
    const text = await edgeText(
      "const show = (n: number) => n.toFixed(1);\nconst neg = (n: number) => 2 ** n;\nexport const a = show(5);\nexport const b = neg(-1);\n",
      "--symbol",
      "show",
    );
    assert.match(text, /export const a = \(5\)\.toFixed\(1\);/);
    const negative = await edgeText(
      "const neg = (n: number) => 2 ** n;\nexport const b = neg(-1) + 1;\n",
      "--symbol",
      "neg",
    );
    assert.match(negative, /2 \*\* \(-1\)/);
  });

  test("shorthand properties get an explicit name", async () => {
    const text = await edgeText(
      "const box = (n: number) => ({ n });\nexport const b = (x: number) => box(x);\n",
      "--symbol",
      "box",
    );
    assert.match(text, /\(x: number\) => \(\{ n: x \}\)/);
    const hoisted = await edgeText(
      "declare function next(): number;\nconst box = (n: number) => ({ n });\nexport function b() {\n  return box(next());\n}\n",
      "--symbol",
      "box",
    );
    assert.match(hoisted, /const n: number = next\(\);\n  return \(\{ n \}\);|const n: number = next\(\);\n  return \{ n \};/);
  });

  test("a mutable identifier argument counts as non-simple (hoisted where possible, refused in the middle of an expression)", async () => {
    const hoisted = await edgeText(
      "const add = (n: number) => n + 1;\nexport function run() {\n  let a = 1;\n  a++;\n  return add(a);\n}\n",
      "--symbol",
      "add",
    );
    assert.match(hoisted, /const n: number = a;\n  return n \+ 1;/);
    const { dir } = await edge(
      "const add = (n: number) => n + 1;\nexport function run() {\n  let a = 1;\n  a++;\n  return 2 * add(a);\n}\n",
      "--symbol",
      "add",
    );
    await refused(dir, "--file", "src/edge.ts", "--symbol", "add");
  });

  test("calls nested in the arguments of another call are refused in definition mode; --at takes the outer one", async () => {
    const source = "const inc = (n: number) => n + 1;\nexport function run(x: number) {\n  const y = inc(inc(x));\n  return y;\n}\n";
    const { dir } = await edge(source, "--symbol", "inc");
    await refused(dir, "--file", "src/edge.ts", "--symbol", "inc");
    const outer = await edgeText(source, "--symbol", "inc", "--at", "src/edge.ts:3:13");
    assert.match(outer, /const n: number = inc\(x\);\n  const y = n \+ 1;/);
  });

  test("an unbraced if body, an arrow body and a template cannot take several statements", async () => {
    const { dir } = await edge(
      [
        "const log: string[] = [];",
        "function note(s: string) {",
        "  const t = s.trim();",
        "  log.push(t);",
        "}",
        "export function run(c: boolean, s: string) {",
        "  if (c) note(s);",
        "  const f = () => note(s);",
        "  return f;",
        "}",
        "",
      ].join("\n"),
      "--symbol",
      "note",
    );
    await refused(dir, "--file", "src/edge.ts", "--symbol", "note");
  });

  test("function expressions, void functions and multi-line template literals", async () => {
    const text = await edgeText(
      [
        "const out: string[] = [];",
        "const emit = function (s: string): void {",
        "  const t = `line one",
        "    line two ${s}`;",
        "  out.push(t);",
        "};",
        "export function run(s: string) {",
        "  if (s) {",
        "    emit(s);",
        "  }",
        "}",
        "",
      ].join("\n"),
      "--symbol",
      "emit",
    );
    // The template literal's own lines keep their content; the statements move to the call's indentation.
    assert.match(text, /\n    const s2: string = s;\n    const t = `line one\n    line two \$\{s2\}`;\n    out\.push\(t\);\n  \}/);
  });

  test("a void function whose result is used is refused", async () => {
    const { dir } = await edge(
      "const out: number[] = [];\nfunction push(n: number): void {\n  out.push(n);\n}\nexport const r = push(1);\n",
      "--symbol",
      "push",
    );
    await refused(dir, "--file", "src/edge.ts", "--symbol", "push");
  });

  test("functions that are not unpackable: generic, default values, reassigned parameter, var, nested function, let", async () => {
    const cases: string[] = [
      "function id<T>(x: T) { return x; }\nexport const a = id(1);\n",
      "function d(x = 1) { return x; }\nexport const a = d();\n",
      "function w(x: number) { x = x + 1; return x; }\nexport const a = w(1);\n",
      "function v(x: number) { var y = x; return y; }\nexport const a = v(1);\n",
      "function n(x: number) { function inner() { return x; } return inner(); }\nexport const a = n(1);\n",
      "let l = (x: number) => x;\nexport const a = l(1);\n",
      "function o(x?: number) { return x; }\nexport const a = o(1);\n",
      "function r(...xs: number[]) { return xs; }\nexport const a = r(1);\n",
      "function p({ a }: { a: number }) { return a; }\nexport const x = p({ a: 1 });\n",
      "const e = () => {};\nexport const a = e();\n",
      "function two(a: number, b: number) { return a + b; }\nexport const x = two(1);\n",
    ];
    for (const source of cases) {
      const symbol = /(?:function|const|let) (\w+)/.exec(source)?.[1] as string;
      const { dir } = await edge(source, "--symbol", symbol);
      await refused(dir, "--file", "src/edge.ts", "--symbol", symbol);
    }
  });

  test("a script (no import/export) and an unused function are refused in definition mode", async () => {
    const script = await edge("function s(x: number) { return x + 1; }\nconst a = s(1);\n", "--symbol", "s");
    await refused(script.dir, "--file", "src/edge.ts", "--symbol", "s");
    const unused = await edge("const u = (x: number) => x;\nexport const a = 1;\n", "--symbol", "u");
    await refused(unused.dir, "--file", "src/edge.ts", "--symbol", "u");
  });

  test("two calls in one block introduce no duplicate names; calls in sibling blocks reuse them", async () => {
    const text = await edgeText(
      [
        "declare function use(n: number): void;",
        "function calc(n: number): number {",
        "  const half = n / 2;",
        "  use(half);",
        "  return half + 1;",
        "}",
        "export function run(x: number, c: boolean) {",
        "  const a = calc(x);",
        "  const b = calc(a);",
        "  if (c) {",
        "    const d = calc(b);",
        "    return d;",
        "  }",
        "  return b;",
        "}",
        "",
      ].join("\n"),
      "--symbol",
      "calc",
    );
    const halves = text.match(/const (half\d*)\b/g);
    assert.equal(new Set(halves).size, halves?.length, text);
  });

  test("a free variable declared later or imported still resolves; a type used by a parameter is checked", async () => {
    const text = await edgeText(
      [
        'import { format } from "./shared";',
        "type Box = { n: number };",
        "const show = (b: Box) => format(b.n);",
        "export function run(b: Box) {",
        "  return show(b);",
        "}",
        "",
      ].join("\n"),
      "--symbol",
      "show",
    );
    assert.match(text, /return format\(b\.n\);/);
    const { dir } = await edge(
      [
        "type Box = { n: number };",
        "const show = (b: Box) => b.n;",
        "export function run(b: { n: number }) {",
        "  type Box = string;",
        "  return show(b);",
        "}",
        "",
      ].join("\n"),
      "--symbol",
      "show",
    );
    await refused(dir, "--file", "src/edge.ts", "--symbol", "show");
  });
});

describe("inline-function: doc comments", () => {
  test("a function declaration keeps its doc comment out of the way: comments attached to it are removed with it", async () => {
    const text = await edgeText(
      "/** Doubles. */\nfunction twice(n: number) {\n  return n * 2;\n}\n\nexport const a = (x: number) => twice(x);\n",
      "--symbol",
      "twice",
    );
    assert.equal(text, "export const a = (x: number) => x * 2;\n");
  });
});

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

  test("a let of a script file (global) is hoisted too", async () => {
    const { dir } = await edge(
      ["let shared = 1;", "declare function bump(): number;", "const f = (n: number) => bump() + n;", "const result = f(shared);", ""].join(
        "\n",
      ),
      "--symbol",
      "f",
      "--at",
      "src/edge.ts:4",
    );
    assertReport(await inline(dir, "--file", "src/edge.ts", "--symbol", "f", "--at", "src/edge.ts:4"));
    const text = (await readTree(dir))["src/edge.ts"] as string;
    assert.match(text, /const n: number = shared;/);
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

  test("a label inside the function that clashes with an enclosing label is refused", async () => {
    const { dir } = await edge(
      [
        "const f = (n: number) => {",
        "  outer: for (let i = 0; i < n; i++) {",
        "    if (i > 1) break outer;",
        "  }",
        "};",
        "export function run() {",
        "  let c = 0;",
        "  outer: for (;;) {",
        "    f(3);",
        "    c++;",
        "    break outer;",
        "  }",
        "  return c;",
        "}",
        "",
      ].join("\n"),
      "--symbol",
      "f",
    );
    await refused(dir, "--file", "src/edge.ts", "--symbol", "f");
  });
});

describe("inline-function: comments and directives", () => {
  test("a @ts-ignore above the final return is not dropped silently", async () => {
    const { dir } = await edge(
      [
        "const f = (n: number) => {",
        "  const m = n + 1;",
        "  // @ts-ignore",
        "  return m * 2;",
        "};",
        "export function run() {",
        "  return f(3);",
        "}",
        "",
      ].join("\n"),
      "--symbol",
      "f",
    );
    await refused(dir, "--file", "src/edge.ts", "--symbol", "f");
    const single = await edge(
      "const f = (n: number) => {\n  // @ts-expect-error\n  return n * 2;\n};\nexport const r = f(3);\n",
      "--symbol",
      "f",
    );
    await refused(single.dir, "--file", "src/edge.ts", "--symbol", "f");
  });

  test("a string literal at the start of a function body does not become a directive", async () => {
    const text = await edgeText(
      ["const label = () => 'use strict';", "export function run() {", "  label();", "  label();", "  return 1;", "}", ""].join("\n"),
      "--symbol",
      "label",
    );
    assert.match(text, /\n {2}\('use strict'\);\n {2}'use strict';\n/);
    const later = await edgeText(
      "const label = () => 'x';\nexport function run() {\n  const a = 1;\n  label();\n  return a;\n}\n",
      "--symbol",
      "label",
    );
    assert.match(later, /\n {2}'x';\n/);
  });
});
