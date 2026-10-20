import type { CodexUserInputRequest } from "@codex-deck/api";
import type { UserInputAnswerDraft } from "../utils";
import { AskQuestionRenderer } from "./tool-renderers/ask-question-renderer";

interface Props {
  requests: CodexUserInputRequest[];
  selectedAnswers: Record<string, Record<string, UserInputAnswerDraft>>;
  submittingRequestIds: string[];
  onSelectOption: (
    request: CodexUserInputRequest,
    questionId: string,
    label: string,
  ) => void;
  onChangeOtherText: (
    request: CodexUserInputRequest,
    questionId: string,
    text: string,
  ) => void;
  onSubmitAnswers: (request: CodexUserInputRequest) => void;
}

export function PendingUserInputRequests(props: Props) {
  if (!props.requests.length) return null;
  return (
    <section aria-label="Pending questions" className="mt-4 space-y-4">
      {props.requests.map((request) => (
        <div
          key={request.requestId}
          data-pending-user-input-request={request.requestId}
        >
          <p className="mb-2 text-xs text-zinc-500">
            {request.isBlocking === false
              ? "Answer when ready · Agent can continue working"
              : "Waiting for your answer"}
          </p>
          <AskQuestionRenderer
            input={{
              questions: request.questions.map((question) => ({
                ...question,
                multiSelect: false,
              })),
            }}
            selectedAnswers={props.selectedAnswers[request.requestId]}
            submitting={props.submittingRequestIds.includes(request.requestId)}
            onSelectOption={(questionId, label) =>
              props.onSelectOption(request, questionId, label)
            }
            onChangeOtherText={(questionId, text) =>
              props.onChangeOtherText(request, questionId, text)
            }
            onSubmitAnswers={() => props.onSubmitAnswers(request)}
          />
        </div>
      ))}
    </section>
  );
}
