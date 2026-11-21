import { extname } from "node:path";
import { listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { Project, TsEngine } from "./engine.ts";
import { byString, diagnostics, list as globList, introduced, matchFiles, unavailable } from "./shared.ts";

/**
 * typescript-add-import-extensions: relative imports, re-exports and dynamic `import()`s with a string
 * literal get the real file's extension (`./a` → `./a.ts`, `./dir` → `./dir/index.ts`). The project's
 * tsconfig gets `allowImportingTsExtensions` when it needs it.
 */

const RELATIVE = /^\.\.?(\/|$)/;
const DECLARATION = /\.d\.[mc]?ts$/;
const TS_EXTENSION = /\.[mc]?tsx?$/;
const FLAG = "allowImportingTsExtensions";

/** One specifier rewrite: `from` → `to` (without quotes), replacing `text` at `start`…`end`. */
type Edit = { start: number; end: number; text: string };

/** The relative module specifiers of `import`/`export … from` declarations and of `import("…")` calls. */
function relativeSpecifiers(t: TsEngine["ts"], sf: ts.SourceFile): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if ((t.isImportDeclaration(node) || t.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (t.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier);
    } else if (t.isCallExpression(node) && node.expression.kind === t.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first && t.isStringLiteralLike(first)) out.push(first);
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return out.filter((s) => RELATIVE.test(s.text));
}

/** The rewrites of one file's specifiers; `tsExtension` when one of them names a `.ts`-like file. */
function planFile(engine: TsEngine, file: string): { edits: Edit[]; tsExtension: boolean } {
  const t = engine.ts;
  const { program, sf } = engine.sourceFile(file);
  const options = program.getCompilerOptions();
  const allowing: ts.CompilerOptions = { ...options, [FLAG]: true };
  const from = engine.absPath(file);
  const edits: Edit[] = [];
  let tsExtension = false;

  for (const specifier of relativeSpecifiers(t, sf)) {
    const mode = t.getModeForUsageLocation(sf, specifier, options);
    const resolve = (name: string, with_: ts.CompilerOptions): string | undefined =>
      t.resolveModuleName(name, from, with_, t.sys, undefined, undefined, mode).resolvedModule?.resolvedFileName;
    const target = resolve(specifier.text, options);
    // Unresolved, or a declaration file (nothing to import it by with an extension): left as is.
    if (target === undefined || DECLARATION.test(target)) continue;
    const ext = extname(target);
    const bare = specifier.text.replace(/\/+$/, "");
    const candidate = [`${specifier.text}${ext}`, `${bare}/index${ext}`].find(
      (c) => c !== specifier.text && resolve(c, allowing) === target,
    );
    // Already has its extension (or an extension that maps to the file, as `./a.js` for `a.ts`).
    if (candidate === undefined) continue;
    const quote = specifier.getText(sf).charAt(0);
    if (candidate.includes(quote) || candidate.includes("\\") || (quote === "`" && candidate.includes("${"))) {
      unavailable(
        `${file}: cannot write ${JSON.stringify(candidate)} as a ${quote}-quoted specifier. Change the quotes of ` +
          `${JSON.stringify(specifier.text)} by hand, then run again.`,
      );
    }
    edits.push({
      start: specifier.getStart(sf),
      end: specifier.getEnd(),
      text: `${quote}${candidate}${quote}`,
    });
    if (TS_EXTENSION.test(candidate)) tsExtension = true;
  }
  return { edits, tsExtension };
}

// ---- the tsconfig ----

function propertyName(t: TsEngine["ts"], p: ts.ObjectLiteralElementLike): string | undefined {
  return t.isPropertyAssignment(p) && (t.isStringLiteral(p.name) || t.isIdentifier(p.name)) ? p.name.text : undefined;
}

/** `entry` added as the last property of `obj`, on its own line indented as the others, or inline. */
function addProperty(json: ts.JsonSourceFile, obj: ts.ObjectLiteralExpression, entry: string): string {
  const text = json.text;
  const last = obj.properties.at(-1);
  if (!last) {
    const open = obj.getStart(json);
    const inner = text.slice(open + 1, obj.getEnd() - 1);
    return inner.trim() === ""
      ? `${text.slice(0, open)}{ ${entry} }${text.slice(obj.getEnd())}`
      : `${text.slice(0, open + 1)} ${entry}${text.slice(open + 1)}`;
  }
  const lastStart = last.getStart(json);
  const line = (pos: number): number => json.getLineAndCharacterOfPosition(pos).line;
  let insert: string;
  if (line(obj.getStart(json)) === line(lastStart)) {
    insert = `, ${entry}`;
  } else {
    const lineStart = json.getPositionOfLineAndCharacter(line(lastStart), 0);
    insert = `,\n${text.slice(lineStart, lastStart).match(/^[ \t]*/)?.[0] ?? ""}${entry}`;
  }
  return text.slice(0, last.getEnd()) + insert + text.slice(last.getEnd());
}

/** The tsconfig's text with `"allowImportingTsExtensions": true` in its compilerOptions. */
function withFlag(engine: TsEngine, tsconfig: string): string {
  const t = engine.ts;
  const text = engine.read(tsconfig) ?? "";
  const json = t.parseJsonText(tsconfig, text);
  const root = json.statements[0]?.expression;
  if (t.parseConfigFileTextToJson(tsconfig, text).error || !root || !t.isObjectLiteralExpression(root)) {
    unavailable(`${tsconfig} is not a JSON object. Fix it, then run again.`);
  }
  const compilerOptions = root.properties.find((p) => propertyName(t, p) === "compilerOptions");
  if (!compilerOptions) return addProperty(json, root, `"compilerOptions": { "${FLAG}": true }`);
  if (!t.isPropertyAssignment(compilerOptions) || !t.isObjectLiteralExpression(compilerOptions.initializer)) {
    return unavailable(`${tsconfig}: compilerOptions is not an object. Fix it, then run again.`);
  }
  return addProperty(json, compilerOptions.initializer, `"${FLAG}": true`);
}

/**
 * The tsconfig to write so `.ts` extensions are allowed in the project, or null when they already are.
 * Refuses when TypeScript would not allow the flag (it needs noEmit or emitDeclarationOnly).
 */
function flagChange(engine: TsEngine, project: Project, file: string): { tsconfig: string; text: string } | null {
  const options = project.service.getProgram()?.getCompilerOptions() ?? {};
  if (options.allowImportingTsExtensions === true || options.rewriteRelativeImportExtensions === true) return null;
  if (project.tsconfig === null) {
    unavailable(`${file}: no tsconfig.json to set ${FLAG} in. Add one, or leave this file out of --files.`);
  }
  if (options.allowImportingTsExtensions === false) {
    unavailable(`${project.tsconfig}: ${FLAG} is set to false. Remove that setting first if .ts extensions are wanted.`);
  }
  if (options.noEmit !== true && options.emitDeclarationOnly !== true) {
    unavailable(
      `${project.tsconfig}: ${FLAG} needs noEmit or emitDeclarationOnly, and neither is set. Set one of them first, then run again.`,
    );
  }
  return { tsconfig: project.tsconfig, text: withFlag(engine, project.tsconfig) };
}

// ---- the action ----

export type AddImportExtensionsParams = { files: string[] };

export const addImportExtensionsAction: Action<AddImportExtensionsParams, TsEngine> = {
  id: "typescript-add-import-extensions",
  kind: "sweep",
  summary: "Gives relative imports and re-exports the real file extension (./a to ./a.ts).",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files whose imports get extensions, as comma-separated globs from the repo root." },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files") }),
  describe: (p) => `${p.files.join(", ")}`,

  async run(engine, p) {
    // Plan everything (and refuse) before writing anything.
    const plans: { file: string; edits: Edit[]; before: string[] }[] = [];
    const flags = new Map<string, { tsconfig: string; text: string } | null>();
    for (const file of await matchFiles(engine.repoRoot, p.files)) {
      const { edits, tsExtension } = planFile(engine, file);
      if (edits.length === 0) continue;
      plans.push({ file, edits, before: diagnostics(engine, file) });
      const project = engine.project(file);
      if (tsExtension && !flags.has(project.folder)) flags.set(project.folder, flagChange(engine, project, file));
    }

    const tsconfigs: string[] = [];
    for (const folder of [...flags.keys()].sort(byString)) {
      const change = flags.get(folder);
      if (!change) continue;
      engine.write(change.tsconfig, change.text);
      tsconfigs.push(change.tsconfig);
    }
    for (const { file, edits } of plans) {
      let text = engine.read(file) ?? "";
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      }
      engine.write(file, text);
    }
    for (const { file, before } of plans) {
      const errors = introduced(before, diagnostics(engine, file));
      if (errors.length > 0) {
        unavailable(
          `Adding import extensions to ${file} would introduce errors: ${errors.join("; ")}. Fix the imports of ` +
            `that file by hand or leave it out of --files, then run again.`,
        );
      }
    }
    const specifiers = plans.reduce((n, plan) => n + plan.edits.length, 0);
    return {
      summary:
        `Added extensions to ${plural(specifiers, "relative import")} in ${plural(plans.length, "file")}` +
        (tsconfigs.length > 0 ? `, and set ${FLAG} in ${tsconfigs.join(", ")}` : "") +
        `:\n${listLines(plans.map((plan) => plan.file))}`,
    };
  },
};
