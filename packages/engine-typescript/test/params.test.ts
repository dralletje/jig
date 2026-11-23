import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const paramsToObject = (dir: string, file: string, symbol: string) =>
  main(["params-to-object", "--file", file, "--symbol", symbol], dir);

/** Asserts that the call is refused with `code` and that nothing on disk changed. */
async function refused(dir: string, file: string, symbol: string, code: string): Promise<void> {
  const before = await readTree(dir);
  assert.equal((await rejects(paramsToObject(dir, file, symbol))).code, code);
  assert.deepEqual(await readTree(dir), before);
}

describe("params-to-object on examples/params-to-object", () => {
  test("a function with three params called from two files: declaration and calls are rewritten", async () => {
    const dir = await workspace("examples/params-to-object");
    const before = await readTree(dir);
    assertReport(await paramsToObject(dir, "src/shipping.ts", "shippingCost"));
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/checkout.ts", "src/reports.ts", "src/shipping.ts"]);
    assert.match(
      after["src/shipping.ts"] ?? "",
      /export function shippingCost\(\{ weightKg, distanceKm, express \}: \{\s*weightKg: number;\s*distanceKm: number;\s*express: boolean;\s*\}\): number \{/,
    );
    assert.equal(
      after["src/checkout.ts"],
      before["src/checkout.ts"]
        ?.replace("shippingCost(weightKg, distanceKm, false)", "shippingCost({ weightKg, distanceKm, express: false })")
        .replace("shippingCost(weightKg, distanceKm, true)", "shippingCost({ weightKg, distanceKm, express: true })"),
    );
    assert.equal(
      after["src/reports.ts"],
      before["src/reports.ts"]?.replace("shippingCost(w, 120, false)", "shippingCost({ weightKg: w, distanceKm: 120, express: false })"),
    );
    assert.deepEqual(await errors(dir, "src/checkout.ts"), []);
  });

  test("optional and default parameters stay optional, with their defaults", async () => {
    const dir = await workspace("examples/params-to-object");
    const before = await readTree(dir);
    await paramsToObject(dir, "src/shipping.ts", "parcelLabel");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/checkout.ts", "src/reports.ts", "src/shipping.ts"]);
    assert.match(
      after["src/shipping.ts"] ?? "",
      /export function parcelLabel\(\{ name, prefix = "#", suffix \}: \{\s*name: string;\s*prefix\?: string;\s*suffix\?: string;\s*\}\): string \{/,
    );
    assert.ok(after["src/checkout.ts"]?.includes('parcelLabel({ name: "order" })'));
    assert.ok(after["src/reports.ts"]?.includes('parcelLabel({ name: "w", prefix: "[", suffix: "]" })'));
    assert.deepEqual(await errors(dir, "src/reports.ts"), []);
  });

  test("a const arrow function works too", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/area.ts": "export const area = (width: number, height: number): number => width * height;\n",
      "src/use-area.ts": 'import { area } from "./area";\n\nexport const big = area(10, 20);\n',
    });
    await paramsToObject(dir, "src/area.ts", "area");
    const after = await readTree(dir);
    assert.ok(after["src/use-area.ts"]?.includes("area({ width: 10, height: 20 })"));
    assert.deepEqual(await errors(dir, "src/use-area.ts"), []);
  });

  test("a local `export { f }` is not a blocking use; the function and its calls are converted", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/sum.ts": "function sum(a: number, b: number): number {\n  return a + b;\n}\n\nexport { sum };\nexport const three = sum(1, 2);\n",
    });
    await paramsToObject(dir, "src/sum.ts", "sum");
    const after = await readTree(dir);
    assert.ok(after["src/sum.ts"]?.includes("export { sum };"));
    assert.ok(after["src/sum.ts"]?.includes("sum({ a: 1, b: 2 })"));
  });

  test("a function used as a callback value is refused", async () => {
    await refused(await workspace("examples/params-to-object"), "src/shipping.ts", "notify", "REFACTOR_UNAVAILABLE");
  });

  test("overloads are refused", async () => {
    await refused(await workspace("examples/params-to-object"), "src/shipping.ts", "parseWeight", "REFACTOR_UNAVAILABLE");
  });

  test("a rest parameter is refused", async () => {
    await refused(await workspace("examples/params-to-object"), "src/shipping.ts", "totalWeight", "REFACTOR_UNAVAILABLE");
  });

  test("a function without parameters, a non-function and a missing symbol are refused", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/none.ts": "export function none(): number {\n  return 1;\n}\n",
      "src/limits.ts": "export const limit = 10;\n",
    });
    await refused(dir, "src/none.ts", "none", "REFACTOR_UNAVAILABLE");
    await refused(dir, "src/limits.ts", "limit", "REFACTOR_UNAVAILABLE");
    await refused(dir, "src/shipping.ts", "Zone", "SYMBOL_NOT_FOUND");
    await refused(dir, "src/shipping.ts", "nope", "SYMBOL_NOT_FOUND");
  });

  test("a call TypeScript cannot rewrite (a spread argument) is refused", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/pair.ts": "export function pair(left: string, right: string): string {\n  return left + right;\n}\n",
      "src/use-pair.ts": "import { pair } from \"./pair\";\n\nconst args: [string, string] = [\"a\", \"b\"];\nexport const joined = pair(...args);\n",
    });
    await refused(dir, "src/pair.ts", "pair", "REFACTOR_UNAVAILABLE");
  });

  test("a destructured parameter is refused", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/point.ts": "export function dist({ x, y }: { x: number; y: number }, scale: number): number {\n  return (x + y) * scale;\n}\n",
    });
    await refused(dir, "src/point.ts", "dist", "REFACTOR_UNAVAILABLE");
  });
});
