import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const removeConsole = (dir: string, files: string, methods?: string) =>
  main(["remove-console", "--files", files, ...(methods ? ["--methods", methods] : [])], dir);

async function run(files: Record<string, string>, methods?: string) {
  const dir = await workspace("examples/remove-console", files);
  const report = await removeConsole(dir, "src/**", methods);
  assertReport(report);
  return { dir, report: report as OkReport, tree: await readTree(dir) };
}

describe("remove-console on examples/remove-console", () => {
  test("console.log statements go, other methods stay, values are listed as not handled", async () => {
    const dir = await workspace("examples/remove-console");
    const before = await readTree(dir);
    const report = await removeConsole(dir, "src/orders.ts");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.subject, "rewrite(typescript remove-console): console.log in src/orders.ts");
    assert.equal(ok.kind, "rewrite");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/orders.ts"]);
    assert.equal(
      after["src/orders.ts"],
      `export type Order = { id: string; total: number };

export function process(order: Order): number {
  const tax = order.total * 0.2;

  console.debug("tax", tax); // temporary

  // keep the rounding rule in one place
  const rounded = Math.round(tax * 100) / 100;
  console.warn("rounded", rounded);
  return order.total + rounded;
}

export function summarize(orders: Order[]): number {
  return orders.reduce((sum, order) => {
    return sum + order.total;
  }, 0);
}

export const trace = (message: string) => console.log(message);

export function describe(order: Order): string {
  const logged = console.log("describing", order.id);
  void logged;
  return \`order \${order.id}\`;
}
`,
    );
    assert.equal(
      ok.summary,
      [
        "Removed 2 console calls from 1 file, and left 2 calls used as values:",
        "  src/orders.ts",
        "",
        "Not handled (2):",
        "  src/orders.ts:20: console.log(…) is used as a value here, so it was left",
        "    Its result is used, so deleting the call would change the code around it.",
        "    Rewrite that code by hand, then remove the call.",
        "  src/orders.ts:23: console.log(…) is used as a value here, so it was left",
        "    Its result is used, so deleting the call would change the code around it.",
        "    Rewrite that code by hand, then remove the call.",
      ].join("\n"),
    );
    assert.deepEqual(await errors(dir, "src/orders.ts"), []);
  });

  test("--methods log,debug covers both", async () => {
    const { report, tree } = await run({}, "log,debug");
    assert.equal(report.subject, "rewrite(typescript remove-console): console.log, console.debug in src/**");
    const orders = tree["src/orders.ts"] ?? "";
    assert.ok(!orders.includes("console.debug"));
    assert.ok(orders.includes("console.warn"));
    assert.ok(!orders.includes('console.log("processing"'));
    assert.match(report.summary, /^Removed 14 console calls from 3 files, and left 2 calls used as values:\n/);
    // The debug line sat between blank lines: one blank line is left, not two.
    assert.ok(orders.includes(`const tax = order.total * 0.2;\n\n  // keep the rounding rule in one place\n`));
  });

  test("comments on the removed line go with it; own-line comments stay; no stray blank lines", async () => {
    const { tree } = await run({});
    assert.equal(
      tree["src/lines.ts"],
      `export function lines(ids: string[]): string {
  let out = "";

  for (const id of ids) {
    out += id;
  }

  out += "!";

  return out;
}
`,
    );
  });

  test("a brace-less if: whole if when the condition is pure and there is no else, else {}", async () => {
    const { dir, report, tree } = await run({});
    assert.equal(
      tree["src/guards.ts"],
      `let calls = 0;

function next(): number {
  calls += 1;
  return calls;
}

export function pureGuard(verbose: boolean, id: string): string {
  return id;
}

export function guardWithElse(verbose: boolean, id: string): string {
  if (verbose) {}
  else id = id.trim();
  return id;
}

export function sideEffectGuard(id: string): string {
  if (next() > 1) {}
  return id;
}

export function loop(ids: string[]): void {
  for (const id of ids) {}
  while (next() < 3) {}
}
`,
    );
    assert.match(report.summary, /\n\nNot handled \(2\):\n/);
    assert.deepEqual(await errors(dir, "src/guards.ts"), []);
  });


  test("statements sharing a blank line are all removed, a second run is a no-op", async () => {
    const src = "export function f(n: number): number {\n  console.log(1);\n\n  console.log(2);\n}\n";
    const { dir, tree } = await run({ "src/shared.ts": src });
    const out = tree["src/shared.ts"] ?? "";
    assert.ok(!out.includes("console.log"), out);
    assert.equal(out, "export function f(n: number): number {\n}\n");
    assert.equal((out.match(/console\./g) ?? []).length, 0);
    const again = await rejects(removeConsole(dir, "src/shared.ts"));
    assert.equal(again.code, "NO_CHANGES");
  });

  test("one call left as a value: the summary names its place and what to do", async () => {
    const dir = await workspace("examples/remove-console", {
      "src/a.ts": 'export function f(): void {\n  void 0;\n  const x = console.log("kept");\n  console.log("go");\n  void x;\n}\n',
    });
    const report = await removeConsole(dir, "src/a.ts");
    assertReport(report);
    const summary = (report as OkReport).summary;
    assert.match(summary, /left 1 call used as a value:/);
    assert.match(summary, /\n\nNot handled \(1\):\n {2}src\/a\.ts:3: console\.log\(…\) is used as a value here, so it was left\n/);
    assert.match(summary, /\n {4}Rewrite that code by hand, then remove the call\.$/);
  });

  test("adjacent removed statements with blank lines around leave no double blank line", async () => {
    const src = "export function f(n: number): number {\n  const a = n;\n\n  console.log(1);\n  console.log(2);\n\n  return a;\n}\n";
    const { tree } = await run({ "src/adj.ts": src });
    assert.equal(tree["src/adj.ts"], "export function f(n: number): number {\n  const a = n;\n\n  return a;\n}\n");
  });

  test("when every call is a value, NO_CHANGES lists each as a miss with its reason", async () => {
    const dir = await workspace("examples/remove-console", {
      "src/values.ts": "export const a = (m: string) => console.log(m);\nexport const b = (m: string) => console.log(m + 1);\n",
    });
    const e = await rejects(removeConsole(dir, "src/values.ts"));
    assert.equal(e.code, "NO_CHANGES");
    assert.match(e.instructions, /src\/values\.ts:1: console\.log\(…\) is used as a value here, so it was left/);
    assert.match(e.instructions, /src\/values\.ts:2: console\.log\(…\) is used as a value here, so it was left/);
  });

  test("a second run changes nothing", async () => {
    const { dir } = await run({});
    const e = await rejects(removeConsole(dir, "src/**"));
    assert.equal(e.code, "NO_CHANGES");
    assert.match(e.instructions, /used as values/);
  });

  test("a console that is not the global one is left alone", async () => {
    const { tree } = await run({
      "src/own.ts": `export function f(console: { log(x: string): void }): void {\n  console.log("mine");\n}\n`,
    });
    assert.equal(tree["src/own.ts"], `export function f(console: { log(x: string): void }): void {\n  console.log("mine");\n}\n`);
  });

  test("else-if branches and nested ifs keep valid syntax", async () => {
    const { dir, tree } = await run({
      "src/chain.ts": `export function f(a: boolean, b: boolean): void {\n  if (a) console.log(1);\n  else if (b) console.log(2);\n  if (a) if (b) console.log(3);\n}\n`,
    });
    assert.equal(
      tree["src/chain.ts"],
      `export function f(a: boolean, b: boolean): void {\n  if (a) {}\n  else {}\n}\n`,
    );
    assert.deepEqual(await errors(dir, "src/chain.ts"), []);
  });

  test("a removal that would introduce an error refuses and writes nothing", async () => {
    const dir = await workspace("examples/remove-console", {
      "tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "noUnusedLocals": true, "lib": ["esnext", "dom"], "types": [] }, "include": ["src"] }\n`,
      "src/unused.ts": `export function f(): void {\n  const x = 1;\n  console.log(x);\n}\n`,
    });
    const before = await readTree(dir);
    const e = await rejects(removeConsole(dir, "src/unused.ts"));
    assert.equal(e.code, "REFACTOR_UNAVAILABLE");
    assert.match(e.instructions, /would introduce errors: TS6133/);
    assert.deepEqual(await readTree(dir), before);
  });

  test("a line whose statements are all removed does not stay behind as spaces", async () => {
    const { tree } = await run({
      "src/line.ts": "export function f(): number {\n  console.log(1); console.log(2);\n  return 1;\n}\n",
    });
    assert.equal(tree["src/line.ts"], "export function f(): number {\n  return 1;\n}\n");
    assert.ok(!/^[ \t]+$/m.test(tree["src/line.ts"] as string));
  });

  test("bad arguments", async () => {
    const dir = await workspace("examples/remove-console");
    assert.equal((await rejects(removeConsole(dir, "src/**", "lo g"))).code, "INVALID_ARGS");
    assert.equal((await rejects(removeConsole(dir, "nothing/**"))).code, "NO_CHANGES");
  });
});
