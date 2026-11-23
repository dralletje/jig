// The TypeScript 7.1.0-beta helpers of the beta image (JIG_TYPESCRIPT=7.1.0-beta). Only ts7/ imports this.
import { NodeFlags, SyntaxKind } from "typescript7/ast";
import type * as ast7 from "typescript7/ast";
import * as is7 from "typescript7/ast/is";

/** A string literal or a template without substitutions, in a TypeScript 7 syntax tree. */
export type StringLiteralLike7 = ast7.StringLiteral | ast7.NoSubstitutionTemplateLiteral;

/**
 * `importSpecifiers` for a TypeScript 7 syntax tree. TypeScript 7 also parses the JSDoc of a JavaScript file
 * into the tree itself (an `@import` tag becomes an import declaration, an `@type` an annotation), marked
 * `Reparsed`: those are skipped, so a JSDoc import counts once (`jsDocSpecifiers7` in relocate reads it).
 */
export function importSpecifiers7(sf: ast7.SourceFile): StringLiteralLike7[] {
  const out: StringLiteralLike7[] = [];
  const isStringLiteralLike = (node: ast7.Node): node is StringLiteralLike7 =>
    is7.isStringLiteral(node) || is7.isNoSubstitutionTemplateLiteral(node);
  const visit = (node: ast7.Node): void => {
    if ((node.flags & NodeFlags.Reparsed) !== 0) return;
    if ((is7.isImportDeclaration(node) || is7.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (is7.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier);
    } else if (is7.isImportEqualsDeclaration(node) && is7.isExternalModuleReference(node.moduleReference)) {
      if (is7.isStringLiteral(node.moduleReference.expression)) out.push(node.moduleReference.expression);
    } else if (is7.isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first && isStringLiteralLike(first)) out.push(first);
    } else if (
      is7.isCallExpression(node) &&
      is7.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      const [first] = node.arguments;
      if (first && isStringLiteralLike(first)) out.push(first);
    } else if (is7.isImportTypeNode(node) && is7.isLiteralTypeNode(node.argument) && is7.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}
