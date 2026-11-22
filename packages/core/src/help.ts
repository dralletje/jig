import type { Action, ActionKind } from "./types.ts";

/** The `schema` of the help object an image prints for `--help` (`schemas/help-1.schema.json`). */
export const HELP_SCHEMA = "urn:jig:help:1";

/** One choice of a `choice` flag: the value, and one line on what it does. */
export type Choice = { name: string; description: string };

/**
 * One flag of an action. `name` starts with `--`; `description` is plain text, may be several lines.
 * - `path`: one repo-relative path; `paths`: comma-separated repo-relative paths;
 * - `globs`: comma-separated globs; `text`: anything else (a symbol name, `src/a.ts:12:20`, ...);
 * - `choice`: the name of one of `choices`.
 */
export type Flag =
  | { name: string; type: "path" | "paths" | "globs" | "text"; required: boolean; description: string }
  | { name: string; type: "choice"; choices: Choice[]; required: boolean; description: string };

/** One action in an image's help: the one kind its commits have, one line on what it does, its flags. */
export type ActionHelp = { name: string; kind: ActionKind; summary: string; flags: Flag[] };

/** What an image prints, as one JSON line, when its arguments are exactly `["--help"]`. */
export type ImageHelp = { schema: typeof HELP_SCHEMA; summary: string; actions: ActionHelp[] };

/**
 * The help object of an image: one line on what it does, and its actions. Throws when an action's
 * kind is not one kind, or a choice flag breaks the rules of `Choice` (jig would refuse the help as broken).
 */
export function imageHelp(summary: string, actions: ActionHelp[]): ImageHelp {
  for (const action of actions) {
    checkKind(action);
    checkChoices(action);
  }
  return { schema: HELP_SCHEMA, summary, actions };
}

/** An `Action`'s entry in its image's help. */
export function actionHelp(action: Action): ActionHelp {
  return { name: action.id, kind: action.kind, summary: action.summary, flags: action.flags };
}

/** Throws when `action` has no single kind of refactor, sweep or rewrite, or still lists `kinds`. */
function checkKind(action: ActionHelp): void {
  const at = `help of action ${JSON.stringify(action.name)}`;
  if ("kinds" in action) throw new Error(`${at} has unknown field(s) kinds (an action has one kind: kind)`);
  const kind: unknown = action.kind;
  if (kind !== "refactor" && kind !== "sweep" && kind !== "rewrite") {
    throw new Error(`${at}: kind must be one of refactor, sweep, rewrite, not ${JSON.stringify(kind)}`);
  }
}

/** Throws when the choices of `action`'s choice flags break the rules of `Choice`. */
function checkChoices(action: ActionHelp): void {
  for (const flag of action.flags) {
    if (flag.type !== "choice") continue;
    const at = `help of action ${JSON.stringify(action.name)}, flag ${flag.name}`;
    if (!Array.isArray(flag.choices) || flag.choices.length === 0) throw new Error(`${at}: choices must be a non-empty list`);
    const names: string[] = [];
    for (const [index, choice] of (flag.choices as unknown[]).entries()) {
      const where = `${at}: choices[${index}]`;
      if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
        throw new Error(`${where} must be an object {name, description}, not ${JSON.stringify(choice)}`);
      }
      const extra = Object.keys(choice).filter((key) => key !== "name" && key !== "description");
      if (extra.length > 0) throw new Error(`${where} has unknown field(s) ${extra.join(", ")}`);
      const { name, description } = choice as Record<string, unknown>;
      if (typeof name !== "string" || name === "") throw new Error(`${where}.name must be a non-empty string`);
      if (typeof description !== "string" || description === "") {
        throw new Error(`${where} (${JSON.stringify(name)}).description must be a non-empty string`);
      }
      if (/[\r\n]/.test(description)) throw new Error(`${where} (${JSON.stringify(name)}).description must be one line`);
      if (names.includes(name)) throw new Error(`${at}: two choices are named ${JSON.stringify(name)}`);
      names.push(name);
    }
  }
}
