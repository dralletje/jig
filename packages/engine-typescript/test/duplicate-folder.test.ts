import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fixturePath, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { rejects, workspace } from "./helpers.ts";

// What can be said in text is in src/duplicate-folder/test/duplicate-folder.toml. Here stay the tests with
// binary files, symlinks, empty folders (git does not hold them, so a case cannot make one) and timing.

const LOGO = readFileSync(join(fixturePath("examples/duplicate-folder"), "src/feature/logo.png"));

function contains(text: string | undefined, part: string): void {
  assert.ok(text?.includes(part), `expected to contain ${JSON.stringify(part)}:\n${text}`);
}

const FEATURE = ["--from", "src/feature", "--to", "src/deep/feature2"];

describe("duplicate-folder", () => {
  test("a binary file is copied byte for byte, and the original stays", async () => {
    const dir = await workspace("examples/duplicate-folder");
    await main(["duplicate-folder", ...FEATURE], dir);
    assert.deepEqual(readFileSync(join(dir, "src/deep/feature2/logo.png")), LOGO);
    assert.deepEqual(readFileSync(join(dir, "src/feature/logo.png")), LOGO);
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

    test("an empty --to folder that already exists is INVALID_ARGS", async () => {
      const dir = await workspace("examples/duplicate-folder");
      await mkdir(join(dir, "src/feature2"), { recursive: true });
      const err = await rejects(main(["duplicate-folder", "--from", "src/feature", "--to", "src/feature2"], dir));
      assert.equal(err.code, "INVALID_ARGS");
    });
  });
});
