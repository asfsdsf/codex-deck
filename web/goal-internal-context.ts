export interface GoalInternalContext {
  source: "goal";
  body: string;
}

const GOAL_INTERNAL_CONTEXT_REGEX =
  /^\s*<codex_internal_context\b[^>]*\bsource=(["'])goal\1[^>]*>\s*([\s\S]*?)\s*<\/codex_internal_context>\s*$/i;

const GOAL_CONTEXT_TAG_REGEX = /<\/?(?:goal|objective|untrusted_objective)>/gi;

export function parseGoalInternalContext(
  text: string,
): GoalInternalContext | null {
  const match = text.replace(/\r\n/g, "\n").match(GOAL_INTERNAL_CONTEXT_REGEX);
  const body = match?.[2]?.trim();
  if (!body) {
    return null;
  }

  return {
    source: "goal",
    body: body.replace(GOAL_CONTEXT_TAG_REGEX, "").trim(),
  };
}
