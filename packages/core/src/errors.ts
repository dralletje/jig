export const ERROR_CODES = [
  "SYMBOL_NOT_FOUND",
  "AMBIGUOUS_SYMBOL",
  "DIRTY_WORKTREE",
  "REFACTOR_UNAVAILABLE",
  "NO_CHANGES",
  "UNKNOWN_ACTION",
  "INVALID_ARGS",
  "IMAGE_NOT_FOUND",
  "IMAGE_FAILED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A refusal with one of the error codes. Its message is the `instructions` of the failure report: what
 * went wrong and what the agent should do next, in plain words ("`x` is passed as a callback in
 * src/jobs.ts:40. Wrap that use in an arrow function first, then run again.").
 */
export class RefactorError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, instructions: string) {
    super(instructions);
    this.name = "RefactorError";
    this.code = code;
  }

  get instructions(): string {
    return this.message;
  }
}
