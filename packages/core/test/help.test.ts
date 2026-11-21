import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { HELP_SCHEMA_ID, schemaErrors } from "@jig/test-utils";
import { HELP_SCHEMA, actionHelp, imageHelp } from "../src/index.ts";
import type { Action } from "../src/index.ts";

const ENTRY = join(import.meta.dirname, "fixtures", "help-entry.ts");
const EXAMPLE = join(import.meta.dirname, "..", "..", "..", "schemas", "examples", "help-1.json");

function run(args: string[], env: Record<string, string> = {}): { status: number | null; lines: string[] } {
  const proc = spawnSync(process.execPath, [ENTRY, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: proc.status, lines: proc.stdout.split("\n").filter((l) => l !== "") };
}

describe("runEntrypoint --help", () => {
  test('exactly ["--help"] prints the help as one JSON line and exits 0', () => {
    const { status, lines } = run(["--help"]);
    assert.equal(status, 0);
    assert.equal(lines.length, 1);
    const help = JSON.parse(lines[0]!) as unknown;
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, help), []);
    assert.deepEqual(help, {
      schema: "urn:jig:help:1",
      summary: "Probes the entrypoint.",
      actions: [
        {
          name: "probe",
          kinds: ["sweep"],
          summary: "Does nothing.",
          flags: [{ name: "--files", type: "globs", required: true, description: "The files." }],
        },
      ],
    });
  });

  test("any other arguments run main as before", () => {
    for (const args of [["--help", "x"], ["probe", "--help"], []]) {
      const { status, lines } = run(args);
      assert.equal(status, 0, args.join(" "));
      const report = JSON.parse(lines.at(-1)!) as { schema: string; subject: string };
      assert.equal(report.schema, "urn:jig:report:1");
      assert.equal(report.subject, `sweep(probe): ${args.join(" ")}`);
    }
  });

  test("a help that throws is an INTERNAL failure report and exit 1", () => {
    const { status, lines } = run(["--help"], { HELP_THROWS: "1" });
    assert.equal(status, 1);
    const report = JSON.parse(lines.at(-1)!) as { ok: boolean; code: string; instructions: string };
    assert.equal(report.ok, false);
    assert.equal(report.code, "INTERNAL");
    assert.match(report.instructions, /no help today/);
  });
});

describe("help builders", () => {
  test("actionHelp takes an action's id, kind, summary and flags", () => {
    const action: Action = {
      id: "x-move",
      kind: "refactor",
      summary: "Moves x.",
      flags: [
        { name: "--to", type: "path", required: true, description: "Where." },
        { name: "--case", type: "choice", choices: ["kebab", "camel"], required: false, description: "Which case." },
      ],
      parseParams: () => ({}),
      describe: () => "x",
      run: async () => ({ summary: "s" }),
    };
    assert.deepEqual(actionHelp(action), {
      name: "x-move",
      kinds: ["refactor"],
      summary: "Moves x.",
      flags: action.flags,
    });
  });

  test("imageHelp builds the urn:jig:help:1 object, keys in order", () => {
    const help = imageHelp("Does things.", []);
    assert.equal(HELP_SCHEMA, "urn:jig:help:1");
    assert.deepEqual(Object.keys(help), ["schema", "summary", "actions"]);
    assert.deepEqual(help, { schema: "urn:jig:help:1", summary: "Does things.", actions: [] });
  });
});

describe("help schema", () => {
  const example = (): Record<string, any> => JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, any>;
  const withFlag = (flag: Record<string, unknown>): unknown => {
    const help = example();
    help.actions[0].flags = [flag];
    return help;
  };

  test("a choice flag with its choices is valid", () => {
    const flag = { name: "--case", type: "choice", choices: ["kebab", "camel"], required: false, description: "d" };
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, withFlag(flag)), []);
  });

  test("jig's own additions are allowed: ok, image, notes", () => {
    const help = { ...example(), ok: true, image: "localhost/jig/fs:local@sha256:00", notes: ["A cached image was used."] };
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, help), []);
  });

  const invalid: [string, () => unknown][] = [
    ["choices on a text flag", () => withFlag({ name: "--to", type: "text", choices: ["a"], required: true, description: "d" })],
    ["a choice flag without choices", () => withFlag({ name: "--case", type: "choice", required: true, description: "d" })],
    ["a choice flag with empty choices", () => withFlag({ name: "--case", type: "choice", choices: [], required: true, description: "d" })],
    ["repeated choices", () => withFlag({ name: "--case", type: "choice", choices: ["a", "a"], required: true, description: "d" })],
    ["an unknown flag type", () => withFlag({ name: "--to", type: "string", required: true, description: "d" })],
    ["a flag name without --", () => withFlag({ name: "to", type: "path", required: true, description: "d" })],
    ["a flag without required", () => withFlag({ name: "--to", type: "path", description: "d" })],
    ["an extra flag field", () => withFlag({ name: "--to", type: "path", required: true, description: "d", default: "x" })],
    ["empty actions", () => ({ ...example(), actions: [] })],
    ["no kinds", () => ({ ...example(), actions: [{ ...example().actions[0], kinds: [] }] })],
    ["an unknown kind", () => ({ ...example(), actions: [{ ...example().actions[0], kinds: ["codemod"] }] })],
    ["repeated kinds", () => ({ ...example(), actions: [{ ...example().actions[0], kinds: ["rewrite", "rewrite"] }] })],
    ["a multi-line action summary", () => ({ ...example(), actions: [{ ...example().actions[0], summary: "a\nb" }] })],
    ["a multi-line image summary", () => ({ ...example(), summary: "a\nb" })],
    ["an extra action field", () => ({ ...example(), actions: [{ ...example().actions[0], kind: "rewrite" }] })],
    ["an extra top-level field", () => ({ ...example(), version: "1" })],
    ["another schema", () => ({ ...example(), schema: "urn:jig:report:1" })],
    ["ok false", () => ({ ...example(), ok: false })],
    ["empty notes", () => ({ ...example(), notes: [] })],
  ];
  for (const [name, doc] of invalid) {
    test(`rejects help with ${name}`, () => {
      assert.notDeepEqual(schemaErrors(HELP_SCHEMA_ID, doc()), []);
    });
  }
});
