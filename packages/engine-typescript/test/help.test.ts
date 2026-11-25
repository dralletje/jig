import assert from "node:assert/strict";
import { test } from "node:test";
import { RefactorError } from "@jig/core";
import type { Flag } from "@jig/core";
import { HELP_SCHEMA_ID, schemaErrors } from "@jig/test-utils";
import { ACTIONS, help, main } from "../src/main.ts";

// A value each declared flag accepts, by its type. Text flags that check their format get a valid one.
function fakeValue(flag: Flag): string {
  if (flag.type === "choice") return flag.choices[0]!.name;
  if (flag.type === "path" || flag.type === "paths" || flag.type === "globs") return "src/a.ts";
  if (flag.name === "--at") return "src/a.ts:12:20";
  if (flag.name === "--lines") return "12-20";
  if (flag.name === "--alias") return "@/";
  if (flag.name === "--prefix") return "#/";
  return "foo";
}

// The raw flags `parseParams` gets: the given flags answered (`values` over the fake ones), every key it reads recorded.
function recordingRaw(flags: Flag[], reads: Set<string>, values: Record<string, string> = {}): Record<string, string | undefined> {
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

// Whether `parse` refuses the flags; a refusal must be INVALID_ARGS.
function refuses(parse: () => unknown): boolean {
  try {
    parse();
    return false;
  } catch (e) {
    assert.ok(e instanceof RefactorError && e.code === "INVALID_ARGS", String(e));
    return true;
  }
}

test("typescript --help is valid and its flags are the ones each action accepts", async () => {
  assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, help()), []);
  for (const action of ACTIONS) {
    const all = action.flags.flatMap((f) => [f.name, fakeValue(f)]);
    await assert.rejects(main([action.id, ...all, "--not-a-flag", "x"], "/nonexistent"), (e: unknown) => {
      assert.ok(e instanceof RefactorError && e.code === "INVALID_ARGS", `${action.id} --not-a-flag: ${String(e)}`);
      return true;
    });
    const reads = new Set<string>();
    assert.equal(refuses(() => action.parseParams(recordingRaw(action.flags, reads))), false, `${action.id} with every flag`);
    assert.deepEqual(
      action.flags.map((f) => f.name).sort(),
      [...reads].map((k) => `--${k}`).sort(),
      `${action.id}: the flags it lists are the ones it reads`,
    );
    for (const flag of action.flags) {
      const others = action.flags.filter((f) => f !== flag);
      assert.equal(refuses(() => action.parseParams(recordingRaw(others, new Set()))), flag.required, `${action.id} without ${flag.name}`);
      if (flag.type !== "choice") continue;
      for (const choice of flag.choices) {
        const raw = recordingRaw(action.flags, new Set(), { [flag.name]: choice.name });
        assert.equal(refuses(() => action.parseParams(raw)), false, `${action.id} ${flag.name} ${choice.name}`);
      }
      const raw = recordingRaw(action.flags, new Set(), { [flag.name]: "not-a-choice" });
      assert.equal(refuses(() => action.parseParams(raw)), true, `${action.id} ${flag.name} not-a-choice`);
    }
  }
});
