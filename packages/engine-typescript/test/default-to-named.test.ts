import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { changed, errors, rejects, workspace } from "./helpers.ts";

const EXAMPLE = "examples/default-to-named";

const run = (dir: string, files: string, keep?: string) =>
  main(["default-to-named", "--files", files, ...(keep ? ["--keep", keep] : [])], dir);

describe("default-to-named on examples/default-to-named", () => {
  test("function, class, const and specifier defaults become named; importers and re-exports follow; skipped files listed as not handled", async () => {
    const dir = await workspace(EXAMPLE);
    const before = await readTree(dir);
    const report = await run(dir, "src/**", "src/routes/**");
    assertReport(report);
    const ok = report as OkReport;
    assert.equal(ok.subject, "sweep(typescript default-to-named): src/** (keeping src/routes/**)");
    assert.equal(ok.kind, "sweep");
    assert.equal(
      ok.summary,
      [
        "Converted the default exports of 5 files to named exports and updated 2 importing files:",
        "  src/config.ts: `config`",
        "  src/lib/format.ts: `formatPrice`",
        "  src/models/Order.ts: `Order`",
        "  src/services/mailer.ts: `sendReceipt`",
        "  src/services/store.ts: `Store`",
        "",
        "Not handled (2):",
        "  src/pages/dashboard.ts:1: the default export is still needed where it is loaded (import(), a namespace, JavaScript or a mock)",
        "    src/pages/dashboard.ts stays as it is because these places need its default export:",
        "    - src/pages/loader.ts:1 (dynamic import())",
        "    Change each to use the named export `Dashboard` by hand (for a lazy import: `import(\"…\").then((m) => ({ default: m.Dashboard }))`), then run again.",
        "  src/pages/home.ts:1: the default export has no name to give a named export",
        "    Give the function a name (`export default function name`) in src/pages/home.ts, then run again.",
      ].join("\n"),
    );

    const after = await readTree(dir);
    assert.deepEqual(changed(before, after), [
      "src/config.ts",
      "src/index.ts",
      "src/lib/format.ts",
      "src/models/Order.ts",
      "src/services/checkout.ts",
      "src/services/mailer.ts",
      "src/services/store.ts",
    ]);
    // Function, class, const (`export default config;`) and `export { Store as default }`.
    assert.equal(after["src/lib/format.ts"], before["src/lib/format.ts"]?.replace("export default function", "export function"));
    assert.equal(after["src/models/Order.ts"], before["src/models/Order.ts"]?.replace("export default class", "export class"));
    assert.equal(after["src/services/mailer.ts"], before["src/services/mailer.ts"]?.replace("export default async function", "export async function"));
    assert.equal(after["src/config.ts"], before["src/config.ts"]?.replace("export default config;", "export { config };"));
    assert.equal(after["src/services/store.ts"], before["src/services/store.ts"]?.replace("export { Store as default };", "export { Store };"));
    // Importers: `as` where the local name differs, merged with the existing named import.
    assert.equal(
      after["src/services/checkout.ts"],
      [
        'import { config, type Config } from "../config";',
        'import { formatPrice as fmt } from "../lib/format";',
        'import { Order } from "../models/Order";',
        'import { sendReceipt } from "./mailer";',
        'import { Store } from "./store";',
        "",
        "const store = new Store();",
        "",
        "export async function checkout(order: Order, email: string): Promise<string> {",
        "  const settings: Config = config;",
        "  store.put(email, order.total());",
        "  const ok = await sendReceipt(email, `Total: ${fmt(order.total())} ${settings.currency}`);",
        '  return ok ? "sent" : "failed";',
        "}",
        "",
      ].join("\n"),
    );
    // Re-exports: `default as X` becomes `Name as X`; `export { default }` keeps exporting `default`.
    assert.equal(
      after["src/index.ts"],
      [
        'export { Order } from "./models/Order";',
        'export { formatPrice } from "./lib/format";',
        'export { config } from "./config";',
        'export { sendReceipt as default } from "./services/mailer";',
        'export type { OrderLine } from "./models/Order";',
        "",
      ].join("\n"),
    );
    // --keep: untouched, so are the refused files.
    assert.equal(after["src/routes/about.ts"], before["src/routes/about.ts"]);
    assert.equal(after["src/pages/home.ts"], before["src/pages/home.ts"]);
    assert.equal(after["src/pages/dashboard.ts"], before["src/pages/dashboard.ts"]);
    assert.deepEqual(await errors(dir, "src/main.ts"), []);
  });

  test("without --keep a route module is converted too", async () => {
    const dir = await workspace(EXAMPLE);
    const report = (await run(dir, "src/routes/**")) as OkReport;
    assertReport(report);
    assert.doesNotMatch(report.summary, /Not handled/);
    assert.equal((await readTree(dir))["src/routes/about.ts"], 'export function About(): string {\n  return "about";\n}\n');
  });

  test("--keep skipping every match leaves nothing to do: NO_CHANGES", async () => {
    const dir = await workspace(EXAMPLE);
    const error = await rejects(run(dir, "src/routes/**", "src/routes/**"));
    assert.equal(error.code, "NO_CHANGES");
  });

  test("a second run finds nothing to convert", async () => {
    const dir = await workspace(EXAMPLE);
    await run(dir, "src/**", "src/routes/**");
    // What is left is only the refused files.
    const error = await rejects(run(dir, "src/lib/**,src/models/**,src/config.ts"));
    assert.equal(error.code, "NO_CHANGES");
  });

  test("the summary stays the same when code moves above the changed places", async () => {
    const plain = (await run(await workspace(EXAMPLE), "src/**", "src/routes/**")) as OkReport;
    const moved = (await run(
      await workspace(EXAMPLE, {
        "src/lib/format.ts": `// a comment\n\nconst unrelated = 1;\nexport const other = unrelated;\n\nexport default function formatPrice(cents: number): string {\n  return \`$\${(cents / 100).toFixed(2)}\`;\n}\n`,
        "src/services/checkout.ts": `// moved\n\n\n${(await readTree(await workspace(EXAMPLE)))["src/services/checkout.ts"]}`,
      }),
      "src/**",
      "src/routes/**",
    )) as OkReport;
    assert.equal(moved.summary, plain.summary);
  });
});

