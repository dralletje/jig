import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const toNamed = (dir: string, files: string) => main(["namespace-to-named", "--files", files], dir);
const importType = (dir: string, files: string) => main(["import-type", "--files", files], dir);

describe("namespace-to-named on examples/import-shapes", () => {
  test("converts `x.name` uses, renames clashes, skips a namespace used as a value", async () => {
    const dir = await workspace("examples/import-shapes");
    const before = await readTree(dir);
    assertReport(await toNamed(dir, "src/**"));
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
    assert.deepEqual(await readTree(dir), once);
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
    await toNamed(dir, "src/**");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/clash.ts", "src/shadow.ts", "src/side.ts", "src/sums.ts", "src/typesonly.ts"]);
    assert.equal(
      after["src/shadow.ts"],
      'import { mul } from "./math";\n\nexport function f(math: { PI: number }) {\n  return math.PI;\n}\nexport const g = mul(2, 3);\n',
    );
    assert.equal(after["src/typesonly.ts"], 'import { Pair, PI } from "./math";\n\nexport type P = Pair;\nexport const k: typeof PI = 3.14159;\n');
    // The side-effect import is untouched.
    assert.equal(after["src/side.ts"], 'import "./math";\nimport { add } from "./math";\n\nexport const s = add(1, 2);\n');
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
    await toNamed(dir, "src/onlytypes.ts,src/values.ts");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/values.ts"]);
  });

  test("globs that match no file are NO_CHANGES", async () => {
    const dir = await workspace("examples/import-shapes");
    assert.equal((await rejects(toNamed(dir, "nope/**"))).code, "NO_CHANGES");
  });
});

describe("import-type on examples/import-shapes", () => {
  test("whole imports and individual specifiers become type-only; value names and side-effect imports stay", async () => {
    const dir = await workspace("examples/import-shapes");
    const before = await readTree(dir);
    assertReport(await importType(dir, "src/**"));
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
    await importType(dir, "src/default-type.ts,src/default-mixed.ts");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/default-type.ts"]);
    assert.equal(after["src/default-type.ts"], 'import type Kind from "./kind";\n\nexport const k = (x: Kind): number => x.id;\n');
    assert.deepEqual(await errors(dir, "src/default-type.ts"), []);
  });

});
