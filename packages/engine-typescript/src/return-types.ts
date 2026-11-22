import { RefactorError, listLines, plural } from "@jig/core";
import type { Action } from "@jig/core";
import type ts from "typescript";
import type { TsEngine } from "./engine.ts";
import { diagnostics, list as globList, introduced, matchFiles, notHandled, unavailable } from "./shared.ts";
import type { NotHandled } from "./shared.ts";

/**
 * typescript-infer-return-types: functions and methods without a return type annotation get the type
 * TypeScript infers, using its "Infer function return type" refactor. A function whose inferred type
 * holds an `any` nobody wrote, or an `import("…")` type (a type that is not in scope where it is
 * written), is left alone and listed in the summary as not handled.
 */

const REFACTOR = "Infer function return type";

type FunctionLike = ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** A function to annotate: where to ask TypeScript (`at`), and where the function starts. */
type Candidate = { node: FunctionLike; at: number; start: number; path: string };

type Done = { candidate: Candidate; type: string; insertedAt: number };

/** Names exported by `export { a, b as c }` and `export default a` (the local names). */
function exportedNames(t: TsEngine["ts"], sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (t.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && t.isNamedExports(stmt.exportClause)) {
      for (const e of stmt.exportClause.elements) names.add((e.propertyName ?? e.name).text);
    } else if (t.isExportAssignment(stmt) && t.isIdentifier(stmt.expression)) {
      names.add(stmt.expression.text);
    }
  }
  return names;
}

