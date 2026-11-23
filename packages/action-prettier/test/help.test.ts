import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RefactorError } from "@jig/core";
import { HELP_SCHEMA_ID, schemaErrors } from "@jig/test-utils";
import { help, main } from "../src/index.ts";

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

test("prettier --help is valid and its flags are the ones each action accepts", async () => {
  const image = help();
  assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, image), []);
  const dir = await mkdtemp(join(tmpdir(), "jig-"));
  for (const action of image.actions) {
    const all = action.flags.flatMap((f) => [f.name, "*.ts"]);
    assert.equal(await refuses(main([action.name, ...all], dir)), false, `${action.name} with every flag`);
    assert.equal(await refuses(main([action.name, ...all, "--not-a-flag", "x"], dir)), true, `${action.name} --not-a-flag`);
    for (const flag of action.flags) {
      const others = action.flags.filter((f) => f !== flag).flatMap((f) => [f.name, "*.ts"]);
      assert.equal(await refuses(main([action.name, ...others], dir)), flag.required, `${action.name} without ${flag.name}`);
    }
  }
});