describe("default-to-named import forms", () => {
  const EXTRA = {
    "src/x/widget.ts": "export default function widget(): number {\n  return 1;\n}\n",
    "src/x/user-a.ts": 'import w from "./widget";\n\nexport const a = w();\n',
    "src/x/user-b.ts": 'import widget, { type Thing } from "./widget";\n\nexport const b: Thing | undefined = undefined;\nexport const c = widget();\n',
    "src/x/user-c.ts": 'import { default as renamed } from "./widget";\n\nexport const d = renamed();\n',
    "src/x/user-d.ts": 'import w, * as all from "./widget";\n\nexport const e = [w(), all.extra];\n',
    "src/x/user-e.ts": 'import type W from "./shape";\n\nexport const f: W | undefined = undefined;\n',
    "src/x/shape.ts": "export default interface Shape {\n  sides: number;\n}\n",
    "src/x/user-f.ts": 'export { default } from "./widget";\nexport type { default as Sh } from "./shape";\n',
  };

  test("importers with another local name use `as`; type-only, namespace and merged forms are kept valid", async () => {
    // `Thing` is not exported by widget: add it so the project is valid before and after.
    const dir = await workspace(EXAMPLE, {
      ...EXTRA,
      "src/x/widget.ts": "export type Thing = { id: number };\nexport const extra = 2;\n\nexport default function widget(): number {\n  return 1;\n}\n",
    });
    assert.deepEqual(await errors(dir, "src/x/widget.ts"), []);
    const report = (await run(dir, "src/x/**")) as OkReport;
    assertReport(report);
    assert.doesNotMatch(report.summary, /Not handled/);
    const after = await readTree(dir);
    assert.equal(after["src/x/user-a.ts"], 'import { widget as w } from "./widget";\n\nexport const a = w();\n');
    assert.equal(after["src/x/user-b.ts"], 'import { widget, type Thing } from "./widget";\n\nexport const b: Thing | undefined = undefined;\nexport const c = widget();\n');
    assert.equal(after["src/x/user-c.ts"], 'import { widget as renamed } from "./widget";\n\nexport const d = renamed();\n');
    assert.equal(after["src/x/user-d.ts"], 'import * as all from "./widget";\nimport { widget as w } from "./widget";\n\nexport const e = [w(), all.extra];\n');
    assert.equal(after["src/x/user-e.ts"], 'import type { Shape as W } from "./shape";\n\nexport const f: W | undefined = undefined;\n');
    assert.equal(after["src/x/shape.ts"], "export interface Shape {\n  sides: number;\n}\n");
    assert.equal(after["src/x/user-f.ts"], 'export { widget as default } from "./widget";\nexport type { Shape as Sh } from "./shape";\n');
    assert.deepEqual(await errors(dir, "src/x/widget.ts"), []);
  });

  test("`export const X` plus `export default X` keeps one named export", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/y/limit.ts": "export const limit = 10;\nexport default limit;\n",
      "src/y/use.ts": 'import max from "./limit";\n\nexport const doubled = max * 2;\n',
    });
    const report = (await run(dir, "src/y/**")) as OkReport;
    assertReport(report);
    const after = await readTree(dir);
    assert.equal(after["src/y/limit.ts"], "export const limit = 10;\n");
    assert.equal(after["src/y/use.ts"], 'import { limit as max } from "./limit";\n\nexport const doubled = max * 2;\n');
    assert.deepEqual(await errors(dir, "src/y/use.ts"), []);
  });

  test("`export default abstract class` and a decorated-free async function lose only `default`", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/z/base.ts": "export default abstract class Base {\n  abstract id(): string;\n}\n",
      "src/z/impl.ts": 'import Base from "./base";\n\nexport class Impl extends Base {\n  id() {\n    return "x";\n  }\n}\n',
    });
    await run(dir, "src/z/**");
    const after = await readTree(dir);
    assert.equal(after["src/z/base.ts"], "export abstract class Base {\n  abstract id(): string;\n}\n");
    assert.equal(after["src/z/impl.ts"]?.startsWith('import { Base } from "./base";'), true);
    assert.deepEqual(await errors(dir, "src/z/impl.ts"), []);
  });

  test("a namespace import that reads `.default` leaves that file not handled", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/n/thing.ts": "export default function thing() {\n  return 1;\n}\n",
      "src/n/other.ts": "export default function other() {\n  return 2;\n}\n",
      "src/n/use.ts": 'import * as t from "./thing";\n\nexport const x = t.default();\n',
    });
    const report = (await run(dir, "src/n/**")) as OkReport;
    assertReport(report);
    assert.match(report.summary, /\n\nNot handled \(1\):\n {2}src\/n\/thing\.ts:1: the default export is still needed where it is loaded/);
    assert.match(report.summary, /\n {4}- src\/n\/use\.ts:3 \(namespace import `t`\)\n/);
    const after = await readTree(dir);
    assert.equal(after["src/n/thing.ts"], "export default function thing() {\n  return 1;\n}\n");
    assert.equal(after["src/n/other.ts"], "export function other() {\n  return 2;\n}\n");
  });
});

