import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const EXAMPLE = "examples/import-styles";

const toRelative = (dir: string, files: string, targets: string) =>
  main(["imports-to-relative", "--files", files, "--targets", targets], dir);
const toAlias = (dir: string, files: string, targets: string, alias = "@/") =>
  main(["imports-to-alias", "--files", files, "--targets", targets, "--alias", alias], dir);
const toSubpath = (dir: string, files: string, targets: string, prefix = "#/") =>
  main(["imports-to-subpath", "--files", files, "--targets", targets, "--prefix", prefix], dir);

async function ok(report: Promise<unknown>): Promise<OkReport> {
  const r = await report;
  assertReport(r);
  return r as OkReport;
}

/** The example's tsconfig with `.ts` extensions not allowed. */
async function tsconfigWithoutTsExtensions(): Promise<string> {
  const base = (await readTree(await workspace(EXAMPLE)))["tsconfig.json"] ?? "";
  return base.replace('    "allowImportingTsExtensions": true,\n', "");
}

// Every import form, written relative / through the alias / as a subpath.
const forms = (lib: string) =>
  [
    "declare function require(id: string): unknown;",
    `import type { Day } from "${lib}/date.ts";`,
    `import { type Day as D2, formatDay } from "${lib}/date.ts";`,
    `export { cents } from "${lib}/money.ts";`,
    `export * from "${lib}/index.ts";`,
    `import money = require("${lib}/money.ts");`,
    `const late = require("${lib}/date.ts");`,
    `export const lazy = () => import("${lib}/money.ts");`,
    `export type DateModule = typeof import("${lib}/date.ts");`,
    "export const all = [formatDay, money, late];",
    "export type Both = [Day, D2];",
    "",
  ].join("\n");

