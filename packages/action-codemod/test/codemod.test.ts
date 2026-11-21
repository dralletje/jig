import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { ActionKind, OkReport, RefactorError } from "@jig/core";
import { HELP_SCHEMA_ID, assertReport, readTree, schemaErrors } from "@jig/test-utils";
import { TRANSFORM_KINDS, help, installedPackage, main } from "../src/index.ts";
import type { CodemodPackage } from "../src/index.ts";

async function rejects(p: Promise<unknown>): Promise<RefactorError> {
  try {
    await p;
  } catch (e) {
    return e as RefactorError;
  }
  throw new Error("expected rejection");
}

const RENAME = `module.exports = (file, api) => api.j(file.source).find(api.j.Identifier, { name: "foo" }).replaceWith("bar").toSource();\n`;
const NOTHING = `module.exports = () => null;\n`;
const THROWS = `module.exports = () => { throw new Error("cannot handle this\\nsecond line"); };\n`;

/** A stand-in for a published codemod package: a folder with `transforms/<name>.js` files. */
async function fakePackage(transforms: Record<string, ActionKind>, sources: Record<string, string> = {}): Promise<CodemodPackage> {
  const dir = await mkdtemp(join(tmpdir(), "fake-codemods-"));
  await mkdir(join(dir, "transforms"));
  for (const name of Object.keys(transforms)) await writeFile(join(dir, "transforms", `${name}.js`), sources[name] ?? RENAME);
  return { name: "fake-codemods", version: "1.2.3", dir, transforms };
}

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jig-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), text);
  }
  return dir;
}

const SRC = "export const foo = 1;\nexport const keep = foo;\n";
const DONE = "export const bar = 1;\nexport const keep = bar;\n";

