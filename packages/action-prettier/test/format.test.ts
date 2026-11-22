import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { OkReport, RefactorError } from "@jig/core";
import { HELP_SCHEMA_ID, assertReport, makeRepo, readTree, schemaErrors } from "@jig/test-utils";
import { help, main } from "../src/index.ts";

async function rejects(p: Promise<unknown>): Promise<RefactorError> {
  try {
    await p;
  } catch (e) {
    return e as RefactorError;
  }
  throw new Error("expected rejection");
}

describe("prettier format", () => {
  test("formats matching files with the repo's config", async () => {
    const dir = await makeRepo("simple");
    await writeFile(join(dir, "ugly.ts"), "export const   x = {a:1,\n  b:'two'}\n");
    const report = await main(["format", "--files", "ugly.ts"], dir);
    assertReport(report);
    assert.deepEqual(Object.keys(report), ["schema", "ok", "kind", "subject", "summary"]);
    assert.deepEqual(report, {
      schema: "urn:jig:report:1",
      ok: true,
      kind: "sweep",
      subject: "sweep(prettier format): ugly.ts",
      summary: "Formatted 1 file with prettier 3.9.10:\n  ugly.ts",
    });
    assert.equal((await readTree(dir))["ugly.ts"], 'export const x = { a: 1, b: "two" };\n');
  });

  test("subject joins globs", async () => {
    const dir = await makeRepo("simple");
    const report = await main(["format", "--files", "*.ts,*.tsx"], dir);
    assertReport(report);
    assert.deepEqual(Object.keys(report), ["schema", "ok", "kind", "subject", "summary"]);
    assert.equal((report as OkReport).subject, "sweep(prettier format): *.ts, *.tsx");
  });

  test("no prettier config: prettier defaults", async () => {
    const dir = await makeRepo("simple");
    await rm(join(dir, ".prettierrc"));
    await writeFile(join(dir, "q.ts"), "const a = 'x'\n");
    await main(["format", "--files", "q.ts"], dir);
    assert.equal((await readTree(dir))["q.ts"], 'const a = "x";\n');
  });

  test("a config that fails to load falls back to the defaults", async () => {
    const dir = await makeRepo("simple");
    await rm(join(dir, ".prettierrc"));
    await writeFile(join(dir, "prettier.config.mjs"), 'import x from "nope"; export default x;');
    await writeFile(join(dir, "q.ts"), "const a = 'x'\n");
    await main(["format", "--files", "q.ts"], dir);
    assert.equal((await readTree(dir))["q.ts"], 'const a = "x";\n');
  });

  test("a plugin the image does not have is dropped, the rest of the config applies", async () => {
    const dir = await makeRepo("simple");
    await writeFile(join(dir, ".prettierrc"), JSON.stringify({ plugins: ["prettier-plugin-nope"], singleQuote: true }));
    await writeFile(join(dir, "q.ts"), 'const a = "x"\n');
    const report = await main(["format", "--files", "q.ts"], dir);
    assert.equal(report.ok, true);
    assert.equal((await readTree(dir))["q.ts"], "const a = 'x';\n");
  });

  test(".prettierignore is respected", async () => {
    const dir = await makeRepo("simple");
    await writeFile(join(dir, ".prettierignore"), "skip.ts\n");
    await writeFile(join(dir, "skip.ts"), "const a = 'x'\n");
    await writeFile(join(dir, "do.ts"), "const a = 'x'\n");
    await main(["format", "--files", "*.ts"], dir);
    const files = await readTree(dir);
    assert.equal(files["skip.ts"], "const a = 'x'\n");
    assert.equal(files["do.ts"], 'const a = "x";\n');
  });

  test("files prettier cannot parse are skipped", async () => {
    const dir = await makeRepo("simple");
    await writeFile(join(dir, "data.bin"), "a   =   'b'\n");
    await main(["format", "--files", "data.bin"], dir);
    assert.equal((await readTree(dir))["data.bin"], "a   =   'b'\n");
  });

  test("unknown action", async () => {
    const dir = await makeRepo("simple");
    assert.equal((await rejects(main(["lint"], dir))).code, "UNKNOWN_ACTION");
  });

  test("missing --files", async () => {
    const dir = await makeRepo("simple");
    assert.equal((await rejects(main(["format"], dir))).code, "INVALID_ARGS");
  });
});

describe("prettier help", () => {
  test("is a valid help object", () => {
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, help()), []);
  });

  test("lists exactly the action main dispatches, format, a sweep taking --files", () => {
    assert.deepEqual(
      help().actions.map((a) => a.name),
      ["format"],
    );
    const [format] = help().actions;
    assert.equal(format!.kind, "sweep");
    assert.deepEqual(
      format!.flags.map(({ name, type, required }) => ({ name, type, required })),
      [{ name: "--files", type: "globs", required: true }],
    );
  });
});

describe("format --files matching", () => {
  // Unformatted everywhere, so a file changes exactly when it was selected.
  const UGLY = "import { b, a } from 'x'\nexport const v = a + b\n";
  const FILES = ["a.ts", "b.ts", "c.tsx", "lib/w.ts", "src/x.ts", "src/deep/y.tsx", "src/.hidden.ts", ".dot/z.ts", "node_modules/m.ts"];

  async function changedBy(globs: string): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "jig-"));
    try {
      for (const file of FILES) {
        await mkdir(dirname(join(dir, file)), { recursive: true });
        await writeFile(join(dir, file), UGLY);
      }
      await main(["format", "--files", globs], dir);
      const after = await readTree(dir);
      return Object.keys(after)
        .filter((file) => after[file] !== UGLY)
        .sort();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // The same files as before the move to Node: `*` and `**` also match names that start with a dot.
  test("src/** selects everything under src, dotfiles included", async () => {
    assert.deepEqual(await changedBy("src/**"), ["src/.hidden.ts", "src/deep/y.tsx", "src/x.ts"]);
  });

  test("**/*.ts selects every .ts file at any depth, outside node_modules", async () => {
    assert.deepEqual(await changedBy("**/*.ts"), [".dot/z.ts", "a.ts", "b.ts", "lib/w.ts", "src/.hidden.ts", "src/x.ts"]);
  });

  test("a.ts,c.tsx selects exactly those two", async () => {
    assert.deepEqual(await changedBy("a.ts,c.tsx"), ["a.ts", "c.tsx"]);
  });
});
