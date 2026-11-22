import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { ActionKind, OkReport, RefactorError } from "@jig/core";
import { HELP_SCHEMA_ID, assertReport, readTree, schemaErrors } from "@jig/test-utils";
import { IMAGES, PARSERS, TRANSFORMS, help, installedPackage, main } from "../src/index.ts";
import type { CodemodPackage, TransformInfo } from "../src/index.ts";

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

/**
 * A stand-in for a published codemod package: a folder with `transforms/<name>.js` files, each transform
 * of the given kind and described as "Runs <name>.".
 */
async function fakePackage(kinds: Record<string, ActionKind>, sources: Record<string, string> = {}): Promise<CodemodPackage> {
  const transforms: Record<string, TransformInfo> = {};
  for (const [name, kind] of Object.entries(kinds)) transforms[name] = { kind, description: `Runs ${name}.` };
  return fakePackageOf(transforms, sources);
}

/** A stand-in for a published codemod package with exactly these transforms (the real table's, say). */
async function fakePackageOf(transforms: Record<string, TransformInfo>, sources: Record<string, string> = {}): Promise<CodemodPackage> {
  const dir = await mkdtemp(join(tmpdir(), "fake-codemods-"));
  await mkdir(join(dir, "transforms"));
  for (const name of Object.keys(transforms)) await writeFile(join(dir, "transforms", `${name}.js`), sources[name] ?? RENAME);
  return { image: "codemod-fake", name: "fake-codemods", version: "1.2.3", dir, transforms };
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
  test("runs the transform named by the action over the matching files and reports its kind from the table", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "b.tsx": "const x = <div>{foo}</div>;\n", "notes.md": "foo\n" });
    const report = await main(["rename", "--files", "*.ts,*.tsx,*.md"], dir, pkg);
    assertReport(report);
    assert.deepEqual(Object.keys(report), ["schema", "ok", "kind", "subject", "summary"]);
    assert.deepEqual(report, {
      schema: "urn:jig:report:1",
      ok: true,
      kind: "rewrite",
      subject: "rewrite(codemod-fake rename): *.ts, *.tsx, *.md",
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
    const report = (await main(["rename", "--files", "*.ts"], dir, pkg)) as OkReport;
    assert.equal(report.summary, "Ran rename from fake-codemods 1.2.3 on 1 file:\n  a.ts");
    assert.equal((await readTree(dir))["b.ts"], "export const keep = 2;\n");
    const none = (await main(["nothing", "--files", "*.ts"], dir, pkg)) as OkReport;
    assert.equal(none.kind, "sweep");
    assert.equal(none.subject, "sweep(codemod-fake nothing): *.ts");
    assert.equal(none.summary, "Ran nothing from fake-codemods 1.2.3; it changed no files.");
  });

  test("every transform of the table, run as its action, commits the table's kind and names image and transform", async () => {
    for (const [name, transforms] of Object.entries(TRANSFORMS)) {
      for (const [transform, info] of Object.entries(transforms)) {
        const pkg = await fakePackage({ [transform]: info.kind });
        const dir = await workspace({ "a.ts": SRC });
        const report = (await main([transform, "--files", "a.ts"], dir, { ...pkg, name, image: IMAGES[name]! })) as OkReport;
        assert.equal(report.kind, info.kind, `${name}/${transform}`);
        assert.equal(report.subject, `${info.kind}(${IMAGES[name]} ${transform}): a.ts`);
      }
    }
  });

  test("react-codemod is carried by the image named codemod-react, and every package of the table has an image", () => {
    assert.equal(IMAGES["react-codemod"], "codemod-react");
    assert.deepEqual(Object.keys(IMAGES).sort(), Object.keys(TRANSFORMS).sort());
    for (const image of Object.values(IMAGES)) assert.match(image, /^[^\s()]+$/);
  });

  test("sort-comp of react-codemod commits sweep(codemod-react sort-comp)", async () => {
    const info = TRANSFORMS["react-codemod"]!["sort-comp"]!;
    const pkg = { ...(await fakePackage({ "sort-comp": info.kind })), name: "react-codemod", image: "codemod-react" };
    const report = (await main(["sort-comp", "--files", "src/**"], await workspace({ "src/a.ts": SRC }), pkg)) as OkReport;
    assert.equal(report.subject, "sweep(codemod-react sort-comp): src/**");
  });

  test("the table holds only valid kinds and one-line descriptions", () => {
    for (const transforms of Object.values(TRANSFORMS)) {
      for (const [transform, info] of Object.entries(transforms)) {
        assert.ok(["refactor", "sweep", "rewrite"].includes(info.kind), `${transform}: ${info.kind}`);
        assert.match(info.description, /^[^\r\n]+\.$/, transform);
      }
    }
  });

  test("a file whose transform throws is listed in the summary as not handled, with what to do", async () => {
    const pkg = await fakePackage({ boom: "rewrite", rename: "rewrite" }, { boom: THROWS });
    const dir = await workspace({ "a.ts": SRC, "b.ts": SRC });
    const report = await main(["boom", "--files", "*.ts"], dir, pkg);
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
    const report = (await main(["rename", "--files", "*.ts"], dir, pkg)) as OkReport;
    assert.match(report.summary, /^Ran rename from fake-codemods 1\.2\.3 on 1 file:\n {2}a\.ts\n\nNot handled \(1\):\n {2}b\.ts:1: rename failed: /);
  });

  test("a parse error's position goes to the path:line, not into the reason", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": "export const a = 1;\nexport const = ;\n" });
    const ok = (await main(["rename", "--files", "a.ts"], dir, pkg)) as OkReport;
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
    const report = (await main(["flowy", "--files", "a.js"], dir, pkg)) as OkReport;
    assert.doesNotMatch(report.summary, /Not handled/, report.summary);
    assert.equal((await readTree(dir))["a.js"], "const y = (1: number);\n");
    const plain = await fakePackage({ rename: "rewrite" });
    const other = await workspace({ "a.js": typed });
    const viaFlag = (await main(["rename", "--files", "a.js", "--parser", "flow"], other, plain)) as OkReport;
    assert.doesNotMatch(viaFlag.summary, /Not handled/, viaFlag.summary);
  });

  test("declaration files are not passed to transforms", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "types.d.ts": "export declare const foo: number;\n", "x.d.mts": "export declare const foo: number;\n" });
    const report = (await main(["rename", "--files", "**/*.ts,**/*.mts"], dir, pkg)) as OkReport;
    assert.equal(report.summary, "Ran rename from fake-codemods 1.2.3 on 1 file:\n  a.ts");
    assert.equal((await readTree(dir))["types.d.ts"], "export declare const foo: number;\n");
  });

  test("when nothing changed the summary says so instead of listing zero files", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": "export const keep = 2;\n" });
    const report = (await main(["rename", "--files", "*.ts"], dir, pkg)) as OkReport;
    assert.equal(report.summary, "Ran rename from fake-codemods 1.2.3; it changed no files.");
  });

  test("--parser is accepted: tsx, ts, babel", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    for (const parser of ["tsx", "ts", "babel"]) {
      const dir = await workspace({ "a.ts": SRC });
      await main(["rename", "--files", "a.ts", "--parser", parser], dir, pkg);
      assert.equal((await readTree(dir))["a.ts"], DONE, parser);
    }
  });

  test("a wrong --parser is INVALID_ARGS", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    const err = await rejects(main(["rename", "--files", "a.ts", "--parser", "bogus"], dir, pkg));
    assert.equal(err.code, "INVALID_ARGS");
    assert.match(err.instructions, /tsx, ts, babel, flow/);
  });
});

