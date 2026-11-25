import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionKind } from "@jig/core";
import { main } from "../src/index.ts";
import type { CodemodPackage, TransformInfo } from "../src/index.ts";

export const RENAME = `module.exports = (file, api) => api.j(file.source).find(api.j.Identifier, { name: "foo" }).replaceWith("bar").toSource();\n`;
export const THROWS = `module.exports = () => { throw new Error("cannot handle this\\nsecond line"); };\n`;
export const FLOW = `module.exports = (file, api) => api.j(file.source).find(api.j.Identifier, { name: "x" }).replaceWith("y").toSource();\nmodule.exports.parser = "flow";\n`;

/**
 * A stand-in for a published codemod package: a folder with `transforms/<name>.js` files, each transform
 * of the given kind and described as "Runs <name>.".
 */
export async function fakePackage(kinds: Record<string, ActionKind>, sources: Record<string, string> = {}): Promise<CodemodPackage> {
  const transforms: Record<string, TransformInfo> = {};
  for (const [name, kind] of Object.entries(kinds)) transforms[name] = { kind, description: `Runs ${name}.` };
  const dir = await mkdtemp(join(tmpdir(), "fake-codemods-"));
  await mkdir(join(dir, "transforms"));
  for (const name of Object.keys(transforms)) await writeFile(join(dir, "transforms", `${name}.js`), sources[name] ?? RENAME);
  return { image: "codemod-fake", name: "fake-codemods", version: "1.2.3", dir, transforms };
}

/** The run function of the TOML cases: `main` with `pkg` as the carried package. */
export function runWith(pkg: CodemodPackage): (argv: string[], dir: string) => Promise<unknown> {
  return (argv, dir) => main(argv, dir, pkg);
}
