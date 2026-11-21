export type DeclKind = "function" | "class" | "interface" | "type" | "enum" | "variable";

/** A top-level declaration. Offsets are into the file's current (overlay) text. */
export interface Decl {
  /** Repo-relative path with `/` separators. */
  file: string;
  name: string;
  kind: DeclKind;
  /** Offset of the declaration's name identifier. */
  nameStart: number;
  /** Start of the full statement, leading trivia (comments, whitespace) excluded. */
  start: number;
  /** End of the full statement. */
  end: number;
}

/** One file's difference between disk and the engine's overlay. `null` = file absent. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * What a commit does, recorded in its subject and its `Refactor-Kind` trailer:
 * - `refactor`: targeted and behaviour-preserving (rename, extract, ...);
 * - `sweep`: a repo-wide or many-file mechanical convention change, behaviour-preserving (format, ...);
 * - `rewrite`: changes behaviour in a simple, repetitive way (removing `console.log` calls, ...).
 */
export type ActionKind = "refactor" | "sweep" | "rewrite";

/** What an action's `run` returns: what happened, for the report and the commit message. */
export type ActionResult = {
  /**
   * User-facing description of what happened: plain text, may be several lines (an ASCII graph is fine).
   * A partial result lists the places it did not handle here, with what to do about them.
   */
  summary: string;
};

/** A refactor. `P` is its parameter object. */
export interface Action<P = any, E extends Engine = any> {
  id: string;
  kind: ActionKind;
  parseParams(raw: Record<string, string | undefined>): P;
  /** What the commit subject says after `<kind>(<id>): `. */
  describe(p: P): string;
  /** Mutates the engine's overlay and says what it did. Throws a `RefactorError` to refuse. */
  run(engine: E, p: P): Promise<ActionResult>;
}

/** What callers see of an engine: an overlay over the files on disk. */
export interface Engine {
  readonly id: string;
  readonly version: string;
  read(path: string): string | null;
  changes(): FileChange[];
}
