import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const infer = (dir: string, files: string, ...extra: string[]) =>
  main(["infer-return-types", "--files", files, ...extra], dir);

/** The `function: type` lines the summary lists under its first line, by function. */
function types(ok: OkReport): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of ok.summary.split("\n").slice(1)) {
    if (!line.startsWith("  ")) break;
    const at = line.indexOf(": ");
    out[line.slice(2, at)] = line.slice(at + 2);
  }
  return out;
}

describe("infer-return-types on examples/infer-return-types", () => {
  test("exported functions and methods gain the inferred types; the rest is skipped or listed", async () => {
    const dir = await workspace("examples/infer-return-types");
    const before = await readTree(dir);
    const report = await infer(dir, "src/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.subject, "sweep(typescript infer-return-types): src/**");
    assert.equal(ok.kind, "sweep");
    assert.deepEqual(types(ok), {
      "src/orders.ts#OrderService.add": "number",
      "src/orders.ts#OrderService.find": "Order | undefined",
      "src/orders.ts#OrderService.ids": "string[]",
      "src/orders.ts#countLines": "number",
      "src/orders.ts#describe": "{ id: string; lines: number; empty: boolean; }",
      "src/orders.ts#emptyOrder": "Order",
      "src/orders.ts#internalUse": "number",
      "src/orders.ts#skus": "string[]",
      "src/orders.ts#summarize": "string",
      "src/orders.ts#totalQuantity": "number",
      "src/reports.ts#pageSize": "number",
    });
    assert.match(ok.summary, /^Added the inferred return type to 11 functions in 2 files:\n/);
    assert.deepEqual(changed(before, await readTree(dir)), ["src/orders.ts", "src/reports.ts"]);

    const orders = (await readTree(dir))["src/orders.ts"] ?? "";
    assert.ok(orders.includes("export function countLines(order: Order): number {"));
    assert.ok(orders.includes("export const skus = (order: Order): string[] => order.lines.map"));
    assert.ok(orders.includes("  find(id: string): Order | undefined {"));
    // Not exported: untouched.
    assert.ok(orders.includes("function normalize(sku: string) {"));
    assert.ok(orders.includes("const double = (n: number) => n * 2;"));
    assert.ok(orders.includes("  private count() {"));
    assert.deepEqual(await errors(dir, "src/orders.ts"), []);

    // Not handled: an `any` nobody wrote, and types that would need an import.
    const skipped = ok.summary.slice(ok.summary.indexOf("\nNot handled"));
    assert.deepEqual(
      skipped.split("\n").filter((l) => /^ {2}\S/.test(l) || l.startsWith("Not handled")),
      [
        "Not handled (3):",
        "  src/loader.ts:1: its inferred return type contains an `any` that nobody wrote",
        "  src/orders.ts:22: its inferred return type needs an import",
        "  src/reports.ts:3: its inferred return type needs an import",
      ],
    );
    assert.match(skipped, /\n {2}src\/orders\.ts:22: [^\n]*\n {4}Write the return type of the function by hand \(TypeScript infers `[^`]*import\("\.\/models\.ts"\)\.Line/);
    assert.equal((await readTree(dir))["src/loader.ts"], before["src/loader.ts"]);
  });

  test("a second run has nothing left to annotate", async () => {
    const dir = await workspace("examples/infer-return-types");
    await infer(dir, "src/**");
    const error = await rejects(infer(dir, "src/**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.match(error.message, /src\/loader\.ts#parseOrder/);
  });

  test("--exported-only false includes functions that are not exported", async () => {
    const dir = await workspace("examples/infer-return-types");
    const ok = (await infer(dir, "src/orders.ts", "--exported-only", "false")) as OkReport;
    assertReport(ok);
    assert.equal(ok.subject, "sweep(typescript infer-return-types): src/orders.ts (including functions that are not exported)");
    const found = types(ok);
    assert.equal(found["src/orders.ts#normalize"], "string");
    assert.equal(found["src/orders.ts#double"], "number");
    assert.equal(found["src/orders.ts#OrderService.count"], "number");
    assert.equal(found["src/orders.ts#countLines"], "number");
    const orders = (await readTree(dir))["src/orders.ts"] ?? "";
    assert.ok(orders.includes("function normalize(sku: string): string {"));
    assert.ok(orders.includes("const double = (n: number): number => n * 2;"));
    assert.ok(orders.includes("  private count(): number {"));
    assert.deepEqual(await errors(dir, "src/orders.ts"), []);
  });

  test("--files limits the sweep", async () => {
    const dir = await workspace("examples/infer-return-types");
    const before = await readTree(dir);
    const ok = (await infer(dir, "src/reports.ts")) as OkReport;
    assertReport(ok);
    assert.deepEqual(Object.keys(types(ok)), ["src/reports.ts#pageSize"]);
    assert.deepEqual(changed(before, await readTree(dir)), ["src/reports.ts"]);
  });

  test("functions exported by name later, and default exports, count as exported", async () => {
    const dir = await workspace("examples/infer-return-types", {
      "src/late.ts": "function late() {\n  return 1;\n}\nfunction hidden() {\n  return 2;\n}\nexport { late as renamed };\nexport default function () {\n  return 'x';\n}\n",
    });
    const ok = (await infer(dir, "src/late.ts")) as OkReport;
    assertReport(ok);
    assert.deepEqual(types(ok), { "src/late.ts#late": "number", "src/late.ts#default": "string" });
    const late = (await readTree(dir))["src/late.ts"] ?? "";
    assert.ok(late.includes("function hidden() {"));
  });

  test("the annotated functions stay the same when code moves above them; skipped places give their current line", async () => {
    const plain = await workspace("examples/infer-return-types");
    const moved = await workspace("examples/infer-return-types");
    const original = (await readTree(moved))["src/orders.ts"] ?? "";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${moved}/src/orders.ts`, `// a\n// b\nexport const unrelated = [1, 2, 3];\n\n${original}`);
    const a = (await infer(plain, "src/**")) as OkReport;
    const b = (await infer(moved, "src/**")) as OkReport;
    assert.deepEqual(types(b), types(a));
    assert.match(a.summary, /\n {2}src\/orders\.ts:22: its inferred return type needs an import\n/);
    assert.match(b.summary, /\n {2}src\/orders\.ts:26: its inferred return type needs an import\n/);
  });

  test("no function to annotate is NO_CHANGES; a bad --exported-only is INVALID_ARGS", async () => {
    const dir = await workspace("examples/infer-return-types");
    assert.equal((await rejects(infer(dir, "src/models.ts"))).code, "NO_CHANGES");
    assert.equal((await rejects(infer(dir, "src/**", "--exported-only", "maybe"))).code, "INVALID_ARGS");
    assert.equal((await rejects(infer(dir, "nothing/**"))).code, "NO_CHANGES");
  });

  test("a function whose inferred type names something not in scope is not handled; the others proceed", async () => {
    const dir = await workspace("examples/infer-return-types", {
      "src/scope.ts":
        "export function good(): number {\n  return 1;\n}\nexport function outer() {\n  interface Hidden {\n    a: number;\n  }\n  const make = () => {\n    const h: Hidden = { a: 1 };\n    return h;\n  };\n  return make;\n}\nexport function fine() {\n  return 'x';\n}\n",
    });
    const ok = (await infer(dir, "src/scope.ts")) as OkReport;
    assertReport(ok);
    assert.deepEqual(types(ok), { "src/scope.ts#fine": "string" });
    assert.match(
      ok.summary,
      /\n\nNot handled \(1\):\n {2}src\/scope\.ts:4: its inferred type names `Hidden`, which is not in scope here\n {4}Write the return type of the function by hand [^\n]*$/,
    );
    assert.deepEqual(await errors(dir, "src/scope.ts"), []);
    assert.ok(((await readTree(dir))["src/scope.ts"] ?? "").includes("export function fine(): string {"));
  });

  test("a type that needs an unexported interface of another file does not block the file", async () => {
    const dir = await workspace("examples/infer-return-types", {
      "src/hidden.ts": "interface Hidden {\n  a: number;\n}\nexport const make = (): Hidden => ({ a: 1 });\n",
      "src/user.ts": "import { make } from './hidden.ts';\nexport function viaHidden() {\n  return make();\n}\nexport function plain() {\n  return 2;\n}\n",
    });
    const ok = (await infer(dir, "src/user.ts")) as OkReport;
    assertReport(ok);
    assert.deepEqual(types(ok), { "src/user.ts#plain": "number" });
    assert.match(ok.summary, /\n\nNot handled \(1\):\n {2}src\/user\.ts:2: /);
    assert.deepEqual(await errors(dir, "src/user.ts"), []);
  });

  test("object-literal methods and get accessors are candidates", async () => {
    const dir = await workspace("examples/infer-return-types", {
      "src/obj.ts":
        "export const api = {\n  count() {\n    return 1;\n  },\n  get label() {\n    return 'x';\n  },\n};\nconst local = {\n  hidden() {\n    return 2;\n  },\n};\nexport class K {\n  get size() {\n    return 3;\n  }\n}\nexport default local;\n",
    });
    const ok = (await infer(dir, "src/obj.ts")) as OkReport;
    assertReport(ok);
    assert.deepEqual(types(ok), {
      "src/obj.ts#api.count": "number",
      "src/obj.ts#api.get label": "string",
      "src/obj.ts#K.get size": "number",
      "src/obj.ts#local.hidden": "number",
    });
    const text = (await readTree(dir))["src/obj.ts"] ?? "";
    assert.ok(text.includes("  count(): number {"));
    assert.ok(text.includes("  get label(): string {"));
    assert.ok(text.includes("  get size(): number {"));
    assert.deepEqual(await errors(dir, "src/obj.ts"), []);
  });
});
