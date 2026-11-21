import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const toNamed = (dir: string, files: string) => main(["typescript-namespace-to-named", "--files", files], dir);
const importType = (dir: string, files: string) => main(["typescript-import-type", "--files", files], dir);

describe("typescript-namespace-to-named on examples/import-shapes", () => {
  test("converts `x.name` uses, renames clashes, skips a namespace used as a value", async () => {
    const dir = await workspace("examples/import-shapes");
    const before = await readTree(dir);
    const report = await toNamed(dir, "src/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.kind, "sweep");
    assert.equal(ok.subject, "sweep(typescript-namespace-to-named): src/**");
    assert.equal(
      ok.summary,
      "Converted 2 namespace imports to named imports in 2 files:\n  src/clash.ts\n  src/sums.ts\n" +
        "\nNot handled (1):\n" +
        "  src/whole.ts:1: `math` is used as a value on its own\n" +
        '    Left `import * as math from "./math"` in src/whole.ts as it is. Use math only as math.<name> (or leave the import as a namespace import), then run again.',
    );
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/clash.ts", "src/sums.ts"]);
    assert.equal(
      after["src/sums.ts"],
      [
        'import { add, mul, PI, Pair } from "./math";',
        "",
        "export const sum = add(1, 2);",
        "export const product = mul(3, 4);",
        "export const again = add(sum, product);",
        "export const pi: typeof PI = PI;",
        "export const pair: Pair = { left: sum, right: product };",
        "",
      ].join("\n"),
    );
    assert.equal(
      after["src/clash.ts"],
      'import { add as add_1 } from "./math";\n\nconst add = 10;\n\nexport const total = add_1(1, 2) + add;\n',
    );
    assert.deepEqual(await errors(dir, "src/sums.ts"), []);
  });

  test("a second run changes nothing (NO_CHANGES for the host)", async () => {
    const dir = await workspace("examples/import-shapes");
    await toNamed(dir, "src/**");
    const once = await readTree(dir);
    const err = await rejects(toNamed(dir, "src/**"));
    assert.equal(err.code, "NO_CHANGES");
    assert.match(err.message, /^No namespace import was converted\. Skipped:\nsrc\/whole\.ts:1: `math` is used as a value on its own$/);
    assert.deepEqual(await readTree(dir), once);
  });

  test("everything converted: nothing listed as not handled", async () => {
    const dir = await workspace("examples/import-shapes");
    const ok = (await toNamed(dir, "src/sums.ts")) as OkReport;
    assertReport(ok);
    assert.equal(ok.summary, "Converted 1 namespace import to named imports in 1 file:\n  src/sums.ts");
  });

  test("when unrelated code moves above, the skipped import is listed at its current line", async () => {
    const plain = (await toNamed(await workspace("examples/import-shapes"), "src/**")) as OkReport;
    const moved = await workspace("examples/import-shapes");
    const tree = await readTree(moved);
    const shifted = await workspace("examples/import-shapes", {
      "src/whole.ts": `// a\n// b\n// c\n${tree["src/whole.ts"]}`,
      "src/sums.ts": `// a\n// b\n${tree["src/sums.ts"]}`,
    });
    const report = (await toNamed(shifted, "src/**")) as OkReport;
    assertReport(report);
    assert.equal(report.summary, plain.summary.replace("src/whole.ts:1:", "src/whole.ts:4:"));
  });

  test("other bare uses (export, shorthand, default, unused) are skipped; type-only and qualified uses convert", async () => {
    const dir = await workspace("examples/import-shapes", {
      "src/reexport.ts": 'import * as math from "./math";\n\nexport { math };\nexport const x = math.PI;\n',
      "src/shorthand.ts": 'import * as math from "./math";\n\nexport const o = { math };\nexport const x = math.PI;\n',
      "src/unused.ts": 'import * as math from "./math";\n\nexport const x = 1;\n',
      "src/defaults.ts": 'import * as geometry from "./geometry";\n\nexport const d = geometry.default;\nexport const c = geometry.Circle;\n',
      "src/typesonly.ts": 'import * as math from "./math";\n\nexport type P = math.Pair;\nexport const k: typeof math.PI = 3.14159;\n',
      "src/shadow.ts": 'import * as math from "./math";\n\nexport function f(math: { PI: number }) {\n  return math.PI;\n}\nexport const g = math.mul(2, 3);\n',
      "src/side.ts": 'import "./math";\nimport * as math from "./math";\n\nexport const s = math.add(1, 2);\n',
    });
    const before = await readTree(dir);
    const report = (await toNamed(dir, "src/**")) as OkReport;
    assertReport(report);
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/clash.ts", "src/shadow.ts", "src/side.ts", "src/sums.ts", "src/typesonly.ts"]);
    assert.equal(
      after["src/shadow.ts"],
      'import { mul } from "./math";\n\nexport function f(math: { PI: number }) {\n  return math.PI;\n}\nexport const g = mul(2, 3);\n',
    );
    assert.equal(after["src/typesonly.ts"], 'import { Pair, PI } from "./math";\n\nexport type P = Pair;\nexport const k: typeof PI = 3.14159;\n');
    // The side-effect import is untouched.
    assert.equal(after["src/side.ts"], 'import "./math";\nimport { add } from "./math";\n\nexport const s = add(1, 2);\n');
    const reasons = Object.fromEntries([...report.summary.matchAll(/^ {2}(\S+):\d+: (.*)$/gm)].map((m) => [m[1], m[2]]));
    assert.deepEqual(reasons, {
      "src/defaults.ts": "`geometry.default` cannot be written as a named import",
      "src/reexport.ts": "`math` is used as a value on its own",
      "src/shorthand.ts": "`math` is used as a value on its own",
      "src/unused.ts": "`math` is not used",
      "src/whole.ts": "`math` is used as a value on its own",
    });
    assert.match(report.summary, /\n\nNot handled \(5\):\n/);
    assert.deepEqual(await errors(dir, "src/side.ts"), []);
  });

  test("several namespace imports in one file are converted one by one", async () => {
    const dir = await workspace("examples/import-shapes", {
      "src/two.ts": 'import * as math from "./math";\nimport * as geometry from "./geometry";\n\nexport const a = math.add(1, 2);\nexport const b = geometry.area(new geometry.Circle(1));\n',
    });
    await toNamed(dir, "src/two.ts");
    assert.equal(
      (await readTree(dir))["src/two.ts"],
      'import { add } from "./math";\nimport { area, Circle } from "./geometry";\n\nexport const a = add(1, 2);\nexport const b = area(new Circle(1));\n',
    );
  });

  test("a file that would gain errors is not handled and is left as it was; the other files are still converted", async () => {
    const tsconfig = (await readTree(await workspace("examples/import-shapes")))["tsconfig.json"] as string;
    const dir = await workspace("examples/import-shapes", {
      "tsconfig.json": tsconfig.replace('"strict": true,', '"strict": true, "verbatimModuleSyntax": true,'),
      "src/onlytypes.ts": 'import * as math from "./math";\n\nexport type P = math.Pair;\n',
      "src/values.ts": 'import * as math from "./math";\n\nexport const x = math.add(1, 2);\n',
    });
    const before = await readTree(dir);
    const report = (await toNamed(dir, "src/onlytypes.ts,src/values.ts")) as OkReport;
    assertReport(report);
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/values.ts"]);
    assert.match(report.summary, /^Converted 1 namespace import to named imports in 1 file:\n {2}src\/values\.ts\n\nNot handled \(1\):\n/);
    assert.match(report.summary, /\n {2}src\/onlytypes\.ts:1: converting it would introduce errors: TS1484/);
    assert.match(report.summary, /\n {4}Left `import \* as math from "\.\/math"` in src\/onlytypes\.ts as it is, because converting it would introduce errors/);
  });

  test("globs that match no file are NO_CHANGES", async () => {
    const dir = await workspace("examples/import-shapes");
    assert.equal((await rejects(toNamed(dir, "nope/**"))).code, "NO_CHANGES");
  });
});

describe("typescript-import-type on examples/import-shapes", () => {
  test("whole imports and individual specifiers become type-only; value names and side-effect imports stay", async () => {
    const dir = await workspace("examples/import-shapes");
    const before = await readTree(dir);
    const report = await importType(dir, "src/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.kind, "sweep");
    assert.equal(ok.subject, "sweep(typescript-import-type): src/**");
    assert.equal(ok.summary, "Made 2 imports type-only in 2 files:\n  src/mixed.ts\n  src/types-only.ts");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/mixed.ts", "src/types-only.ts"]);
    // A mixed import is split by name: values keep their plain specifier, the default stays a value.
    assert.equal(
      after["src/mixed.ts"],
      [
        'import "./side";',
        'import describe, { Circle, type Shape, type Unit, area } from "./geometry";',
        "",
        'export const unit: Unit = "m";',
        "export const shape: Shape = new Circle(2);",
        "",
        "export const text = describe(shape) + area(new Circle(1));",
        "",
      ].join("\n"),
    );
    assert.equal(after["src/types-only.ts"]?.split("\n")[0], 'import type { Shape, Unit } from "./geometry";');
    // The project's tsconfig is not touched.
    assert.equal(after["tsconfig.json"], before["tsconfig.json"]);
    assert.deepEqual(await errors(dir, "src/mixed.ts"), []);
  });

  test("a second run changes nothing (NO_CHANGES for the host)", async () => {
    const dir = await workspace("examples/import-shapes");
    await importType(dir, "src/**");
    const once = await readTree(dir);
    assert.equal((await rejects(importType(dir, "src/**"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), once);
  });

  test("imports already type-only, classes used as types, and quotes are left as they are", async () => {
    const dir = await workspace("examples/import-shapes", {
      "src/keep.ts": [
        "import type { Shape } from './geometry';",
        "import { type Unit, Circle } from './geometry';",
        "import { area } from './geometry';",
        "",
        "export const a = (s: Shape, u: Unit, c: Circle): number => area(c);",
        "",
      ].join("\n"),
      "src/quotes.ts": ["import { Shape, Unit } from './geometry';", "", "export type Both = [Shape, Unit];", ""].join("\n"),
    });
    const before = await readTree(dir);
    assert.equal((await rejects(importType(dir, "src/keep.ts"))).code, "NO_CHANGES");
    // `Circle` is a class: a type-only import of it would drop the module's runtime import, so TypeScript keeps it.
    assert.deepEqual(await readTree(dir), before);
    await importType(dir, "src/quotes.ts");
    assert.equal(
      (await readTree(dir))["src/quotes.ts"],
      ["import type { Shape, Unit } from './geometry';", "", "export type Both = [Shape, Unit];", ""].join("\n"),
    );
  });

  test("the summary stays the same when unrelated code moves above", async () => {
    const plain = (await importType(await workspace("examples/import-shapes"), "src/**")) as OkReport;
    const tree = await readTree(await workspace("examples/import-shapes"));
    const shifted = await workspace("examples/import-shapes", {
      "src/mixed.ts": `// a\n// b\n${tree["src/mixed.ts"]}`,
    });
    const report = (await importType(shifted, "src/**")) as OkReport;
    assertReport(report);
    assert.equal(report.summary, plain.summary);
  });

  test("`verbatimModuleSyntax` need not be set in the project", async () => {
    const dir = await workspace("examples/import-shapes", { "tsconfig.json": '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler", "noEmit": true } }\n' });
    await importType(dir, "src/types-only.ts");
    assert.equal((await readTree(dir))["src/types-only.ts"]?.split("\n")[0], 'import type { Shape, Unit } from "./geometry";');
  });

  test("a default import used only as a type becomes `import type D`; with named imports beside it, it is not handled", async () => {
    const dir = await workspace("examples/import-shapes", {
      "src/kind.ts": "export default interface Kind {\n  id: number;\n}\n\nexport const make = (): number => 1;\n",
      "src/default-type.ts": 'import Kind from "./kind";\n\nexport const k = (x: Kind): number => x.id;\n',
      "src/default-mixed.ts": 'import Kind, { make } from "./kind";\n\nexport const k = (x: Kind): number => x.id + make();\n',
    });
    const before = await readTree(dir);
    const report = (await importType(dir, "src/default-type.ts,src/default-mixed.ts")) as OkReport;
    assertReport(report);
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/default-type.ts"]);
    assert.equal(after["src/default-type.ts"], 'import type Kind from "./kind";\n\nexport const k = (x: Kind): number => x.id;\n');
    assert.match(report.summary, /^Made 1 import type-only in 1 file:\n {2}src\/default-type\.ts\n\nNot handled \(1\):\n/);
    assert.match(report.summary, /\n {2}src\/default-mixed\.ts:1: the default import `Kind` is only a type/);
    assert.match(report.summary, /\n {4}Left the import of "\.\/kind" in src\/default-mixed\.ts as it is/);
    assert.deepEqual(await errors(dir, "src/default-type.ts"), []);
  });

  test("only misses: NO_CHANGES listing them", async () => {
    const dir = await workspace("examples/import-shapes", {
      "src/kind.ts": "export default interface Kind {\n  id: number;\n}\n\nexport const make = (): number => 1;\n",
      "src/default-mixed.ts": 'import Kind, { make } from "./kind";\n\nexport const k = (x: Kind): number => x.id + make();\n',
    });
    const err = await rejects(importType(dir, "src/default-mixed.ts"));
    assert.equal(err.code, "NO_CHANGES");
    assert.match(err.message, /src\/default-mixed\.ts:1: /);
    assert.match(err.message, /\n  Left the import of "\.\/kind" in src\/default-mixed\.ts as it is: .*Split it into/s);
  });

  test("globs that match no file are NO_CHANGES", async () => {
    const dir = await workspace("examples/import-shapes");
    assert.equal((await rejects(importType(dir, "nope/**"))).code, "NO_CHANGES");
  });
});
