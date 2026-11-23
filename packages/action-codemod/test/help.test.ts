import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RefactorError } from "@jig/core";
import type { Flag } from "@jig/core";
import { HELP_SCHEMA_ID, schemaErrors } from "@jig/test-utils";
import { help, main } from "../src/index.ts";
import type { CodemodPackage } from "../src/index.ts";

// Whether `main` refuses the arguments; a refusal must be INVALID_ARGS.
async function refuses(run: Promise<unknown>): Promise<boolean> {
  try {
    await run;
    return false;
  } catch (e) {
    assert.ok(e instanceof RefactorError && e.code === "INVALID_ARGS", String(e));
    return true;
  }
}

// The flags as arguments, each with a value it accepts (`values` over those).
function args(flags: Flag[], values: Record<string, string> = {}): string[] {
  return flags.flatMap((f) => [f.name, values[f.name] ?? (f.type === "choice" ? f.choices[0]!.name : "*.ts")]);
}

test("codemod --help is valid and its flags are the ones each action accepts", async () => {
  const pkgDir = await mkdtemp(join(tmpdir(), "fake-codemods-"));
  await mkdir(join(pkgDir, "transforms"));
  await writeFile(join(pkgDir, "transforms", "noop.js"), "module.exports = (file) => file.source;\n");
  const pkg: CodemodPackage = {
    image: "codemod-fake",
    name: "fake-codemods",
    version: "1.2.3",
    dir: pkgDir,
    transforms: { noop: { kind: "rewrite", description: "Changes nothing." } },
  };
  const image = help(pkg);
  assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, image), []);
  const dir = await mkdtemp(join(tmpdir(), "jig-"));
  for (const action of image.actions) {
    assert.equal(await refuses(main([action.name, ...args(action.flags)], dir, pkg)), false, `${action.name} with every flag`);
    assert.equal(await refuses(main([action.name, ...args(action.flags), "--not-a-flag", "x"], dir, pkg)), true, `${action.name} --not-a-flag`);
    for (const flag of action.flags) {
      const others = action.flags.filter((f) => f !== flag);
      assert.equal(await refuses(main([action.name, ...args(others)], dir, pkg)), flag.required, `${action.name} without ${flag.name}`);
      if (flag.type !== "choice") continue;
      for (const choice of flag.choices) {
        const given = args(action.flags, { [flag.name]: choice.name });
        assert.equal(await refuses(main([action.name, ...given], dir, pkg)), false, `${action.name} ${flag.name} ${choice.name}`);
      }
      const bad = args(action.flags, { [flag.name]: "not-a-choice" });
      assert.equal(await refuses(main([action.name, ...bad], dir, pkg)), true, `${action.name} ${flag.name} not-a-choice`);
    }
  }
});
