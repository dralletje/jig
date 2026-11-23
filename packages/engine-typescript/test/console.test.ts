import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const removeConsole = (dir: string, files: string, methods?: string) =>
  main(["remove-console", "--files", files, ...(methods ? ["--methods", methods] : [])], dir);

async function run(files: Record<string, string>, methods?: string) {
  const dir = await workspace("examples/remove-console", files);
  await removeConsole(dir, "src/**", methods);
  return { dir, tree: await readTree(dir) };
}

describe("remove-console on examples/remove-console", () => {
  test("console.log statements go, other methods stay, calls used as values are left", async () => {
    const dir = await workspace("examples/remove-console");
    const before = await readTree(dir);
    await removeConsole(dir, "src/orders.ts");
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
    assert.deepEqual(await errors(dir, "src/orders.ts"), []);
  });

  test("--methods log,debug covers both", async () => {
    const { tree } = await run({}, "log,debug");
    const orders = tree["src/orders.ts"] ?? "";
    assert.ok(!orders.includes("console.debug"));
    assert.ok(orders.includes("console.warn"));
    assert.ok(!orders.includes('console.log("processing"'));
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
    const { dir, tree } = await run({});
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
    assert.deepEqual(await errors(dir, "src/guards.ts"), []);
  });


  test("statements sharing a blank line are all removed", async () => {
    const src = "export function f(n: number): number {\n  console.log(1);\n\n  console.log(2);\n}\n";
    const { tree } = await run({ "src/shared.ts": src });
    assert.equal(tree["src/shared.ts"], "export function f(n: number): number {\n}\n");
  });

  test("adjacent removed statements with blank lines around leave no double blank line", async () => {
    const src = "export function f(n: number): number {\n  const a = n;\n\n  console.log(1);\n  console.log(2);\n\n  return a;\n}\n";
    const { tree } = await run({ "src/adj.ts": src });
    assert.equal(tree["src/adj.ts"], "export function f(n: number): number {\n  const a = n;\n\n  return a;\n}\n");
  });

  test("when every call is a value, it is NO_CHANGES", async () => {
    const dir = await workspace("examples/remove-console", {
      "src/values.ts": "export const a = (m: string) => console.log(m);\nexport const b = (m: string) => console.log(m + 1);\n",
    });
    const before = await readTree(dir);
    const e = await rejects(removeConsole(dir, "src/values.ts"));
    assert.equal(e.code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), before);
  });

  test("a second run changes nothing", async () => {
    const { dir, tree } = await run({});
    const e = await rejects(removeConsole(dir, "src/**"));
    assert.equal(e.code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), tree);
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