describe("default-to-named anonymous defaults", () => {
  test("an anonymous default is listed as not handled when other files were converted", async () => {
    const dir = await workspace(EXAMPLE);
    const report = (await run(dir, "src/pages/home.ts,src/lib/format.ts")) as OkReport;
    assertReport(report);
    assert.match(report.summary, /\n\nNot handled \(1\):\n {2}src\/pages\/home\.ts:1: the default export has no name to give a named export\n {4}Give the function a name/);
  });

  test("an anonymous default alone is NO_CHANGES with instructions listing the skipped files; nothing is written", async () => {
    const dir = await workspace(EXAMPLE, {
      "src/a/arrow.ts": "export default () => 1;\n",
      "src/a/cls.ts": "export default class {}\n",
    });
    const before = await readTree(dir);
    const error = await rejects(run(dir, "src/a/**,src/pages/home.ts"));
    assert.equal(error.code, "NO_CHANGES");
    assert.match(error.message, /src\/a\/arrow\.ts: .*Assign it to a named const/);
    assert.match(error.message, /src\/a\/cls\.ts: .*Give the class a name/);
    assert.match(error.message, /src\/pages\/home\.ts: /);
    assert.deepEqual(await readTree(dir), before);
  });
});

describe("default-to-named JavaScript and mock users", () => {
  const TS_MODULES = {
    "src/j/widget.ts": "export default function widget(): number {\n  return 1;\n}\n",
    "src/j/ok.ts": "export default function ok(): number {\n  return 2;\n}\n",
  };

  test("a JS importer of the default blocks that file: not handled, JS and file untouched, others converted", async () => {
    const dir = await workspace(EXAMPLE, {
      ...TS_MODULES,
      "src/j/use.js": 'import w from "./widget";\n\nexport const a = w();\n',
    });
    const before = await readTree(dir);
    const report = (await run(dir, "src/j/**")) as OkReport;
    assertReport(report);
    assert.match(report.summary, /\n\nNot handled \(1\):\n {2}src\/j\/widget\.ts:1: /);
    assert.match(report.summary, /\n {4}- src\/j\/use\.js:1 /);
    const after = await readTree(dir);
    assert.equal(after["src/j/widget.ts"], before["src/j/widget.ts"]);
    assert.equal(after["src/j/use.js"], before["src/j/use.js"]);
    assert.equal(after["src/j/ok.ts"], "export function ok(): number {\n  return 2;\n}\n");
  });

  test("a JS named-only import does not block", async () => {
    const dir = await workspace(EXAMPLE, {
      ...TS_MODULES,
      "src/j/use.js": 'import { other } from "./widget";\n\nexport const a = other;\n',
    });
    const report = (await run(dir, "src/j/widget.ts")) as OkReport;
    assert.doesNotMatch(report.summary, /Not handled/);
  });

  test("require(...).default in a JS file blocks, also through a .js extension specifier", async () => {
    const dir = await workspace(EXAMPLE, {
      ...TS_MODULES,
      "src/j/free.ts": "export default function free(): number {\n  return 4;\n}\n",
      "src/j/use.cjs": 'const w = require("./widget").default;\nmodule.exports = w;\n',
      "src/j/use2.mjs": 'const m = await import("./ok.js");\nexport default m.default;\n',
    });
    const report = (await run(dir, "src/j/**")) as OkReport;
    assert.match(report.summary, /\n\nNot handled \(2\):\n {2}src\/j\/ok\.ts:1: [^\n]*\n(?: {4}[^\n]*\n)+ {2}src\/j\/widget\.ts:1: /);
  });

  test("a vi.mock factory returning default blocks the mocked file", async () => {
    const dir = await workspace(EXAMPLE, {
      ...TS_MODULES,
      "src/j/widget.test.ts": 'declare const vi: { mock(path: string, f: () => unknown): void };\nvi.mock("./widget", () => ({ default: () => 3 }));\nexport {};\n',
    });
    const report = (await run(dir, "src/j/widget.ts,src/j/ok.ts")) as OkReport;
    assert.match(report.summary, /\n\nNot handled \(1\):\n {2}src\/j\/widget\.ts:1: /);
    assert.match(report.summary, /\n {4}- src\/j\/widget\.test\.ts:2 \(vi\.mock/);
  });

  test("rerun after a partial result is NO_CHANGES and lists the skipped files", async () => {
    const dir = await workspace(EXAMPLE, {
      ...TS_MODULES,
      "src/j/use.js": 'import w from "./widget";\nexport const a = w();\n',
    });
    await run(dir, "src/j/**");
    const error = await rejects(run(dir, "src/j/**"));
    assert.equal(error.code, "NO_CHANGES");
    assert.match(error.message, /src\/j\/widget\.ts: /);
    assert.match(error.message, /src\/j\/use\.js:1/);
  });

  test("one file left: `Not handled (1)` with its place, reason and what to do", async () => {
    const dir = await workspace(EXAMPLE, {
      ...TS_MODULES,
      "src/j/use.js": 'import w from "./widget";\nexport const a = w();\n',
    });
    const report = (await run(dir, "src/j/**")) as OkReport;
    assert.match(report.summary, /\n\nNot handled \(1\):\n {2}src\/j\/widget\.ts:1: the default export is still needed where it is loaded \(import\(\), a namespace, JavaScript or a mock\)\n {4}src\/j\/widget\.ts stays as it is because these places need its default export:\n {4}- src\/j\/use\.js:1 \(JavaScript import\)\n {4}Change each to use the named export `widget` by hand/);
  });
});