describe("codemod", () => {
  test("runs the transform over the matching files and reports its kind from the table", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "b.tsx": "const x = <div>{foo}</div>;\n", "notes.md": "foo\n" });
    const report = await main(["codemod", "--transform", "rename", "--files", "*.ts,*.tsx,*.md"], dir, pkg);
    assertReport(report);
    assert.deepEqual(Object.keys(report), ["schema", "ok", "kind", "subject", "summary"]);
    assert.deepEqual(report, {
      schema: "urn:jig:report:1",
      ok: true,
      kind: "rewrite",
      subject: "rewrite(fake-codemods@1.2.3/rename): *.ts, *.tsx, *.md",
      summary: "Ran rename from fake-codemods 1.2.3 on 2 files:\n  a.ts\n  b.tsx",
    });
    const tree = await readTree(dir);
    assert.equal(tree["a.ts"], DONE);
    assert.equal(tree["b.tsx"], "const x = <div>{bar}</div>;\n");
    assert.equal(tree["notes.md"], "foo\n", "only JavaScript and TypeScript files are transformed");
  });

  test("a file the transform leaves alone is not changed or listed", async () => {
    const pkg = await fakePackage({ rename: "rewrite", nothing: "sweep" }, { nothing: NOTHING });
    const dir = await workspace({ "a.ts": SRC, "b.ts": "export const keep = 2;\n" });
    const report = (await main(["codemod", "--transform", "rename", "--files", "*.ts"], dir, pkg)) as OkReport;
    assert.equal(report.summary, "Ran rename from fake-codemods 1.2.3 on 1 file:\n  a.ts");
    assert.equal((await readTree(dir))["b.ts"], "export const keep = 2;\n");
    const none = (await main(["codemod", "--transform", "nothing", "--files", "*.ts"], dir, pkg)) as OkReport;
    assert.equal(none.kind, "sweep");
    assert.equal(none.subject, "sweep(fake-codemods@1.2.3/nothing): *.ts");
    assert.equal(none.summary, "Ran nothing from fake-codemods 1.2.3; it changed no files.");
  });

  test("every transform of the table reports the kind the table gives it", async () => {
    for (const [name, transforms] of Object.entries(TRANSFORM_KINDS)) {
      for (const [transform, kind] of Object.entries(transforms)) {
        const pkg = await fakePackage({ [transform]: kind });
        const dir = await workspace({ "a.ts": SRC });
        const report = (await main(["codemod", "--transform", transform, "--files", "a.ts"], dir, { ...pkg, name })) as OkReport;
        assert.equal(report.kind, kind, `${name}/${transform}`);
        assert.ok(report.subject.startsWith(`${kind}(${name}@1.2.3/${transform}): `), report.subject);
      }
    }
  });

  test("the table holds only valid kinds", () => {
    for (const transforms of Object.values(TRANSFORM_KINDS)) {
      for (const kind of Object.values(transforms)) assert.ok(["refactor", "sweep", "rewrite"].includes(kind), kind);
    }
  });

  test("a file whose transform throws is listed in the summary as not handled, with what to do", async () => {
    const pkg = await fakePackage({ boom: "rewrite", rename: "rewrite" }, { boom: THROWS });
    const dir = await workspace({ "a.ts": SRC, "b.ts": SRC });
    const report = await main(["codemod", "--transform", "boom", "--files", "*.ts"], dir, pkg);
    assertReport(report);
    assert.deepEqual(Object.keys(report), ["schema", "ok", "kind", "subject", "summary"]);
    assert.equal(
      (report as OkReport).summary,
      [
        "Ran boom from fake-codemods 1.2.3; it changed no files.",
        "",
        "Not handled (2):",
        "  a.ts:1: boom failed: cannot handle this",
        "    Apply boom to a.ts by hand, or run again with --parser set to the dialect it uses.",
        "  b.ts:1: boom failed: cannot handle this",
        "    Apply boom to b.ts by hand, or run again with --parser set to the dialect it uses.",
      ].join("\n"),
    );
    assert.equal((await readTree(dir))["a.ts"], SRC);
  });

  test("files changed and files not handled are both in the summary", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "b.ts": "export const = ;\n" });
    const report = (await main(["codemod", "--transform", "rename", "--files", "*.ts"], dir, pkg)) as OkReport;
    assert.match(report.summary, /^Ran rename from fake-codemods 1\.2\.3 on 1 file:\n {2}a\.ts\n\nNot handled \(1\):\n {2}b\.ts:1: rename failed: /);
  });

  test("a parse error's position goes to the path:line, not into the reason", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": "export const a = 1;\nexport const = ;\n" });
    const ok = (await main(["codemod", "--transform", "rename", "--files", "a.ts"], dir, pkg)) as OkReport;
    const line = ok.summary.split("\n").find((l) => l.startsWith("  a.ts:"));
    assert.ok(line, ok.summary);
    assert.match(line, /^ {2}a\.ts:2: rename failed: \S/);
    assert.doesNotMatch(line, /\(\d+:\d+\)/);
  });

  test("a transform that declares parser flow gets it, and --parser flow is accepted", async () => {
    const FLOW = `module.exports = (file, api) => api.j(file.source).find(api.j.Identifier, { name: "x" }).replaceWith("y").toSource();\nmodule.exports.parser = "flow";\n`;
    const pkg = await fakePackage({ flowy: "rewrite" }, { flowy: FLOW });
    const typed = "const x = (1: number);\n"; // a type cast: Flow's parser reads it, Babel's does not
    const dir = await workspace({ "a.js": typed });
    const report = (await main(["codemod", "--transform", "flowy", "--files", "a.js"], dir, pkg)) as OkReport;
    assert.doesNotMatch(report.summary, /Not handled/, report.summary);
    assert.equal((await readTree(dir))["a.js"], "const y = (1: number);\n");
    const plain = await fakePackage({ rename: "rewrite" });
    const other = await workspace({ "a.js": typed });
    const viaFlag = (await main(["codemod", "--transform", "rename", "--files", "a.js", "--parser", "flow"], other, plain)) as OkReport;
    assert.doesNotMatch(viaFlag.summary, /Not handled/, viaFlag.summary);
  });

  test("declaration files are not passed to transforms", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "types.d.ts": "export declare const foo: number;\n", "x.d.mts": "export declare const foo: number;\n" });
    const report = (await main(["codemod", "--transform", "rename", "--files", "**/*.ts,**/*.mts"], dir, pkg)) as OkReport;
    assert.equal(report.summary, "Ran rename from fake-codemods 1.2.3 on 1 file:\n  a.ts");
    assert.equal((await readTree(dir))["types.d.ts"], "export declare const foo: number;\n");
  });

  test("when nothing changed the summary says so instead of listing zero files", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": "export const keep = 2;\n" });
    const report = (await main(["codemod", "--transform", "rename", "--files", "*.ts"], dir, pkg)) as OkReport;
    assert.equal(report.summary, "Ran rename from fake-codemods 1.2.3; it changed no files.");
  });

  test("--parser is accepted: tsx, ts, babel", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    for (const parser of ["tsx", "ts", "babel"]) {
      const dir = await workspace({ "a.ts": SRC });
      await main(["codemod", "--transform", "rename", "--files", "a.ts", "--parser", parser], dir, pkg);
      assert.equal((await readTree(dir))["a.ts"], DONE, parser);
    }
  });

  test("a wrong --parser is INVALID_ARGS", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    const err = await rejects(main(["codemod", "--transform", "rename", "--files", "a.ts", "--parser", "bogus"], dir, pkg));
    assert.equal(err.code, "INVALID_ARGS");
    assert.match(err.instructions, /tsx, ts, babel, flow/);
  });
});

