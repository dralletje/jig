import type { Action, ActionKind } from "./types.ts";

/** The `schema` of the help object an image prints for `--help` (`schemas/help-1.schema.json`). */
export const HELP_SCHEMA = "urn:jig:help:1";

/**
 * One choice of a `choice` flag: the value, one line on what it does, and, when picking it decides the
 * commit's kind, that kind. In one action, at most one flag has choices with kinds; when one choice of
 * a flag has a kind, all of them do, and the action's `kinds` are exactly the kinds they use.
 */
export type Choice = { name: string; description: string; kind?: ActionKind };

/**
 * One flag of an action. `name` starts with `--`; `description` is plain text, may be several lines.
 * - `path`: one repo-relative path; `paths`: comma-separated repo-relative paths;
 * - `globs`: comma-separated globs; `text`: anything else (a symbol name, `src/a.ts:12:20`, ...);
 * - `choice`: the name of one of `choices`.
 */
export type Flag =
  | { name: string; type: "path" | "paths" | "globs" | "text"; required: boolean; description: string }
  | { name: string; type: "choice"; choices: Choice[]; required: boolean; description: string };

/** One action in an image's help: the kinds its commits can have, one line on what it does, its flags. */
export type ActionHelp = { name: string; kinds: ActionKind[]; summary: string; flags: Flag[] };

/** What an image prints, as one JSON line, when its arguments are exactly `["--help"]`. */
export type ImageHelp = { schema: typeof HELP_SCHEMA; summary: string; actions: ActionHelp[] };

/**
 * The help object of an image: one line on what it does, and its actions. Throws when a choice flag
 * breaks the rules of `Choice` (jig would refuse the help as broken).
 */
export function imageHelp(summary: string, actions: ActionHelp[]): ImageHelp {
  for (const action of actions) checkChoices(action);
  return { schema: HELP_SCHEMA, summary, actions };
}

/** An `Action`'s entry in its image's help. */
export function actionHelp(action: Action): ActionHelp {
  return { name: action.id, kinds: [action.kind], summary: action.summary, flags: action.flags };
}

/** Throws when the choices of `action`'s choice flags break the rules of `Choice`. */
function checkChoices(action: ActionHelp): void {
  const validKinds: ActionKind[] = ["refactor", "sweep", "rewrite"];
  let kindedFlag: string | undefined;
  for (const flag of action.flags) {
    if (flag.type !== "choice") continue;
    const at = `help of action ${JSON.stringify(action.name)}, flag ${flag.name}`;
    if (!Array.isArray(flag.choices) || flag.choices.length === 0) throw new Error(`${at}: choices must be a non-empty list`);
    const names: string[] = [];
    const used: ActionKind[] = [];
    let withKind = 0;
    for (const [index, choice] of (flag.choices as unknown[]).entries()) {
      const where = `${at}: choices[${index}]`;
      if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
        throw new Error(`${where} must be an object {name, description, kind?}, not ${JSON.stringify(choice)}`);
      }
      const extra = Object.keys(choice).filter((key) => key !== "name" && key !== "description" && key !== "kind");
      if (extra.length > 0) throw new Error(`${where} has unknown field(s) ${extra.join(", ")}`);
      const { name, description } = choice as Record<string, unknown>;
      if (typeof name !== "string" || name === "") throw new Error(`${where}.name must be a non-empty string`);
      if (typeof description !== "string" || description === "") {
        throw new Error(`${where} (${JSON.stringify(name)}).description must be a non-empty string`);
      }
      if (/[\r\n]/.test(description)) throw new Error(`${where} (${JSON.stringify(name)}).description must be one line`);
      if (names.includes(name)) throw new Error(`${at}: two choices are named ${JSON.stringify(name)}`);
      names.push(name);
      if (Object.hasOwn(choice, "kind")) {
        const kind = (choice as Record<string, unknown>).kind;
        if (!validKinds.includes(kind as ActionKind)) {
          throw new Error(`${where} (${JSON.stringify(name)}).kind must be refactor, sweep or rewrite, not ${JSON.stringify(kind)}`);
        }
        withKind += 1;
        if (!used.includes(kind as ActionKind)) used.push(kind as ActionKind);
      }
    }
    if (withKind === 0) continue;
    if (withKind !== flag.choices.length) throw new Error(`${at}: some choices have a kind and others not; give every choice a kind, or none`);
    if (kindedFlag !== undefined) throw new Error(`${at}: both ${kindedFlag} and ${flag.name} have choices with kinds; only one flag may decide the kind`);
    kindedFlag = flag.name;
    const sameKinds = used.length === action.kinds.length && used.every((kind) => action.kinds.includes(kind));
    if (!sameKinds) {
      throw new Error(`${at}: the choices' kinds (${used.join(", ")}) must be exactly the action's kinds (${action.kinds.join(", ")})`);
    }
  }
}
