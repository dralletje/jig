import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, fixturePath, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { errors, rejects, workspace } from "./helpers.ts";

const LOGO = readFileSync(join(fixturePath("examples/duplicate-folder"), "src/feature/logo.png"));

function contains(text: string | undefined, part: string): void {
  assert.ok(text?.includes(part), `expected to contain ${JSON.stringify(part)}:\n${text}`);
}

const FEATURE = ["--from", "src/feature", "--to", "src/deep/feature2"];

describe("duplicate-folder", () => {
  test("duplicate-folder copies a folder and leaves outside importers on the originals", async () => {
    const dir = await workspace("examples/duplicate-folder");
    const before = await readTree(dir);
    const report = (await main(["duplicate-folder", ...FEATURE], dir)) as OkReport;
    assertReport(report);
    const files = await readTree(dir);
    for (const [path, content] of Object.entries(before)) assert.equal(files[path], content, path);
    assert.deepEqual(
      Object.keys(files)
        .filter((f) => f.startsWith("src/deep/"))
        .sort(),
      [
        "src/deep/feature2/a.ts",
        "src/deep/feature2/index.ts",
        "src/deep/feature2/logo.png",
        "src/deep/feature2/styles.css",
        "src/deep/feature2/sub/b.ts",
      ],
    );
    const a = files["src/deep/feature2/a.ts"];
    contains(a, 'from "./sub/b"');
    contains(a, 'from "./sub/b.ts"');
    contains(a, 'import "./styles.css"');
    contains(a, 'from "../../shared"');
    assert.equal(files["src/deep/feature2/index.ts"], before["src/feature/index.ts"]);
    assert.deepEqual(readFileSync(join(dir, "src/deep/feature2/logo.png")), LOGO);
    assert.deepEqual(readFileSync(join(dir, "src/feature/logo.png")), LOGO);
    assert.deepEqual(await errors(dir, "src/user.ts"), []);
    assert.deepEqual(await errors(dir, "src/deep/feature2/a.ts"), []);
  });

  test("declaration files are copied with the files they declare", async () => {
    const dir = await workspace("examples/duplicate-folder", {
      "src/feature/plain.js": "export const p = 1;\n",
      "src/feature/plain.d.ts": "export declare const p: number;\n",
      "src/feature/theme.css": ".a {}\n",
      "src/feature/theme.d.css.ts": "declare const styles: Record<string, string>;\nexport default styles;\n",
    });
    await main(["duplicate-folder", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(files["src/deep/feature2/plain.js"], "export const p = 1;\n");
    assert.equal(files["src/deep/feature2/plain.d.ts"], "export declare const p: number;\n");
    assert.equal(files["src/deep/feature2/theme.css"], ".a {}\n");
    assert.equal(files["src/deep/feature2/theme.d.css.ts"], "declare const styles: Record<string, string>;\nexport default styles;\n");
  });

  test("a typed CSS module (theme.d.css.ts) inside the folder is imported as the CSS file in the copy", async () => {
    const dir = await workspace("examples/duplicate-folder", {
      "src/feature/theme.css": ".a {}\n",
      "src/feature/theme.d.css.ts": "declare const styles: Record<string, string>;\nexport default styles;\n",
      "src/feature/themed.ts": 'import styles from "./theme.css";\nexport const s = styles;\n',
    });
    await main(["duplicate-folder", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(files["src/deep/feature2/themed.ts"], 'import styles from "./theme.css";\nexport const s = styles;\n');
    assert.deepEqual(await errors(dir, "src/deep/feature2/themed.ts"), []);
  });

  test("a copy's import of a typed CSS module outside the folder follows it", async () => {
    const dir = await workspace("examples/duplicate-folder", {
      "src/theme.css": ".a {}\n",
      "src/theme.d.css.ts": "declare const styles: Record<string, string>;\nexport default styles;\n",
      "src/feature/themed.ts": 'import styles from "../theme.css";\nimport aliased from "@/theme.css";\nexport const s = [styles, aliased];\n',
    });
    await main(["duplicate-folder", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(
      files["src/deep/feature2/themed.ts"],
      'import styles from "../../theme.css";\nimport aliased from "@/theme.css";\nexport const s = [styles, aliased];\n',
    );
    assert.deepEqual(await errors(dir, "src/deep/feature2/themed.ts"), []);
  });

  test("a copy into another package (another nearest package.json) is INVALID_ARGS", async () => {
    const dir = await workspace("examples/duplicate-folder", {
      "src/other/package.json": '{ "name": "other", "private": true }\n',
      "src/other/inner/keep.ts": "export {};\n",
    });
    const before = await readTree(dir);
    const into = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "src/other/feature"], dir));
    assert.equal(into.code, "INVALID_ARGS");
    const out = await rejects(main(["duplicate-folder", "--from", "src/other/inner", "--to", "src/inner"], dir));
    assert.equal(out.code, "INVALID_ARGS");
    assert.deepEqual(await readTree(dir), before);
  });

  test("a copy within the same package (same nearest package.json) is allowed", async () => {
    const dir = await workspace("examples/duplicate-folder", {
      "src/pkg/package.json": '{ "name": "pkg", "private": true }\n',
      "src/pkg/lib/a.ts": "export const a = 1;\n",
    });
    await main(["duplicate-folder", "--from", "src/pkg/lib", "--to", "src/pkg/lib2"], dir);
    const files = await readTree(dir);
    assert.equal(files["src/pkg/lib2/a.ts"], "export const a = 1;\n");
  });

  test("a copy's JSDoc imports and triple-slash references follow it", async () => {
    const dir = await workspace("examples/duplicate-folder", {
      "src/feature/tool.js":
        '/** @import { shared } from "../shared.ts" */\n\n/** @param {import("./sub/b.ts").B} value */\nexport function apply(value) {\n  return value;\n}\n',
      "src/feature/ref.ts": '/// <reference path="../shared.ts" />\n/// <reference path="./sub/b.ts" />\nexport {};\n',
    });
    await main(["duplicate-folder", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(
      files["src/deep/feature2/tool.js"],
      '/** @import { shared } from "../../shared.ts" */\n\n/** @param {import("./sub/b.ts").B} value */\nexport function apply(value) {\n  return value;\n}\n',
    );
    assert.equal(files["src/deep/feature2/ref.ts"], '/// <reference path="../../shared.ts" />\n/// <reference path="./sub/b.ts" />\nexport {};\n');
  });

  test("alias and subpath imports in a copy keep their style", async () => {
    const dir = await workspace("examples/duplicate-folder", {
      "src/feature/c.ts": 'import { shared } from "@/shared";\nimport { a } from "#/feature/a.ts";\n\nexport const c = shared + a;\n',
    });
    await main(["duplicate-folder", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(files["src/deep/feature2/c.ts"], 'import { shared } from "@/shared";\nimport { a } from "#/deep/feature2/a.ts";\n\nexport const c = shared + a;\n');
  });

  test("a copy's URLs point at the copies in the folder and at the originals outside it", async () => {
    const dir = await workspace("examples/duplicate-folder", {
      "src/feature/worker.ts":
        'export const logo = new URL("./logo.png", import.meta.url);\nexport const shared = new URL("../shared.ts", import.meta.url);\n',
      "src/assets.ts": 'export const logo = new URL("./feature/logo.png", import.meta.url);\n',
    });
    await main(["duplicate-folder", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(
      files["src/deep/feature2/worker.ts"],
      'export const logo = new URL("./logo.png", import.meta.url);\nexport const shared = new URL("../../shared.ts", import.meta.url);\n',
    );
    assert.equal(files["src/assets.ts"], 'export const logo = new URL("./feature/logo.png", import.meta.url);\n');
  });

  test("a 50-file folder with 3000 importers outside it is copied in under 3 seconds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jig-bench-"));
    const put = async (path: string, content: string): Promise<void> => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    };
    await put(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true, paths: { "@/*": ["./src/*"] } },
      }),
    );
    await put("src/shared.ts", "export const shared = 1;\n");
    for (let i = 0; i < 50; i++) {
      await put(
        `src/big/f${i}.ts`,
        `import { shared } from "../shared";\nimport { f${(i + 1) % 50} } from "./f${(i + 1) % 50}";\nimport { f${(i + 2) % 50} } from "@/big/f${(i + 2) % 50}";\n\nexport const f${i} = () => shared + f${(i + 1) % 50}.length + f${(i + 2) % 50}.length;\n`,
      );
    }
    for (let i = 0; i < 3000; i++) {
      await put(
        `src/users/g${i % 30}/u${i}.ts`,
        `import { f${i % 50} } from "../../big/f${i % 50}";\nimport { f${(i + 7) % 50} } from "@/big/f${(i + 7) % 50}";\nimport { shared } from "../../shared";\n\nexport const u${i} = [f${i % 50}, f${(i + 7) % 50}, shared];\n`,
      );
    }
    const started = performance.now();
    await main(["duplicate-folder", "--from", "src/big", "--to", "src/lib/big"], dir);
    const elapsed = performance.now() - started;
    console.log(`duplicate-folder bench: ${Math.round(elapsed)} ms`);
    const files = await readTree(dir);
    contains(files["src/users/g0/u0.ts"], 'from "../../big/f0"');
    contains(files["src/lib/big/f0.ts"], 'from "../../shared"');
    contains(files["src/lib/big/f0.ts"], 'from "./f1"');
    contains(files["src/lib/big/f0.ts"], 'from "@/lib/big/f2"');
    assert.ok(elapsed < 3000, `took ${Math.round(elapsed)} ms`);
  });

  describe("refusals", () => {
    test("a --from that does not exist is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const err = await rejects(main(["duplicate-folder", "--from", "src/nothing", "--to", "src/else"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("an empty --from folder is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      await mkdir(join(dir, "src/empty/inner"), { recursive: true });
      const err = await rejects(main(["duplicate-folder", "--from", "src/empty", "--to", "src/else"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("symlinks and node_modules folders under --from are INVALID_ARGS, listed", async () => {
      const dir = await workspace("examples/duplicate-folder", {
        "src/feature/node_modules/dep/index.js": "module.exports = 1;\n",
        "src/feature/sub/deeper/node_modules/x.js": "",
      });
      await symlink("../shared.ts", join(dir, "src/feature/linked.ts"));
      await symlink("../../user.ts", join(dir, "src/feature/sub/user-link.ts"));
      await symlink("..", join(dir, "src/feature/sub/up"));
      const before = await readTree(dir);
      const err = await rejects(main(["duplicate-folder", ...FEATURE], dir));
      assert.equal(err.code, "INVALID_ARGS");
      assert.deepEqual(await readTree(dir), before);
      assert.equal((await readdir(join(dir, "src"))).includes("deep"), false);
    });

    test("a --from that is itself a symlink is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      await symlink("feature", join(dir, "src/feature-link"));
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature-link", "--to", "src/else"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("a --from that is a file is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const err = await rejects(main(["duplicate-folder", "--from", "src/user.ts", "--to", "src/else"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("a --to folder that already exists is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder", { "src/feature2/other.ts": "export {};\n" });
      const before = await readTree(dir);
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "src/feature2"], dir));
      assert.equal(err.code, "INVALID_ARGS");
      assert.deepEqual(await readTree(dir), before);
    });

    test("an empty --to folder that already exists is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      await mkdir(join(dir, "src/feature2"), { recursive: true });
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "src/feature2"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("a --to that is an existing file is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "src/shared.ts"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("a --to under an existing file is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "src/shared.ts/feature"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("a --to inside --from is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "src/feature/v2"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("--from equal to --to is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "src/feature/"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("the repo root as --from is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const err = await rejects(main(["duplicate-folder", "--from", ".", "--to", "copy"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });

    test("a path outside the repo is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const fromOutside = await rejects(main(["duplicate-folder", "--from", "../elsewhere", "--to", "src/else"], dir));
      assert.equal(fromOutside.code, "INVALID_ARGS");
      const toOutside = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "/tmp/elsewhere"], dir));
      assert.equal(toOutside.code, "INVALID_ARGS");
    });

    test("a folder holding a package.json is INVALID_ARGS, named", async () => {
      const dir = await workspace("examples/duplicate-folder", { "src/feature/package.json": "{}\n" });
      const before = await readTree(dir);
      const err = await rejects(main(["duplicate-folder", ...FEATURE], dir));
      assert.equal(err.code, "INVALID_ARGS");
      assert.deepEqual(await readTree(dir), before);
    });

    test("a --to outside the tsconfig's include refuses", async () => {
      const dir = await workspace("examples/duplicate-folder");
      const before = await readTree(dir);
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "lib/feature"], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.deepEqual(await readTree(dir), before);
    });

    test("a query import in a copy refuses", async () => {
      const dir = await workspace("examples/duplicate-folder", {
        "src/feature/inline.ts": 'import "./styles.css?inline";\n\nexport {};\n',
        "src/icons.ts": 'import "./feature/logo.png?react";\n\nexport {};\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["duplicate-folder", ...FEATURE], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.deepEqual(await readTree(dir), before);
    });

    test("a relative import in a copied file that does not resolve refuses", async () => {
      const dir = await workspace("examples/duplicate-folder", {
        "src/feature/broken.ts": 'import { x } from "./missing";\n\nexport const y = x;\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["duplicate-folder", ...FEATURE], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.deepEqual(await readTree(dir), before);
    });

    test("a URL with a query or hash in a copy refuses", async () => {
      const dir = await workspace("examples/duplicate-folder", {
        "src/feature/worker.ts": 'export const shared = new URL("../shared.ts#x", import.meta.url);\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["duplicate-folder", ...FEATURE], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.deepEqual(await readTree(dir), before);
    });
  });
});
