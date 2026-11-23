import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RefactorError } from "@jig/core";
import type { Flag } from "@jig/core";
import { HELP_SCHEMA_ID, schemaErrors } from "@jig/test-utils";
import { ACTIONS, help, main } from "../src/main.ts";

// A value each declared flag accepts, by its type. Two text flags check their format and get a valid one.
function fakeValue(flag: Flag): string {
  if (flag.type === "choice") return flag.choices[0]!.name;
  if (flag.type === "path" || flag.type === "paths" || flag.type === "globs") return "src/a.ts";
  if (flag.name === "--at") return "src/a.ts:12:20";
  if (flag.name === "--alias") return "@/";
  if (flag.name === "--prefix") return "#/";
  return "foo";
}

// The raw object `parseParams` gets, answering the given flags (with `values` over the fake ones);
// every key it reads is recorded.
function recordingRaw(
  flags: Flag[],
  reads: Set<string>,
  values: Record<string, string> = {},
): Record<string, string | undefined> {
  return new Proxy({} as Record<string, string | undefined>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      reads.add(key);
      const flag = flags.find((f) => f.name === `--${key}`);
      if (flag === undefined) return undefined;
      return values[flag.name] ?? fakeValue(flag);
    },
  });
}

// Whether `parse` refuses; a refusal must be an INVALID_ARGS RefactorError.
function refuses(parse: () => unknown): boolean {
  try {
    parse();
    return false;
  } catch (e) {
    assert.ok(e instanceof RefactorError, String(e));
    assert.equal(e.code, "INVALID_ARGS");
    return true;
  }
}

describe("typescript help", () => {
  test("is a valid help object", () => {
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, help()), []);
  });

  test("lists exactly the actions main dispatches, in order", () => {
    assert.deepEqual(
      help().actions.map((a) => a.name),
      ACTIONS.map((a) => a.id),
    );
    assert.equal(help().actions.length, 22);
  });

  test("the actions are named without a typescript- prefix", () => {
    assert.deepEqual(
      help().actions.map((a) => a.name),
      [
        "rename",
        "extract",
        "lift-out",
        "move-file",
        "organize-imports",
        "remove-barrels",
        "add-import-extensions",
        "subpath-imports",
        "imports-to-relative",
        "imports-to-alias",
        "imports-to-subpath",
        "params-to-object",
        "infer-return-types",
        "namespace-to-named",
        "import-type",
        "remove-console",
        "template-string",
        "rename-files",
        "remove-unused-variable",
        "convert-function",
        "default-to-named",
        "inline-function",
      ],
    );
  });

  test("an old prefixed name is an unknown action", async () => {
    await assert.rejects(main(["typescript-rename", "--file", "a.ts", "--symbol", "a", "--to", "b"], "/nonexistent"), (e: unknown) => {
      assert.ok(e instanceof RefactorError, String(e));
      assert.equal(e.code, "UNKNOWN_ACTION");
      assert.match(e.message, /^Unknown action "typescript-rename"\. This image has: rename, extract, /);
      return true;
    });
  });

  test("every action's summary is one real line", () => {
    for (const a of help().actions) {
      assert.ok(a.summary.trim().length > 0, a.name);
      assert.doesNotMatch(a.summary, /\n/, a.name);
      assert.doesNotMatch(a.summary, /todo|tbd|placeholder/i, a.name);
    }
  });

  test("every flag has a description", () => {
    for (const a of help().actions) {
      for (const f of a.flags) assert.ok(f.description.trim().length > 0, `${a.name} ${f.name}`);
    }
  });

  for (const action of ACTIONS) {
    test(`${action.id}: its flags are exactly the keys parseParams reads`, () => {
      const reads = new Set<string>();
      action.parseParams(recordingRaw(action.flags, reads));
      assert.deepEqual(
        action.flags.map((f) => f.name).sort(),
        [...reads].map((k) => `--${k}`).sort(),
      );
    });

    test(`${action.id}: required says whether parseParams refuses the call without the flag`, () => {
      for (const flag of action.flags) {
        const others = action.flags.filter((f) => f !== flag);
        assert.equal(
          refuses(() => action.parseParams(recordingRaw(others, new Set()))),
          flag.required,
          flag.name,
        );
      }
    });

    test(`${action.id}: parseParams accepts every listed choice and refuses any other value`, () => {
      for (const flag of action.flags) {
        if (flag.type !== "choice") continue;
        for (const choice of flag.choices) {
          assert.equal(
            refuses(() => action.parseParams(recordingRaw(action.flags, new Set(), { [flag.name]: choice.name }))),
            false,
            `${flag.name} ${choice.name}`,
          );
        }
        assert.equal(
          refuses(() => action.parseParams(recordingRaw(action.flags, new Set(), { [flag.name]: "not-a-choice" }))),
          true,
          `${flag.name} not-a-choice`,
        );
      }
    });
  }
});