describe("codemod arguments", () => {
  test("an unknown action is UNKNOWN_ACTION and the instructions list the transforms", async () => {
    const pkg = await fakePackage({ b: "sweep", a: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    const err = await rejects(main(["nope", "--files", "a.ts"], dir, pkg));
    assert.equal(err.code, "UNKNOWN_ACTION");
    assert.equal(err.instructions, 'Unknown action "nope". This image has: a, b.');
    assert.equal((await readTree(dir))["a.ts"], SRC);
  });

  test("codemod is no longer an action, and no arguments at all is UNKNOWN_ACTION", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    const err = await rejects(main(["codemod", "--transform", "rename", "--files", "a.ts"], dir, pkg));
    assert.equal(err.code, "UNKNOWN_ACTION");
    assert.equal(err.instructions, 'Unknown action "codemod". This image has: rename.');
    assert.equal((await rejects(main([], dir, pkg))).code, "UNKNOWN_ACTION");
    assert.equal((await readTree(dir))["a.ts"], SRC);
  });

  test("a name from Object.prototype is not an action", async () => {
    const pkg = await fakePackage({ a: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["constructor", "--files", "a.ts"], dir, pkg))).code, "UNKNOWN_ACTION");
  });

  test("missing --files is INVALID_ARGS", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["rename"], dir, pkg))).code, "INVALID_ARGS");
    assert.equal((await rejects(main(["rename", "--files", " , "], dir, pkg))).code, "INVALID_ARGS");
  });

  test("an unknown flag is INVALID_ARGS, --transform too", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["rename", "--files", "a.ts", "--force"], dir, pkg))).code, "INVALID_ARGS");
    const err = await rejects(main(["rename", "--transform", "rename", "--files", "a.ts"], dir, pkg));
    assert.equal(err.code, "INVALID_ARGS");
    assert.match(err.instructions, /rename takes --files <glob,glob> \[--parser tsx\|ts\|babel\|flow\]/);
  });

  test("CODEMOD_PACKAGE must name a package of the table", () => {
    assert.throws(() => installedPackage({ CODEMOD_PACKAGE: "nope" }), /not a known codemod package/);
    assert.throws(() => installedPackage({}), /not a known codemod package/);
  });
});