describe("imports-to-relative", () => {
  test("alias and subpath imports become relative imports; relative ones stay; the subject names the globs", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const report = await ok(toRelative(dir, "src/**", "**"));
    assert.equal(report.kind, "sweep");
    assert.equal(report.subject, "sweep(typescript imports-to-relative): src/** importing **");
    assert.equal(report.summary, "Rewrote 3 imports to relative imports in 2 files:\n  src/components/Invoice.ts\n  src/main.ts");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/components/Invoice.ts", "src/main.ts"]);
    assert.equal(
      after["src/components/Invoice.ts"]?.split("\n").slice(0, 3).join("\n"),
      ['import { formatDay } from "../lib/date.ts";', 'import type { Day } from "../lib/date.ts";', 'import { cents } from "../lib/money.ts";'].join("\n"),
    );
    assert.match(after["src/components/Invoice.ts"] ?? "", /import\("\.\.\/lib\/index\.ts"\)/);
    assert.equal(after["src/main.ts"]?.split("\n")[1], 'import { formatDay } from "./lib/index.ts";');
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("--targets limits which imports change", async () => {
    const dir = await workspace(EXAMPLE);
    const report = await ok(toRelative(dir, "src/**", "src/lib/date.ts"));
    assert.match(report.summary, /^Rewrote 1 import to relative imports in 1 file:\n {2}src\/components\/Invoice\.ts$/);
    const after = await readTree(dir);
    assert.match(after["src/components/Invoice.ts"] ?? "", /import type \{ Day \} from "\.\.\/lib\/date\.ts";\nimport \{ cents \} from "#\/lib\/money\.ts";/);
    assert.equal(after["src/main.ts"]?.split("\n")[1], 'import { formatDay } from "@/lib/index.ts";');
  });

  test("the extension form is kept: none, .ts, a folder for its index file", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/extra/forms.ts": 'import { formatDay } from "@/lib/date";\nimport { cents } from "@/lib";\nimport type { Day } from "@/lib/date.ts";\nexport const x = [formatDay, cents] as const;\nexport type D = Day;\n',
    });
    const report = await ok(toRelative(dir, "src/extra/**", "**"));
    assert.doesNotMatch(report.summary, /Not handled/);
    assert.equal(
      (await readTree(dir))["src/extra/forms.ts"]?.split("\n").slice(0, 3).join("\n"),
      ['import { formatDay } from "../lib/date";', 'import { cents } from "../lib";', 'import type { Day } from "../lib/date.ts";'].join("\n"),
    );
    assert.deepEqual((await errors(dir, "src/extra/forms.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("a .js specifier for a .ts file stays .js", async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": await tsconfigWithoutTsExtensions(),
      "src/extra/forms.ts": 'import { formatDay } from "@/lib/date.js";\nexport const f = formatDay;\n',
    });
    await ok(toRelative(dir, "src/extra/**", "**"));
    assert.equal((await readTree(dir))["src/extra/forms.ts"]?.split("\n")[0], 'import { formatDay } from "../lib/date.js";');
    assert.deepEqual((await errors(dir, "src/extra/forms.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("import types, re-exports, import(), import = require(), require() and import() types all change", async () => {
    const dir = await workspace(EXAMPLE, { "src/extra/forms.ts": forms("@/lib") });
    const report = await ok(toRelative(dir, "src/extra/**", "**"));
    assert.match(report.summary, /^Rewrote 8 imports to relative imports in 1 file:/);
    assert.doesNotMatch(report.summary, /Not handled/);
    assert.equal((await readTree(dir))["src/extra/forms.ts"], forms("../lib"));
  });

  test("packages, relative imports and a file without other styles are untouched (NO_CHANGES)", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/extra/pkg.ts": 'import { thing } from "some-package";\nimport { cents } from "../lib/money.ts";\nexport const x = [thing, cents];\n',
    });
    const before = await readTree(dir);
    const error = await rejects(toRelative(dir, "src/extra/**", "**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.match(error.message, /^No import in src\/extra\/\*\* resolving to a file matching \*\* is written in another style than relative imports/);
    assert.deepEqual(await readTree(dir), before);
  });

  test("a target outside the importer's project folder is left alone and named", async () => {
    const dir = await workspace(EXAMPLE, {
      "app/tsconfig.json": '{ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true, "paths": { "@shared/*": ["../shared/*"], "@app/*": ["./src/*"] } } }\n',
      "app/src/a.ts": 'import { s } from "@shared/s.ts";\nimport { b } from "@app/b.ts";\nexport const a = [s, b];\n',
      "app/src/b.ts": "export const b = 1;\n",
      "shared/s.ts": "export const s = 1;\n",
    });
    const report = await ok(toRelative(dir, "app/**", "**"));
    assert.equal(
      report.summary,
      [
        "Rewrote 1 import to relative imports in 1 file:",
        "  app/src/a.ts",
        "",
        "Not handled (1):",
        "  app/src/a.ts:1: shared/s.ts is outside the project folder app",
        "    A relative import from app/src/a.ts would leave its project. Leave this import as it is.",
      ].join("\n"),
    );
    assert.equal((await readTree(dir))["app/src/a.ts"], 'import { s } from "@shared/s.ts";\nimport { b } from "./b.ts";\nexport const a = [s, b];\n');
  });

  test("an import that does not resolve is left alone and named; an exact paths key's form is unclear and named", async () => {
    const base = (await readTree(await workspace(EXAMPLE)))["tsconfig.json"] ?? "";
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": base.replace('"@/*": ["./src/*"]', '"@/*": ["./src/*"],\n      "@money": ["./src/lib/money.ts"]'),
      "src/extra/use.ts": 'import { nope } from "@/lib/nope.ts";\nimport { cents } from "@money";\nimport { formatDay } from "@/lib/date.ts";\nexport const x = [nope, cents, formatDay];\n',
    });
    const report = await ok(toRelative(dir, "src/extra/**", "**"));
    assert.match(report.summary, /^Rewrote 1 import to relative imports in 1 file:/);
    assert.match(report.summary, /\n\nNot handled \(2\):\n {2}src\/extra\/use\.ts:1: "@\/lib\/nope\.ts" does not resolve\n/);
    assert.match(report.summary, /\n {2}src\/extra\/use\.ts:2: cannot tell whether "@money" names src\/lib\/money\.ts with or without its extension, or by its folder\n/);
    assert.match((await readTree(dir))["src/extra/use.ts"] ?? "", /from "@money";\nimport \{ formatDay \} from "\.\.\/lib\/date\.ts";/);
  });

  test("a second run, and --targets matching nothing, are NO_CHANGES", async () => {
    const dir = await workspace(EXAMPLE);
    assert.equal((await rejects(toRelative(dir, "src/**", "nothing/**"))).code, "NO_CHANGES");
    await toRelative(dir, "src/**", "**");
    const once = await readTree(dir);
    assert.equal((await rejects(toRelative(dir, "src/**", "**"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), once);
  });

  test("--targets is required", async () => {
    const dir = await workspace(EXAMPLE);
    const error = await rejects(main(["imports-to-relative", "--files", "src/**"], dir));
    assert.equal(error.code, "INVALID_ARGS");
    assert.match(error.message, /Missing --targets/);
  });
});

describe("imports-to-alias", () => {
  test("relative and subpath imports become alias imports; alias ones stay", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const report = await ok(toAlias(dir, "src/**", "**"));
    assert.equal(report.subject, "sweep(typescript imports-to-alias): src/** importing ** as @/");
    assert.equal(
      report.summary,
      "Rewrote 6 imports to `@/` imports in 3 files:\n  src/components/Invoice.ts\n  src/lib/index.ts\n  src/main.ts",
    );
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/components/Invoice.ts", "src/lib/index.ts", "src/main.ts"]);
    assert.equal(
      after["src/components/Invoice.ts"],
      [
        'import { formatDay } from "@/lib/date.ts";',
        'import type { Day } from "@/lib/date.ts";',
        'import { cents } from "@/lib/money.ts";',
        "",
        "export function invoiceLine(day: Day, amount: number): string {",
        "  return `${formatDay(day)}: ${cents(amount)}`;",
        "}",
        "",
        'export const loadLib = () => import("@/lib/index.ts");',
        "",
      ].join("\n"),
    );
    assert.equal(after["src/lib/index.ts"], 'export { formatDay } from "@/lib/date.ts";\nexport { cents } from "@/lib/money.ts";\n');
    assert.equal(after["tsconfig.json"], before["tsconfig.json"]);
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("--targets limits which imports change", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const report = await ok(toAlias(dir, "src/**", "src/lib/money.ts"));
    assert.match(report.summary, /^Rewrote 2 imports to `@\/` imports in 2 files:\n {2}src\/components\/Invoice\.ts\n {2}src\/lib\/index\.ts$/);
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/components/Invoice.ts", "src/lib/index.ts"]);
    assert.equal(after["src/lib/index.ts"], 'export { formatDay } from "./date.ts";\nexport { cents } from "@/lib/money.ts";\n');
  });

  test("the extension form is kept: none, .ts, a folder for its index file", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/extra/forms.ts": 'import { formatDay } from "../lib/date";\nimport { cents } from "../lib";\nimport type { Day } from "../lib/date.ts";\nexport const x = [formatDay, cents] as const;\nexport type D = Day;\n',
    });
    const report = await ok(toAlias(dir, "src/extra/**", "**"));
    assert.doesNotMatch(report.summary, /Not handled/);
    assert.equal(
      (await readTree(dir))["src/extra/forms.ts"]?.split("\n").slice(0, 3).join("\n"),
      ['import { formatDay } from "@/lib/date";', 'import { cents } from "@/lib";', 'import type { Day } from "@/lib/date.ts";'].join("\n"),
    );
    assert.deepEqual((await errors(dir, "src/extra/forms.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("a .js specifier for a .ts file stays .js", async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": await tsconfigWithoutTsExtensions(),
      "src/extra/forms.ts": 'import { formatDay } from "../lib/date.js";\nexport const f = formatDay;\n',
    });
    await ok(toAlias(dir, "src/extra/**", "**"));
    assert.equal((await readTree(dir))["src/extra/forms.ts"]?.split("\n")[0], 'import { formatDay } from "@/lib/date.js";');
    assert.deepEqual((await errors(dir, "src/extra/forms.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("import types, re-exports, import(), import = require(), require() and import() types all change", async () => {
    const dir = await workspace(EXAMPLE, { "src/extra/forms.ts": forms("../lib") });
    const report = await ok(toAlias(dir, "src/extra/**", "**"));
    assert.match(report.summary, /^Rewrote 8 imports to `@\/` imports in 1 file:/);
    assert.doesNotMatch(report.summary, /Not handled/);
    assert.equal((await readTree(dir))["src/extra/forms.ts"], forms("@/lib"));
  });

  test("packages and imports already through an alias are untouched (NO_CHANGES)", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/extra/pkg.ts": 'import { thing } from "some-package";\nimport { cents } from "@/lib/money.ts";\nexport const x = [thing, cents];\n',
    });
    const before = await readTree(dir);
    const error = await rejects(toAlias(dir, "src/extra/**", "**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), before);
  });

  test("an alias missing from the importer's tsconfig paths is refused, and nothing is written", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const error = await rejects(toAlias(dir, "src/**", "**", "~/"));
    assert.equal(error.code, "INVALID_ARGS");
    assert.match(error.message, /^src\/components\/Invoice\.ts: its project, tsconfig\.json, has no compilerOptions\.paths entry "~\/\*" \(it has "@\/\*"\)\. /);
    assert.match(error.message, /imports-to-alias does not change tsconfig\.json\.$/);
    assert.deepEqual(await readTree(dir), before);
  });

  test("a target outside the alias folder is left alone and named", async () => {
    const dir = await workspace(EXAMPLE, {
      "other/x.ts": "export const x = 1;\n",
      "src/extra/use.ts": 'import { x } from "../../other/x.ts";\nimport { cents } from "../lib/money.ts";\nexport const c = [x, cents];\n',
    });
    const report = await ok(toAlias(dir, "src/extra/**", "**"));
    assert.equal(
      report.summary,
      [
        "Rewrote 1 import to `@/` imports in 1 file:",
        "  src/extra/use.ts",
        "",
        "Not handled (1):",
        "  src/extra/use.ts:1: other/x.ts is outside src, the folder of @/*",
        "    The import of other/x.ts in src/extra/use.ts cannot be written with @/. Leave it as it is.",
      ].join("\n"),
    );
    assert.match((await readTree(dir))["src/extra/use.ts"] ?? "", /from "\.\.\/\.\.\/other\/x\.ts";\nimport \{ cents \} from "@\/lib\/money\.ts";/);
  });

  test("when every import is left alone the run is NO_CHANGES, naming them", async () => {
    const dir = await workspace(EXAMPLE, {
      "other/x.ts": "export const x = 1;\n",
      "src/extra/use.ts": 'import { x } from "../../other/x.ts";\nexport const c = x;\n',
    });
    const error = await rejects(toAlias(dir, "src/extra/**", "**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.match(error.message, /^No import in src\/extra\/\*\* could be rewritten to `@\/` imports\. Skipped:\nsrc\/extra\/use\.ts:1: other\/x\.ts is outside src/);
  });

  test("a second run is NO_CHANGES", async () => {
    const dir = await workspace(EXAMPLE);
    await toAlias(dir, "src/**", "**");
    const once = await readTree(dir);
    assert.equal((await rejects(toAlias(dir, "src/**", "**"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), once);
  });

  test("--alias must end in a slash and must not be a subpath prefix", async () => {
    const dir = await workspace(EXAMPLE);
    assert.equal((await rejects(toAlias(dir, "src/**", "**", "@"))).code, "INVALID_ARGS");
    assert.equal((await rejects(toAlias(dir, "src/**", "**", "#/"))).code, "INVALID_ARGS");
    assert.equal((await rejects(main(["imports-to-alias", "--files", "src/**", "--targets", "**"], dir))).code, "INVALID_ARGS");
  });
});

describe("imports-to-subpath", () => {
  test("relative and alias imports become subpath imports; subpath ones stay", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const report = await ok(toSubpath(dir, "src/**", "**"));
    assert.equal(report.subject, "sweep(typescript imports-to-subpath): src/** importing ** as #/");
    assert.equal(
      report.summary,
      "Rewrote 7 imports to `#/` subpath imports in 3 files:\n  src/components/Invoice.ts\n  src/lib/index.ts\n  src/main.ts",
    );
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/components/Invoice.ts", "src/lib/index.ts", "src/main.ts"]);
    assert.equal(
      after["src/components/Invoice.ts"]?.split("\n").slice(0, 3).join("\n"),
      ['import { formatDay } from "#/lib/date.ts";', 'import type { Day } from "#/lib/date.ts";', 'import { cents } from "#/lib/money.ts";'].join("\n"),
    );
    assert.equal(after["src/main.ts"]?.split("\n").slice(0, 2).join("\n"), 'import { invoiceLine } from "#/components/Invoice.ts";\nimport { formatDay } from "#/lib/index.ts";');
    assert.equal(after["package.json"], before["package.json"]);
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("--targets limits which imports change", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const report = await ok(toSubpath(dir, "src/**", "src/components/**"));
    assert.match(report.summary, /^Rewrote 1 import to `#\/` subpath imports in 1 file:\n {2}src\/main\.ts$/);
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/main.ts"]);
    assert.equal(after["src/main.ts"]?.split("\n").slice(0, 2).join("\n"), 'import { invoiceLine } from "#/components/Invoice.ts";\nimport { formatDay } from "@/lib/index.ts";');
  });

  test("the .ts form is kept; extensionless and folder imports cannot be subpath imports and are named", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/extra/forms.ts": 'import { formatDay } from "../lib/date";\nimport { cents } from "../lib";\nimport type { Day } from "../lib/date.ts";\nexport const x = [formatDay, cents] as const;\nexport type D = Day;\n',
    });
    const report = await ok(toSubpath(dir, "src/extra/**", "**"));
    assert.match(report.summary, /^Rewrote 1 import to `#\/` subpath imports in 1 file:/);
    assert.match(
      report.summary,
      /\n\nNot handled \(2\):\n {2}src\/extra\/forms\.ts:1: "#\/lib\/date" would not resolve to src\/lib\/date\.ts as "\.\.\/lib\/date" does\n {4}TypeScript resolves "#\/lib\/date" from src\/extra\/forms\.ts to nothing\. Subpath imports name files exactly/,
    );
    assert.match(report.summary, /\n {2}src\/extra\/forms\.ts:2: "#\/lib" would not resolve to src\/lib\/index\.ts as "\.\.\/lib" does\n/);
    assert.equal(
      (await readTree(dir))["src/extra/forms.ts"]?.split("\n").slice(0, 3).join("\n"),
      ['import { formatDay } from "../lib/date";', 'import { cents } from "../lib";', 'import type { Day } from "#/lib/date.ts";'].join("\n"),
    );
  });

  test("a .js specifier for a .ts file stays .js", async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": await tsconfigWithoutTsExtensions(),
      "src/extra/forms.ts": 'import { formatDay } from "@/lib/date.js";\nexport const f = formatDay;\n',
    });
    await ok(toSubpath(dir, "src/extra/**", "**"));
    assert.equal((await readTree(dir))["src/extra/forms.ts"]?.split("\n")[0], 'import { formatDay } from "#/lib/date.js";');
    assert.deepEqual((await errors(dir, "src/extra/forms.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("import types, re-exports, import(), import = require(), require() and import() types all change", async () => {
    const dir = await workspace(EXAMPLE, { "src/extra/forms.ts": forms("@/lib") });
    const report = await ok(toSubpath(dir, "src/extra/**", "**"));
    assert.match(report.summary, /^Rewrote 8 imports to `#\/` subpath imports in 1 file:/);
    assert.doesNotMatch(report.summary, /Not handled/);
    assert.equal((await readTree(dir))["src/extra/forms.ts"], forms("#/lib"));
  });

  test("packages and subpath imports (also through another key) are untouched (NO_CHANGES)", async () => {
    const dir = await workspace(EXAMPLE, {
      "package.json": '{ "type": "module", "imports": { "#/*": "./src/*", "#money": "./src/lib/money.ts" } }\n',
      "src/extra/pkg.ts": 'import { thing } from "some-package";\nimport { cents } from "#money";\nimport { formatDay } from "#/lib/date.ts";\nexport const x = [thing, cents, formatDay];\n',
    });
    const before = await readTree(dir);
    const error = await rejects(toSubpath(dir, "src/extra/**", "**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), before);
  });

  test("a prefix missing from the nearest package.json imports is refused, and nothing is written", async () => {
    const dir = await workspace(EXAMPLE, { "package.json": '{ "name": "x", "type": "module" }\n' });
    const before = await readTree(dir);
    const error = await rejects(toSubpath(dir, "src/**", "**"));
    assert.equal(error.code, "INVALID_ARGS");
    assert.match(error.message, /^package\.json, the nearest package\.json to src\/components\/Invoice\.ts, has no "imports" entry "#\/\*"\. /);
    assert.match(error.message, /imports-to-subpath does not change package\.json\.$/);
    assert.deepEqual(await readTree(dir), before);
  });

  test("a prefix mapped to something other than one folder is refused", async () => {
    const dir = await workspace(EXAMPLE, { "package.json": '{ "type": "module", "imports": { "#/*": { "types": "./src/*", "default": "./dist/*" } } }\n' });
    const error = await rejects(toSubpath(dir, "src/**", "**"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.match(error.message, /^package\.json: "imports" "#\/\*" must map to one folder, "\.\/<folder>\/\*"/);
  });

  test("a target outside the prefix folder is left alone and named", async () => {
    const dir = await workspace(EXAMPLE, {
      "other/x.ts": "export const x = 1;\n",
      "src/extra/use.ts": 'import { x } from "../../other/x.ts";\nimport { cents } from "@/lib/money.ts";\nexport const c = [x, cents];\n',
    });
    const report = await ok(toSubpath(dir, "src/extra/**", "**"));
    assert.equal(
      report.summary,
      [
        "Rewrote 1 import to `#/` subpath imports in 1 file:",
        "  src/extra/use.ts",
        "",
        "Not handled (1):",
        "  src/extra/use.ts:1: other/x.ts is outside src, the folder of #/*",
        "    The import of other/x.ts in src/extra/use.ts cannot be written with #/. Leave it as it is.",
      ].join("\n"),
    );
  });

  test("a second run is NO_CHANGES", async () => {
    const dir = await workspace(EXAMPLE);
    await toSubpath(dir, "src/**", "**");
    const once = await readTree(dir);
    assert.equal((await rejects(toSubpath(dir, "src/**", "**"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), once);
  });

  test("--prefix must start with # and end in a slash", async () => {
    const dir = await workspace(EXAMPLE);
    assert.equal((await rejects(toSubpath(dir, "src/**", "**", "@/"))).code, "INVALID_ARGS");
    assert.equal((await rejects(toSubpath(dir, "src/**", "**", "#"))).code, "INVALID_ARGS");
    assert.equal((await rejects(main(["imports-to-subpath", "--files", "src/**", "--targets", "**"], dir))).code, "INVALID_ARGS");
  });
});
