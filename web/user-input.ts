import type {
  CodexUserInputQuestion,
  CodexUserInputRequest,
  CodexUserInputResponsePayload,
  ConversationMessage,
} from "@codex-deck/api";
import {
  USER_INPUT_NOTE_PREFIX,
  USER_INPUT_OTHER_OPTION_LABEL,
  parseResolvedUserInputAnswers,
  type UserInputAnswerDraft,
} from "./utils";
import {
  ASYNC_QUESTION_TOOL_NAME,
  buildAsyncQuestionReplyText,
  getAsyncQuestionItemId,
  parseAsyncQuestionItemId,
  parseAsyncQuestionReply,
} from "./async-question-reply";

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

const ASYNC_MESSAGE_REQUEST_PREFIX = "async-message:";

export function isMessageUserInputRequest(
  request: CodexUserInputRequest,
): boolean {
  return (
    request.requestId === `${ASYNC_MESSAGE_REQUEST_PREFIX}${request.itemId}`
  );
}

/** Async questions have no ids of their own; ours encode the tool's question index. */
function getAsyncQuestionIndex(
  question: Pick<CodexUserInputQuestion, "id">,
  position: number,
): number {
  const match = /^question-(\d+)$/.exec(question.id);
  return match ? Number(match[1]) : position;
}

function toAsyncAnswerDraft(
  question: Pick<CodexUserInputQuestion, "options">,
  answer: string,
): UserInputAnswerDraft {
  return question.options.some((option) => option.label === answer)
    ? { optionLabel: answer, otherText: "" }
    : { optionLabel: USER_INPUT_OTHER_OPTION_LABEL, otherText: answer };
}

/**
 * Native async questions are answered by a later user message, without an RPC
 * response. Uses Codex's `<send_user_message_question_reply>` envelope, like
 * the Codex TUI and desktop app.
 */
export function buildAsyncUserInputMessage(
  request: CodexUserInputRequest,
  response: CodexUserInputResponsePayload,
): string {
  const replies = request.questions.flatMap((question, position) => {
    const answers = response.answers[question.id]?.answers ?? [];
    const note = answers.find((answer) =>
      answer.startsWith(USER_INPUT_NOTE_PREFIX),
    );
    const answer = (
      note ? note.slice(USER_INPUT_NOTE_PREFIX.length) : answers.join("\n")
    ).trim();
    if (!answer) return [];
    return [
      {
        questionItemId: getAsyncQuestionItemId(
          request.itemId,
          getAsyncQuestionIndex(question, position),
        ),
        question: question.question,
        answer,
      },
    ];
  });
  return replies.length ? buildAsyncQuestionReplyText(replies) : "";
}

/** Reads the plain-text format earlier codex-deck versions sent. */
function parseLegacyAsyncUserInputMessage(
  request: CodexUserInputRequest,
  text: string,
): Record<string, UserInputAnswerDraft> | null {
  const drafts: Record<string, UserInputAnswerDraft> = {};
  let remaining = text.trim();
  for (const [index, question] of request.questions.entries()) {
    const prefix = `Question: ${question.question}\nAnswer: `;
    if (!remaining.startsWith(prefix)) return null;
    remaining = remaining.slice(prefix.length);
    const nextQuestion = request.questions[index + 1];
    const end = nextQuestion
      ? remaining.indexOf(`\n\nQuestion: ${nextQuestion.question}\nAnswer: `)
      : remaining.length;
    if (end < 0) return null;
    const answer = remaining.slice(0, end).trim();
    if (!answer) return null;
    drafts[question.id] = toAsyncAnswerDraft(question, answer);
    remaining = remaining.slice(end).trimStart();
  }
  return drafts;
}

export function getAsyncUserInputState(
  messages: readonly ConversationMessage[],
  threadId: string,
  pendingMessages: readonly { text: string }[] = [],
): {
  requests: CodexUserInputRequest[];
  resolvedAnswersByItemId: Map<string, Record<string, UserInputAnswerDraft>>;
} {
  const requests = new Map<string, CodexUserInputRequest>();
  const resolvedAnswersByItemId = new Map<
    string,
    Record<string, UserInputAnswerDraft>
  >();
  const resolveReply = (text: string) => {
    const replies = parseAsyncQuestionReply(text);
    if (replies) {
      // Replies carry stable question ids, so answers from any client
      // (web, TUI, desktop) resolve exactly the question they answer.
      for (const reply of replies) {
        const target = parseAsyncQuestionItemId(reply.questionItemId);
        const request = requests.get(target?.itemId ?? reply.questionItemId);
        if (!request) continue;
        const drafts = { ...resolvedAnswersByItemId.get(request.itemId) };
        const question = target
          ? request.questions.find(
              (candidate, position) =>
                getAsyncQuestionIndex(candidate, position) === target.index,
            )
          : undefined;
        if (question) {
          drafts[question.id] = toAsyncAnswerDraft(question, reply.answer);
        }
        resolvedAnswersByItemId.set(request.itemId, drafts);
      }
      return;
    }
    // Match the latest unanswered occurrence when an agent repeats a question.
    for (const request of [...requests.values()].reverse()) {
      if (resolvedAnswersByItemId.has(request.itemId)) continue;
      const answers = parseLegacyAsyncUserInputMessage(request, text);
      if (!answers) continue;
      resolvedAnswersByItemId.set(request.itemId, answers);
      break;
    }
  };
  for (const message of messages) {
    const content = message.message?.content;
    if (message.type === "user") {
      resolveReply(
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("\n\n")
            : "",
      );
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.name?.toLowerCase() === ASYNC_QUESTION_TOOL_NAME &&
        block.id
      ) {
        const questions = normalizeUserInputQuestions(
          block.input &&
            typeof block.input === "object" &&
            !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {},
        );
        if (!questions.length) continue;
        requests.set(block.id, {
          requestId: `${ASYNC_MESSAGE_REQUEST_PREFIX}${block.id}`,
          threadId,
          turnId: message.turnId ?? "",
          itemId: block.id,
          isBlocking: false,
          questions,
        });
      } else if (
        block.type === "tool_result" &&
        block.tool_use_id &&
        requests.has(block.tool_use_id)
      ) {
        if (block.is_error) {
          requests.delete(block.tool_use_id);
        } else {
          const answers = parseResolvedUserInputAnswers(block.content);
          if (answers) resolvedAnswersByItemId.set(block.tool_use_id, answers);
        }
      }
    }
  }
  for (const message of pendingMessages) resolveReply(message.text);
  return { requests: [...requests.values()], resolvedAnswersByItemId };
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
