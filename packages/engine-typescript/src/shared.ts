import { RefactorError, listFiles, matchesAnyGlob } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";

/** Refuses with `REFACTOR_UNAVAILABLE`; `instructions` say why and what to do first. */
export function unavailable(instructions: string): never {
  throw new RefactorError("REFACTOR_UNAVAILABLE", instructions);
}

/** `a`, `a` and `b`, `a`, `b` and `c`, each in backticks: names in a summary. */
export function names(items: string[]): string {
  const quoted = items.map((i) => `\`${i}\``);
  return quoted.length <= 1 ? (quoted[0] ?? "") : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** A place a partial result left as it was: where, why, and what the reader should do about it. */
export type NotHandled = { path: string; line: number; reason: string; instructions: string };

/**
 * The block a partial result ends its summary with, every place listed:
 *
 *     Not handled (2):
 *       src/a.ts:3: why it was left
 *         what to do
 */
export function notHandled(places: NotHandled[]): string {
  const lines = [`Not handled (${places.length}):`];
  for (const place of places) {
    lines.push(`  ${place.path}:${place.line}: ${place.reason}`);
    for (const line of place.instructions.split("\n")) lines.push(`    ${line}`);
  }
  return lines.join("\n");
}

export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The file's syntactic and semantic errors, as `TS<code>: <message>`. */
export function diagnostics(engine: TsEngine, file: string): string[] {
  const { program, sf } = engine.sourceFile(file);
  return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map(
    (d) => `TS${d.code}: ${engine.ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
  );
}

/** The errors in `after` that were not in `before` (counted: one of two identical errors is new). */
export function introduced(before: string[], after: string[]): string[] {
  const out = [...after];
  for (const d of before) {
    const at = out.indexOf(d);
    if (at >= 0) out.splice(at, 1);
  }
  return out;
}

/** TypeScript source files: what a project holds. */
export const TS_FILE = /\.(m|c)?tsx?$/;

/** TypeScript files under the root matching any of the globs, sorted. Fails when nothing matches. */
export async function matchFiles(root: string, globs: string[]): Promise<string[]> {
  const files = (await listFiles(root)).filter((f) => TS_FILE.test(f) && matchesAnyGlob(f, globs));
  if (files.length === 0) {
    throw new RefactorError(
      "NO_CHANGES",
      `No TypeScript file matches ${globs.join(", ")}. Globs are matched against the committed files from the repo root (for example "src/**").`,
    );
  }
  return files;
}

export const PREFERENCES: ts.UserPreferences = {
  allowTextChangesInNewFiles: true,
  quotePreference: "auto",
};

export function required(raw: Record<string, string | undefined>, key: string): string {
  const v = raw[key];
  if (v === undefined || v === "") throw new RefactorError("INVALID_ARGS", `Missing --${key}. Pass it and run again.`);
  return v;
}

/** A comma-separated `--key` value as a non-empty list. */
export function list(raw: Record<string, string | undefined>, key: string): string[] {
  const items = required(raw, key)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) throw new RefactorError("INVALID_ARGS", `--${key} is empty. Pass a comma-separated list.`);
  return items;
}

/** The place `--at <path>:<line>[:<column>]` names, 1-based. */
export type At = { path: string; line: number; column?: number };

/** `<path>:<line>[:<column>]` as a string, for messages. */
export function atText(file: string, at: { line: number; column?: number }): string {
  return `${file}:${at.line}${at.column === undefined ? "" : `:${at.column}`}`;
}

/** Parses `--at <path>:<line>[:<column>]` (1-based numbers); anything else is `INVALID_ARGS`. */
export function parseAt(raw: string): At {
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(raw);
  const line = match ? Number(match[2]) : 0;
  const column = match?.[3] === undefined ? undefined : Number(match[3]);
  if (!match || line < 1 || (column !== undefined && column < 1)) {
    throw new RefactorError(
      "INVALID_ARGS",
      `--at must be <path>:<line>[:<column>] with 1-based numbers, not ${JSON.stringify(raw)}. Pass for example --at src/a.ts:12 or --at src/a.ts:12:20.`,
    );
  }
  return { path: match[1] as string, line, ...(column === undefined ? {} : { column }) };
}

/** A node `--at` may name: the span `start`…`end` (a column inside it picks it); `label` names it in messages. */
export type AtCandidate<T> = {
  item: T;
  start: number;
  end: number;
  label?: string;
  /** Another offset whose line also counts as a line the candidate starts on. */
  startAlt?: number;
};

/**
 * The candidate `at` names in `file` (root-relative, `sf` its source file):
 * - a line or column outside the file is `INVALID_ARGS`;
 * - with a column: the smallest candidate whose span holds it;
 * - without: the one candidate that starts on the line (`outermost`: candidates inside another candidate
 *   of that line do not count), and several is `INVALID_ARGS` asking for a column;
 * - none is `REFACTOR_UNAVAILABLE`, saying what to point at (`hint`).
 * `what` and `plural` are the noun phrase for one and for several candidates in messages ("variable name", "variable names").
 */
export function findAt<T>(
  sf: ts.SourceFile,
  file: string,
  at: At,
  candidates: AtCandidate<T>[],
  options: { what: string; plural: string; hint: string; outermost?: boolean },
): T {
  const starts = sf.getLineStarts();
  const where = atText(file, at);
  if (at.line > starts.length) {
    throw new RefactorError("INVALID_ARGS", `${file} has ${starts.length} lines, not ${at.line}. Pass a line within the file.`);
  }
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const columnOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).character + 1;
  let found: AtCandidate<T>[];
  if (at.column === undefined) {
    const onLine = candidates.filter((c) => lineOf(c.start) === at.line || (c.startAlt !== undefined && lineOf(c.startAlt) === at.line));
    found = options.outermost
      ? onLine.filter((n) => !onLine.some((o) => o !== n && o.start <= n.start && n.end <= o.end && (o.start < n.start || n.end < o.end)))
      : onLine;
  } else {
    const lineStart = starts[at.line - 1] as number;
    const lineEnd = at.line < starts.length ? (starts[at.line] as number) : sf.end;
    const offset = lineStart + at.column - 1;
    if (offset >= Math.max(lineEnd, lineStart + 1)) {
      throw new RefactorError("INVALID_ARGS", `Line ${file}:${at.line} has no column ${at.column}. Pass a column within the line.`);
    }
    found = candidates.filter((c) => c.start <= offset && offset < c.end).sort((a, b) => a.end - a.start - (b.end - b.start)).slice(0, 1);
  }
  if (found.length === 0) {
    throw new RefactorError(
      "REFACTOR_UNAVAILABLE",
      `There is no ${options.what} ${at.column === undefined ? "starting on line" : "at"} ${where}. ${options.hint}`,
    );
  }
  if (found.length > 1) {
    const labelled = found.every((c) => c.label !== undefined);
    const list = labelled
      ? found.map((c) => `${c.label} at column ${columnOf(c.start)}`).join(", ")
      : `at columns ${found.map((c) => columnOf(c.start)).join(", ")}`;
    throw new RefactorError(
      "INVALID_ARGS",
      `Line ${file}:${at.line} has ${found.length} ${options.plural} (${list}). Pass a column to pick one: --at ${file}:${at.line}:<column>.`,
    );
  }
  return (found[0] as AtCandidate<T>).item;
}
