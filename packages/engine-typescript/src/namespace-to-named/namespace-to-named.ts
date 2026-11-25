import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "../engine.ts";
import { PREFERENCES, byString, diagnostics, list as globList, introduced, matchFiles, moduleName, notHandled } from "../shared.ts";
import type { NotHandled } from "../shared.ts";

/**
 * A sweep over the shape of imports: `import * as x` becomes `import { a, b }` (TypeScript'"'"'s
 * "Convert namespace import to named imports").
 */

type Ts = TsEngine["ts"];

/** The statements of a file that are `import * as x from "m"` (possibly with a default import). */
function namespaceOf(t: Ts, node: ts.Node): ts.NamespaceImport | undefined {
  if (!t.isImportDeclaration(node)) return undefined;
  const bindings = node.importClause?.namedBindings;
  return bindings && t.isNamespaceImport(bindings) ? bindings : undefined;
}

// ---- namespace-to-named ----

type Analysis = { skip: string | null };

/**
 * Whether the namespace import can become named imports: every use of `x` must be `x.name` (an
 * expression or a type), and at least one must exist. Otherwise the reason it is skipped.
 */
function analyse(engine: TsEngine, file: string, toConvert: ts.NamespaceImport): Analysis {
  const t = engine.ts;
  const { program, sf } = engine.sourceFile(file);
  const checker = program.getTypeChecker();
  // The node of the current source file at the same place.
  const ns = (() => {
    let found: ts.NamespaceImport | undefined;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (t.isNamespaceImport(n) && n.getStart(sf) === toConvert.getStart(sf)) found = n;
      else t.forEachChild(n, visit);
    };
    visit(sf);
    return found ?? toConvert;
  })();
  const symbol = checker.getSymbolAtLocation(ns.name);
  const name = ns.name.text;
  let accesses = 0;
  let own = false;
  let reserved = false;
  const visit = (node: ts.Node): void => {
    if (t.isIdentifier(node) && node.text === name && node !== ns.name) {
      const parent = node.parent;
      let used: ts.Symbol | undefined;
      if (t.isShorthandPropertyAssignment(parent) && parent.name === node) {
        used = checker.getShorthandAssignmentValueSymbol(parent);
      } else if (t.isExportSpecifier(parent) && !parent.parent.parent.moduleSpecifier) {
        used = checker.getExportSpecifierLocalTargetSymbol(parent);
      } else {
        used = checker.getSymbolAtLocation(node);
      }
      if (used !== undefined && used === symbol) {
        if (t.isPropertyAccessExpression(parent) && parent.expression === node) {
          accesses++;
          if (parent.name.text === "default") reserved = true;
        } else if (t.isQualifiedName(parent) && parent.left === node) {
          accesses++;
          if (parent.right.text === "default") reserved = true;
        } else {
          own = true;
        }
      }
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  if (own) return { skip: `\`${name}\` is used as a value on its own` };
  if (reserved) return { skip: `\`${name}.default\` cannot be written as a named import` };
  if (accesses === 0) return { skip: `\`${name}\` is not used` };
  return { skip: null };
}

export type NamespaceToNamedParams = { files: string[] };

type Converted = { index: number; module: string; namespace: string };
type Skipped = { index: number; name: string; reason: string; instructions?: string };

export const namespaceToNamedAction: Action<NamespaceToNamedParams, TsEngine> = {
  id: "namespace-to-named",
  kind: "sweep",
  summary: "Turns import * as x into named imports where every use is x.name.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files whose namespace imports change, as comma-separated globs from the repo root." },
  ],
  parseParams: (raw) => ({ files: globList(raw, "files") }),
  describe: (p) => p.files.join(", "),

  async run(engine, p) {
    const t = engine.ts;
    const format = t.getDefaultFormatCodeSettings("\n");
    const done = new Map<string, Converted[]>();
    const skipped = new Map<string, Skipped[]>();

    for (const file of await matchFiles(engine.repoRoot, p.files)) {
      const original = engine.read(file) ?? "";
      let errorsBefore: string[] | null = null;
      const converted: Converted[] = [];
      const left: Skipped[] = [];
      const ignore = new Set<number>();
      while (true) {
        const { sf } = engine.sourceFile(file);
        const index = sf.statements.findIndex((s, i) => !ignore.has(i) && namespaceOf(t, s) !== undefined);
        if (index < 0) break;
        const declaration = sf.statements[index] as ts.ImportDeclaration;
        const ns = namespaceOf(t, declaration) as ts.NamespaceImport;
        const { skip } = analyse(engine, file, ns);
        ignore.add(index);
        if (skip !== null) {
          left.push({ index, name: ns.name.text, reason: skip });
          continue;
        }
        errorsBefore ??= diagnostics(engine, file);
        const edits = engine
          .project(file)
          .service.getEditsForRefactor(
            engine.absPath(file),
            format,
            ns.getStart(sf),
            "Convert import",
            "Convert namespace import to named imports",
            PREFERENCES,
          );
        if (!edits || edits.edits.length === 0) {
          left.push({ index, name: ns.name.text, reason: `TypeScript cannot convert the import of \`${ns.name.text}\`` });
          continue;
        }
        engine.applyTextChanges(edits.edits);
        converted.push({ index, module: moduleName(declaration), namespace: ns.name.text });
      }
      // A file that would gain errors is put back as it was: its conversions are not handled, the rest of the run goes on.
      const errors = errorsBefore === null ? [] : introduced(errorsBefore, diagnostics(engine, file));
      if (errors.length > 0) {
        engine.write(file, original);
        const reason = `converting it would introduce errors: ${errors.join("; ")}`;
        for (const c of converted) {
          left.push({
            index: c.index,
            name: c.namespace,
            reason,
            instructions:
              `Left \`import * as ${c.namespace} from "${c.module}"\` in ${file} as it is, because converting it would introduce ` +
              `errors (${errors.join("; ")}). Fix that by hand, then run again.`,
          });
        }
        converted.length = 0;
        left.sort((a, b) => a.index - b.index);
      }
      if (converted.length > 0) done.set(file, converted);
      if (left.length > 0) skipped.set(file, left);
    }

    // What was not handled, from the nodes of the files as they are now.
    const misses: NotHandled[] = [];
    for (const file of [...skipped.keys()].sort(byString)) {
      const { sf } = engine.sourceFile(file);
      for (const { index, name, reason, instructions } of skipped.get(file) ?? []) {
        const declaration = sf.statements[index] as ts.ImportDeclaration;
        const module = moduleName(declaration);
        const { path, line } = engine.location(declaration);
        misses.push({
          path,
          line,
          reason,
          instructions:
            instructions ??
            `Left \`import * as ${name} from "${module}"\` in ${file} as it is. Use ${name} only as ${name}.<name> ` +
              `(or leave the import as a namespace import), then run again.`,
        });
      }
    }

    const files = [...done.keys()].sort(byString);
    if (files.length === 0) {
      throw new RefactorError(
        "NO_CHANGES",
        misses.length === 0
          ? `No namespace import in ${p.files.join(", ")} can be converted (there is none).`
          : `No namespace import was converted. Skipped:\n${misses.map((m) => `${m.path}:${m.line}: ${m.reason}`).join("\n")}`,
      );
    }
    let count = 0;
    for (const file of files) count += (done.get(file) ?? []).length;
    return {
      summary:
        `Converted ${plural(count, "namespace import")} to named imports in ${plural(files.length, "file")}:\n${listLines(files)}` +
        (misses.length > 0 ? `\n\n${notHandled(misses)}` : ""),
    };
  },
};
