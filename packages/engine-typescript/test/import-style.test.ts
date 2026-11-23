import assert from "node:assert/strict";
import { describe, test } from "node:test";
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
  test("alias and subpath imports become relative imports; relative ones stay", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    assertReport(await toRelative(dir, "src/**", "**"));
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

  test("a .js specifier for a .ts file stays .js", async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": await tsconfigWithoutTsExtensions(),
      "src/extra/forms.ts": 'import { formatDay } from "@/lib/date.js";\nexport const f = formatDay;\n',
    });
    await toRelative(dir, "src/extra/**", "**");
    assert.equal((await readTree(dir))["src/extra/forms.ts"]?.split("\n")[0], 'import { formatDay } from "../lib/date.js";');
    assert.deepEqual((await errors(dir, "src/extra/forms.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("import types, re-exports, import(), import = require(), require() and import() types all change", async () => {
    const dir = await workspace(EXAMPLE, { "src/extra/forms.ts": forms("@/lib") });
    await toRelative(dir, "src/extra/**", "**");
    assert.equal((await readTree(dir))["src/extra/forms.ts"], forms("../lib"));
  });

  test("packages, relative imports and a file without other styles are untouched (NO_CHANGES)", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/extra/pkg.ts": 'import { thing } from "some-package";\nimport { cents } from "../lib/money.ts";\nexport const x = [thing, cents];\n',
    });
    const before = await readTree(dir);
    const error = await rejects(toRelative(dir, "src/extra/**", "**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), before);
  });

  test("a target outside the importer's project folder is left alone", async () => {
    const dir = await workspace(EXAMPLE, {
      "app/tsconfig.json": '{ "compilerOptions": { "module": "esnext", "moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true, "paths": { "@shared/*": ["../shared/*"], "@app/*": ["./src/*"] } } }\n',
      "app/src/a.ts": 'import { s } from "@shared/s.ts";\nimport { b } from "@app/b.ts";\nexport const a = [s, b];\n',
      "app/src/b.ts": "export const b = 1;\n",
      "shared/s.ts": "export const s = 1;\n",
    });
    await toRelative(dir, "app/**", "**");
    assert.equal((await readTree(dir))["app/src/a.ts"], 'import { s } from "@shared/s.ts";\nimport { b } from "./b.ts";\nexport const a = [s, b];\n');
  });

  test("an import that does not resolve, and one through an exact paths key, are left alone", async () => {
    const base = (await readTree(await workspace(EXAMPLE)))["tsconfig.json"] ?? "";
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": base.replace('"@/*": ["./src/*"]', '"@/*": ["./src/*"],\n      "@money": ["./src/lib/money.ts"]'),
      "src/extra/use.ts": 'import { nope } from "@/lib/nope.ts";\nimport { cents } from "@money";\nimport { formatDay } from "@/lib/date.ts";\nexport const x = [nope, cents, formatDay];\n',
    });
    await toRelative(dir, "src/extra/**", "**");
    assert.equal(
      (await readTree(dir))["src/extra/use.ts"],
      'import { nope } from "@/lib/nope.ts";\nimport { cents } from "@money";\nimport { formatDay } from "../lib/date.ts";\nexport const x = [nope, cents, formatDay];\n',
    );
  });

  test("a second run, and --targets matching nothing, are NO_CHANGES", async () => {
    const dir = await workspace(EXAMPLE);
    assert.equal((await rejects(toRelative(dir, "src/**", "nothing/**"))).code, "NO_CHANGES");
    await toRelative(dir, "src/**", "**");
    const once = await readTree(dir);
    assert.equal((await rejects(toRelative(dir, "src/**", "**"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), once);
  });
});

describe("imports-to-* edge cases", () => {
  const tsconfig = (extra: object) =>
    `${JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true, allowImportingTsExtensions: true, types: [], ...extra } }, null, 2)}\n`;

  test("a package reached through a catch-all \"*\" paths key is a package: never rewritten into node_modules", async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": tsconfig({ baseUrl: ".", paths: { "*": ["./types/*"], "@/*": ["./src/*"] } }),
      "node_modules/@types/dep/index.d.ts": "export declare const x: number;\n",
      "node_modules/@types/dep/package.json": '{ "name": "@types/dep", "types": "index.d.ts" }\n',
      "node_modules/dep/package.json": '{ "name": "dep", "main": "index.js" }\n',
      "node_modules/dep/index.js": "exports.x = 1;\n",
      "src/x/a.ts": 'import { x } from "dep";\nimport { formatDay } from "@/lib/date";\nexport const z = [x, formatDay];\n',
    });
    await toRelative(dir, "src/x/**", "**");
    assert.equal((await readTree(dir))["src/x/a.ts"], 'import { x } from "dep";\nimport { formatDay } from "../lib/date";\nexport const z = [x, formatDay];\n');
  });

  test("a subpath key mapped to a package (\"#dep\": \"dep\") is a package: untouched", async () => {
    const dir = await workspace(EXAMPLE, {
      "package.json": '{ "type": "module", "imports": { "#/*": "./src/*", "#dep": "dep" } }\n',
      "node_modules/dep/package.json": '{ "name": "dep", "types": "index.d.ts" }\n',
      "node_modules/dep/index.d.ts": "export declare const x: number;\n",
      "src/x/a.ts": 'import { x } from "#dep";\nimport { cents } from "#/lib/money.ts";\nexport const z = [x, cents];\n',
    });
    await toRelative(dir, "src/x/**", "**");
    assert.equal((await readTree(dir))["src/x/a.ts"]?.split("\n").slice(0, 2).join("\n"), 'import { x } from "#dep";\nimport { cents } from "../lib/money.ts";');
  });

  test("a folder whose package.json points TypeScript at a declaration file elsewhere is left alone", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/vendor/thing/package.json": '{ "types": "dist/index.d.ts", "main": "lib/index.js" }\n',
      "src/vendor/thing/dist/index.d.ts": "export declare const t: number;\n",
      "src/vendor/thing/lib/index.js": "exports.t = 1;\n",
      "src/x/a.ts": 'import { t } from "../vendor/thing";\nexport const z = t;\n',
    });
    const before = await readTree(dir);
    const error = await rejects(toAlias(dir, "src/x/**", "**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), before);
  });

  test("an exact subpath key to an index file is left alone, whatever its target", async () => {
    const dir = await workspace(EXAMPLE, {
      "package.json": '{ "type": "module", "imports": { "#/*": "./src/*", "#config": "./src/config/index.ts" } }\n',
      "src/config/index.ts": "export const c = 1;\n",
      "src/x/a.ts": 'import { c } from "#config";\nexport const z = c;\n',
    });
    const before = await readTree(dir);
    const error = await rejects(toRelative(dir, "src/x/**", "**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), before);
  });

  test("paths relative to baseUrl: the alias folder is found through it; a baseUrl import is a package and stays", async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": tsconfig({ baseUrl: "./src", paths: { "~/*": ["./*"] } }),
      "src/x/a.ts": 'import { formatDay } from "../lib/date";\nimport { cents } from "lib/money";\nexport const z = [formatDay, cents];\n',
    });
    await toAlias(dir, "src/x/**", "**", "~/");
    assert.equal((await readTree(dir))["src/x/a.ts"]?.split("\n").slice(0, 2).join("\n"), 'import { formatDay } from "~/lib/date";\nimport { cents } from "lib/money";');
  });

  test("a template-literal import(), .js for .ts, .mjs for .mts and an extensionless .tsx keep their form and quotes", async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": tsconfig({ jsx: "react-jsx", paths: { "@/*": ["./src/*"] } }),
      "src/lib/m.mts": "export const m = 1;\n",
      "src/lib/c.tsx": "export const c = 1;\n",
      "src/x/a.ts": "const l = import(`../lib/date.js`);\nimport { m } from \"../lib/m.mjs\";\nimport { c } from '../lib/c';\nexport const z = [l, m, c];\n",
    });
    await toAlias(dir, "src/x/**", "**");
    assert.equal(
      (await readTree(dir))["src/x/a.ts"],
      "const l = import(`@/lib/date.js`);\nimport { m } from \"@/lib/m.mjs\";\nimport { c } from '@/lib/c';\nexport const z = [l, m, c];\n",
    );
  });

  test("imports-to-subpath uses the nearest package.json's imports, not the root's", async () => {
    const dir = await workspace(EXAMPLE, {
      "packages/inner/package.json": '{ "name": "inner", "type": "module", "imports": { "#/*": "./src/*" } }\n',
      "packages/inner/src/util.ts": "export const u = 1;\n",
      "packages/inner/src/deep/use.ts": 'import { u } from "../util.ts";\nexport const z = u;\n',
    });
    await toSubpath(dir, "packages/inner/**", "**");
    assert.equal((await readTree(dir))["packages/inner/src/deep/use.ts"], 'import { u } from "#/util.ts";\nexport const z = u;\n');
  });

  test("a relative path to a sibling whose name starts with \"..\" gets \"./\"", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/x/..foo.ts": "export const f = 1;\n",
      "src/x/a.ts": 'import { f } from "@/x/..foo.ts";\nexport const z = f;\n',
    });
    await toRelative(dir, "src/x/a.ts", "**");
    assert.equal((await readTree(dir))["src/x/a.ts"], 'import { f } from "./..foo.ts";\nexport const z = f;\n');
  });
});

describe("imports-to-alias", () => {
  test("relative and subpath imports become alias imports; alias ones stay", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    assertReport(await toAlias(dir, "src/**", "**"));
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
    await toAlias(dir, "src/**", "src/lib/money.ts");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/components/Invoice.ts", "src/lib/index.ts"]);
    assert.equal(after["src/lib/index.ts"], 'export { formatDay } from "./date.ts";\nexport { cents } from "@/lib/money.ts";\n');
  });

  test("the extension form is kept: none, .ts, a folder for its index file", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/extra/forms.ts": 'import { formatDay } from "../lib/date";\nimport { cents } from "../lib";\nimport type { Day } from "../lib/date.ts";\nexport const x = [formatDay, cents] as const;\nexport type D = Day;\n',
    });
    await toAlias(dir, "src/extra/**", "**");
    assert.equal(
      (await readTree(dir))["src/extra/forms.ts"]?.split("\n").slice(0, 3).join("\n"),
      ['import { formatDay } from "@/lib/date";', 'import { cents } from "@/lib";', 'import type { Day } from "@/lib/date.ts";'].join("\n"),
    );
    assert.deepEqual((await errors(dir, "src/extra/forms.ts")).filter((e) => e.includes("/src/extra/")), []);
  });

  test("import types, re-exports, import(), import = require(), require() and import() types all change", async () => {
    const dir = await workspace(EXAMPLE, { "src/extra/forms.ts": forms("../lib") });
    await toAlias(dir, "src/extra/**", "**");
    assert.equal((await readTree(dir))["src/extra/forms.ts"], forms("@/lib"));
  });

  test("an alias missing from the importer's tsconfig paths is refused, and nothing is written", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const error = await rejects(toAlias(dir, "src/**", "**", "~/"));
    assert.equal(error.code, "INVALID_ARGS");
    assert.deepEqual(await readTree(dir), before);
  });

  test("a target outside the alias folder is left alone; with nothing else to do the run is NO_CHANGES", async () => {
    const dir = await workspace(EXAMPLE, {
      "other/x.ts": "export const x = 1;\n",
      "src/extra/use.ts": 'import { x } from "../../other/x.ts";\nimport { cents } from "../lib/money.ts";\nexport const c = [x, cents];\n',
    });
    await toAlias(dir, "src/extra/**", "**");
    const once = await readTree(dir);
    assert.equal(once["src/extra/use.ts"], 'import { x } from "../../other/x.ts";\nimport { cents } from "@/lib/money.ts";\nexport const c = [x, cents];\n');
    assert.equal((await rejects(toAlias(dir, "src/extra/**", "**"))).code, "NO_CHANGES");
    assert.deepEqual(await readTree(dir), once);
  });

  test("--alias must end in a slash and must not be a subpath prefix", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    assert.equal((await rejects(toAlias(dir, "src/**", "**", "@"))).code, "INVALID_ARGS");
    assert.equal((await rejects(toAlias(dir, "src/**", "**", "#/"))).code, "INVALID_ARGS");
    assert.deepEqual(await readTree(dir), before);
  });
});

describe("imports-to-subpath", () => {
  test("relative and alias imports become subpath imports; subpath ones stay", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    assertReport(await toSubpath(dir, "src/**", "**"));
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

  test("the .ts form is kept; extensionless and folder imports cannot be subpath imports and are left", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/extra/forms.ts": 'import { formatDay } from "../lib/date";\nimport { cents } from "../lib";\nimport type { Day } from "../lib/date.ts";\nexport const x = [formatDay, cents] as const;\nexport type D = Day;\n',
    });
    await toSubpath(dir, "src/extra/**", "**");
    assert.equal(
      (await readTree(dir))["src/extra/forms.ts"]?.split("\n").slice(0, 3).join("\n"),
      ['import { formatDay } from "../lib/date";', 'import { cents } from "../lib";', 'import type { Day } from "#/lib/date.ts";'].join("\n"),
    );
  });

  test("import types, re-exports, import(), import = require(), require() and import() types all change", async () => {
    const dir = await workspace(EXAMPLE, { "src/extra/forms.ts": forms("@/lib") });
    await toSubpath(dir, "src/extra/**", "**");
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
    assert.deepEqual(await readTree(dir), before);
  });

  test("a prefix mapped to something other than one folder is refused", async () => {
    const dir = await workspace(EXAMPLE, { "package.json": '{ "type": "module", "imports": { "#/*": { "types": "./src/*", "default": "./dist/*" } } }\n' });
    const before = await readTree(dir);
    const error = await rejects(toSubpath(dir, "src/**", "**"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.deepEqual(await readTree(dir), before);
  });

  test("--prefix must start with # and end in a slash; --targets is required", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    assert.equal((await rejects(toSubpath(dir, "src/**", "**", "@/"))).code, "INVALID_ARGS");
    assert.equal((await rejects(toSubpath(dir, "src/**", "**", "#"))).code, "INVALID_ARGS");
    assert.equal((await rejects(main(["imports-to-subpath", "--files", "src/**", "--targets", "**"], dir))).code, "INVALID_ARGS");
    assert.equal((await rejects(main(["imports-to-relative", "--files", "src/**"], dir))).code, "INVALID_ARGS");
    assert.deepEqual(await readTree(dir), before);
  });
});
