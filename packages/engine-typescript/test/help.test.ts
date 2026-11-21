import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Flag } from "@jig/core";
import { HELP_SCHEMA_ID, schemaErrors } from "@jig/test-utils";
import { ACTIONS, help } from "../src/main.ts";

// A value each declared flag accepts, by its type. Two text flags check their format and get a valid one.
function fakeValue(flag: Flag): string {
  if (flag.type === "choice") return flag.choices[0]!;
  if (flag.type === "path" || flag.type === "paths" || flag.type === "globs") return "src/a.ts";
  if (flag.name === "--at") return "src/a.ts:12:20";
  if (flag.name === "--alias") return "@/";
  return "foo";
}

// The raw object `parseParams` gets, answering the given flags; every key it reads is recorded.
function recordingRaw(flags: Flag[], reads: Set<string>): Record<string, string | undefined> {
  return new Proxy({} as Record<string, string | undefined>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      reads.add(key);
      const flag = flags.find((f) => f.name === `--${key}`);
      return flag === undefined ? undefined : fakeValue(flag);
    },
  });
}

function refuses(parse: () => unknown): boolean {
  try {
    parse();
    return false;
  } catch {
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
    assert.equal(help().actions.length, 19);
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
  }
});