describe("codemod arguments", () => {
  test("an unknown transform is INVALID_ARGS and the instructions list the known ones", async () => {
    const pkg = await fakePackage({ b: "sweep", a: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    const err = await rejects(main(["codemod", "--transform", "nope", "--files", "a.ts"], dir, pkg));
    assert.equal(err.code, "INVALID_ARGS");
    assert.equal(err.instructions, 'Unknown transform "nope". fake-codemods@1.2.3 has: a, b.');
    assert.equal((await readTree(dir))["a.ts"], SRC);
  });

  test("a name from Object.prototype is not a transform", async () => {
    const pkg = await fakePackage({ a: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["codemod", "--transform", "constructor", "--files", "a.ts"], dir, pkg))).code, "INVALID_ARGS");
  });

  test("missing --transform and missing --files are INVALID_ARGS", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["codemod", "--files", "a.ts"], dir, pkg))).code, "INVALID_ARGS");
    assert.equal((await rejects(main(["codemod", "--transform", "rename"], dir, pkg))).code, "INVALID_ARGS");
    assert.equal((await rejects(main(["codemod", "--transform", "rename", "--files", " , "], dir, pkg))).code, "INVALID_ARGS");
  });

  test("an unknown flag is INVALID_ARGS", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["codemod", "--transform", "rename", "--files", "a.ts", "--force"], dir, pkg))).code, "INVALID_ARGS");
  });

  test("an unknown action is UNKNOWN_ACTION", async () => {
    const dir = await workspace({});
    assert.equal((await rejects(main(["format"], dir, await fakePackage({})))).code, "UNKNOWN_ACTION");
  });

  test("CODEMOD_PACKAGE must name a package of the table", () => {
    assert.throws(() => installedPackage({ CODEMOD_PACKAGE: "nope" }), /not a known codemod package/);
    assert.throws(() => installedPackage({}), /not a known codemod package/);
  });
});

describe("codemod help", () => {
  test("is a valid help object with one action, codemod", async () => {
    const h = help(await fakePackage({ rename: "rewrite" }));
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, h), []);
    assert.deepEqual(
      h.actions.map((a) => a.name),
      ["codemod"],
    );
  });

  test("kinds are the distinct kinds of the transforms, in the order refactor, sweep, rewrite", async () => {
    const kinds = async (transforms: Record<string, ActionKind>) => help(await fakePackage(transforms)).actions[0]!.kinds;
    assert.deepEqual(await kinds({ a: "rewrite", b: "sweep", c: "rewrite" }), ["sweep", "rewrite"]);
    assert.deepEqual(await kinds({ a: "rewrite", b: "refactor" }), ["refactor", "rewrite"]);
    assert.deepEqual(await kinds({ a: "sweep" }), ["sweep"]);
  });

  test("--transform is a required choice of the sorted transform names, each named with its kind", async () => {
    const [codemod] = help(await fakePackage({ zeta: "rewrite", alpha: "sweep", mid: "rewrite" })).actions;
    const transform = codemod!.flags.find((f) => f.name === "--transform");
    assert.ok(transform && transform.type === "choice", JSON.stringify(transform));
    assert.deepEqual(transform.choices, ["alpha", "mid", "zeta"]);
    assert.equal(transform.required, true);
    assert.match(transform.description, /alpha\b.*sweep/);
    assert.match(transform.description, /mid\b.*rewrite/);
    assert.match(transform.description, /zeta\b.*rewrite/);
  });

  test("--files is required globs, --parser an optional choice of tsx, ts, babel, flow", async () => {
    const [codemod] = help(await fakePackage({ rename: "rewrite" })).actions;
    assert.deepEqual(
      codemod!.flags.map((f) => f.name),
      ["--transform", "--files", "--parser"],
    );
    const files = codemod!.flags.find((f) => f.name === "--files");
    assert.deepEqual([files?.type, files?.required], ["globs", true]);
    const parser = codemod!.flags.find((f) => f.name === "--parser");
    assert.ok(parser && parser.type === "choice", JSON.stringify(parser));
    assert.deepEqual(parser.choices, ["tsx", "ts", "babel", "flow"]);
    assert.equal(parser.required, false);
  });

  test("every package of the table gives a valid help", async () => {
    for (const [name, transforms] of Object.entries(TRANSFORM_KINDS)) {
      const pkg = await fakePackage(transforms);
      assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, help({ ...pkg, name })), [], name);
    }
  });
});

describe("codemod --files matching", () => {
  const FILES = ["a.ts", "c.tsx", "lib/w.ts", "src/x.ts", "src/deep/y.tsx", "src/.hidden.ts", ".dot/z.ts", "node_modules/m.ts"];

  async function changedBy(globs: string): Promise<string[]> {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace(Object.fromEntries(FILES.map((f) => [f, SRC])));
    try {
      await main(["codemod", "--transform", "rename", "--files", globs], dir, pkg);
      const after = await readTree(dir);
      return Object.keys(after)
        .filter((file) => after[file] !== SRC)
        .sort();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("src/** selects everything under src, dotfiles included", async () => {
    assert.deepEqual(await changedBy("src/**"), ["src/.hidden.ts", "src/deep/y.tsx", "src/x.ts"]);
  });

  test("**/*.ts selects every .ts file at any depth, outside node_modules", async () => {
    assert.deepEqual(await changedBy("**/*.ts"), [".dot/z.ts", "a.ts", "lib/w.ts", "src/.hidden.ts", "src/x.ts"]);
  });

  test("a.ts,c.tsx selects exactly those two", async () => {
    assert.deepEqual(await changedBy("a.ts,c.tsx"), ["a.ts", "c.tsx"]);
  });
});
