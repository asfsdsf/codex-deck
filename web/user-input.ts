import type {
  CodexUserInputQuestion,
  CodexUserInputRequest,
  CodexUserInputResponsePayload,
  ConversationMessage,
} from "@codex-deck/api";
import {
  USER_INPUT_NOTE_PREFIX,
  USER_INPUT_OTHER_OPTION_LABEL,
  type UserInputAnswerDraft,
} from "./utils";

export function isUserInputToolName(name: string | undefined): boolean {
  return [
    "request_user_input",
    "request_user_input_async",
    "askuserquestion",
  ].includes((name ?? "").toLowerCase());
}

export function normalizeUserInputQuestions(
  input: Record<string, unknown>,
): Array<CodexUserInputQuestion & { multiSelect: boolean }> {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const question = value as Record<string, unknown>;
    const prompt = question.question ?? question.title;
    if (typeof prompt !== "string" || !prompt.trim()) return [];
    return [
      {
        id:
          typeof question.id === "string" && question.id.trim()
            ? question.id
            : `question-${index}`,
        header:
          typeof question.header === "string" && question.header.trim()
            ? question.header
            : "Question",
        question: prompt,
        options: Array.isArray(question.options)
          ? question.options.flatMap((option) => {
              if (typeof option === "string" && option.trim())
                return [{ label: option, description: "" }];
              if (
                !option ||
                typeof option !== "object" ||
                Array.isArray(option)
              )
                return [];
              const record = option as Record<string, unknown>;
              return typeof record.label === "string" && record.label.trim()
                ? [
                    {
                      label: record.label,
                      description:
                        typeof record.description === "string"
                          ? record.description
                          : "",
                    },
                  ]
                : [];
            })
          : [],
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
        multiSelect: question.multiSelect === true,
      },
    ];
  });
}

export function isUserInputQuestionAnswered(
  question: Pick<CodexUserInputQuestion, "options">,
  draft: UserInputAnswerDraft | undefined,
): draft is UserInputAnswerDraft {
  if (!question.options.length) return !!draft?.otherText.trim();
  return !!draft?.optionLabel.trim();
}

export function buildUserInputResponsePayload(
  request: CodexUserInputRequest,
  drafts: Record<string, UserInputAnswerDraft>,
): CodexUserInputResponsePayload {
  const answers: CodexUserInputResponsePayload["answers"] = {};
  for (const question of request.questions) {
    const draft = drafts[question.id];
    if (!isUserInputQuestionAnswered(question, draft)) continue;
    if (!question.options.length) {
      answers[question.id] = { answers: [draft.otherText.trim()] };
      continue;
    }
    const answerList = [draft.optionLabel.trim()];
    if (
      draft.optionLabel === USER_INPUT_OTHER_OPTION_LABEL &&
      draft.otherText.trim()
    ) {
      answerList.push(`${USER_INPUT_NOTE_PREFIX}${draft.otherText.trim()}`);
    }
    answers[question.id] = { answers: answerList };
  }
  return { answers };
}

/** Requests can arrive before their tool call is persisted, or without a tool call at all. */
export function getUnattachedUserInputRequests(
  messages: readonly ConversationMessage[],
  requests: readonly CodexUserInputRequest[],
): CodexUserInputRequest[] {
  const toolIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content) {
      if (
        block.type === "tool_use" &&
        block.id &&
        isUserInputToolName(block.name)
      )
        toolIds.add(block.id);
    }
  }
  return requests.filter((request) => !toolIds.has(request.itemId));
}
