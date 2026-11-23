import { parseArgs } from "node:util";
import { RefactorError, actionHelp, imageHelp, okReport, writeChanges } from "@jig/core";
import type { Action, ImageHelp, Report } from "@jig/core";
import { extractAction, renameAction } from "./actions.ts";
import { removeBarrelsAction } from "./barrels.ts";
import { removeConsoleAction } from "./console.ts";
import { convertFunctionAction } from "./convert-function.ts";
import { defaultToNamedAction } from "./default-to-named.ts";
import { TsEngine } from "./engine.ts";
import { addImportExtensionsAction } from "./extensions.ts";
import { moveFileAction, organizeImportsAction } from "./files.ts";
import { importTypeAction, namespaceToNamedAction } from "./imports.ts";
import { inlineFunctionAction } from "./inline.ts";
import { liftOutAction } from "./lift.ts";
import { paramsToObjectAction } from "./params.ts";
import { inferReturnTypesAction } from "./return-types.ts";
import { renameFilesAction } from "./rename-files.ts";
import { subpathImportsAction } from "./subpath-imports.ts";
import { templateStringAction } from "./template-string.ts";
import { removeUnusedVariableAction } from "./unused-variable.ts";

export const ACTIONS: Action[] = [
  renameAction,
  extractAction,
  liftOutAction,
  moveFileAction,
  organizeImportsAction,
  removeBarrelsAction,
  addImportExtensionsAction,
  subpathImportsAction,
  paramsToObjectAction,
  inferReturnTypesAction,
  namespaceToNamedAction,
  importTypeAction,
  removeConsoleAction,
  templateStringAction,
  renameFilesAction,
  removeUnusedVariableAction,
  convertFunctionAction,
  defaultToNamedAction,
  inlineFunctionAction,
];

/** What the image prints for `--help`: its actions, their summaries and flags. */
export function help(): ImageHelp {
  return imageHelp("Refactors TypeScript and JavaScript with the TypeScript language service.", ACTIONS.map(actionHelp));
}

/**
 * Parses `args` against the flags `action` declares in its help, so a flag of another action is refused
 * instead of ignored.
 */
function flags(action: Action, args: string[]): Record<string, string | undefined> {
  const names = action.flags.map((f) => f.name.replace(/^--/, ""));
  try {
    const { values } = parseArgs({
      args,
      options: Object.fromEntries(names.map((f) => [f, { type: "string" as const }])),
    });
    return values as Record<string, string | undefined>;
  } catch (e) {
    const known = names.length === 0 ? `${action.id} takes no flags` : `${action.id} takes --${names.join(", --")}`;
    throw new RefactorError(
      "INVALID_ARGS",
      `${(e as Error).message}. ${known}; jig <image> ${action.id} --help describes them.`,
    );
  }
}

/**
 * The typescript image's entrypoint: `<action> --flags...` on the files under `root`. Writes the
 * action's changes into `root` and returns the v1 report: the commit subject `<kind>(typescript <id>): <description>`
 * and what the action's `run` said it did.
 */
export async function main(argv: string[], root: string): Promise<Report> {
  const [id, ...args] = argv;
  const action = ACTIONS.find((a) => a.id === id);
  if (!action) {
    throw new RefactorError(
      "UNKNOWN_ACTION",
      `Unknown action ${JSON.stringify(id ?? "")}. This image has: ${ACTIONS.map((a) => a.id).join(", ")}.`,
    );
  }
  const params = action.parseParams(flags(action, args));
  const engine = await TsEngine.load(root);
  const result = await action.run(engine, params);
  await writeChanges(root, engine.changes());
  return okReport(action.kind, "typescript", action.id, action.describe(params), result);
}
