import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const subpath = (dir: string, files: string, ...more: string[]) =>
  main(["subpath-imports", "--files", files, ...more], dir);

const PACKAGE_AFTER = `{
  "name": "subpath-imports-example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "imports": {
    "#config": "./src/config.ts",
    "#/*": "./src/*"
  }
}
`;

describe("subpath-imports on examples/subpath-imports", () => {
  test("alias imports become subpath imports; package.json imports are merged; paths stay", async () => {
    const dir = await workspace("examples/subpath-imports");
    const before = await readTree(dir);
    const report = await subpath(dir, "src/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.kind, "sweep");
    assert.doesNotMatch(ok.summary, /Not handled/);
    assert.equal(ok.subject, "sweep(typescript subpath-imports): src/**");
    assert.match(
      ok.summary,
      /^Rewrote 9 `@\/` imports to subpath imports in 4 files, and added `#\/\*`: `\.\/src\/\*` to "imports" in package\.json:\n  src\/components\/Total\.ts\n/,
    );
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), [
      "package.json",
      "src/components/Total.ts",
      "src/lib/format.ts",
      "src/lib/index.ts",
      "src/main.ts",
    ]);
    assert.equal(after["package.json"], PACKAGE_AFTER);
    // The tsconfig, with its `paths`, is untouched.
    assert.equal(after["tsconfig.json"], before["tsconfig.json"]);
    assert.equal(
      after["src/components/Total.ts"],
      [
        'import { sum } from "#/lib/index.ts";',
        'import { percent } from "#/lib/format.ts";',
        'import type { items } from "#/services/store.ts";',
        'import { appName } from "#config";',
        'import { helper } from "../lib/relative.ts";',
        "",
        "export type Items = typeof items;",
        "",
        "export function total(values: number[]): string {",
        "  return `${appName}: ${percent(sum(values))} ${helper()}`;",
        "}",
        "",
        'export const lazy = () => import("#/lib/math.ts");',
        "",
      ].join("\n"),
    );
    // Quote style is kept.
    assert.equal(after["src/main.ts"]?.split("\n")[0], "import { total } from '#/components/Total.ts';");
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("a second run changes nothing (NO_CHANGES for the host)", async () => {
    const dir = await workspace("examples/subpath-imports");
    await subpath(dir, "src/**");
    const once = await readTree(dir);
    await subpath(dir, "src/**");
    assert.deepEqual(await readTree(dir), once);
  });

  test("imports written without extensions become .js specifiers (TypeScript does not resolve extensionless targets of imports); directories become their index file", async () => {
    const dir = await workspace("examples/subpath-imports", {
      "src/extra/use.ts": [
        'import { clamp } from "@/lib/math";',
        'import { percent } from "@/lib";',
        'export { add } from "@/services/store";',
        "export const both = [clamp, percent];",
        "",
      ].join("\n"),
    });
    const before = await readTree(dir);
    const report = await subpath(dir, "src/extra/**");
    assertReport(report);
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["package.json", "src/extra/use.ts"]);
    assert.equal(
      after["src/extra/use.ts"],
      [
        'import { clamp } from "#/lib/math.js";',
        'import { percent } from "#/lib/index.js";',
        'export { add } from "#/services/store.js";',
        "export const both = [clamp, percent];",
        "",
      ].join("\n"),
    );
    assert.deepEqual(await errors(dir, "src/extra/use.ts"), []);
  });

  test("an existing identical mapping is not added twice; a different one is refused", async () => {
    const same = await workspace("examples/subpath-imports", {
      "package.json": PACKAGE_AFTER,
    });
    const before = await readTree(same);
    assertReport(await subpath(same, "src/**"));
    const after = await readTree(same);
    assert.equal(after["package.json"], PACKAGE_AFTER);
    assert.ok(changed(before, after).every((p) => p !== "package.json"));

    const other = await workspace("examples/subpath-imports", {
      "package.json": PACKAGE_AFTER.replace('"#/*": "./src/*"', '"#/*": "./lib/*"'),
    });
    const error = await rejects(subpath(other, "src/**"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.match(error.message, /package\.json: "imports" already maps "#\/\*" to something other than "\.\/src\/\*"/);
  });

  test("package.json without imports gets the block, in its own indentation", async () => {
    const dir = await workspace("examples/subpath-imports", {
      "package.json": '{\n    "name": "x",\n    "type": "module"\n}\n',
    });
    await subpath(dir, "src/**");
    assert.equal(
      (await readTree(dir))["package.json"],
      '{\n    "name": "x",\n    "type": "module",\n    "imports": {\n        "#/*": "./src/*"\n    }\n}\n',
    );
  });

  test("--alias picks another prefix", async () => {
    const dir = await workspace("examples/subpath-imports", {
      "tsconfig.json": (await readTree(await workspace("examples/subpath-imports")))["tsconfig.json"]?.replace('"@/*"', '"~app/*"') ?? "",
      "src/other.ts": 'import { sum } from "~app/lib/math.ts";\nexport const s = sum([1]);\n',
    });
    const before = await readTree(dir);
    const report = await subpath(dir, "src/**", "--alias", "~app/");
    assertReport(report);
    assert.equal((report as OkReport).subject, "sweep(typescript subpath-imports): src/** (~app/)");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["package.json", "src/other.ts"]);
    assert.match(after["package.json"] ?? "", /"#app\/\*": "\.\/src\/\*"/);
    assert.equal(after["src/other.ts"]?.split("\n")[0], 'import { sum } from "#app/lib/math.ts";');
  });

  test("an alias whose target is outside the package folder is refused, and nothing is written", async () => {
    const dir = await workspace("examples/subpath-imports", {
      "tsconfig.json": (await readTree(await workspace("examples/subpath-imports")))["tsconfig.json"]?.replace('"./src/*"', '"../shared/*"') ?? "",
    });
    const before = await readTree(dir);
    const error = await rejects(subpath(dir, "src/**"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.match(error.message, /outside the package folder \./);
    assert.deepEqual(await readTree(dir), before);
  });

  test("a tsconfig without a package.json next to it is refused", async () => {
    const dir = await workspace("examples/subpath-imports", { "nested/tsconfig.json": '{ "compilerOptions": { "moduleResolution": "bundler", "module": "esnext", "paths": { "@/*": ["./src/*"] } } }\n', "nested/src/a.ts": "export const a = 1;\n", "nested/src/b.ts": 'import { a } from "@/a";\nexport const b = a;\n' });
    const error = await rejects(subpath(dir, "nested/**"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.match(error.message, /nested\/tsconfig\.json: there is no package\.json next to it/);
  });

  test("moduleResolution node10 cannot resolve subpath imports: every import is a miss (NO_CHANGES)", async () => {
    const dir = await workspace("examples/subpath-imports", {
      "tsconfig.json": (await readTree(await workspace("examples/subpath-imports")))["tsconfig.json"]?.replace('"bundler"', '"node10"').replace('"esnext",\n    "moduleResolution"', '"commonjs",\n    "moduleResolution"') ?? "",
    });
    const before = await readTree(dir);
    const error = await rejects(subpath(dir, "src/**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.match(error.message, /would not resolve to the same file as a subpath import/);
    assert.deepEqual(await readTree(dir), before);
  });

  test("without allowImportingTsExtensions, extensionless imports get .js (never .ts) and the run succeeds", async () => {
    const base = (await readTree(await workspace("examples/subpath-imports")))["tsconfig.json"] ?? "";
    const dir = await workspace("examples/subpath-imports", {
      "tsconfig.json": base.replace('    "allowImportingTsExtensions": true,\n', ""),
      "src/extra/use.ts": [
        'import { clamp } from "@/lib/math";',
        'import { percent } from "@/lib";',
        'export { add } from "@/services/store";',
        "export const both = [clamp, percent];",
        "",
      ].join("\n"),
    });
    const report = await subpath(dir, "src/extra/**");
    assertReport(report);
    assert.doesNotMatch((report as OkReport).summary, /Not handled/);
    const after = await readTree(dir);
    assert.equal(after["src/extra/use.ts"]?.split("\n").slice(0, 3).join("\n"), [
      'import { clamp } from "#/lib/math.js";',
      'import { percent } from "#/lib/index.js";',
      'export { add } from "#/services/store.js";',
    ].join("\n"));
    assert.deepEqual((await errors(dir, "src/extra/use.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("without allowImportingTsExtensions, imports written with .js become subpath imports with .js", async () => {
    const base = (await readTree(await workspace("examples/subpath-imports")))["tsconfig.json"] ?? "";
    const dir = await workspace("examples/subpath-imports", {
      "tsconfig.json": base.replace('    "allowImportingTsExtensions": true,\n', ""),
      "src/extra/use.ts": 'import { clamp } from "@/lib/math.js";\nexport const c = clamp;\n',
    });
    assertReport(await subpath(dir, "src/extra/**"));
    assert.equal((await readTree(dir))["src/extra/use.ts"]?.split("\n")[0], 'import { clamp } from "#/lib/math.js";');
    assert.deepEqual((await errors(dir, "src/extra/use.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("an alias specifier that does not resolve is not handled, not a refusal; the others are rewritten", async () => {
    const dir = await workspace("examples/subpath-imports", {
      "src/extra/use.ts": 'import { clamp } from "@/lib/math.ts";\nimport { x } from "@/nope/missing.ts";\nexport const c = [clamp, x];\n',
    });
    const before = await readTree(dir);
    const report = await subpath(dir, "src/extra/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.match(
      ok.summary,
      /\n\nNot handled \(1\):\n {2}src\/extra\/use\.ts:2: "@\/nope\/missing\.ts" does not resolve\n {4}Fix or remove the import of "@\/nope\/missing\.ts" in src\/extra\/use\.ts, or leave it as it is\.$/,
    );
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["package.json", "src/extra/use.ts"]);
    assert.match(after["src/extra/use.ts"] ?? "", /from "#\/lib\/math\.ts";\nimport \{ x \} from "@\/nope\/missing\.ts";/);
  });

  test("an alias specifier that resolves outside the alias folder is not handled", async () => {
    const dir = await workspace("examples/subpath-imports", {
      "other/x.ts": "export const x = 1;\n",
      "src/extra/use.ts": 'import { x } from "@/../other/x.ts";\nimport { clamp } from "@/lib/math.ts";\nexport const c = [x, clamp];\n',
    });
    const report = await subpath(dir, "src/extra/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.match(ok.summary, /\n\nNot handled \(1\):\n {2}src\/extra\/use\.ts:1: "@\/\.\.\/other\/x\.ts" resolves outside /);
    assert.match((await readTree(dir))["src/extra/use.ts"] ?? "", /from "@\/\.\.\/other\/x\.ts";\nimport \{ clamp \} from "#\/lib\/math\.ts"/);
  });

  test("a file that would gain diagnostics is not handled; other files are rewritten and the file is left as it was", async () => {
    const dir = await workspace("examples/subpath-imports", {
      // An ambient module wins over the file once the specifier is `#/lib/math.ts`: the rewrite changes the types.
      "src/types.d.ts": 'declare module "#/lib/math.ts" { export const clamp: string; }\n',
      "src/extra/bad.ts": 'import { clamp } from "@/lib/math.ts";\nexport const n: number = clamp(1, 0, 2);\n',
      "src/extra/good.ts": 'import { sum } from "@/lib/index.ts";\nexport const s = sum([1]);\n',
    });
    const before = await readTree(dir);
    const report = await subpath(dir, "src/extra/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.match(ok.summary, /\n\nNot handled \(1\):\n {2}src\/extra\/bad\.ts:1: rewriting the alias imports would introduce errors: /);
    assert.match(ok.summary, /\n {4}Fix the imports of src\/extra\/bad\.ts by hand, or leave the file as it is\.$/);
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["package.json", "src/extra/good.ts"]);
    assert.equal(after["src/extra/bad.ts"], before["src/extra/bad.ts"]);
  });

  test("a glob that matches no file is NO_CHANGES; no alias imports changes nothing", async () => {
    const dir = await workspace("examples/subpath-imports");
    assert.equal((await rejects(subpath(dir, "nope/**"))).code, "NO_CHANGES");
    const before = await readTree(dir);
    await subpath(dir, "src/lib/relative.ts");
    assert.deepEqual(await readTree(dir), before);
  });

  test("--alias without a trailing slash is INVALID_ARGS", async () => {
    const dir = await workspace("examples/subpath-imports");
    assert.equal((await rejects(subpath(dir, "src/**", "--alias", "@"))).code, "INVALID_ARGS");
  });
});
