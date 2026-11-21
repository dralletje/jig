import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RefactorError } from "@jig/core";
import { makeRepo } from "@jig/test-utils";
import { TsEngine } from "../src/engine.ts";

/** An example copy, with extra files written into it. */
export async function workspace(fixture: string, extra: Record<string, string> = {}): Promise<string> {
  const dir = await makeRepo(fixture);
  for (const [path, content] of Object.entries(extra)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

export async function rejects(p: Promise<unknown>): Promise<RefactorError> {
  try {
    await p;
  } catch (e) {
    return e as RefactorError;
  }
  throw new Error("expected rejection");
}

/** Paths whose content differs (deleted files included), sorted. */
export function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort();
}

/** TypeScript errors in the project of `file`, read fresh from disk. */
export async function errors(dir: string, file: string): Promise<string[]> {
  const engine = await TsEngine.load(dir);
  const program = engine.project(file).service.getProgram();
  assert.ok(program);
  return engine.ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? ""}: ${engine.ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}
