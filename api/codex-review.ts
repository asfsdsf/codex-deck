export type CodexReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string | null }
  | { type: "custom"; instructions: string };

export interface CodexReviewResult {
  threadId: string;
  turnId: string | null;
}

export function parseReviewTarget(value: unknown): CodexReviewTarget {
  if (!value || typeof value !== "object")
    throw new Error("Invalid review target");
  const target = value as Record<string, unknown>;
  const required = (key: string) => {
    const value = typeof target[key] === "string" ? target[key].trim() : "";
    if (!value) throw new Error(`Invalid review target: ${key} is required`);
    return value;
  };
  switch (target.type) {
    case "uncommittedChanges":
      return { type: target.type };
    case "baseBranch":
      return { type: target.type, branch: required("branch") };
    case "commit":
      return {
        type: target.type,
        sha: required("sha"),
        ...(typeof target.title === "string" ? { title: target.title } : {}),
      };
    case "custom":
      return { type: target.type, instructions: required("instructions") };
    default:
      throw new Error("Invalid review target");
  }
}
