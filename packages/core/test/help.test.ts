import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { HELP_SCHEMA_ID, schemaErrors } from "@jig/test-utils";
import { HELP_SCHEMA, actionHelp, imageHelp } from "../src/index.ts";
import type { Action, ActionHelp, ActionKind, Flag } from "../src/index.ts";

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
        {
          name: "--case",
          type: "choice",
          choices: [
            { name: "kebab", description: "kebab-case." },
            { name: "camel", description: "camelCase." },
          ],
          required: false,
          description: "Which case.",
        },
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

describe("imageHelp checks the choices", () => {
  /** An action with `kinds` and `flags`, as the builder gets it; choices are `unknown` to also pass wrong ones. */
  const withFlags = (kinds: ActionKind[], flags: unknown[]): ActionHelp => ({ name: "codemod", kinds, summary: "Runs it.", flags: flags as Flag[] });
  const choiceFlag = (choices: unknown[], name = "--transform") => ({ name, type: "choice", choices, required: true, description: "Which." });

  test("object choices, with or without kinds, are accepted and carried through", () => {
    const action = withFlags(
      ["sweep", "rewrite"],
      [
        choiceFlag([
          { name: "a", description: "Does a.", kind: "rewrite" },
          { name: "b", description: "Does b.", kind: "sweep" },
          { name: "c", description: "Does c.", kind: "rewrite" },
        ]),
        choiceFlag([{ name: "tsx", description: "TypeScript with JSX." }], "--parser"),
      ],
    );
    const help = imageHelp("Does things.", [action]);
    assert.deepEqual(help.actions, [action]);
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, help), []);
  });

  const refused: [string, ActionHelp, RegExp][] = [
    ["a string choice", withFlags(["rewrite"], [choiceFlag(["a"])]), /choices\[0\] must be an object/],
    ["a choice without description", withFlags(["rewrite"], [choiceFlag([{ name: "a" }])]), /description must be a non-empty string/],
    ["a choice with an empty description", withFlags(["rewrite"], [choiceFlag([{ name: "a", description: "" }])]), /description must be a non-empty string/],
    ["a multi-line choice description", withFlags(["rewrite"], [choiceFlag([{ name: "a", description: "A.\nB." }])]), /description must be one line/],
    ["a choice without name", withFlags(["rewrite"], [choiceFlag([{ description: "D." }])]), /name must be a non-empty string/],
    ["a choice with an unknown field", withFlags(["rewrite"], [choiceFlag([{ name: "a", description: "D.", default: true }])]), /unknown field\(s\) default/],
    ["a choice with an unknown kind", withFlags(["rewrite"], [choiceFlag([{ name: "a", description: "D.", kind: "delete" }])]), /kind must be refactor, sweep or rewrite/],
    ["two choices with one name", withFlags(["rewrite"], [choiceFlag([{ name: "a", description: "D." }, { name: "a", description: "E." }])]), /two choices are named "a"/],
    ["empty choices", withFlags(["rewrite"], [choiceFlag([])]), /non-empty list/],
    [
      "a kind on some choices but not all",
      withFlags(["rewrite"], [choiceFlag([{ name: "a", description: "D.", kind: "rewrite" }, { name: "b", description: "E." }])]),
      /some choices have a kind and others not/,
    ],
    [
      "kinds on the choices of two flags",
      withFlags(["rewrite"], [choiceFlag([{ name: "a", description: "D.", kind: "rewrite" }]), choiceFlag([{ name: "b", description: "E.", kind: "rewrite" }], "--other")]),
      /both --transform and --other have choices with kinds/,
    ],
    [
      "an action kind no choice has",
      withFlags(["sweep", "rewrite"], [choiceFlag([{ name: "a", description: "D.", kind: "rewrite" }])]),
      /must be exactly the action's kinds/,
    ],
    [
      "a choice kind the action does not list",
      withFlags(["rewrite"], [choiceFlag([{ name: "a", description: "D.", kind: "rewrite" }, { name: "b", description: "E.", kind: "sweep" }])]),
      /must be exactly the action's kinds/,
    ],
  ];
  for (const [name, action, message] of refused) {
    test(`refuses ${name}`, () => {
      assert.throws(() => imageHelp("Does things.", [action]), message);
    });
  }
});

describe("help schema", () => {
  const example = (): Record<string, any> => JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, any>;
  const withFlag = (flag: Record<string, unknown>): unknown => {
    const help = example();
    help.actions[0].flags = [flag];
    return help;
  };

  test("a choice flag with its choices is valid, with or without kinds", () => {
    const choices = [
      { name: "kebab", description: "kebab-case." },
      { name: "camel", description: "camelCase.", kind: "rewrite" },
    ];
    const flag = { name: "--case", type: "choice", choices, required: false, description: "d" };
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, withFlag(flag)), []);
  });

  const choiceFlag = (choices: unknown[]) => withFlag({ name: "--case", type: "choice", choices, required: true, description: "d" });

  test("jig's own additions are allowed: ok, image, notes", () => {
    const help = { ...example(), ok: true, image: "localhost/jig/fs:local@sha256:00", notes: ["A cached image was used."] };
    assert.deepEqual(schemaErrors(HELP_SCHEMA_ID, help), []);
  });

  const invalid: [string, () => unknown][] = [
    ["choices on a text flag", () => withFlag({ name: "--to", type: "text", choices: [{ name: "a", description: "A." }], required: true, description: "d" })],
    ["a choice flag without choices", () => withFlag({ name: "--case", type: "choice", required: true, description: "d" })],
    ["a choice flag with empty choices", () => choiceFlag([])],
    ["a string choice", () => choiceFlag(["a"])],
    ["a choice without description", () => choiceFlag([{ name: "a" }])],
    ["a choice with an empty description", () => choiceFlag([{ name: "a", description: "" }])],
    ["a multi-line choice description", () => choiceFlag([{ name: "a", description: "A.\nB." }])],
    ["a choice with an empty name", () => choiceFlag([{ name: "", description: "A." }])],
    ["a choice with an unknown field", () => choiceFlag([{ name: "a", description: "A.", default: true }])],
    ["a choice with an unknown kind", () => choiceFlag([{ name: "a", description: "A.", kind: "codemod" }])],
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
    ["an empty action name", () => ({ ...example(), actions: [{ ...example().actions[0], name: "" }] })],
    ["an action name that is a flag", () => ({ ...example(), actions: [{ ...example().actions[0], name: "--help" }] })],
    ["an action name starting with -", () => ({ ...example(), actions: [{ ...example().actions[0], name: "-x" }] })],
    ["an action name with a space", () => ({ ...example(), actions: [{ ...example().actions[0], name: "a b" }] })],
    ["an action name with a line break", () => ({ ...example(), actions: [{ ...example().actions[0], name: "a\nb" }] })],
    ["an extra action field",() => ({ ...example(), actions: [{ ...example().actions[0], kind: "rewrite" }] })],
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
