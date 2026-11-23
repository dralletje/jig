import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { ActionKind, RefactorError } from "@jig/core";
import { assertReport, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
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
const THROWS = `module.exports = () => { throw new Error("cannot handle this\\nsecond line"); };\n`;

/**
 * A stand-in for a published codemod package: a folder with `transforms/<name>.js` files, each transform
 * of the given kind and described as "Runs <name>.".
 */
async function fakePackage(kinds: Record<string, ActionKind>, sources: Record<string, string> = {}): Promise<CodemodPackage> {
  const transforms: Record<string, TransformInfo> = {};
  for (const [name, kind] of Object.entries(kinds)) transforms[name] = { kind, description: `Runs ${name}.` };
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
  test("runs the transform named by the action over the matching JavaScript and TypeScript files, with the table's kind", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "b.tsx": "const x = <div>{foo}</div>;\n", "notes.md": "foo\n" });
    const report = await main(["rename", "--files", "*.ts,*.tsx,*.md"], dir, pkg);
    assertReport(report);
    assert.equal(report.ok && report.kind, "rewrite");
    const tree = await readTree(dir);
    assert.equal(tree["a.ts"], DONE);
    assert.equal(tree["b.tsx"], "const x = <div>{bar}</div>;\n");
    assert.equal(tree["notes.md"], "foo\n", "only JavaScript and TypeScript files are transformed");
  });

  test("a file the transform leaves alone is not changed", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "b.ts": "export const keep = 2;\n" });
    await main(["rename", "--files", "*.ts"], dir, pkg);
    const tree = await readTree(dir);
    assert.equal(tree["a.ts"], DONE);
    assert.equal(tree["b.ts"], "export const keep = 2;\n");
  });

  test("a transform that throws leaves the files as they were, without failing the run", async () => {
    const pkg = await fakePackage({ boom: "rewrite" }, { boom: THROWS });
    const dir = await workspace({ "a.ts": SRC, "b.ts": SRC });
    const report = await main(["boom", "--files", "*.ts"], dir, pkg);
    assert.equal(report.ok, true);
    const tree = await readTree(dir);
    assert.equal(tree["a.ts"], SRC);
    assert.equal(tree["b.ts"], SRC);
  });

  test("a file that does not parse is left, the others are still changed", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "b.ts": "export const = ;\n" });
    await main(["rename", "--files", "*.ts"], dir, pkg);
    const tree = await readTree(dir);
    assert.equal(tree["a.ts"], DONE);
    assert.equal(tree["b.ts"], "export const = ;\n");
  });

  test("a transform that declares parser flow gets it, and --parser flow gives it to any transform", async () => {
    const FLOW = `module.exports = (file, api) => api.j(file.source).find(api.j.Identifier, { name: "x" }).replaceWith("y").toSource();\nmodule.exports.parser = "flow";\n`;
    const pkg = await fakePackage({ flowy: "rewrite" }, { flowy: FLOW });
    // a type cast: Flow's parser reads it, Babel's does not
    const dir = await workspace({ "a.js": "const x = (1: number);\n" });
    await main(["flowy", "--files", "a.js"], dir, pkg);
    assert.equal((await readTree(dir))["a.js"], "const y = (1: number);\n");
    const plain = await fakePackage({ rename: "rewrite" });
    const other = await workspace({ "a.js": "const foo = (1: number);\n" });
    await main(["rename", "--files", "a.js", "--parser", "flow"], other, plain);
    assert.equal((await readTree(other))["a.js"], "const bar = (1: number);\n");
  });

  test("declaration files are not passed to transforms", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC, "types.d.ts": "export declare const foo: number;\n", "x.d.mts": "export declare const foo: number;\n" });
    await main(["rename", "--files", "**/*.ts,**/*.mts"], dir, pkg);
    const tree = await readTree(dir);
    assert.equal(tree["a.ts"], DONE);
    assert.equal(tree["types.d.ts"], "export declare const foo: number;\n");
    assert.equal(tree["x.d.mts"], "export declare const foo: number;\n");
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
    assert.equal((await readTree(dir))["a.ts"], SRC);
  });
});

describe("codemod arguments", () => {
  test("an unknown action, or none, is UNKNOWN_ACTION", async () => {
    const pkg = await fakePackage({ b: "sweep", a: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["nope", "--files", "a.ts"], dir, pkg))).code, "UNKNOWN_ACTION");
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

  test("an unknown flag is INVALID_ARGS", async () => {
    const pkg = await fakePackage({ rename: "rewrite" });
    const dir = await workspace({ "a.ts": SRC });
    assert.equal((await rejects(main(["rename", "--files", "a.ts", "--force"], dir, pkg))).code, "INVALID_ARGS");
    assert.equal((await readTree(dir))["a.ts"], SRC);
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
