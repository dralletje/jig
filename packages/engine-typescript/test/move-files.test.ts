import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { OkReport } from "@jig/core";
import { assertReport, fixturePath, readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { errors, rejects, workspace } from "./helpers.ts";

const LOGO = readFileSync(join(fixturePath("examples/move-files"), "src/feature/logo.png"));

function contains(text: string | undefined, part: string): void {
  assert.ok(text?.includes(part), `expected to contain ${JSON.stringify(part)}:\n${text}`);
}

function lacks(text: string | undefined, part: string): void {
  assert.ok(!text?.includes(part), `expected not to contain ${JSON.stringify(part)}:\n${text}`);
}

const FEATURE = ["--files", "src/feature/**", "--from", "src/feature", "--to", "src/deep/feature2"];

describe("move-files", () => {
  test("move-files moves a folder and every reference follows", async () => {
    const dir = await workspace("examples/move-files");
    const report = (await main(["move-files", ...FEATURE], dir)) as OkReport;
    assertReport(report);
    assert.equal(report.subject, "refactor(typescript move-files): src/feature/** from src/feature to src/deep/feature2");
    const files = await readTree(dir);
    assert.deepEqual(
      Object.keys(files).filter((f) => f.startsWith("src/feature/")),
      [],
    );
    const user = files["src/user.ts"];
    contains(user, 'from "./deep/feature2/a.ts"');
    contains(user, 'from "@/deep/feature2/a"');
    contains(user, 'from "#/deep/feature2/a.ts"');
    lacks(user, "./feature/");
    const a = files["src/deep/feature2/a.ts"];
    contains(a, 'from "./sub/b"');
    contains(a, 'from "./sub/b.ts"');
    contains(a, 'import "./styles.css"');
    contains(a, 'from "../../shared"');
    assert.deepEqual(readFileSync(join(dir, "src/deep/feature2/logo.png")), LOGO);
    assert.match(report.summary, /^Moved 5 files from src\/feature to src\/deep\/feature2\./);
    contains(report.summary, "src/user.ts");
    assert.deepEqual(await errors(dir, "src/user.ts"), []);
  });

  test("an index folder import stays a folder import", async () => {
    const dir = await workspace("examples/move-files");
    await main(["move-files", ...FEATURE], dir);
    const files = await readTree(dir);
    contains(files["src/user.ts"], 'from "./deep/feature2";');
    contains(files["src/deep/feature2/index.ts"], 'from "./a";');
  });

  test("a pattern moves some files; the files left behind and the moved ones still find each other", async () => {
    const dir = await workspace("examples/move-files");
    await main(["move-files", "--files", "src/feature/a.ts", "--from", "src/feature", "--to", "src/deep/feature2"], dir);
    const files = await readTree(dir);
    assert.equal(files["src/feature/a.ts"], undefined);
    const a = files["src/deep/feature2/a.ts"];
    contains(a, 'from "../../feature/sub/b"');
    contains(a, 'from "../../feature/sub/b.ts"');
    contains(a, 'import "../../feature/styles.css"');
    contains(a, 'from "../../shared"');
    contains(files["src/feature/index.ts"], 'from "../deep/feature2/a";');
    contains(files["src/user.ts"], 'from "./deep/feature2/a.ts"');
    contains(files["src/user.ts"], 'from "./feature";');
    assert.deepEqual(await errors(dir, "src/user.ts"), []);
  });

  test("--to inside --from works", async () => {
    const dir = await workspace("examples/move-files");
    await main(["move-files", "--files", "src/feature/**", "--from", "src/feature", "--to", "src/feature/v2"], dir);
    const files = await readTree(dir);
    assert.deepEqual(
      Object.keys(files)
        .filter((f) => f.startsWith("src/feature/"))
        .sort(),
      [
        "src/feature/v2/a.ts",
        "src/feature/v2/index.ts",
        "src/feature/v2/logo.png",
        "src/feature/v2/styles.css",
        "src/feature/v2/sub/b.ts",
      ],
    );
    contains(files["src/user.ts"], 'from "./feature/v2/a.ts"');
    contains(files["src/user.ts"], 'from "./feature/v2";');
    contains(files["src/feature/v2/a.ts"], 'from "./sub/b"');
    contains(files["src/feature/v2/a.ts"], 'from "../../shared"');
    assert.deepEqual(await errors(dir, "src/user.ts"), []);
  });

  test("a JSDoc import type and a triple-slash reference follow the move", async () => {
    const dir = await workspace("examples/move-files");
    await main(["move-files", ...FEATURE], dir);
    const files = await readTree(dir);
    contains(files["src/tool.js"], '@import { useB } from "./deep/feature2/a.ts"');
    contains(files["src/tool.js"], 'import("./deep/feature2/sub/b.ts").B');
    contains(files["src/user.ts"], '/// <reference path="./deep/feature2/sub/b.ts" />');
    contains(files["src/user.ts"], 'import("./deep/feature2/sub/b")');
    contains(files["src/user.ts"], 'require("./deep/feature2/sub/b.ts")');
  });

  test("packages that do not resolve are left alone", async () => {
    const dir = await workspace("examples/move-files", {
      "src/feature/pad.ts": 'import leftPad from "left-pad";\n\nexport const pad = leftPad;\n',
    });
    await main(["move-files", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(files["src/deep/feature2/pad.ts"], 'import leftPad from "left-pad";\n\nexport const pad = leftPad;\n');
  });

  test("alias and subpath imports of files TypeScript does not resolve follow the move", async () => {
    const dir = await workspace("examples/move-files", {
      "src/assets/logo.svg": "<svg/>\n",
      "src/assets/use.ts": 'import "@/assets/logo.svg";\n\nexport {};\n',
      "src/page.ts": 'import "@/assets/logo.svg";\nimport "#/assets/logo.svg";\nimport "./assets/logo.svg";\n\nexport {};\n',
    });
    await main(["move-files", "--files", "src/assets/**", "--from", "src/assets", "--to", "src/media"], dir);
    const files = await readTree(dir);
    assert.equal(files["src/page.ts"], 'import "@/media/logo.svg";\nimport "#/media/logo.svg";\nimport "./media/logo.svg";\n\nexport {};\n');
    assert.equal(files["src/media/use.ts"], 'import "@/media/logo.svg";\n\nexport {};\n');
  });

  test("a tsconfig paths key starting with # is an alias, not a subpath import", async () => {
    const dir = await workspace("examples/move-files", {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          types: [],
          paths: { "@/*": ["./src/*"], "#app/*": ["./src/*"] },
        },
        include: ["src"],
      }),
      "src/feature/c.ts": 'import { shared } from "#app/shared";\n\nexport const c = shared;\n',
      "src/other.ts": 'import { c } from "#app/feature/c";\n\nexport const d = c;\n',
    });
    await main(["move-files", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(files["src/deep/feature2/c.ts"], 'import { shared } from "#app/shared";\n\nexport const c = shared;\n');
    contains(files["src/other.ts"], 'from "#app/deep/feature2/c"');
  });

  test("new URL(path, import.meta.url) follows the move, keeping its spelling", async () => {
    const dir = await workspace("examples/move-files", {
      "src/feature/worker.ts":
        'export const logo = new URL("./logo.png", import.meta.url);\n' +
        "export const shared = new URL(`../shared.ts`, import.meta.url);\n" +
        'export const bare = new URL("sub/b.ts", import.meta.url);\n',
      "src/assets.ts":
        'export const logo = new URL("./feature/logo.png", import.meta.url);\n' +
        'export const styles = new URL("feature/styles.css", import.meta.url);\n' +
        'export const here = new URL(".", import.meta.url);\n' +
        'export const missing = new URL("./missing.png", import.meta.url);\n' +
        'export const web = new URL("https://example.com/feature/logo.png", import.meta.url);\n' +
        'export const data = new URL("data:text/plain,feature/logo.png", import.meta.url);\n' +
        'export const absolute = new URL("/feature/logo.png", import.meta.url);\n' +
        'export const otherBase = new URL("./feature/logo.png", "file:///x/");\n',
    });
    await main(["move-files", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(
      files["src/deep/feature2/worker.ts"],
      'export const logo = new URL("./logo.png", import.meta.url);\n' +
        "export const shared = new URL(`../../shared.ts`, import.meta.url);\n" +
        'export const bare = new URL("sub/b.ts", import.meta.url);\n',
    );
    assert.equal(
      files["src/assets.ts"],
      'export const logo = new URL("./deep/feature2/logo.png", import.meta.url);\n' +
        'export const styles = new URL("deep/feature2/styles.css", import.meta.url);\n' +
        'export const here = new URL(".", import.meta.url);\n' +
        'export const missing = new URL("./missing.png", import.meta.url);\n' +
        'export const web = new URL("https://example.com/feature/logo.png", import.meta.url);\n' +
        'export const data = new URL("data:text/plain,feature/logo.png", import.meta.url);\n' +
        'export const absolute = new URL("/feature/logo.png", import.meta.url);\n' +
        'export const otherBase = new URL("./feature/logo.png", "file:///x/");\n',
    );
  });

  test("a file moving away from what its URL names gets a path that climbs out", async () => {
    const dir = await workspace("examples/move-files", {
      "src/feature/worker.ts": 'export const shared = new URL("shared.ts", import.meta.url);\n',
      "src/feature/shared.ts": "export {};\n",
    });
    await main(["move-files", "--files", "src/feature/worker.ts", "--from", "src/feature", "--to", "src/deep"], dir);
    const files = await readTree(dir);
    assert.equal(files["src/deep/worker.ts"], 'export const shared = new URL("../feature/shared.ts", import.meta.url);\n');
  });

  describe("refusals", () => {
    test("a URL that would need to change but names no file refuses, naming it", async () => {
      const dir = await workspace("examples/move-files", {
        "src/feature/worker.ts": 'export const missing = new URL("./missing.wasm", import.meta.url);\n',
        "src/assets.ts": 'export const folder = new URL("./feature/", import.meta.url);\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["move-files", ...FEATURE], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.match(err.message, /src\/feature\/worker\.ts:1: new URL\("\.\/missing\.wasm", import\.meta\.url\) does not name a file/);
      assert.match(err.message, /src\/assets\.ts:1: new URL\("\.\/feature\/", import\.meta\.url\) names a folder whose files all move/);
      assert.deepEqual(await readTree(dir), before);
    });

    test("a URL with a query or hash that would need to change refuses", async () => {
      const dir = await workspace("examples/move-files", {
        "src/feature/worker.ts": 'export const shared = new URL("../shared.ts#x", import.meta.url);\n',
        "src/assets.ts": 'export const logo = new URL("./feature/logo.png?url", import.meta.url);\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["move-files", ...FEATURE], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.match(err.message, /src\/feature\/worker\.ts:1: new URL\("\.\.\/shared\.ts#x", import\.meta\.url\) has a query or hash/);
      assert.match(err.message, /src\/assets\.ts:1: new URL\("\.\/feature\/logo\.png\?url", import\.meta\.url\) has a query or hash/);
      assert.deepEqual(await readTree(dir), before);
    });

    test("a query import of a file in the group refuses, in a file that stays too", async () => {
      const dir = await workspace("examples/move-files", {
        "src/icons.ts":
          'import "./feature/logo.png?react";\nimport "@/feature/styles.css?inline";\nimport "#/feature/sub/b.ts?raw";\nimport "./shared.ts?raw";\n\nexport {};\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["move-files", ...FEATURE], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.match(err.message, /src\/icons\.ts:1: "\.\/feature\/logo\.png\?react" is a query import of src\/feature\/logo\.png, which moves\. jig does not rewrite query imports yet/);
      assert.match(err.message, /src\/icons\.ts:2: "@\/feature\/styles\.css\?inline" is a query import of src\/feature\/styles\.css/);
      assert.match(err.message, /src\/icons\.ts:3: "#\/feature\/sub\/b\.ts\?raw" is a query import of src\/feature\/sub\/b\.ts/);
      lacks(err.message, "src/icons.ts:4:");
      assert.deepEqual(await readTree(dir), before);
    });

    test("a query import in a moving file refuses", async () => {
      const dir = await workspace("examples/move-files", {
        "src/feature/raw.ts": 'import "../shared.ts?raw";\n\nexport {};\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["move-files", ...FEATURE], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.match(err.message, /src\/feature\/raw\.ts:1: "\.\.\/shared\.ts\?raw" is a query import in src\/feature\/raw\.ts, which moves\. jig does not rewrite query imports yet/);
      assert.deepEqual(await readTree(dir), before);
    });

    test("a query import elsewhere does not stop a move", async () => {
      const dir = await workspace("examples/move-files", {
        "src/icons.ts": 'import "./shared.ts?raw";\n\nexport {};\n',
      });
      await main(["move-files", ...FEATURE], dir);
      const files = await readTree(dir);
      assert.equal(files["src/icons.ts"], 'import "./shared.ts?raw";\n\nexport {};\n');
    });

    test("no match is INVALID_ARGS", async () => {
      const dir = await workspace("examples/move-files");
      const err = await rejects(main(["move-files", "--files", "src/nothing/**", "--from", "src/nothing", "--to", "src/else"], dir));
      assert.equal(err.code, "INVALID_ARGS");
      assert.match(err.message, /No file matches src\/nothing\/\*\*/);
    });

    test("a match outside --from is INVALID_ARGS", async () => {
      const dir = await workspace("examples/move-files");
      const err = await rejects(main(["move-files", "--files", "src/**", "--from", "src/feature", "--to", "src/other"], dir));
      assert.equal(err.code, "INVALID_ARGS");
      assert.match(err.message, /src\/user\.ts/);
      assert.match(err.message, /not under --from src\/feature/);
    });

    test("--from equal to --to is INVALID_ARGS", async () => {
      const dir = await workspace("examples/move-files");
      const err = await rejects(main(["move-files", "--files", "src/feature/**", "--from", "src/feature", "--to", "src/feature/"], dir));
      assert.equal(err.code, "INVALID_ARGS");
      assert.match(err.message, /--from and --to are both src\/feature/);
    });

    test("an existing destination is INVALID_ARGS, named", async () => {
      const dir = await workspace("examples/move-files", { "src/deep/feature2/a.ts": "export {};\n" });
      const err = await rejects(main(["move-files", ...FEATURE], dir));
      assert.equal(err.code, "INVALID_ARGS");
      assert.match(err.message, /src\/deep\/feature2\/a\.ts already exists/);
    });

    test("a group containing package.json is INVALID_ARGS, named", async () => {
      const dir = await workspace("examples/move-files", { "src/feature/package.json": "{}\n" });
      const err = await rejects(main(["move-files", ...FEATURE], dir));
      assert.equal(err.code, "INVALID_ARGS");
      assert.match(err.message, /src\/feature\/package\.json/);
    });

    test("an alias whose folder does not hold the new place refuses the whole move, naming the import", async () => {
      const dir = await workspace("examples/move-files");
      const before = await readTree(dir);
      const err = await rejects(main(["move-files", "--files", "src/feature/**", "--from", "src/feature", "--to", "lib/feature"], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.match(err.message, /src\/user\.ts:3: "@\/feature\/a"/);
      assert.match(err.message, /src\/user\.ts:4: "#\/feature\/a\.ts"/);
      assert.deepEqual(await readTree(dir), before);
    });

    test("moving into a project whose tsconfig lacks the alias refuses", async () => {
      const dir = await workspace("examples/move-files", {
        "pkg/tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true } }),
        "src/feature/c.ts": 'import { shared } from "@/shared";\n\nexport const c = shared;\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["move-files", "--files", "src/feature/**", "--from", "src/feature", "--to", "pkg/feature"], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.match(err.message, /src\/feature\/c\.ts:1: "@\/shared"/);
      assert.match(err.message, /pkg\/tsconfig\.json/);
      assert.deepEqual(await readTree(dir), before);
    });

    test("a relative import in a moved file that does not resolve refuses", async () => {
      const dir = await workspace("examples/move-files", {
        "src/feature/broken.ts": 'import { x } from "./missing";\n\nexport const y = x;\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["move-files", ...FEATURE], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.match(err.message, /src\/feature\/broken\.ts:1: "\.\/missing" does not resolve/);
      assert.deepEqual(await readTree(dir), before);
    });

    test("a bare specifier resolving into the group through baseUrl refuses", async () => {
      const dir = await workspace("examples/move-files", {
        "app/tsconfig.json": JSON.stringify({
          compilerOptions: { module: "ESNext", moduleResolution: "bundler", baseUrl: ".", ignoreDeprecations: "6.0", noEmit: true },
        }),
        "app/lib/x.ts": "export const x = 1;\n",
        "app/main.ts": 'import { x } from "lib/x";\n\nexport const y = x;\n',
      });
      const before = await readTree(dir);
      const err = await rejects(main(["move-files", "--files", "app/lib/**", "--from", "app/lib", "--to", "app/lib2"], dir));
      assert.equal(err.code, "REFACTOR_UNAVAILABLE");
      assert.match(err.message, /app\/main\.ts:1: "lib\/x"/);
      assert.deepEqual(await readTree(dir), before);
    });
  });

  test("a 50-file folder with 3000 importers moves in under 3 seconds", async () => {
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
      await put(`src/big/f${i}.ts`, `import { shared } from "../shared";\nimport { f${(i + 1) % 50} } from "./f${(i + 1) % 50}";\n\nexport const f${i} = () => shared + f${(i + 1) % 50}.length;\n`);
    }
    for (let i = 0; i < 3000; i++) {
      await put(
        `src/users/g${i % 30}/u${i}.ts`,
        `import { f${i % 50} } from "../../big/f${i % 50}";\nimport { f${(i + 7) % 50} } from "@/big/f${(i + 7) % 50}";\nimport { shared } from "../../shared";\n\nexport const u${i} = [f${i % 50}, f${(i + 7) % 50}, shared];\n`,
      );
    }
    const started = performance.now();
    await main(["move-files", "--files", "src/big/**", "--from", "src/big", "--to", "src/lib/big"], dir);
    const elapsed = performance.now() - started;
    console.log(`move-files bench: ${Math.round(elapsed)} ms`);
    const files = await readTree(dir);
    contains(files["src/users/g0/u0.ts"], 'from "../../lib/big/f0"');
    contains(files["src/users/g0/u0.ts"], 'from "@/lib/big/f7"');
    contains(files["src/lib/big/f0.ts"], 'from "../../shared"');
    assert.ok(elapsed < 3000, `took ${Math.round(elapsed)} ms`);
  });
});

describe("duplicate-files", () => {
  test("duplicate-files copies a folder and leaves outside importers on the originals", async () => {
    const dir = await workspace("examples/move-files");
    const before = await readTree(dir);
    const report = (await main(["duplicate-files", ...FEATURE], dir)) as OkReport;
    assertReport(report);
    assert.equal(report.subject, "refactor(typescript duplicate-files): src/feature/** from src/feature to src/deep/feature2");
    const files = await readTree(dir);
    for (const [path, content] of Object.entries(before)) assert.equal(files[path], content, path);
    const a = files["src/deep/feature2/a.ts"];
    contains(a, 'from "./sub/b"');
    contains(a, 'from "./sub/b.ts"');
    contains(a, 'import "./styles.css"');
    contains(a, 'from "../../shared"');
    assert.equal(files["src/deep/feature2/index.ts"], before["src/feature/index.ts"]);
    assert.deepEqual(readFileSync(join(dir, "src/deep/feature2/logo.png")), LOGO);
    assert.deepEqual(readFileSync(join(dir, "src/feature/logo.png")), LOGO);
    assert.match(report.summary, /^Copied 5 files from src\/feature to src\/deep\/feature2\./);
    contains(report.summary, "Files outside the copies still import the originals.");
    assert.deepEqual(await errors(dir, "src/user.ts"), []);
  });

  test("a copy's URLs point at the copies in the group and at the originals outside it", async () => {
    const dir = await workspace("examples/move-files", {
      "src/feature/worker.ts":
        'export const logo = new URL("./logo.png", import.meta.url);\nexport const shared = new URL("../shared.ts", import.meta.url);\n',
      "src/assets.ts": 'export const logo = new URL("./feature/logo.png", import.meta.url);\n',
    });
    await main(["duplicate-files", ...FEATURE], dir);
    const files = await readTree(dir);
    assert.equal(
      files["src/deep/feature2/worker.ts"],
      'export const logo = new URL("./logo.png", import.meta.url);\nexport const shared = new URL("../../shared.ts", import.meta.url);\n',
    );
    assert.equal(files["src/assets.ts"], 'export const logo = new URL("./feature/logo.png", import.meta.url);\n');
  });

  test("a query import in a copy refuses; one in a file outside the group does not", async () => {
    const dir = await workspace("examples/move-files", {
      "src/feature/inline.ts": 'import "./styles.css?inline";\n\nexport {};\n',
      "src/icons.ts": 'import "./feature/logo.png?react";\n\nexport {};\n',
    });
    const before = await readTree(dir);
    const err = await rejects(main(["duplicate-files", ...FEATURE], dir));
    assert.equal(err.code, "REFACTOR_UNAVAILABLE");
    assert.match(err.message, /src\/feature\/inline\.ts:1: "\.\/styles\.css\?inline" is a query import of src\/feature\/styles\.css, which is copied/);
    lacks(err.message, "src/icons.ts");
    assert.deepEqual(await readTree(dir), before);
  });
});
