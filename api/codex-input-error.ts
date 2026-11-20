/** A caller-supplied value was rejected before reaching codex app-server. */
export class CodexInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexInputError";
  }
}
