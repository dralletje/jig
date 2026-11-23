import { RefactorError } from "./errors.ts";
import type { ImageHelp } from "./help.ts";
import type { ActionKind, ActionResult } from "./types.ts";

/** The `schema` of every image report this version writes (`schemas/report-1.schema.json`). */
export const REPORT_SCHEMA = "urn:jig:report:1";

export type OkReport = { schema: typeof REPORT_SCHEMA; ok: true; kind: ActionKind; subject: string; summary: string };

export type FailedReport = { schema: typeof REPORT_SCHEMA; ok: false; code: string; instructions: string };

/** What an action image prints as the last line of its output. */
export type Report = OkReport | FailedReport;

/**
 * The v1 success report: subject `<kind>(<image> <action>): <description>`, and the action's summary
 * without trailing whitespace. `image` is the image's own name (`typescript`, `prettier`, ...), `action`
 * the action jig ran (the first argument). Throws (an `INTERNAL` failure) on an image bug: an image name
 * that is empty or has a space or parenthesis, an empty action, a blank summary, or a subject with a
 * line break.
 */
export function okReport(kind: ActionKind, image: string, action: string, description: string, result: ActionResult): OkReport {
  if (!/^[^\s()]+$/.test(image)) throw new Error(`the image name ${JSON.stringify(image)} is empty or has a space or parenthesis`);
  if (action === "") throw new Error(`${image}: the action is empty`);
  if (result.summary.trim() === "") throw new Error(`${image} ${action}: the summary is empty`);
  const subject = `${kind}(${image} ${action}): ${description}`;
  if (/[\r\n]/.test(subject)) throw new Error(`${image} ${action}: the subject has a line break`);
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
 *
 * Arguments that are exactly `["--help"]` print the image's help as one JSON line instead and exit 0
 * (a `help` that throws is an `INTERNAL` failure); any other arguments go to `main` as they are.
 */
export async function runEntrypoint(
  main: (argv: string[], root: string) => Promise<Report>,
  help: () => ImageHelp | Promise<ImageHelp>,
): Promise<never> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    let answer: ImageHelp;
    try {
      answer = await help();
    } catch (e) {
      await printLine(JSON.stringify(failedReport("INTERNAL", `the help crashed: ${e instanceof Error ? e.message : String(e)}`)));
      process.exit(1);
    }
    await printLine(JSON.stringify(answer));
    process.exit(0);
  }
  let report: Report;
  try {
    report = await main(argv, process.cwd());
  } catch (e) {
    report =
      e instanceof RefactorError
        ? failedReport(e.code, e.message)
        : failedReport("INTERNAL", `the action crashed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await printLine(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}

/**
 * Writes `line` and a newline to stdout and resolves once it is handed to the system. `process.exit`
 * right after `console.log` drops what is still queued when stdout is a non-blocking pipe (as under
 * some Docker setups), which cut help off at 8192 bytes.
 */
function printLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
  });
}
