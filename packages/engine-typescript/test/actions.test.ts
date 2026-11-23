import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { OkReport, RefactorError } from "@jig/core";
import { assertReport, makeRepo, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";

const BIN = join(import.meta.dirname, "..", "src", "bin.ts");

/** A fixture copy, with extra files written into it. */
async function workspace(fixture: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = await makeRepo(fixture);
  for (const [path, content] of Object.entries(extra)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

async function rejects(p: Promise<unknown>): Promise<RefactorError> {
  try {
    await p;
  } catch (e) {
    return e as RefactorError;
  }
  throw new Error("expected rejection");
}

function contains(text: string | undefined, part: string): void {
  assert.ok(text?.includes(part), `expected to contain ${JSON.stringify(part)}:\n${text}`);
}

function lacks(text: string | undefined, part: string): void {
  assert.ok(!text?.includes(part), `expected not to contain ${JSON.stringify(part)}:\n${text}`);
}

describe("rename", () => {
  test("renames across .ts/.tsx, keeping shorthand properties and re-exports", async () => {
    const dir = await workspace("simple");
    await main(["rename", "--file", "a.ts", "--symbol", "foo", "--to", "bar"], dir);
    const files = await readTree(dir);
    contains(files["a.ts"], "export function bar()");
    contains(files["b.ts"], "{ foo: bar }"); // shorthand keeps its property name
    contains(files["b.ts"], "export { bar as renamedFoo }");
    contains(files["c.tsx"], "{bar()}");
  });

  test("report: subject and summary", async () => {
    const dir = await workspace("simple");
    const report = await main(["rename", "--file", "a.ts", "--symbol", "foo", "--to", "bar"], dir);
    assertReport(report);
    assert.deepEqual(report, {
      schema: "urn:jig:report:1",
      ok: true,
      kind: "refactor",
      subject: "refactor(typescript rename): foo → bar in a.ts",
      summary: "Renamed `foo` to `bar` in a.ts (9 places in 4 files).",
    });
  });

  test("the summary is the same when code moved above the symbol", async () => {
    const plain = await workspace("simple");
    const moved = await workspace("simple");
    await writeFile(join(moved, "a.ts"), `export const unrelated = 1;\n\n${(await readTree(moved))["a.ts"]}`);
    const args = ["rename", "--file", "a.ts", "--symbol", "foo", "--to", "bar"];
    const first = (await main(args, plain)) as OkReport;
    const second = (await main(args, moved)) as OkReport;
    assert.equal(second.summary, first.summary);
  });

  test("a rename in one monorepo package leaves other packages as is", async () => {
    const dir = await workspace("monorepo");
    const before = await readTree(dir);
    await main(
      ["rename", "--file", "packages/core/src/util.ts", "--symbol", "formatName", "--to", "formatFullName"],
      dir,
    );
    const files = await readTree(dir);
    contains(files["packages/core/src/util.ts"], "export function formatFullName(");
    assert.equal(files["packages/app/src/main.ts"], before["packages/app/src/main.ts"] ?? "");
  });

  test("a missing symbol is SYMBOL_NOT_FOUND", async () => {
    const dir = await workspace("simple");
    const err = await rejects(main(["rename", "--file", "a.ts", "--symbol", "nope", "--to", "bar"], dir));
    assert.equal(err.code, "SYMBOL_NOT_FOUND");
  });

  test("--kind picks one of a variable and an interface of the same name", async () => {
    for (const kind of ["variable", "interface"]) {
      const report = (await main(["rename", "--file", "a.ts", "--symbol", "shared", "--kind", kind, "--to", "x"], await workspace("simple"))) as OkReport;
      assert.match(report.summary, /^Renamed `shared` to `x` in a\.ts /);
    }
    // --kind interface looks at interfaces only: `keep` is only a const, so there is none to pick.
    const err = await rejects(main(["rename", "--file", "a.ts", "--symbol", "keep", "--kind", "interface", "--to", "x"], await workspace("simple")));
    assert.equal(err.code, "SYMBOL_NOT_FOUND");
  });

  test("a name with several declarations is AMBIGUOUS_SYMBOL", async () => {
    const dir = await workspace("simple");
    const err = await rejects(main(["rename", "--file", "a.ts", "--symbol", "shared", "--to", "x"], dir));
    assert.equal(err.code, "AMBIGUOUS_SYMBOL");
  });
});

describe("extract", () => {
  test("report", async () => {
    const dir = await workspace("simple");
    const report = (await main(["extract", "--file", "a.ts", "--symbols", "helper,keep", "--to", "lib.ts"], dir)) as OkReport;
    assertReport(report);
    assert.equal(report.subject, "refactor(typescript extract): helper, keep → lib.ts from a.ts");
    assert.match(report.summary, /^Moved `helper` and `keep` from a\.ts to lib\.ts \(a new file\), updating the imports of \d+ other files?\.$/);
  });

  test("an ambiguous or missing later symbol refuses before anything moves, with the lines on disk", async () => {
    const dir = await workspace("simple");
    const before = await readTree(dir);
    const ambiguous = await rejects(main(["extract", "--file", "a.ts", "--symbols", "helper,shared", "--to", "lib.ts"], dir));
    assert.equal(ambiguous.code, "AMBIGUOUS_SYMBOL");
    assert.match(ambiguous.message, /a\.ts:15\b/);
    assert.match(ambiguous.message, /a\.ts:17\b/);
    const missing = await rejects(main(["extract", "--file", "a.ts", "--symbols", "helper,nope", "--to", "lib.ts"], dir));
    assert.equal(missing.code, "SYMBOL_NOT_FOUND");
    assert.deepEqual(await readTree(dir), before);
  });

  test("moves two symbols to a new file and rewires importers", async () => {
    const dir = await workspace("simple");
    await main(["extract", "--file", "a.ts", "--symbols", "helper,keep", "--to", "lib.ts"], dir);
    const files = await readTree(dir);
    lacks(files["a.ts"], "function helper");
    lacks(files["a.ts"], "const keep");
    contains(files["lib.ts"], "export function helper");
    contains(files["lib.ts"], "export const keep");
    assert.match(files["a.ts"] ?? "", /import \{ helper \} from "\.\/lib"/);
    assert.match(files["b.ts"] ?? "", /import \{ keep \} from "\.\/lib"/);
  });
});

describe("lift-out", () => {
  const lift = (dir: string, args: string[]) =>
    main(["lift-out", "--file", "nested.ts", "--in", "outer", ...args], dir);

  test("lifts a nested function to module level, dedented, above its parent", async () => {
    const dir = await workspace("simple");
    await lift(dir, ["--symbol", "double"]);
    const text = (await readTree(dir))["nested.ts"] ?? "";
    assert.equal(
      text.startsWith(
        'import { keep } from "./a";\n\nfunction double(x: number) {\n  return x * 2 + keep;\n}\n\nexport function outer',
      ),
      true,
    );
    assert.equal(text.match(/function double/g)?.length, 1);
  });

  test("doc comments stay with what they describe", async () => {
    const dir = await workspace("simple", {
      "documented.ts": [
        "// file header",
        "",
        "/** Does X. */",
        "export function outer() {",
        "  const a = 1; // trailing note on a",
        "  /** Helps. */",
        "  function helper() {",
        "    return 2;",
        "  }",
        "  return a + helper();",
        "}",
        "",
      ].join("\n"),
    });
    await main(["lift-out", "--file", "documented.ts", "--in", "outer", "--symbol", "helper"], dir);
    assert.equal(
      (await readTree(dir))["documented.ts"],
      [
        "// file header",
        "",
        "/** Helps. */",
        "function helper() {",
        "  return 2;",
        "}",
        "",
        "/** Does X. */",
        "export function outer() {",
        "  const a = 1; // trailing note on a",
        "  return a + helper();",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("takes the locals it uses along, in source order", async () => {
    const dir = await workspace("simple");
    const report = (await lift(dir, ["--symbol", "clamp"])) as OkReport;
    assertReport(report);
    assert.equal(report.summary, "Lifted `clamp` out of `outer` to module level in nested.ts, together with `LIMIT`, which it uses.");
    const text = (await readTree(dir))["nested.ts"] ?? "";
    contains(text, "const LIMIT = 10;\n\nconst clamp = (x: number) => Math.min(x, LIMIT);\n\nexport function outer");
    assert.equal(text.match(/const LIMIT/g)?.length, 1);
  });

  test("refuses when it uses a local that cannot move (a parameter), and names it", async () => {
    const dir = await workspace("simple");
    const err = await rejects(lift(dir, ["--symbol", "scaled"]));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    contains(err.message, "scaled uses n from outer, which cannot be moved");
    contains(err.message, "Pass n to scaled as parameters first, then run again.");
  });

  test("import.meta: fine within the file, refused when moving to another file", async () => {
    const refused = await workspace("simple");
    const err = await rejects(lift(refused, ["--symbol", "here", "--to", "meta.ts"]));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    contains(err.message, "import.meta");

    const dir = await workspace("simple");
    await lift(dir, ["--symbol", "here"]);
    contains((await readTree(dir))["nested.ts"], "const here = () => import.meta;\n\nexport function outer");
  });

  test("refuses a const whose initializer may have side effects", async () => {
    const dir = await workspace("simple");
    const err = await rejects(lift(dir, ["--symbol", "started"]));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    contains(err.message, "side effects");
  });

  test("--to lifts and moves to another file", async () => {
    const dir = await workspace("simple");
    const report = (await lift(dir, ["--symbol", "double", "--to", "math.ts"])) as OkReport;
    assertReport(report);
    assert.equal(report.subject, "refactor(typescript lift-out): outer › double → math.ts in nested.ts");
    assert.equal(report.summary, "Lifted `double` out of `outer` in nested.ts and moved it to math.ts.");
    const files = await readTree(dir);
    contains(files["math.ts"], "export function double(x: number)");
    assert.match(files["nested.ts"] ?? "", /import \{ double \} from "\.\/math"/);
    lacks(files["nested.ts"], "function double");
    // the import it uses goes with it, and leaves the source once unused there
    assert.match(files["math.ts"] ?? "", /import \{ keep \} from "\.\/a"/);
    lacks(files["nested.ts"], "keep");
  });

  test("--to takes the locals along into the other file", async () => {
    const dir = await workspace("simple");
    await lift(dir, ["--symbol", "clamp", "--to", "clamp.ts"]);
    const files = await readTree(dir);
    contains(files["clamp.ts"], "const LIMIT = 10;");
    contains(files["clamp.ts"], "export const clamp");
    lacks(files["nested.ts"], "LIMIT");
    assert.match(files["nested.ts"] ?? "", /import \{ clamp \} from "\.\/clamp"/);
  });
});

describe("move-file", () => {
  // simple's tsconfig includes only top-level files, and a file is not moved out of its tsconfig's include.
  const SIMPLE_EVERYWHERE = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, jsx: "preserve", module: "esnext", moduleResolution: "bundler", target: "esnext", skipLibCheck: true, types: [] },
      include: ["**/*.ts", "**/*.tsx"],
    }),
  };

  test("moves a file, rewriting its own relative imports", async () => {
    const dir = await workspace("simple", SIMPLE_EVERYWHERE);
    const report = (await main(["move-file", "--file", "b.ts", "--to", "sub/b.ts"], dir)) as OkReport;
    assertReport(report);
    assert.equal(report.subject, "refactor(typescript move-file): b.ts → sub/b.ts");
    assert.match(report.summary, /^Moved b\.ts to sub\/b\.ts(, updating the imports of \d+ other files?)?\.$/);
    const files = await readTree(dir);
    assert.equal(files["b.ts"], undefined);
    contains(files["sub/b.ts"], 'from "../a"');
  });

  test("refuses to move a file out of its tsconfig's include", async () => {
    const dir = await workspace("simple");
    const before = await readTree(dir);
    const err = await rejects(main(["move-file", "--file", "b.ts", "--to", "sub/b.ts"], dir));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    contains(err.message, "b.ts:1: tsconfig.json includes b.ts, but tsconfig.json would not include sub/b.ts");
    assert.deepEqual(await readTree(dir), before);
  });

  test("importers follow a moved module", async () => {
    const dir = await workspace("simple", SIMPLE_EVERYWHERE);
    await main(["move-file", "--file", "a.ts", "--to", "lib/a.ts"], dir);
    const files = await readTree(dir);
    assert.equal(files["a.ts"], undefined);
    contains(files["b.ts"], 'from "./lib/a"');
    contains(files["c.tsx"], 'from "./lib/a"');
    contains(files["nested.ts"], 'from "./lib/a"');
    contains(files["scripts/tool.ts"], 'from "../lib/a"');
  });

  test("paths aliases inside the project are rewritten", async () => {
    const dir = await workspace("paths");
    await main(["move-file", "--file", "src/util.ts", "--to", "src/lib/util.ts"], dir);
    const files = await readTree(dir);
    assert.equal(files["src/lib/util.ts"], "export function util() {}\n");
    contains(files["src/main.ts"], 'from "@/lib/util"');
  });

  test("move-file keeps each import's extension form in a file that mixes them", async () => {
    const dir = await workspace("examples/move-files", {
      "src/other.ts": "export const other = 2;\n",
      "src/lib/sub/b.ts": "export const b = 3;\n",
      "src/lib/a.ts": 'import { shared } from "../shared";\nimport { other } from "../other.ts";\nimport { b } from "./sub/b";\n\nexport const a = shared + other + b;\n',
    });
    await main(["move-file", "--file", "src/lib/a.ts", "--to", "src/lib/deep/a.ts"], dir);
    const files = await readTree(dir);
    assert.equal(files["src/lib/a.ts"], undefined);
    assert.equal(
      files["src/lib/deep/a.ts"],
      'import { shared } from "../../shared";\nimport { other } from "../../other.ts";\nimport { b } from "../sub/b";\n\nexport const a = shared + other + b;\n',
    );
  });

  test("refuses to move a file without its declaration file", async () => {
    const dir = await workspace("examples/move-files", {
      "src/lib/plain.js": "export const p = 1;\n",
      "src/lib/plain.d.ts": "export declare const p: number;\n",
    });
    const before = await readTree(dir);
    const err = await rejects(main(["move-file", "--file", "src/lib/plain.js", "--to", "src/lib2/plain.js"], dir));
    assert.equal(err.code, "INVALID_ARGS");
    contains(err.message, "src/lib/plain.js is in --files, but its declaration file src/lib/plain.d.ts is not");
    assert.deepEqual(await readTree(dir), before);
  });

  test("refuses an existing target", async () => {
    const dir = await workspace("simple");
    const err = await rejects(main(["move-file", "--file", "b.ts", "--to", "a.ts"], dir));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
  });
});

describe("organize-imports", () => {
  test("merges, sorts and drops unused imports in matching files", async () => {
    const dir = await workspace("simple", {
      "messy.ts": 'import { keep, foo } from "./a";\nimport { helper } from "./a";\n\nexport const m = foo() + keep;\n',
    });
    const report = await main(["organize-imports", "--files", "messy.ts"], dir);
    assertReport(report);
    assert.deepEqual(report, {
      schema: "urn:jig:report:1",
      ok: true,
      kind: "sweep",
      subject: "sweep(typescript organize-imports): messy.ts",
      summary: "Organized the imports of 1 file:\n  messy.ts",
    });
    assert.equal((await readTree(dir))["messy.ts"], 'import { foo, keep } from "./a";\n\nexport const m = foo() + keep;\n');
  });

  test("a file with nothing to organize is left as is", async () => {
    const dir = await workspace("simple");
    const before = await readTree(dir);
    await main(["organize-imports", "--files", "*.tsx"], dir);
    assert.deepEqual(await readTree(dir), before);
  });

  test("globs that match no file are NO_CHANGES", async () => {
    const dir = await workspace("simple");
    assert.equal((await rejects(main(["organize-imports", "--files", "nope/**"], dir))).code, "NO_CHANGES");
  });
});

describe("organize-imports --files matching", () => {
  // Unsorted everywhere, so a file changes exactly when it was selected.
  const MESSY = 'import { b, a } from "x";\nexport const v = a + b;\n';
  const FILES = ["a.ts", "b.ts", "c.tsx", "lib/w.ts", "src/x.ts", "src/deep/y.tsx", "src/.hidden.ts", ".dot/z.ts", "node_modules/m.ts"];

  async function changedBy(globs: string): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "jig-"));
    try {
      for (const file of FILES) {
        await mkdir(dirname(join(dir, file)), { recursive: true });
        await writeFile(join(dir, file), MESSY);
      }
      await main(["organize-imports", "--files", globs], dir);
      const after = await readTree(dir);
      return Object.keys(after)
        .filter((file) => after[file] !== MESSY)
        .sort();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // The same files as before the move to Node: `*` and `**` also match names that start with a dot.
  test("src/** selects every TypeScript file under src, dotfiles included", async () => {
    assert.deepEqual(await changedBy("src/**"), ["src/.hidden.ts", "src/deep/y.tsx", "src/x.ts"]);
  });

  test("**/*.ts selects every .ts file at any depth, outside node_modules", async () => {
    assert.deepEqual(await changedBy("**/*.ts"), [".dot/z.ts", "a.ts", "b.ts", "lib/w.ts", "src/.hidden.ts", "src/x.ts"]);
  });

  test("a.ts,c.tsx selects exactly those two", async () => {
    assert.deepEqual(await changedBy("a.ts,c.tsx"), ["a.ts", "c.tsx"]);
  });
});

describe("main", () => {
  test("an unknown action is UNKNOWN_ACTION", async () => {
    const dir = await workspace("simple");
    assert.equal((await rejects(main(["frobnicate"], dir))).code, "UNKNOWN_ACTION");
  });

  test("an unknown flag is INVALID_ARGS", async () => {
    const dir = await workspace("simple");
    assert.equal((await rejects(main(["rename", "--nope", "x"], dir))).code, "INVALID_ARGS");
  });

  test("a flag of another action is INVALID_ARGS, listing this action's own flags", async () => {
    const dir = await workspace("simple");
    const error = await rejects(main(["move-file", "--file", "a.ts", "--to", "b.ts", "--symbol", "foo"], dir));
    assert.equal(error.code, "INVALID_ARGS");
    assert.match(error.message, /move-file takes --file, --to; jig <image> move-file --help describes them\.$/);
  });
});

describe("bin", () => {
  function bin(dir: string, args: string[]): Promise<{ code: number | null; last: unknown }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [BIN, ...args], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        try {
          resolve({ code, last: JSON.parse(out.trim().split("\n").at(-1) ?? "") });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  test("runs in the working directory and prints the report as the last line", async () => {
    const dir = await workspace("simple");
    const { code, last } = await bin(dir, ["rename", "--file", "a.ts", "--symbol", "foo", "--to", "bar"]);
    assert.equal(code, 0);
    assertReport(last);
    assert.equal((last as OkReport).subject, "refactor(typescript rename): foo → bar in a.ts");
    contains((await readTree(dir))["a.ts"], "export function bar()");
  });

  test("a failure exits 1 with the error report", async () => {
    const dir = await workspace("simple");
    const { code, last } = await bin(dir, ["rename", "--file", "a.ts", "--symbol", "nope", "--to", "bar"]);
    assert.equal(code, 1);
    assertReport(last);
    assert.deepEqual(last, {
      schema: "urn:jig:report:1",
      ok: false,
      code: "SYMBOL_NOT_FOUND",
      instructions:
        "There is no top-level nope in a.ts. Check the name and the file (only top-level declarations count), then run again.",
    });
  });
});