/** The functions and methods with a body and without a return type, in source order. */
function candidates(engine: TsEngine, sf: ts.SourceFile, exportedOnly: boolean): Candidate[] {
  const t = engine.ts;
  const later = exportedNames(t, sf);
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
    t.canHaveModifiers(node) && (t.getModifiers(node) ?? []).some((m) => m.kind === kind);
  const isExported = (statement: ts.Node, name: string | undefined): boolean =>
    hasModifier(statement, t.SyntaxKind.ExportKeyword) || (name !== undefined && later.has(name));
  const out: Candidate[] = [];

  /** Whether the function counts as exported: a top-level function or variable, or a member of a top-level class. */
  const exported = (node: FunctionLike): boolean => {
    if (t.isFunctionDeclaration(node)) return t.isSourceFile(node.parent) && isExported(node, node.name?.text);
    if (t.isMethodDeclaration(node) || t.isGetAccessorDeclaration(node)) {
      return t.isObjectLiteralExpression(node.parent) ? literalExported(node.parent) : memberOfExportedClass(node, node.name);
    }
    const holder = node.parent;
    if (t.isVariableDeclaration(holder) && holder.initializer === node && t.isIdentifier(holder.name)) {
      const statement = holder.parent.parent;
      return t.isVariableStatement(statement) && t.isSourceFile(statement.parent) && isExported(statement, holder.name.text);
    }
    if (t.isPropertyDeclaration(holder) && holder.initializer === node) return memberOfExportedClass(holder, holder.name);
    return false;
  };
  /** Whether an object literal is held by an exported top-level variable (or is the default export), at any depth. */
  const literalExported = (literal: ts.ObjectLiteralExpression): boolean => {
    const holder = literal.parent;
    if (t.isPropertyAssignment(holder) && holder.initializer === literal && t.isObjectLiteralExpression(holder.parent)) {
      return literalExported(holder.parent);
    }
    if (t.isVariableDeclaration(holder) && holder.initializer === literal && t.isIdentifier(holder.name)) {
      const statement = holder.parent.parent;
      return t.isVariableStatement(statement) && t.isSourceFile(statement.parent) && isExported(statement, holder.name.text);
    }
    return t.isExportAssignment(holder) && holder.expression === literal;
  };
  const memberOfExportedClass = (member: ts.ClassElement, name: ts.PropertyName): boolean => {
    const cls = member.parent;
    if (!t.isClassDeclaration(cls) || !t.isSourceFile(cls.parent) || !isExported(cls, cls.name?.text)) return false;
    return !t.isPrivateIdentifier(name) && !hasModifier(member, t.SyntaxKind.PrivateKeyword);
  };
  /** A named function: a declaration, a method, or a function expression/arrow held by a variable or property. */
  const named = (node: ts.Node): node is FunctionLike => {
    if (t.isFunctionDeclaration(node)) return node.name !== undefined || hasModifier(node, t.SyntaxKind.DefaultKeyword);
    if (t.isMethodDeclaration(node) || t.isGetAccessorDeclaration(node)) {
      return t.isClassLike(node.parent) || t.isObjectLiteralExpression(node.parent);
    }
    if (!t.isArrowFunction(node) && !t.isFunctionExpression(node)) return false;
    const holder = node.parent;
    return (
      (t.isVariableDeclaration(holder) && holder.initializer === node && t.isIdentifier(holder.name)) ||
      (t.isPropertyDeclaration(holder) && holder.initializer === node)
    );
  };

  const visit = (node: ts.Node): void => {
    if (named(node) && node.type === undefined && node.body !== undefined && (!exportedOnly || exported(node))) {
      const at = (t.isFunctionDeclaration(node) || t.isMethodDeclaration(node) || t.isGetAccessorDeclaration(node)) && node.name
          ? node.name
          : node;
      out.push({ node, at: at.getStart(sf), start: node.getStart(sf), path: engine.declarationPath(node) });
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Why the inferred type text cannot be written as it is, or null when it can. */
function problem(t: TsEngine["ts"], type: string, node: FunctionLike): string | null {
  const parsed = t.createSourceFile("type.ts", `type T = ${type};`, t.ScriptTarget.Latest);
  let imported = false;
  let any = false;
  const visit = (n: ts.Node): void => {
    if (t.isImportTypeNode(n)) imported = true;
    if (n.kind === t.SyntaxKind.AnyKeyword) any = true;
    t.forEachChild(n, visit);
  };
  visit(parsed);
  if (imported) return "its inferred return type needs an import";
  if (any) {
    // An `any` the function itself spells out (a parameter typed `any`) is the author's. This is an
    // approximation: any `any` written anywhere in the function counts, even one unrelated to the return
    // type, so such a function is annotated even when the inferred `any` came from elsewhere.
    let written = false;
    const find = (n: ts.Node): void => {
      if (n.kind === t.SyntaxKind.AnyKeyword) written = true;
      t.forEachChild(n, find);
    };
    find(node);
    if (!written) return "its inferred return type contains an `any` that nobody wrote";
  }
  return null;
}

/** The edit that writes the type of a get accessor's property after its parameter list, or undefined. */
function accessorEdits(engine: TsEngine, file: string, candidate: Candidate): ts.RefactorEditInfo | undefined {
  const t = engine.ts;
  const { program, sf } = engine.sourceFile(file);
  let current: ts.GetAccessorDeclaration | undefined;
  const find = (n: ts.Node): void => {
    if (current === undefined && t.isGetAccessorDeclaration(n) && n.getStart(sf) === candidate.start) current = n;
    else if (current === undefined && n.getStart(sf) <= candidate.start && candidate.start < n.getEnd()) t.forEachChild(n, find);
  };
  find(sf);
  if (!current || current.type !== undefined) return undefined;
  const close = current.getChildren(sf).find((c) => c.kind === t.SyntaxKind.CloseParenToken);
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(current.name);
  if (!close || !symbol) return undefined;
  const type = checker.typeToString(
    checker.getTypeOfSymbolAtLocation(symbol, current),
    current,
    t.TypeFormatFlags.NoTruncation | t.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
  return {
    edits: [{ fileName: sf.fileName, textChanges: [{ span: { start: close.end, length: 0 }, newText: `: ${type}` }] }],
  };
}

// ---- the action ----

export type InferReturnTypesParams = { files: string[]; exportedOnly: boolean };

export const inferReturnTypesAction: Action<InferReturnTypesParams, TsEngine> = {
  id: "typescript-infer-return-types",
  kind: "sweep",
  summary: "Adds the inferred return type to functions that have none.",
  flags: [
    { name: "--files", type: "globs", required: true, description: "The files whose functions get return types, as comma-separated globs from the repo root." },
    {
      name: "--exported-only",
      type: "choice",
      choices: [
        { name: "true", description: "Only exported functions (the default)." },
        { name: "false", description: "Every function." },
      ],
      required: false,
      description: "Which functions get a return type.",
    },
  ],
  parseParams: (raw) => {
    const flag = raw["exported-only"];
    if (flag !== undefined && flag !== "true" && flag !== "false") {
      throw new RefactorError("INVALID_ARGS", `--exported-only is "${flag}". Pass true or false.`);
    }
    return { files: globList(raw, "files"), exportedOnly: flag !== "false" };
  },
  describe: (p) => p.files.join(", ") + (p.exportedOnly ? "" : " (including functions that are not exported)"),

  async run(engine, p) {
    const t = engine.ts;
    const format = t.getDefaultFormatCodeSettings("\n");
    const misses: (NotHandled & { function: string })[] = [];
    const lines: string[] = [];
    const edited: { file: string; before: string[] }[] = [];

    for (const file of await matchFiles(engine.repoRoot, p.files)) {
      if (/\.d\.[mc]?ts$/.test(file)) continue;
      const found = candidates(engine, engine.sourceFile(file).sf, p.exportedOnly);
      if (found.length === 0) continue;
      const before = diagnostics(engine, file);
      let known = before;
      const service = engine.project(file).service;
      const done: Done[] = [];
      const skipped: { candidate: Candidate; reason: string; instructions: string }[] = [];

      // Last function first: an insertion never moves the functions before it, so every position is
      // still the one it had when the file was read.
      for (const candidate of [...found].reverse()) {
        const abs = engine.absPath(file);
        const skip = (reason: string, instructions: string): void => {
          skipped.push({ candidate, reason, instructions });
        };
        const accessor = t.isGetAccessorDeclaration(candidate.node);
        // TypeScript's refactor does not offer get accessors: write the type of the property ourselves.
        const applicable =
          accessor ||
          service
            .getApplicableRefactors(abs, candidate.at, {}, undefined, undefined)
            .some((r) => r.name === REFACTOR && r.actions.some((a) => a.name === REFACTOR && !a.notApplicableReason));
        if (!applicable) {
          skip(
            "TypeScript cannot infer a return type here",
            "Write the return type by hand, or fix the errors in the function first.",
          );
          continue;
        }
        const edits = accessor
          ? accessorEdits(engine, file, candidate)
          : service.getEditsForRefactor(abs, format, candidate.at, REFACTOR, REFACTOR, {});
        const change = edits?.edits.length === 1 ? edits.edits[0] : undefined;
        const insertion = change?.textChanges.length === 1 ? change.textChanges[0] : undefined;
        if (!edits || !change || !insertion || insertion.span.length !== 0 || !insertion.newText.startsWith(": ")) {
          skip("TypeScript proposed more than a return type", "Write the return type by hand.");
          continue;
        }
        const type = insertion.newText.slice(2);
        const why = problem(t, type, candidate.node);
        if (why !== null) {
          skip(
            why,
            `Write the return type of the function by hand (TypeScript infers \`${type}\`), or give it a type that can be named here.`,
          );
          continue;
        }
        const text = engine.read(file) ?? "";
        engine.applyTextChanges(edits.edits);
        // Names in the type that do not resolve at the insertion point show up as new errors: undo this one.
        const now = diagnostics(engine, file);
        const errors = introduced(known, now);
        if (errors.length > 0) {
          engine.write(file, text);
          const name = errors.map((e) => /Cannot find name '([^']+)'/.exec(e)?.[1]).find((n) => n !== undefined);
          skip(
            name !== undefined
              ? `its inferred type names \`${name}\`, which is not in scope here`
              : "its inferred return type does not compile where it would be written",
            `Write the return type of the function by hand (TypeScript infers \`${type}\`), or export the type it names.`,
          );
          continue;
        }
        known = now;
        done.push({ candidate, type, insertedAt: insertion.span.start });
      }

      /** An offset in the file as it was read, in the file now. */
      const shifted = (offset: number): number =>
        offset + done.filter((d) => d.insertedAt <= offset).reduce((n, d) => n + d.type.length + 2, 0);
      for (const { candidate, type } of done.reverse()) lines.push(`${candidate.path}: ${type}`);
      // Skipped last function first: in source order for the summary.
      for (const { candidate, reason, instructions } of skipped.reverse()) {
        const { path, line } = engine.locationAt(file, shifted(candidate.start));
        misses.push({ function: candidate.path, path, line, reason, instructions });
      }
      if (done.length > 0) edited.push({ file, before });
    }

    if (lines.length === 0) {
      throw new RefactorError(
        "NO_CHANGES",
        misses.length === 0
          ? `No function without a return type${p.exportedOnly ? " that is exported" : ""} in ${p.files.join(", ")}.`
          : `Nothing could be annotated in ${p.files.join(", ")}. Skipped: ${misses
              .map((m) => `${m.function} (${m.reason}; ${m.path}:${m.line})`)
              .join("; ")}.`,
      );
    }
    for (const { file, before } of edited) {
      const errors = introduced(before, diagnostics(engine, file));
      if (errors.length > 0) {
        unavailable(
          `Adding return types to ${file} would introduce errors: ${errors.join("; ")}. Write the return types of ` +
            `that file by hand or leave it out of --files, then run again.`,
        );
      }
    }
    const files = edited.length;
    return {
      summary:
        `Added the inferred return type to ${plural(lines.length, "function")} in ${plural(files, "file")}:\n${listLines(lines)}` +
        (misses.length > 0 ? `\n\n${notHandled(misses)}` : ""),
    };
  },
};