describe("codemod help", () => {
  test("is a valid help object with one action per transform, sorted, each with its kind and description", async () => {
    const h = help(await fakePackage({ zeta: "rewrite", alpha: "sweep", mid: "refactor" }));
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, h), []);
    assert.deepEqual(
      h.actions.map((a) => [a.name, a.kinds, a.summary]),
      [
        ["alpha", ["sweep"], "Runs alpha."],
        ["mid", ["refactor"], "Runs mid."],
        ["zeta", ["rewrite"], "Runs zeta."],
      ],
    );
  });

  test("the real table gives 14 actions, each with the kind its run commits and the transform's description", async () => {
    for (const [name, transforms] of Object.entries(TRANSFORMS)) {
      const pkg = { ...(await fakePackageOf(transforms)), name };
      const actions = help(pkg).actions;
      assert.deepEqual(
        actions.map((action) => action.name),
        Object.keys(transforms).sort(),
      );
      if (name === "react-codemod") assert.equal(actions.length, 14);
      for (const action of actions) {
        assert.deepEqual(action.kinds, [transforms[action.name]!.kind], action.name);
        assert.equal(action.summary, transforms[action.name]!.description);
        const dir = await workspace({ "a.ts": SRC });
        const report = (await main([action.name, "--files", "a.ts"], dir, pkg)) as OkReport;
        assert.equal(report.kind, action.kinds[0], `${name}/${action.name}`);
      }
    }
  });

  test("every action takes --files, required globs, and --parser, an optional choice of tsx, ts, babel, flow; no --transform", async () => {
    for (const action of help(await fakePackage({ rename: "rewrite", other: "sweep" })).actions) {
      assert.deepEqual(
        action.flags.map((f) => f.name),
        ["--files", "--parser"],
      );
      const files = action.flags.find((f) => f.name === "--files");
      assert.deepEqual([files?.type, files?.required], ["globs", true]);
      const parser = action.flags.find((f) => f.name === "--parser");
      assert.ok(parser && parser.type === "choice", JSON.stringify(parser));
      assert.deepEqual(
        parser.choices.map((choice) => choice.name),
        ["tsx", "ts", "babel", "flow"],
      );
      assert.ok(parser.choices.every((choice) => choice.description.length > 0 && Object.keys(choice).length === 2));
      assert.equal(parser.required, false);
    }
  });

  test("--parser's choices are exactly the parsers main accepts, in order", async () => {
    const parser = help(await fakePackage({ rename: "rewrite" })).actions[0]!.flags.find((f) => f.name === "--parser");
    assert.ok(parser && parser.type === "choice", JSON.stringify(parser));
    assert.deepEqual(
      parser.choices.map((choice) => choice.name),
      [...PARSERS],
    );
  });

  test("every package of the table gives a valid help", async () => {
    for (const [name, transforms] of Object.entries(TRANSFORMS)) {
      const pkg = await fakePackageOf(transforms);
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
      await main(["rename", "--files", globs], dir, pkg);
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
