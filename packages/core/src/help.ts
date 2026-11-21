import type { Action, ActionKind } from "./types.ts";

/** The `schema` of the help object an image prints for `--help` (`schemas/help-1.schema.json`). */
export const HELP_SCHEMA = "urn:jig:help:1";

/**
 * One flag of an action. `name` starts with `--`; `description` is plain text, may be several lines.
 * - `path`: one repo-relative path; `paths`: comma-separated repo-relative paths;
 * - `globs`: comma-separated globs; `text`: anything else (a symbol name, `src/a.ts:12:20`, ...);
 * - `choice`: one of `choices`.
 */
export type Flag =
  | { name: string; type: "path" | "paths" | "globs" | "text"; required: boolean; description: string }
  | { name: string; type: "choice"; choices: string[]; required: boolean; description: string };

/** One action in an image's help: the kinds its commits can have, one line on what it does, its flags. */
export type ActionHelp = { name: string; kinds: ActionKind[]; summary: string; flags: Flag[] };

/** What an image prints, as one JSON line, when its arguments are exactly `["--help"]`. */
export type ImageHelp = { schema: typeof HELP_SCHEMA; summary: string; actions: ActionHelp[] };

/** The help object of an image: one line on what it does, and its actions. */
export function imageHelp(summary: string, actions: ActionHelp[]): ImageHelp {
  return { schema: HELP_SCHEMA, summary, actions };
}

/** An `Action`'s entry in its image's help. */
export function actionHelp(action: Action): ActionHelp {
  return { name: action.id, kinds: [action.kind], summary: action.summary, flags: action.flags };
}
