import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  HELP_SCHEMA_ID,
  OUTPUT_SCHEMA_ID,
  REPORT_SCHEMA_ID,
  VERIFY_SCHEMA_ID,
  assertReport,
  schemaErrors,
} from "@jig/test-utils";
import { failedReport, listLines, okReport, plural } from "../src/index.ts";

const EXAMPLES = join(import.meta.dirname, "..", "..", "..", "schemas", "examples");
const example = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(EXAMPLES, name), "utf8")) as Record<string, unknown>;

describe("okReport", () => {
  test("builds the v1 success shape: kind, subject and the summary without trailing whitespace", () => {
    const report = okReport("refactor", "rename", "a → b", { summary: "Renamed a.\n\n" });
    assertReport(report);
    assert.deepEqual(report, {
      schema: "urn:jig:report:1",
      ok: true,
      kind: "refactor",
      subject: "refactor(rename): a → b",
      summary: "Renamed a.",
    });
  });

  test("has exactly the keys schema, ok, kind, subject, summary, in that order", () => {
    assert.deepEqual(Object.keys(okReport("sweep", "format", "x", { summary: "Formatted." })), [
      "schema",
      "ok",
      "kind",
      "subject",
      "summary",
    ]);
  });

  test("refuses a blank summary or a subject with a line break (an action bug)", () => {
    assert.throws(() => okReport("refactor", "a", "b", { summary: " \n" }), /summary is empty/);
    assert.throws(() => okReport("refactor", "a", "b\nc", { summary: "s" }), /subject has a line break/);
  });
});

describe("schemas", () => {
  test("the examples in schemas/examples are valid", () => {
    const names = readdirSync(EXAMPLES).sort();
    assert.deepEqual(names, [
      "help-1.json",
      "output-failure.json",
      "output-success.json",
      "report-complete.json",
      "report-failure.json",
      "verify-1-range.json",
    ]);
    for (const name of names) {
      const id = name.startsWith("report-")
        ? REPORT_SCHEMA_ID
        : name.startsWith("verify-")
          ? VERIFY_SCHEMA_ID
          : name.startsWith("help-")
            ? HELP_SCHEMA_ID
            : OUTPUT_SCHEMA_ID;
      assert.deepEqual(schemaErrors(id, example(name)), [], name);
    }
  });

  const verifyInvalid: [string, (commits: Record<string, unknown>[]) => unknown][] = [
    ["identical with files differing", ([c]) => [{ ...c, filesDiffering: ["a.ts"] }]],
    ["different with no file differing and no mismatch", ([, , d]) => [{ ...d, filesDiffering: [], mismatches: [] }]],
    ["a mismatch of an unknown field", ([, , , d]) => [{ ...d, mismatches: [{ field: "summary", recorded: "a", replayed: "b" }] }]],
    ["skipped without a reason", ([, s]) => [{ ...s, reason: undefined }]],
    ["failed without a code", ([, , , , f]) => [{ ...f, code: undefined }]],
    ["an unknown verdict", ([c]) => [{ ...c, verdict: "same" }]],
    ["an extra field", ([c]) => [{ ...c, effect: [] }]],
  ];
  for (const [name, change] of verifyInvalid) {
    test(`rejects verify output with ${name}`, () => {
      const output = example("verify-1-range.json");
      const commits = JSON.parse(JSON.stringify(change(output.commits as Record<string, unknown>[])));
      assert.notDeepEqual(schemaErrors(VERIFY_SCHEMA_ID, { ...output, commits }), []);
    });
  }

  test("success output: notes are optional, and when there, a non-empty list of non-empty strings", () => {
    const output = example("output-success.json");
    assert.deepEqual(schemaErrors(OUTPUT_SCHEMA_ID, { ...output, notes: ["A cached image was used."] }), []);
    assert.notDeepEqual(schemaErrors(OUTPUT_SCHEMA_ID, { ...output, notes: [] }), []);
    assert.notDeepEqual(schemaErrors(OUTPUT_SCHEMA_ID, { ...output, notes: [""] }), []);
    assert.notDeepEqual(schemaErrors(OUTPUT_SCHEMA_ID, { ...output, notes: "x" }), []);
  });

  test("failure output: REGISTRY_UNAVAILABLE is a code", () => {
    const output = example("output-failure.json");
    assert.deepEqual(schemaErrors(OUTPUT_SCHEMA_ID, { ...output, code: "REGISTRY_UNAVAILABLE" }), []);
  });

  test("the failure report is valid; INTERNAL is allowed (the binary turns it into IMAGE_FAILED)", () => {
    assertReport(failedReport("SYMBOL_NOT_FOUND", "No top-level foo in a.ts."));
    assertReport(failedReport("INTERNAL", "crashed"));
    assert.notDeepEqual(schemaErrors(REPORT_SCHEMA_ID, failedReport("WHATEVER", "x")), []);
  });

  const invalid: [string, (r: Record<string, unknown>) => unknown][] = [
    ["no schema", ({ schema: _s, ...r }) => r],
    ["an older schema", (r) => ({ ...r, schema: "urn:jig:report:0" })],
    ["a multi-line subject", (r) => ({ ...r, subject: "a\nb" })],
    ["an unknown kind", (r) => ({ ...r, kind: "codemod" })],
    ["an extra field", (r) => ({ ...r, effectHash: "sha256:00" })],
    ["a status (no longer in v1)", (r) => ({ ...r, status: "complete" })],
    ["a whitespace-only summary", (r) => ({ ...r, summary: " \n\t" })],
    ["the old v0 error shape", () => ({ ok: false, error: { code: "INVALID_ARGS", message: "m" } })],
  ];
  for (const [name, change] of invalid) {
    test(`rejects a report with ${name}`, () => {
      assert.notDeepEqual(schemaErrors(REPORT_SCHEMA_ID, change(example("report-complete.json"))), []);
    });
  }
});

describe("helpers", () => {
  test("listLines caps the list", () => {
    assert.equal(listLines(["a", "b", "c"], 2), "  a\n  b\n  … and 1 more");
  });

  test("plural", () => {
    assert.equal(plural(1, "file"), "1 file");
    assert.equal(plural(2, "file"), "2 files");
    assert.equal(plural(2, "match", "matches"), "2 matches");
  });
});
