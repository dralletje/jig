import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const addExtensions = (dir: string, files: string) => main(["add-import-extensions", "--files", files], dir);

/** `before` with each `[old, new]` replaced once (and asserted to be there). */
function edited(before: string | undefined, ...replacements: [string, string][]): string {
  let text = before ?? "";
  for (const [from, to] of replacements) {
    assert.ok(text.includes(from), `missing: ${from}`);
    text = text.replace(from, to);
  }
  return text;
}

const WEBAPP_TSCONFIG_AFTER = `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "esnext",
    "skipLibCheck": true,
    "types": [],
    "paths": {
      "@/*": ["./src/*"]
    },
    "allowImportingTsExtensions": true
  },
  "include": ["src"]
}
`;

describe("add-import-extensions on examples/webapp", () => {
  test("relative imports, re-exports and dynamic imports get the file's extension; the tsconfig allows it", async () => {
    const dir = await workspace("examples/webapp");
    const before = await readTree(dir);
    const report = await addExtensions(dir, "src/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.subject, "sweep(typescript add-import-extensions): src/**");
    assert.match(ok.summary, /^Added extensions to \d+ relative imports in 8 files, and set allowImportingTsExtensions in tsconfig\.json:\n  src\/lib\/index\.ts\n/);
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), [
      "src/lib/index.ts",
      "src/lib/strings/index.ts",
      "src/models/index.ts",
      "src/reports.ts",
      "src/services/index.ts",
      "src/services/userService.ts",
      "src/setup/index.ts",
      "src/widgets/index.ts",
      "tsconfig.json",
    ]);
    assert.equal(after["tsconfig.json"], WEBAPP_TSCONFIG_AFTER);
    // `./dir` → `./dir/index.ts`; `export type … from` keeps its `type`; named re-exports keep their aliases.
    assert.equal(
      after["src/lib/index.ts"],
      [
        'export * from "./math.ts";',
        'export { formatDate, formatCurrency as currency, formatPrice } from "./format.ts";',
        'export * from "./strings/index.ts";',
        'export type { Level } from "./logger.ts";',
        "",
      ].join("\n"),
    );
    assert.equal(
      after["src/reports.ts"],
      edited(before["src/reports.ts"], ['import("./lib/math")', 'import("./lib/math.ts")']),
    );
    assert.equal(
      after["src/services/userService.ts"],
      edited(before["src/services/userService.ts"], ['from "./store";', 'from "./store.ts";']),
    );
    // Alias imports (`@/…`) are not relative: left as they are.
    assert.equal(after["src/main.ts"], before["src/main.ts"]);
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("a second run changes nothing (NO_CHANGES for the host)", async () => {
    const dir = await workspace("examples/webapp");
    await addExtensions(dir, "src/**");
    const once = await readTree(dir);
    await addExtensions(dir, "src/**");
    assert.deepEqual(await readTree(dir), once);
  });

  test("side-effect and type-only imports stay intact, quotes are kept, template dynamic imports count", async () => {
    const dir = await workspace("examples/webapp", {
      "src/extra/side.ts": "export const side = 1;\n",
      "src/extra/types.d.ts": "export interface T {\n  a: number;\n}\n",
      "src/extra/use.ts": [
        "import './side';",
        'import type { T } from "./types";',
        'import { type Level } from "../lib/logger";',
        'export { sum } from "../lib/math";',
        'export * as strings from "../lib/strings";',
        "",
        "export const later = () => import(`../lib/format`);",
        'const where = "./side";',
        "export const dynamic = () => import(where);",
        'export type Both = [T, Level, typeof import("../lib/math")];',
        "",
      ].join("\n"),
    });
    const before = await readTree(dir);
    await addExtensions(dir, "src/extra/**");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), ["src/extra/use.ts", "tsconfig.json"]);
    assert.equal(
      after["src/extra/use.ts"],
      [
        "import './side.ts';",
        // A declaration file has no extension to import it by: left as is.
        'import type { T } from "./types";',
        'import { type Level } from "../lib/logger.ts";',
        'export { sum } from "../lib/math.ts";',
        'export * as strings from "../lib/strings/index.ts";',
        "",
        "export const later = () => import(`../lib/format.ts`);",
        'const where = "./side";',
        "export const dynamic = () => import(where);",
        'export type Both = [T, Level, typeof import("../lib/math")];',
        "",
      ].join("\n"),
    );
    assert.deepEqual(await errors(dir, "src/extra/use.ts"), []);
  });

  test("an unresolved relative import is left as is", async () => {
    const dir = await workspace("examples/webapp", {
      "src/extra/use.ts": '// @ts-ignore\nimport { x } from "./missing";\nimport { sum } from "../lib/math";\n\nexport const y = [x, sum];\n',
    });
    await addExtensions(dir, "src/extra/**");
    assert.equal(
      (await readTree(dir))["src/extra/use.ts"],
      '// @ts-ignore\nimport { x } from "./missing";\nimport { sum } from "../lib/math.ts";\n\nexport const y = [x, sum];\n',
    );
  });

  test("REFACTOR_UNAVAILABLE when the tsconfig has neither noEmit nor emitDeclarationOnly", async () => {
    const dir = await workspace("examples/webapp", {
      "tsconfig.json": '{\n  "compilerOptions": {\n    "strict": true,\n    "module": "esnext",\n    "moduleResolution": "bundler"\n  }\n}\n',
    });
    const before = await readTree(dir);
    const err = await rejects(addExtensions(dir, "src/**"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.equal(
      err.message,
      "tsconfig.json: allowImportingTsExtensions needs noEmit or emitDeclarationOnly, and neither is set. Set one of them first, then run again.",
    );
    assert.deepEqual(await readTree(dir), before);
  });

  test("without noEmit, nothing to rewrite is not a refusal", async () => {
    const dir = await workspace("examples/webapp", {
      "tsconfig.json": '{\n  "compilerOptions": {\n    "strict": true,\n    "module": "esnext",\n    "moduleResolution": "bundler"\n  }\n}\n',
    });
    const before = await readTree(dir);
    await addExtensions(dir, "src/main.ts");
    assert.deepEqual(await readTree(dir), before);
  });

  test("emitDeclarationOnly is enough; a flag already set leaves the tsconfig alone", async () => {
    const declOnly =
      '{\n  "compilerOptions": { "declaration": true, "emitDeclarationOnly": true, "module": "esnext", "moduleResolution": "bundler", "paths": { "@/*": ["./src/*"] } }\n}\n';
    const dir = await workspace("examples/webapp", { "tsconfig.json": declOnly });
    await addExtensions(dir, "src/services/**");
    assert.equal(
      (await readTree(dir))["tsconfig.json"],
      declOnly.replace(' } }\n}', ' }, "allowImportingTsExtensions": true }\n}'),
    );

    const already =
      '{\n  // comments are fine\n  "compilerOptions": {\n    "noEmit": true,\n    "allowImportingTsExtensions": true,\n    "module": "esnext",\n    "moduleResolution": "bundler",\n    "paths": { "@/*": ["./src/*"] },\n  },\n}\n';
    const dir2 = await workspace("examples/webapp", { "tsconfig.json": already });
    const before = await readTree(dir2);
    await addExtensions(dir2, "src/services/**");
    const after = await readTree(dir2);
    assert.deepEqual(changed(before, after), ["src/services/index.ts", "src/services/userService.ts"]);
  });

  test("a trailing comma and comments in the tsconfig are kept", async () => {
    const tsconfig = '{\n  "compilerOptions": {\n    // no output\n    "noEmit": true,\n    "moduleResolution": "bundler",\n    "module": "esnext",\n  },\n}\n';
    const dir = await workspace("examples/webapp", { "tsconfig.json": tsconfig });
    await addExtensions(dir, "src/services/**");
    assert.equal(
      (await readTree(dir))["tsconfig.json"],
      tsconfig.replace('"module": "esnext",', '"module": "esnext",\n    "allowImportingTsExtensions": true,'),
    );
  });

  test("globs that match no file are NO_CHANGES", async () => {
    const dir = await workspace("examples/webapp");
    assert.equal((await rejects(addExtensions(dir, "nope/**"))).code, "NO_CHANGES");
  });
});

describe("add-import-extensions on other examples", () => {
  test("examples/react-app: .tsx targets", async () => {
    const dir = await workspace("examples/react-app");
    const before = await readTree(dir);
    await addExtensions(dir, "src/**");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), [
      "src/App.tsx",
      "src/components/Counter.tsx",
      "src/index.tsx",
      "tsconfig.json",
    ]);
    assert.equal(after["src/index.tsx"], edited(before["src/index.tsx"], ['from "./App";', 'from "./App.tsx";']));
    assert.equal(
      after["src/App.tsx"],
      edited(before["src/App.tsx"], ['from "./components/Counter";', 'from "./components/Counter.tsx";']),
    );
    assert.ok(after["tsconfig.json"]?.includes('"allowImportingTsExtensions": true'));
  });

  test("examples/monorepo: each package's own tsconfig gets the flag", async () => {
    const dir = await workspace("examples/monorepo");
    const before = await readTree(dir);
    await addExtensions(dir, "**");
    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), [
      "packages/app/src/lib/index.ts",
      "packages/app/src/main.ts",
      "packages/app/src/ui/index.ts",
      "packages/app/src/view.ts",
      "packages/app/tsconfig.json",
      "packages/shared/src/index.ts",
      "packages/shared/src/text/index.ts",
      "packages/shared/tsconfig.json",
    ]);
    assert.equal(
      after["packages/shared/src/index.ts"],
      'export * from "./ids.ts";\nexport * from "./text/index.ts";\n',
    );
    assert.deepEqual(await errors(dir, "packages/app/src/main.ts"), []);
    assert.deepEqual(await errors(dir, "packages/shared/src/index.ts"), []);
  });

  test("REFACTOR_UNAVAILABLE without a tsconfig to set the flag in", async () => {
    const dir = await workspace("examples/monorepo", {
      "scripts/a.ts": "export const a = 1;\n",
      "scripts/b.ts": 'import { a } from "./a";\n\nexport const b = a;\n',
    });
    const before = await readTree(dir);
    const err = await rejects(addExtensions(dir, "scripts/**"));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.equal(err.message, "scripts/b.ts: no tsconfig.json to set allowImportingTsExtensions in. Add one, or leave this file out of --files.");
    assert.deepEqual(await readTree(dir), before);
  });
});
