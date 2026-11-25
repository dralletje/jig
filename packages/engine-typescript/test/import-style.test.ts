import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readTree } from "@jig/test-utils";
import { main } from "../src/index.ts";
import { rejects, workspace } from "./helpers.ts";

// The imports-to-* cases are TOML files in src/imports-to-*/test. These two depend on which TypeScript build
// runs (JIG_TYPESCRIPT), so they stay here.

const EXAMPLE = "examples/import-styles";

const toAlias = (dir: string, files: string, targets: string, alias = "@/") =>
  main(["imports-to-alias", "--files", files, "--targets", targets, "--alias", alias], dir);

const tsconfig = (extra: object) =>
  `${JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true, allowImportingTsExtensions: true, types: [], ...extra } }, null, 2)}\n`;

describe("imports-to-alias with a baseUrl", () => {
  test("paths relative to baseUrl: the alias folder is found through it; a baseUrl import is a package and stays", { skip: process.env.JIG_TYPESCRIPT === "7.1.0-beta" }, async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": tsconfig({ baseUrl: "./src", paths: { "~/*": ["./*"] } }),
      "src/x/a.ts": 'import { formatDay } from "../lib/date";\nimport { cents } from "lib/money";\nexport const z = [formatDay, cents];\n',
    });
    await toAlias(dir, "src/x/**", "**", "~/");
    assert.equal((await readTree(dir))["src/x/a.ts"]?.split("\n").slice(0, 2).join("\n"), 'import { formatDay } from "~/lib/date";\nimport { cents } from "lib/money";');
  });

  test("TypeScript 7.1.0-beta build: a baseUrl other than the tsconfig's folder is refused", { skip: process.env.JIG_TYPESCRIPT !== "7.1.0-beta" }, async () => {
    const dir = await workspace(EXAMPLE, {
      "tsconfig.json": tsconfig({ baseUrl: "./src", paths: { "~/*": ["./*"] } }),
      "src/x/a.ts": 'import { formatDay } from "../lib/date";\nimport { cents } from "lib/money";\nexport const z = [formatDay, cents];\n',
    });
    const before = await readTree(dir);
    const error = await rejects(toAlias(dir, "src/x/**", "**", "~/"));
    assert.equal(error.code, "REFACTOR_UNAVAILABLE");
    assert.deepEqual(await readTree(dir), before);
  });
});
