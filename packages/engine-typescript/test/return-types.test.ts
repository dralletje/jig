import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const infer = (dir: string, files: string, ...extra: string[]) =>
  main(["infer-return-types", "--files", files, ...extra], dir);

describe("infer-return-types on examples/infer-return-types", () => {
  test("exported functions and methods gain the inferred types; the rest is left as it is", async () => {
    const dir = await workspace("examples/infer-return-types");
    const before = await readTree(dir);
    assertReport(await infer(dir, "src/**"));
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/orders.ts", "src/reports.ts"]);

    const orders = after["src/orders.ts"] ?? "";
    assert.ok(orders.includes("export function countLines(order: Order): number {"));
    assert.ok(orders.includes("export const skus = (order: Order): string[] => order.lines.map"));
    assert.ok(orders.includes("  find(id: string): Order | undefined {"));
    // Not exported: untouched.
    assert.ok(orders.includes("function normalize(sku: string) {"));
    assert.ok(orders.includes("const double = (n: number) => n * 2;"));
    assert.ok(orders.includes("  private count() {"));
    assert.deepEqual(await errors(dir, "src/orders.ts"), []);
    // A type that would need an import, and an `any` nobody wrote, are not written down.
    assert.ok(orders.includes("export function singleLine(sku: string) {"));
    assert.ok(after["src/reports.ts"]?.includes("export function firstLine(skus: string[]) {"));
    assert.equal(after["src/loader.ts"], before["src/loader.ts"]);
  });

  test("a second run has nothing left to annotate", async () => {
    const dir = await workspace("examples/infer-return-types");
    await infer(dir, "src/**");
    const once = await readTree(dir);
    assert.equal((await rejects(infer(dir, "src/**"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), once);
  });

  test("--exported-only false includes functions that are not exported", async () => {
    const dir = await workspace("examples/infer-return-types");
    await infer(dir, "src/orders.ts", "--exported-only", "false");
    const orders = (await readTree(dir))["src/orders.ts"] ?? "";
    assert.ok(orders.includes("function normalize(sku: string): string {"));
    assert.ok(orders.includes("const double = (n: number): number => n * 2;"));
    assert.ok(orders.includes("  private count(): number {"));
    assert.ok(orders.includes("export function countLines(order: Order): number {"));
    assert.deepEqual(await errors(dir, "src/orders.ts"), []);
  });

  test("--files limits the sweep", async () => {
    const dir = await workspace("examples/infer-return-types");
    const before = await readTree(dir);
    await infer(dir, "src/reports.ts");
    assert.deepEqual(changed(before, await readTree(dir)), ["src/reports.ts"]);
  });

  test("functions exported by name later, and default exports, count as exported", async () => {
    const dir = await workspace("examples/infer-return-types", {
      "src/late.ts": "function late() {\n  return 1;\n}\nfunction hidden() {\n  return 2;\n}\nexport { late as renamed };\nexport default function () {\n  return 'x';\n}\n",
    });
    await infer(dir, "src/late.ts");
    assert.equal(
      (await readTree(dir))["src/late.ts"],
      "function late(): number {\n  return 1;\n}\nfunction hidden() {\n  return 2;\n}\nexport { late as renamed };\nexport default function (): string {\n  return 'x';\n}\n",
    );
  });

  test("no function to annotate is NO_CHANGES; a bad --exported-only is INVALID_ARGS", async () => {
    const dir = await workspace("examples/infer-return-types");
    const before = await readTree(dir);
    assert.equal((await rejects(infer(dir, "src/models.ts"))).code, "NO_CHANGES");
    assert.equal((await rejects(infer(dir, "src/**", "--exported-only", "maybe"))).code, "INVALID_ARGS");
    assert.equal((await rejects(infer(dir, "nothing/**"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), before);
  });

  test("a function whose inferred type names something not in scope is left; the others proceed", async () => {
    const dir = await workspace("examples/infer-return-types", {
      "src/scope.ts":
        "export function good(): number {\n  return 1;\n}\nexport function outer() {\n  interface Hidden {\n    a: number;\n  }\n  const make = () => {\n    const h: Hidden = { a: 1 };\n    return h;\n  };\n  return make;\n}\nexport function fine() {\n  return 'x';\n}\n",
    });
    await infer(dir, "src/scope.ts");
    const text = (await readTree(dir))["src/scope.ts"] ?? "";
    assert.ok(text.includes("export function outer() {"));
    assert.ok(text.includes("export function fine(): string {"));
    assert.deepEqual(await errors(dir, "src/scope.ts"), []);
  });

  test("a type that needs an unexported interface of another file does not block the file", async () => {
    const dir = await workspace("examples/infer-return-types", {
      "src/hidden.ts": "interface Hidden {\n  a: number;\n}\nexport const make = (): Hidden => ({ a: 1 });\n",
      "src/user.ts": "import { make } from './hidden.ts';\nexport function viaHidden() {\n  return make();\n}\nexport function plain() {\n  return 2;\n}\n",
    });
    await infer(dir, "src/user.ts");
    const text = (await readTree(dir))["src/user.ts"] ?? "";
    assert.ok(text.includes("export function viaHidden() {"));
    assert.ok(text.includes("export function plain(): number {"));
    assert.deepEqual(await errors(dir, "src/user.ts"), []);
  });

  test("object-literal methods and get accessors are candidates", async () => {
    const dir = await workspace("examples/infer-return-types", {
      "src/obj.ts":
        "export const api = {\n  count() {\n    return 1;\n  },\n  get label() {\n    return 'x';\n  },\n};\nconst local = {\n  hidden() {\n    return 2;\n  },\n};\nexport class K {\n  get size() {\n    return 3;\n  }\n}\nexport default local;\n",
    });
    await infer(dir, "src/obj.ts");
    const text = (await readTree(dir))["src/obj.ts"] ?? "";
    assert.ok(text.includes("  count(): number {"));
    assert.ok(text.includes("  get label(): string {"));
    assert.ok(text.includes("  get size(): number {"));
    assert.ok(text.includes("  hidden(): number {"));
    assert.deepEqual(await errors(dir, "src/obj.ts"), []);
  });
});
