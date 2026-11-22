import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const paramsToObject = (dir: string, file: string, symbol: string) =>
  main(["params-to-object", "--file", file, "--symbol", symbol], dir);

describe("params-to-object on examples/params-to-object", () => {
  test("the example type-checks to begin with", async () => {
    const dir = await workspace("examples/params-to-object");
    assert.deepEqual(await errors(dir, "src/shipping.ts"), []);
  });

  test("a function with three params called from two files: declaration and calls are rewritten", async () => {
    const dir = await workspace("examples/params-to-object");
    const before = await readTree(dir);
    const report = await paramsToObject(dir, "src/shipping.ts", "shippingCost");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.subject, "refactor(params-to-object): shippingCost in src/shipping.ts");
    assert.equal(ok.kind, "refactor");
    assert.equal(
      ok.summary,
      "Changed `shippingCost` in src/shipping.ts from 3 positional parameters (weightKg, distanceKm, express) to one destructured object parameter, and rewrote 3 calls to pass an object.",
    );

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
    const ok = (await paramsToObject(dir, "src/shipping.ts", "parcelLabel")) as OkReport;
    assertReport(ok);
    assert.match(ok.summary, /^Changed `parcelLabel` in src\/shipping\.ts from 3 positional parameters \(name, prefix, suffix\) to one destructured object parameter, and rewrote 2 calls/);
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
    const ok = (await paramsToObject(dir, "src/area.ts", "area")) as OkReport;
    assertReport(ok);
    assert.match(ok.summary, /^Changed `area` in src\/area\.ts from 2 positional parameters \(width, height\) to one destructured object parameter, and rewrote 1 call/);
    const after = await readTree(dir);
    assert.ok(after["src/use-area.ts"]?.includes("area({ width: 10, height: 20 })"));
    assert.deepEqual(await errors(dir, "src/use-area.ts"), []);
  });

  test("a function used as a callback value is refused, naming the use, and nothing changes", async () => {
    const dir = await workspace("examples/params-to-object");
    const before = await readTree(dir);
    const err = await rejects(paramsToObject(dir, "src/shipping.ts", "notify"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.match(err.message, /`notify` is used other than as a direct call .* at src\/jobs\.ts:4,/);
    assert.match(err.message, /Wrap each in an arrow function/);
    assert.deepEqual(await readTree(dir), before);
  });

  test("overloads are refused", async () => {
    const dir = await workspace("examples/params-to-object");
    const err = await rejects(paramsToObject(dir, "src/shipping.ts", "parseWeight"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.match(err.message, /`parseWeight` in src\/shipping\.ts is overloaded \(3 declarations\)/);
    assert.match(err.message, /Merge the overloads into one signature/);
  });

  test("a rest parameter is refused", async () => {
    const dir = await workspace("examples/params-to-object");
    const err = await rejects(paramsToObject(dir, "src/shipping.ts", "totalWeight"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.match(err.message, /`totalWeight` in src\/shipping\.ts has a rest parameter/);
  });

  test("a function without parameters, a non-function and a missing symbol are refused", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/none.ts": "export function none(): number {\n  return 1;\n}\n",
    });
    const noParams = await rejects(paramsToObject(dir, "src/none.ts", "none"));
    assert.equal(noParams.code, "REFACTOR_UNAVAILABLE");
    assert.match(noParams.message, /has no parameters to convert/);
    const notFunction = await rejects(paramsToObject(dir, "src/shipping.ts", "Zone"));
    assert.equal(notFunction.code, "SYMBOL_NOT_FOUND");
    const missing = await rejects(paramsToObject(dir, "src/shipping.ts", "nope"));
    assert.equal(missing.code, "SYMBOL_NOT_FOUND");
  });

  test("a variable that is not a function is refused", async () => {
    const dir = await workspace("examples/params-to-object", { "src/limits.ts": "export const limit = 10;\n" });
    const err = await rejects(paramsToObject(dir, "src/limits.ts", "limit"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.match(err.message, /not a function declaration or a const arrow function/);
  });

  test("a call TypeScript cannot rewrite (a spread argument) is refused and nothing changes", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/pair.ts": "export function pair(left: string, right: string): string {\n  return left + right;\n}\n",
      "src/use-pair.ts": "import { pair } from \"./pair\";\n\nconst args: [string, string] = [\"a\", \"b\"];\nexport const joined = pair(...args);\n",
    });
    const before = await readTree(dir);
    const err = await rejects(paramsToObject(dir, "src/pair.ts", "pair"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.deepEqual(await readTree(dir), before);
  });

  test("a local `export { f }` is not a blocking use; the function and its calls are converted", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/sum.ts": "function sum(a: number, b: number): number {\n  return a + b;\n}\n\nexport { sum };\nexport const three = sum(1, 2);\n",
    });
    const ok = (await paramsToObject(dir, "src/sum.ts", "sum")) as OkReport;
    assertReport(ok);
    assert.match(ok.summary, /^Changed `sum` in src\/sum\.ts from 2 positional parameters \(a, b\) to one destructured object parameter, and rewrote 1 call/);
    const after = await readTree(dir);
    assert.ok(after["src/sum.ts"]?.includes("export { sum };"));
    assert.ok(after["src/sum.ts"]?.includes("sum({ a: 1, b: 2 })"));
  });

  test("a destructured parameter is refused with the real reason", async () => {
    const dir = await workspace("examples/params-to-object", {
      "src/point.ts": "export function dist({ x, y }: { x: number; y: number }, scale: number): number {\n  return (x + y) * scale;\n}\n",
    });
    const before = await readTree(dir);
    const err = await rejects(paramsToObject(dir, "src/point.ts", "dist"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.match(err.message, /`dist` in src\/point\.ts has a destructured parameter/);
    assert.match(err.message, /plain names|named one/);
    assert.deepEqual(await readTree(dir), before);
  });
});
