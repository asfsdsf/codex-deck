import { HelpCircle, CheckSquare, Square } from "lucide-react";
import { UserInputTextarea } from "../user-input-textarea";
import { useTextTranslations } from "../../hooks/use-text-translations";
import { TextBlockActions } from "./text-block-actions";

const OTHER_OPTION_LABEL = "None of the above";
const OTHER_OPTION_DESCRIPTION =
  "Choose this and optionally add your own prompt below.";

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  isSecret: boolean;
}

interface AskQuestionInput {
  requestId?: string;
  questions: Question[];
}

interface AskQuestionRendererProps {
  input: AskQuestionInput;
  embedded?: boolean;
  hideHeader?: boolean;
  selectedAnswers?: Record<
    string,
    {
      optionLabel: string;
      otherText: string;
    }
  >;
  onSelectOption?: (questionId: string, optionLabel: string) => void;
  onChangeOtherText?: (questionId: string, text: string) => void;
  onSubmitAnswers?: () => void;
  submitting?: boolean;
}

export function AskQuestionRenderer(props: AskQuestionRendererProps) {
  const {
    input,
    embedded = false,
    hideHeader = false,
    selectedAnswers,
    onSelectOption,
    onChangeOtherText,
    onSubmitAnswers,
    submitting = false,
  } = props;
  const questions = input?.questions ?? [];
  const translation = useTextTranslations([
    ...questions.flatMap((question) => [
      question.header || "Question",
      question.question,
      ...question.options.flatMap((option) => [
        option.label,
        option.description,
      ]),
    ]),
    ...(questions.some((question) => question.options.length)
      ? [OTHER_OPTION_LABEL, OTHER_OPTION_DESCRIPTION]
      : []),
  ]);

  if (!input || !input.questions || input.questions.length === 0) {
    return null;
  }

  const allQuestionsAnswered = input.questions.every((question) => {
    const draft = selectedAnswers?.[question.id];
    if (!question.options.length) return !!draft?.otherText?.trim();
    return !!draft?.optionLabel?.trim();
  });

  const hasSelectedOtherOption = input.questions.some((question) => {
    const draft = selectedAnswers?.[question.id];
    return draft?.optionLabel === OTHER_OPTION_LABEL;
  });

  const showSubmitButton =
    !!onSubmitAnswers &&
    (hasSelectedOtherOption ||
      input.questions.some((question) => !question.options.length));
  const canSubmitManually =
    showSubmitButton && !submitting && allQuestionsAnswered;
  const copyText = questions
    .map((question) =>
      [
        translation.text(question.header || "Question"),
        translation.text(question.question),
        ...question.options.map(
          (option) =>
            `- ${translation.text(option.label)}${option.description ? `: ${translation.text(option.description)}` : ""}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"} space-y-3`}>
      <TextBlockActions
        translation={translation}
        copyText={copyText}
        label="questions"
      />
      {input.questions.map((question, qIndex) => (
        <div
          key={question.id || qIndex}
          className="bg-zinc-900/70 border border-zinc-700/50 rounded-lg overflow-hidden"
        >
          {!hideHeader && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700/50 bg-zinc-800/30">
              <HelpCircle size={14} className="text-violet-400" />
              <span className="text-xs font-medium text-zinc-300">
                {translation.text(question.header || "Question")}
              </span>
              {question.multiSelect && (
                <span className="text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded ml-auto">
                  Multi-select
                </span>
              )}
            </div>
          )}
          <div className="p-3 space-y-3">
            <p className="text-sm text-zinc-200">
              {translation.text(question.question)}
            </p>
            {question.options && question.options.length > 0 && (
              <div className="space-y-2">
                {[
                  ...question.options,
                  {
                    label: OTHER_OPTION_LABEL,
                    description: OTHER_OPTION_DESCRIPTION,
                  },
                ].map((option, oIndex) => {
                  const selected =
                    selectedAnswers?.[question.id]?.optionLabel ===
                    option.label;
                  const Icon =
                    question.multiSelect || selected ? CheckSquare : Square;
                  const canSelect = !!onSelectOption && !submitting;
                  return (
                    <button
                      type="button"
                      key={oIndex}
                      disabled={!canSelect}
                      onClick={() => {
                        if (!canSelect) {
                          return;
                        }
                        onSelectOption(question.id, option.label);
                      }}
                      className={`w-full text-left flex items-start gap-2 px-2 py-1.5 rounded border transition-colors ${
                        selected
                          ? "bg-violet-500/12 border-violet-400/45"
                          : "bg-zinc-800/40 border-zinc-700/30"
                      } ${canSelect ? "cursor-pointer hover:bg-zinc-800/70" : "cursor-default opacity-80"}`}
                    >
                      <Icon
                        size={14}
                        className={`mt-0.5 flex-shrink-0 ${selected ? "text-violet-300" : "text-violet-400/70"}`}
                      />
                      <div className="min-w-0">
                        <div
                          className={`text-xs font-medium ${selected ? "text-violet-100" : "text-zinc-200"}`}
                        >
                          {translation.text(option.label)}
                        </div>
                        {option.description && (
                          <div className="text-xs text-zinc-500 mt-0.5">
                            {translation.text(option.description)}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {!question.options.length &&
              (question.isSecret ? (
                <input
                  type="password"
                  aria-label={question.question}
                  autoComplete="off"
                  value={
                    selectedAnswers?.[question.id]?.otherText ||
                    (selectedAnswers?.[question.id]?.optionLabel ===
                    OTHER_OPTION_LABEL
                      ? ""
                      : selectedAnswers?.[question.id]?.optionLabel) ||
                    ""
                  }
                  onChange={(event) =>
                    onChangeOtherText?.(question.id, event.target.value)
                  }
                  disabled={!onChangeOtherText || submitting}
                  placeholder="Your answer..."
                  className="w-full rounded-md border border-zinc-700/50 bg-zinc-800/40 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-violet-400/45 disabled:cursor-default disabled:opacity-80"
                />
              ) : (
                <UserInputTextarea
                  aria-label={question.question}
                  value={
                    selectedAnswers?.[question.id]?.otherText ||
                    (selectedAnswers?.[question.id]?.optionLabel ===
                    OTHER_OPTION_LABEL
                      ? ""
                      : selectedAnswers?.[question.id]?.optionLabel) ||
                    ""
                  }
                  onChange={(event) =>
                    onChangeOtherText?.(question.id, event.target.value)
                  }
                  disabled={!onChangeOtherText || submitting}
                  rows={3}
                  placeholder="Your answer..."
                  className="w-full rounded-md border border-zinc-700/50 bg-zinc-800/40 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-violet-400/45 disabled:cursor-default disabled:opacity-80"
                />
              ))}
            {question.options.length > 0 &&
              selectedAnswers?.[question.id]?.optionLabel ===
                OTHER_OPTION_LABEL && (
                <UserInputTextarea
                  aria-label={`Custom answer: ${question.question}`}
                  value={selectedAnswers?.[question.id]?.otherText ?? ""}
                  onChange={(event) => {
                    onChangeOtherText?.(question.id, event.target.value);
                  }}
                  disabled={!onChangeOtherText || submitting}
                  rows={3}
                  placeholder="Optionally add your custom prompt..."
                  className="w-full rounded-md border border-zinc-700/50 bg-zinc-800/40 px-2 py-1.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-violet-400/45 disabled:cursor-default disabled:opacity-80"
                />
              )}
          </div>
        </div>
      ))}
      {showSubmitButton && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onSubmitAnswers?.()}
            disabled={!canSubmitManually}
            className="rounded-md border border-violet-400/45 bg-violet-500/15 px-2.5 py-1.5 text-xs font-medium text-violet-100 transition-colors hover:bg-violet-500/25 disabled:cursor-default disabled:opacity-70"
          >
            {submitting ? "Sending answers..." : "Submit answers"}
          </button>
        </div>
      )}
    </div>
  );
}
