import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

const fixturesDir = join(import.meta.dirname, "..", "fixtures");
const repoRoot = join(import.meta.dirname, "..", "..", "..");

// test-utils is a leaf package, so it runs git itself.
function git(repo: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/** `examples/<name>` is the example repo at the repository root; any other name a fixture here. */
export function fixturePath(name: string): string {
  return name.startsWith("examples/") ? join(repoRoot, name) : join(fixturesDir, name);
}

/** A git repo (one commit, "init") holding a copy of the fixture or example `fixturePath` names. */
export async function makeRepo(fixture: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jig-"));
  await cp(fixturePath(fixture), dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** The JSON Schemas of `schemas/`, by `$id`. */
export const REPORT_SCHEMA_ID = "urn:jig:report:1";
export const OUTPUT_SCHEMA_ID = "urn:jig:output:1";
export const VERIFY_SCHEMA_ID = "urn:jig:verify:1";
export const HELP_SCHEMA_ID = "urn:jig:help:1";

let ajv: Ajv2020 | undefined;
function validator(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    for (const name of ["report-1.schema.json", "output-1.schema.json", "verify-1.schema.json", "help-1.schema.json"]) {
      ajv.addSchema(JSON.parse(readFileSync(join(repoRoot, "schemas", name), "utf8")) as object);
    }
  }
  return ajv;
}

/** Why `doc` does not match the schema `schemaId` (empty when it does). */
export function schemaErrors(schemaId: string, doc: unknown): string[] {
  const validate = validator().getSchema(schemaId);
  if (!validate) throw new Error(`no schema ${schemaId}`);
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""} ${JSON.stringify(e.params)}`);
}

/** Fails unless `doc` is a valid v1 image report. */
export function assertReport(doc: unknown): void {
  const errors = schemaErrors(REPORT_SCHEMA_ID, doc);
  if (errors.length > 0) throw new Error(`not a valid report:\n${errors.join("\n")}\n${JSON.stringify(doc, null, 2)}`);
}

/**
 * The files under `dir` (not .git), by path relative to it. Symlinks are neither read nor followed.
 *
 * It walks folder by folder: Node 26's `readdir(dir, { recursive: true })` now and then follows a symlink to a
 * folder (about 1 call in 300 on a tree holding `up -> ..`), looping until ELOOP.
 */
export async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const e of await readdir(folder, { withFileTypes: true })) {
      const rel = `${prefix}${e.name}`;
      if (rel === ".git") continue;
      if (e.isDirectory()) await walk(join(folder, e.name), `${rel}/`);
      else if (e.isFile()) out[rel] = await readFile(join(folder, e.name), "utf8");
    }
  };
  await walk(dir, "");
  return out;
}

export { actionToml } from "./toml-actions.ts";
export type { RunAction, TypeErrors } from "./toml-actions.ts";
