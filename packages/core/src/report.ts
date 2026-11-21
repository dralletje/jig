import { RefactorError } from "./errors.ts";
import type { ActionKind, ActionResult } from "./types.ts";

/** The `schema` of every image report this version writes (`schemas/report-1.schema.json`). */
export const REPORT_SCHEMA = "urn:jig:report:1";

export type OkReport = { schema: typeof REPORT_SCHEMA; ok: true; kind: ActionKind; subject: string; summary: string };

export type FailedReport = { schema: typeof REPORT_SCHEMA; ok: false; code: string; instructions: string };

/** What an action image prints as the last line of its output. */
export type Report = OkReport | FailedReport;

/**
 * The v1 success report: subject `<kind>(<label>): <description>`, and the action's summary without
 * trailing whitespace. Throws (an `INTERNAL` failure) on an action bug: a blank summary, or a subject
 * with a line break.
 */
export function okReport(kind: ActionKind, label: string, description: string, result: ActionResult): OkReport {
  if (result.summary.trim() === "") throw new Error(`${label}: the summary is empty`);
  const subject = `${kind}(${label}): ${description}`;
  if (/[\r\n]/.test(subject)) throw new Error(`${label}: the subject has a line break`);
  return { schema: REPORT_SCHEMA, ok: true, kind, subject, summary: result.summary.replace(/\s+$/, "") };
}

/** The v1 failure report. */
export function failedReport(code: string, instructions: string): FailedReport {
  return { schema: REPORT_SCHEMA, ok: false, code, instructions };
}

/** `items` one per line, indented, the first `max` of them and then `… and N more`. */
export function listLines(items: string[], max = 20): string {
  const shown = items.slice(0, max).map((i) => `  ${i}`);
  if (items.length > max) shown.push(`  … and ${items.length - max} more`);
  return shown.join("\n");
}

/** `1 file`, `2 files`. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/**
 * Runs an image's `main` on its arguments and working directory, prints the report as the last line
 * and exits 0 when it is ok, else 1. A thrown RefactorError becomes its code and instructions; anything
 * else `INTERNAL` (which the binary reports as `IMAGE_FAILED`).
 */
export async function runEntrypoint(main: (argv: string[], root: string) => Promise<Report>): Promise<never> {
  let report: Report;
  try {
    report = await main(process.argv.slice(2), process.cwd());
  } catch (e) {
    report =
      e instanceof RefactorError
        ? failedReport(e.code, e.message)
        : failedReport("INTERNAL", `the action crashed: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
