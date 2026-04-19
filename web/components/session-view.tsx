import {
  useEffect,
  useState,
  useRef,
  useCallback,
  memo,
  useMemo,
  useLayoutEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import type { MouseEvent } from "react";
import type {
  ConversationMessage,
  CodexApprovalRequest,
  CodexApprovalResponsePayload,
  CodexUserInputRequest,
  CodexUserInputResponsePayload,
} from "@codex-deck/api";
import MessageBlock from "./message-block";
import ScrollToBottomButton from "./scroll-to-bottom-button";
import {
  listCodexApprovalRequests,
  listCodexUserInputRequests,
  respondCodexApprovalRequest,
  respondCodexUserInputRequest,
  subscribeConversationStream,
  type ConversationStreamPhase,
} from "../api";
import { usePageVisibility } from "../hooks/use-page-visibility";
import {
  clampPage,
  formatLocalTimestamp,
  getPageSliceBounds,
  getTotalPages,
  parseResolvedUserInputAnswers,
  sanitizeText,
  USER_INPUT_NOTE_PREFIX,
  USER_INPUT_OTHER_OPTION_LABEL,
  type UserInputAnswerDraft,
} from "../utils";
import { getSearchableToolUseText } from "../message-block-utils";
import {
  getCollapsedViewportLine,
  getViewportMessageGroup,
  type ViewportTextTone,
} from "../message-viewport-groups";
import { mergeDisplayConversationMessages } from "../conversation-message-merge";
import { computeRailScrollDelta } from "../rail-scroll-utils";
import { shouldToggleCollapsedSegmentFromContentClick } from "../segment-toggle-click";
import { findConversationSearchMatches } from "../conversation-search";
import { shouldShowTokenLimitNotice } from "../token-limit-notices";
import {
  deriveAiTerminalStepStatesByMessageKey,
  extractConversationMessageText,
  getAiTerminalMessageKey,
  parseAiTerminalMessage,
  type AiTerminalStepDirective,
} from "../ai-terminal";
import { CollapsedViewportSummary } from "./collapsed-viewport-summary";
import type { PendingUserMessage } from "../pending-user-messages";

const SCROLL_THRESHOLD_PX = 100;
const USER_INPUT_POLL_INTERVAL_MS = 1200;
const APPROVAL_POLL_INTERVAL_MS = 1200;
const MESSAGES_PER_PAGE = 100;
const SEARCH_MATCH_SELECTOR = "[data-conversation-search-match]";

type SearchDirection = "next" | "previous";

export interface SessionSearchStatus {
  totalMatches: number;
  activeMatchIndex: number | null;
}

export interface SessionViewHandle {
  navigateConversationSearchMatch: (direction: SearchDirection) => void;
}

interface PagedMessageEntry {
  entryKey: string;
  page: number;
  visibleIndex: number;
  message: ConversationMessage;
  usesUserInputState: boolean;
  timestampText: string | null;
  timestampAlignment: string;
  group: "default" | "important";
}

interface ConversationSearchMatchTarget {
  entryKey: string;
  page: number;
  pageMatchIndex: number;
  targetMatchIndex: number;
  forcePrimaryExpanded: boolean;
  forceBlockIndex: number | null;
}

export interface TurnLifecycleEvent {
  type: "task_started" | "task_complete" | "turn_aborted";
  turnId: string | null;
}

type MessageViewportChunk =
  | {
      kind: "important";
      entry: PagedMessageEntry;
    }
  | {
      kind: "default-segment";
      segmentKey: string;
      entries: PagedMessageEntry[];
    };

function getConversationEntryKey(
  message: ConversationMessage,
  visibleIndex: number,
): string {
  return (
    message.uuid ??
    `${visibleIndex}:${message.type}:${message.turnId ?? ""}:${message.timestamp ?? ""}`
  );
}

function formatSearchableReasoningText(text: string): string {
  return sanitizeText(text)
    .trim()
    .replace(/^\*\*(.*?)\*\*$/s, "$1")
    .trim();
}

function stringifySearchableContent(value: unknown): string {
  if (typeof value === "string") {
    return sanitizeText(value).trim();
  }

  if (
    value !== undefined &&
    (typeof value === "object" ||
      typeof value === "number" ||
      typeof value === "boolean")
  ) {
    try {
      return sanitizeText(JSON.stringify(value, null, 2) ?? "").trim();
    } catch {
      return sanitizeText(String(value)).trim();
    }
  }

  return "";
}

function scrollSearchMatchWithinAncestor(
  ancestor: HTMLElement,
  target: HTMLElement,
): void {
  const ancestorRect = ancestor.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();

  if (ancestor.scrollHeight > ancestor.clientHeight) {
    ancestor.scrollTop +=
      targetRect.top -
      ancestorRect.top -
      ancestor.clientHeight / 2 +
      targetRect.height / 2;
  }

  if (ancestor.scrollWidth > ancestor.clientWidth) {
    ancestor.scrollLeft +=
      targetRect.left -
      ancestorRect.left -
      ancestor.clientWidth / 2 +
      targetRect.width / 2;
  }
}

function scrollSearchMatchWithinNestedContainers(
  container: HTMLElement,
  target: HTMLElement,
): void {
  let currentAncestor = target.parentElement;

  while (currentAncestor && currentAncestor !== container) {
    if (
      currentAncestor.scrollHeight > currentAncestor.clientHeight ||
      currentAncestor.scrollWidth > currentAncestor.clientWidth
    ) {
      scrollSearchMatchWithinAncestor(currentAncestor, target);
    }

    currentAncestor = currentAncestor.parentElement;
  }
}

function getCollapsedLineToneClasses(tone: ViewportTextTone): string {
  if (tone === "user") {
    return "text-indigo-200";
  }
  if (tone === "assistant") {
    return "text-cyan-200";
  }
  if (tone === "tool") {
    return "text-emerald-200";
  }
  if (tone === "plan") {
    return "text-sky-200";
  }
  return "text-rose-200";
}

interface SessionViewProps {
  sessionId: string;
  projectPath?: string | null;
  pendingUserMessages?: PendingUserMessage[];
  railCollapsedByDefault?: boolean;
  latestButtonBottomOffsetPx?: number;
  conversationSearchOpen?: boolean;
  conversationSearchQuery?: string;
  workflowShortcut?: {
    label: string;
    title?: string;
    onClick: () => void;
  } | null;
  terminalShortcut?: {
    label: string;
    title?: string;
    onClick: () => void;
  } | null;
  onPlanAction?: (sessionId: string, action: "implement" | "stay") => void;
  onFilePathLinkClick?: (href: string) => boolean;
  onMessageHistoryChange?: (
    sessionId: string,
    history: string[],
    confirmedUserMessageCount: number,
  ) => void;
  onConversationActivity?: (
    sessionId: string,
    details?: {
      hasVisibleMessageIncrease: boolean;
      phase: ConversationStreamPhase;
      done: boolean;
      turnLifecycleEvents?: TurnLifecycleEvent[];
    },
  ) => void;
  onConversationSearchStatusChange?: (status: SessionSearchStatus) => void;
  onStreamConnect?: (sessionId: string) => void;
  aiTerminalTerminalId?: string | null;
  onApproveAiTerminalStep?: (input: {
    sessionId: string;
    terminalId: string;
    messageKey: string;
    step: AiTerminalStepDirective;
  }) => Promise<boolean>;
  onRejectAiTerminalStep?: (input: {
    sessionId: string;
    terminalId: string;
    messageKey: string;
    step: AiTerminalStepDirective;
    reason: string;
  }) => Promise<boolean>;
}

function clearConversationSearchHighlights(root: ParentNode): void {
  const matches = Array.from(
    root.querySelectorAll<HTMLElement>(SEARCH_MATCH_SELECTOR),
  );

  for (const match of matches) {
    const parent = match.parentNode;
    if (!parent) {
      continue;
    }

    while (match.firstChild) {
      parent.insertBefore(match.firstChild, match);
    }
    parent.removeChild(match);
    parent.normalize();
  }
}

function collectSearchableTextNodes(root: HTMLElement): Text[] {
  const textNodes: Text[] = [];
  const documentRef = root.ownerDocument;

  if (!documentRef) {
    return textNodes;
  }

  const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (node.nodeValue?.length === 0) {
        return NodeFilter.FILTER_REJECT;
      }

      const parentElement = node.parentElement;
      if (!parentElement) {
        return NodeFilter.FILTER_REJECT;
      }

      if (parentElement.closest("script, style, textarea, input")) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }

  return textNodes;
}

function wrapConversationSearchSegments(
  textNodes: readonly Text[],
  matches: ReturnType<typeof findConversationSearchMatches>,
): HTMLElement[][] {
  const wrappedByMatchIndex: HTMLElement[][] = matches.map(() => []);
  const segmentsByNodeIndex = new Map<
    number,
    { start: number; end: number; matchIndex: number }[]
  >();

  matches.forEach((match, matchIndex) => {
    for (
      let nodeIndex = match.startFragmentIndex;
      nodeIndex <= match.endFragmentIndex;
      nodeIndex++
    ) {
      const textNode = textNodes[nodeIndex];
      if (!textNode) {
        continue;
      }

      const start =
        nodeIndex === match.startFragmentIndex ? match.startOffset : 0;
      const end =
        nodeIndex === match.endFragmentIndex
          ? match.endOffset
          : textNode.data.length;

      if (start >= end) {
        continue;
      }

      const nodeSegments = segmentsByNodeIndex.get(nodeIndex) ?? [];
      nodeSegments.push({ start, end, matchIndex });
      segmentsByNodeIndex.set(nodeIndex, nodeSegments);
    }
  });

  for (let nodeIndex = 0; nodeIndex < textNodes.length; nodeIndex++) {
    const originalTextNode = textNodes[nodeIndex];
    const nodeSegments = segmentsByNodeIndex.get(nodeIndex);
    if (!originalTextNode || !nodeSegments || nodeSegments.length === 0) {
      continue;
    }

    const documentRef = originalTextNode.ownerDocument;
    if (!documentRef) {
      continue;
    }

    const sortedSegments = [...nodeSegments].sort(
      (left, right) => right.start - left.start,
    );
    let workingTextNode = originalTextNode;

    for (const segment of sortedSegments) {
      if (segment.end < workingTextNode.data.length) {
        workingTextNode.splitText(segment.end);
      }

      let middleNode = workingTextNode;
      if (segment.start > 0) {
        middleNode = workingTextNode.splitText(segment.start);
      }

      const highlight = documentRef.createElement("mark");
      highlight.dataset.conversationSearchMatch = String(segment.matchIndex);
      highlight.className = "conversation-search-match";
      middleNode.parentNode?.insertBefore(highlight, middleNode);
      highlight.appendChild(middleNode);
      wrappedByMatchIndex[segment.matchIndex]?.push(highlight);
    }
  }

  return wrappedByMatchIndex;
}

function updateConversationSearchMatchFocus(
  matchGroups: readonly HTMLElement[][],
  activeMatchIndex: number | null,
): void {
  matchGroups.forEach((matchGroup, matchIndex) => {
    const isActive = activeMatchIndex === matchIndex;
    for (const segment of matchGroup) {
      segment.classList.toggle("conversation-search-match-active", isActive);
    }
  });
}

function areUserInputRequestsEqual(
  previous: CodexUserInputRequest[],
  next: CodexUserInputRequest[],
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }

  for (let requestIndex = 0; requestIndex < previous.length; requestIndex++) {
    const left = previous[requestIndex];
    const right = next[requestIndex];

    if (
      left.requestId !== right.requestId ||
      left.threadId !== right.threadId ||
      left.turnId !== right.turnId ||
      left.itemId !== right.itemId ||
      left.questions.length !== right.questions.length
    ) {
      return false;
    }

    for (
      let questionIndex = 0;
      questionIndex < left.questions.length;
      questionIndex++
    ) {
      const leftQuestion = left.questions[questionIndex];
      const rightQuestion = right.questions[questionIndex];

      if (
        leftQuestion.id !== rightQuestion.id ||
        leftQuestion.header !== rightQuestion.header ||
        leftQuestion.question !== rightQuestion.question ||
        leftQuestion.isOther !== rightQuestion.isOther ||
        leftQuestion.isSecret !== rightQuestion.isSecret ||
        leftQuestion.options.length !== rightQuestion.options.length
      ) {
        return false;
      }

      for (
        let optionIndex = 0;
        optionIndex < leftQuestion.options.length;
        optionIndex++
      ) {
        const leftOption = leftQuestion.options[optionIndex];
        const rightOption = rightQuestion.options[optionIndex];
        if (
          leftOption.label !== rightOption.label ||
          leftOption.description !== rightOption.description
        ) {
          return false;
        }
      }
    }
  }

  return true;
}

function pruneSelectedAnswers(
  previous: Record<string, Record<string, UserInputAnswerDraft>>,
  activeIds: Set<string>,
): Record<string, Record<string, UserInputAnswerDraft>> {
  let removedAny = false;
  const next: Record<string, Record<string, UserInputAnswerDraft>> = {};

  for (const [requestId, answers] of Object.entries(previous)) {
    if (activeIds.has(requestId)) {
      next[requestId] = answers;
      continue;
    }
    removedAny = true;
  }

  return removedAny ? next : previous;
}

function pruneSubmittingIds(
  previous: string[],
  activeIds: Set<string>,
): string[] {
  if (previous.length === 0) {
    return previous;
  }

  let removedAny = false;
  const next = previous.filter((requestId) => {
    const keep = activeIds.has(requestId);
    if (!keep) {
      removedAny = true;
    }
    return keep;
  });

  return removedAny ? next : previous;
}

function buildUserInputResponsePayload(
  request: CodexUserInputRequest,
  drafts: Record<string, UserInputAnswerDraft>,
): CodexUserInputResponsePayload {
  const answers: CodexUserInputResponsePayload["answers"] = {};

  for (const question of request.questions) {
    const draft = drafts[question.id];
    const optionLabel = draft?.optionLabel?.trim() ?? "";
    if (!optionLabel) {
      continue;
    }

    const answerList: string[] = [optionLabel];
    if (optionLabel === USER_INPUT_OTHER_OPTION_LABEL) {
      const note = draft?.otherText?.trim() ?? "";
      if (note.length > 0) {
        answerList.push(`${USER_INPUT_NOTE_PREFIX}${note}`);
      }
    }

    answers[question.id] = {
      answers: answerList,
    };
  }

  return { answers };
}

function messageUsesUserInputState(message: ConversationMessage): boolean {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some(
    (block) =>
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      block.name.toLowerCase() === "request_user_input",
  );
}

function messageUsesApprovalState(message: ConversationMessage): boolean {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some(
    (block) =>
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      (block.name.toLowerCase() === "exec_command" ||
        block.name.toLowerCase() === "apply_patch" ||
        block.name.toLowerCase() === "request_permissions"),
  );
}

function buildPendingApprovalByItemId(
  pendingApprovalRequests: readonly CodexApprovalRequest[],
): Map<string, CodexApprovalRequest> {
  const next = new Map<string, CodexApprovalRequest>();

  for (const request of pendingApprovalRequests) {
    const itemId = request.itemId.trim();
    if (!itemId) {
      continue;
    }

    next.set(itemId, request);
  }

  return next;
}

function messageHasPendingExecApproval(
  message: ConversationMessage,
  pendingApprovalByItemId: ReadonlyMap<string, CodexApprovalRequest>,
): boolean {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (block.type !== "tool_use" || typeof block.name !== "string") {
      return false;
    }

    if (block.name.toLowerCase() !== "exec_command") {
      return false;
    }

    const blockId = typeof block.id === "string" ? block.id.trim() : "";
    if (!blockId) {
      return false;
    }

    return pendingApprovalByItemId.has(blockId);
  });
}

export function shouldAutoForceBlockModeForMessages(
  messages: readonly ConversationMessage[],
  pendingApprovalRequests: readonly CodexApprovalRequest[],
): boolean {
  if (messages.length === 0 || pendingApprovalRequests.length === 0) {
    return false;
  }

  const pendingApprovalByItemId = buildPendingApprovalByItemId(
    pendingApprovalRequests,
  );
  if (pendingApprovalByItemId.size === 0) {
    return false;
  }

  return messages.some((message) =>
    messageHasPendingExecApproval(message, pendingApprovalByItemId),
  );
}

function isVisibleConversationMessage(message: ConversationMessage): boolean {
  return (
    message.type === "user" ||
    message.type === "assistant" ||
    message.type === "reasoning" ||
    message.type === "agent_reasoning" ||
    message.type === "system_error" ||
    (message.type === "token_limit_notice" &&
      shouldShowTokenLimitNotice(message)) ||
    message.type === "turn_aborted"
  );
}

export function getConversationActivityDetails(
  newMessages: ConversationMessage[],
  phase: ConversationStreamPhase,
  insertion: "append" | "prepend" = "append",
): {
  hasVisibleMessageIncrease: boolean;
  turnLifecycleEvents?: TurnLifecycleEvent[];
} {
  const isLiveAppend = phase === "incremental" && insertion === "append";
  const turnLifecycleEvents = isLiveAppend
    ? newMessages
        .filter(
          (message) =>
            message.type === "task_started" ||
            message.type === "task_complete" ||
            message.type === "turn_aborted",
        )
        .map((message) => ({
          type: message.type as TurnLifecycleEvent["type"],
          turnId: message.turnId ?? null,
        }))
    : [];

  const visibleMessageCount = newMessages.filter(
    isVisibleConversationMessage,
  ).length;

  return {
    hasVisibleMessageIncrease: isLiveAppend && visibleMessageCount > 0,
    turnLifecycleEvents:
      turnLifecycleEvents.length > 0 ? turnLifecycleEvents : undefined,
  };
}

function extractMessageText(message: ConversationMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const textParts = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0);
  return textParts.join("\n").trim();
}

function extractUserInputHistory(messages: ConversationMessage[]): string[] {
  return getComposerUserMessages(messages)
    .map(extractMessageText)
    .filter((text) => text.length > 0);
}

function getComposerUserMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  const userMessages = messages.filter((message) => message.type === "user");
  if (userMessages.length === 0) {
    return [];
  }

  const firstMessage = messages[0];
  const secondMessage = messages[1];
  const skipFirstUserMessage =
    firstMessage?.type === "user" && secondMessage?.type === "user";

  return skipFirstUserMessage
    ? userMessages.filter((message) => message !== firstMessage)
    : userMessages;
}

const SessionView = memo(
  forwardRef<SessionViewHandle, SessionViewProps>(
    function SessionView(props, ref) {
      const {
        sessionId,
        projectPath,
        pendingUserMessages = [],
        railCollapsedByDefault = false,
        latestButtonBottomOffsetPx,
        conversationSearchOpen = false,
        conversationSearchQuery = "",
        workflowShortcut = null,
        terminalShortcut = null,
        onPlanAction,
        onFilePathLinkClick,
        onMessageHistoryChange,
        onConversationActivity,
        onConversationSearchStatusChange,
        onStreamConnect,
        aiTerminalTerminalId = null,
        onApproveAiTerminalStep,
        onRejectAiTerminalStep,
      } = props;

      const [messages, setMessages] = useState<ConversationMessage[]>([]);
      const [pendingUserInputRequests, setPendingUserInputRequests] = useState<
        CodexUserInputRequest[]
      >([]);
      const [pendingApprovalRequests, setPendingApprovalRequests] = useState<
        CodexApprovalRequest[]
      >([]);
      const [selectedUserInputAnswers, setSelectedUserInputAnswers] = useState<
        Record<string, Record<string, UserInputAnswerDraft>>
      >({});
      const [submittingUserInputRequestIds, setSubmittingUserInputRequestIds] =
        useState<string[]>([]);
      const [submittingApprovalRequestIds, setSubmittingApprovalRequestIds] =
        useState<string[]>([]);
      const [loading, setLoading] = useState(true);
      const [autoScroll, setAutoScroll] = useState(true);
      const [currentPage, setCurrentPage] = useState(1);
      const [pageInputValue, setPageInputValue] = useState("1");
      const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState<
        number | null
      >(null);
      const [collapsedDefaultSegmentKeys, setCollapsedDefaultSegmentKeys] =
        useState<Record<string, boolean>>({});
      const pendingApprovalByItemId = useMemo(
        () => buildPendingApprovalByItemId(pendingApprovalRequests),
        [pendingApprovalRequests],
      );
      const isPageVisible = usePageVisibility();
      const containerRef = useRef<HTMLDivElement>(null);
      const contentRef = useRef<HTMLDivElement>(null);
      const offsetRef = useRef(0);
      const isScrollingProgrammaticallyRef = useRef(false);
      const streamCleanupRef = useRef<(() => void) | null>(null);
      const lastEventAtRef = useRef(0);
      const mountedRef = useRef(true);
      const messagesRef = useRef<ConversationMessage[]>([]);
      const submittingRequestIdsRef = useRef<Set<string>>(new Set());
      const onConversationActivityRef = useRef(onConversationActivity);
      const onMessageHistoryChangeRef = useRef(onMessageHistoryChange);
      const onStreamConnectRef = useRef(onStreamConnect);
      const totalPagesRef = useRef(1);
      const autoScrollRef = useRef(autoScroll);
      const remoteBootstrapInProgressRef = useRef(false);
      const lastReportedHistoryKeyRef = useRef("");
      const userInputPollInFlightRef = useRef(false);
      const userInputPollRerunRequestedRef = useRef(false);
      const approvalPollInFlightRef = useRef(false);
      const approvalPollRerunRequestedRef = useRef(false);
      const submittingApprovalRequestIdsRef = useRef<Set<string>>(new Set());
      const railButtonRefsRef = useRef<Map<string, HTMLButtonElement>>(
        new Map(),
      );
      const collapsedDefaultSegmentKeysRef = useRef<Record<string, boolean>>(
        {},
      );
      const railAlignmentEpochRef = useRef(0);
      const railCollapsedByDefaultRef = useRef(railCollapsedByDefault);
      const searchMatchGroupsRef = useRef<HTMLElement[][]>([]);
      const conversationSearchMatchCountRef = useRef(0);
      const onConversationSearchStatusChangeRef = useRef(
        onConversationSearchStatusChange,
      );
      const shouldFollowActiveSearchMatchRef = useRef(false);
      const lastNormalizedConversationSearchQueryRef = useRef("");

      useEffect(() => {
        onConversationActivityRef.current = onConversationActivity;
        onMessageHistoryChangeRef.current = onMessageHistoryChange;
        onConversationSearchStatusChangeRef.current =
          onConversationSearchStatusChange;
        onStreamConnectRef.current = onStreamConnect;
      }, [
        onConversationActivity,
        onConversationSearchStatusChange,
        onMessageHistoryChange,
        onStreamConnect,
      ]);

      useEffect(() => {
        autoScrollRef.current = autoScroll;
      }, [autoScroll]);

      useEffect(() => {
        collapsedDefaultSegmentKeysRef.current = collapsedDefaultSegmentKeys;
      }, [collapsedDefaultSegmentKeys]);

      const appendDisplayMessages = useCallback(
        (
          displayMessages: ConversationMessage[],
          options?: {
            phase?: ConversationStreamPhase;
            done?: boolean;
            insertion?: "append" | "prepend";
          },
        ) => {
          const phase = options?.phase ?? "incremental";
          const insertion = options?.insertion ?? "append";
          const previousMessages = messagesRef.current;
          const nextMessages = mergeDisplayConversationMessages(
            previousMessages,
            displayMessages,
            insertion,
          );

          if (nextMessages !== previousMessages) {
            messagesRef.current = nextMessages;
            setMessages(nextMessages);
          }

          if (phase === "bootstrap" && options?.done) {
            remoteBootstrapInProgressRef.current = false;
            if (autoScrollRef.current) {
              const nextVisibleCount = nextMessages.filter(
                isVisibleConversationMessage,
              ).length;
              setCurrentPage(
                getTotalPages(nextVisibleCount, MESSAGES_PER_PAGE),
              );
            }
          }
        },
        [],
      );

      const connect = useCallback(() => {
        if (!mountedRef.current) {
          return;
        }

        if (streamCleanupRef.current) {
          streamCleanupRef.current();
          streamCleanupRef.current = null;
        }

        if (
          typeof document !== "undefined" &&
          document.visibilityState !== "visible"
        ) {
          return;
        }

        remoteBootstrapInProgressRef.current = offsetRef.current === 0;
        lastEventAtRef.current = Date.now();
        onStreamConnectRef.current?.(sessionId);

        streamCleanupRef.current = subscribeConversationStream(
          sessionId,
          {
            onMessages: (newMessages, batch) => {
              lastEventAtRef.current = Date.now();
              const phase = batch?.phase ?? "incremental";
              if (batch && Number.isFinite(batch.nextOffset)) {
                offsetRef.current = batch.nextOffset;
              }

              onConversationActivityRef.current?.(sessionId, {
                ...getConversationActivityDetails(
                  newMessages,
                  phase,
                  batch?.insertion ?? "append",
                ),
                phase,
                done: batch?.done ?? true,
              });

              const displayMessages = newMessages.filter(
                (m) => m.type !== "task_started" && m.type !== "task_complete",
              );

              setLoading(false);
              appendDisplayMessages(displayMessages, {
                phase,
                done: batch?.done,
                insertion: batch?.insertion,
              });
            },
            onHeartbeat: () => {
              lastEventAtRef.current = Date.now();
              setLoading(false);
            },
            onError: () => {
              if (messagesRef.current.length > 0) {
                setLoading(false);
              }
            },
          },
          {
            initialOffset: offsetRef.current,
          },
        );
      }, [appendDisplayMessages, sessionId]);

      useEffect(() => {
        mountedRef.current = true;
        railAlignmentEpochRef.current += 1;
        setLoading(true);
        setAutoScroll(true);
        autoScrollRef.current = true;
        messagesRef.current = [];
        setMessages([]);
        setPendingUserInputRequests([]);
        setPendingApprovalRequests([]);
        setSelectedUserInputAnswers({});
        setSubmittingUserInputRequestIds([]);
        setSubmittingApprovalRequestIds([]);
        setCollapsedDefaultSegmentKeys({});
        setCurrentPage(1);
        setActiveSearchMatchIndex(null);
        submittingRequestIdsRef.current.clear();
        offsetRef.current = 0;
        totalPagesRef.current = 1;
        remoteBootstrapInProgressRef.current = false;
        lastReportedHistoryKeyRef.current = "";
        userInputPollInFlightRef.current = false;
        userInputPollRerunRequestedRef.current = false;
        approvalPollInFlightRef.current = false;
        approvalPollRerunRequestedRef.current = false;
        submittingApprovalRequestIdsRef.current.clear();
        railButtonRefsRef.current.clear();
        collapsedDefaultSegmentKeysRef.current = {};
        isScrollingProgrammaticallyRef.current = false;
        searchMatchGroupsRef.current = [];
        if (containerRef.current) {
          containerRef.current.style.overflowAnchor = "";
        }

        connect();

        return () => {
          mountedRef.current = false;
          if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
          }
        };
      }, [connect]);

      useEffect(() => {
        if (!mountedRef.current) {
          return;
        }

        if (!isPageVisible) {
          if (streamCleanupRef.current) {
            streamCleanupRef.current();
            streamCleanupRef.current = null;
          }
          return;
        }

        if (streamCleanupRef.current) {
          return;
        }
        connect();
      }, [connect, isPageVisible]);

      useEffect(() => {
        if (!isPageVisible) {
          return;
        }

        const reconnectIfNeeded = () => {
          if (!mountedRef.current) {
            return;
          }
          if (
            typeof document !== "undefined" &&
            document.visibilityState !== "visible"
          ) {
            return;
          }

          const current = streamCleanupRef.current;
          const now = Date.now();
          const staleThresholdMs = 45000;
          if (!current || now - lastEventAtRef.current > staleThresholdMs) {
            connect();
          }
        };

        const interval = setInterval(reconnectIfNeeded, 15000);
        if (typeof window !== "undefined") {
          window.addEventListener("focus", reconnectIfNeeded);
          window.addEventListener("pageshow", reconnectIfNeeded);
          window.addEventListener("online", reconnectIfNeeded);
        }

        return () => {
          clearInterval(interval);
          if (typeof window !== "undefined") {
            window.removeEventListener("focus", reconnectIfNeeded);
            window.removeEventListener("pageshow", reconnectIfNeeded);
            window.removeEventListener("online", reconnectIfNeeded);
          }
        };
      }, [connect, isPageVisible]);

      const pollPendingUserInputRequests = useCallback(async () => {
        if (userInputPollInFlightRef.current) {
          userInputPollRerunRequestedRef.current = true;
          return;
        }
        userInputPollInFlightRef.current = true;
        try {
          const requests = await listCodexUserInputRequests(sessionId);
          if (!mountedRef.current) {
            return;
          }

          setPendingUserInputRequests((previous) =>
            areUserInputRequestsEqual(previous, requests) ? previous : requests,
          );
          const activeIds = new Set(
            requests.map((request) => request.requestId),
          );

          setSelectedUserInputAnswers((previous) =>
            pruneSelectedAnswers(previous, activeIds),
          );

          setSubmittingUserInputRequestIds((previous) =>
            pruneSubmittingIds(previous, activeIds),
          );
          const nextSubmittingRequestIds = new Set(
            [...submittingRequestIdsRef.current].filter((requestId) =>
              activeIds.has(requestId),
            ),
          );
          if (
            nextSubmittingRequestIds.size !==
            submittingRequestIdsRef.current.size
          ) {
            submittingRequestIdsRef.current = nextSubmittingRequestIds;
          }
        } catch {
          // Keep UI state as-is on transient polling failures.
        } finally {
          userInputPollInFlightRef.current = false;
          if (
            userInputPollRerunRequestedRef.current &&
            mountedRef.current &&
            isPageVisible
          ) {
            userInputPollRerunRequestedRef.current = false;
            void pollPendingUserInputRequests();
          } else {
            userInputPollRerunRequestedRef.current = false;
          }
        }
      }, [isPageVisible, sessionId]);

      const pollPendingApprovalRequests = useCallback(async () => {
        if (approvalPollInFlightRef.current) {
          approvalPollRerunRequestedRef.current = true;
          return;
        }

        approvalPollInFlightRef.current = true;
        try {
          const requests = await listCodexApprovalRequests(sessionId);
          if (!mountedRef.current) {
            return;
          }

          setPendingApprovalRequests((previous) => {
            if (previous.length !== requests.length) {
              return requests;
            }
            for (let index = 0; index < requests.length; index += 1) {
              if (
                JSON.stringify(previous[index]) !==
                JSON.stringify(requests[index])
              ) {
                return requests;
              }
            }
            return previous;
          });

          const activeIds = new Set(
            requests.map((request) => request.requestId),
          );
          setSubmittingApprovalRequestIds((previous) =>
            pruneSubmittingIds(previous, activeIds),
          );

          const nextSubmittingIds = new Set(
            [...submittingApprovalRequestIdsRef.current].filter((requestId) =>
              activeIds.has(requestId),
            ),
          );
          if (
            nextSubmittingIds.size !==
            submittingApprovalRequestIdsRef.current.size
          ) {
            submittingApprovalRequestIdsRef.current = nextSubmittingIds;
          }
        } catch {
          // Keep UI state as-is on transient polling failures.
        } finally {
          approvalPollInFlightRef.current = false;
          if (
            approvalPollRerunRequestedRef.current &&
            mountedRef.current &&
            isPageVisible
          ) {
            approvalPollRerunRequestedRef.current = false;
            void pollPendingApprovalRequests();
          } else {
            approvalPollRerunRequestedRef.current = false;
          }
        }
      }, [isPageVisible, sessionId]);

      useEffect(() => {
        if (!isPageVisible) {
          return;
        }

        void pollPendingUserInputRequests();
        const interval = setInterval(() => {
          void pollPendingUserInputRequests();
        }, USER_INPUT_POLL_INTERVAL_MS);
        return () => clearInterval(interval);
      }, [pollPendingUserInputRequests, isPageVisible]);

      useEffect(() => {
        if (!isPageVisible) {
          return;
        }

        void pollPendingApprovalRequests();
        const interval = setInterval(() => {
          void pollPendingApprovalRequests();
        }, APPROVAL_POLL_INTERVAL_MS);
        return () => clearInterval(interval);
      }, [pollPendingApprovalRequests, isPageVisible]);

      const submitUserInputResponse = useCallback(
        async (
          request: CodexUserInputRequest,
          response: CodexUserInputResponsePayload,
        ) => {
          const requestId = request.requestId;
          if (submittingRequestIdsRef.current.has(requestId)) {
            return;
          }
          submittingRequestIdsRef.current.add(requestId);
          setSubmittingUserInputRequestIds((previous) =>
            previous.includes(requestId) ? previous : [...previous, requestId],
          );

          try {
            await respondCodexUserInputRequest(sessionId, requestId, response);
          } catch {
            // Let polling keep the request visible if submission fails.
          } finally {
            submittingRequestIdsRef.current.delete(requestId);
            setSubmittingUserInputRequestIds((previous) =>
              previous.filter((id) => id !== requestId),
            );
            void pollPendingUserInputRequests();
          }
        },
        [pollPendingUserInputRequests, sessionId],
      );

      const submitApprovalResponse = useCallback(
        async (
          request: CodexApprovalRequest,
          response: CodexApprovalResponsePayload,
        ) => {
          const requestId = request.requestId;
          if (submittingApprovalRequestIdsRef.current.has(requestId)) {
            return;
          }

          submittingApprovalRequestIdsRef.current.add(requestId);
          setSubmittingApprovalRequestIds((previous) =>
            previous.includes(requestId) ? previous : [...previous, requestId],
          );

          try {
            await respondCodexApprovalRequest(sessionId, requestId, response);
          } catch {
            // Let polling keep the request visible if submission fails.
          } finally {
            submittingApprovalRequestIdsRef.current.delete(requestId);
            setSubmittingApprovalRequestIds((previous) =>
              previous.filter((id) => id !== requestId),
            );
            void pollPendingApprovalRequests();
          }
        },
        [pollPendingApprovalRequests, sessionId],
      );

      const handleSelectUserInputOption = useCallback(
        (
          request: CodexUserInputRequest,
          questionId: string,
          optionLabel: string,
        ) => {
          if (!request.requestId || !questionId || !optionLabel) {
            return;
          }

          if (submittingRequestIdsRef.current.has(request.requestId)) {
            return;
          }

          setSelectedUserInputAnswers((previous) => {
            const currentAnswers = previous[request.requestId] ?? {};
            const currentDraft = currentAnswers[questionId] ?? {
              optionLabel: "",
              otherText: "",
            };
            const nextAnswers = {
              ...currentAnswers,
              [questionId]: {
                optionLabel,
                otherText:
                  optionLabel === USER_INPUT_OTHER_OPTION_LABEL
                    ? currentDraft.otherText
                    : "",
              },
            };

            const allAnswered = request.questions.every(
              (question) =>
                nextAnswers[question.id]?.optionLabel.trim().length > 0,
            );
            const hasOtherSelection = request.questions.some(
              (question) =>
                nextAnswers[question.id]?.optionLabel ===
                USER_INPUT_OTHER_OPTION_LABEL,
            );
            const selectedQuestion = request.questions.find(
              (question) => question.id === questionId,
            );
            const shouldAutoSubmitSingle =
              request.questions.length <= 1 &&
              !(
                !!selectedQuestion &&
                optionLabel === USER_INPUT_OTHER_OPTION_LABEL
              );

            if (shouldAutoSubmitSingle || (allAnswered && !hasOtherSelection)) {
              const payload = buildUserInputResponsePayload(
                request,
                nextAnswers,
              );
              if (Object.keys(payload.answers).length > 0) {
                void submitUserInputResponse(request, payload);
              }
            }

            return {
              ...previous,
              [request.requestId]: nextAnswers,
            };
          });
        },
        [submitUserInputResponse],
      );

      const handleChangeUserInputOtherText = useCallback(
        (request: CodexUserInputRequest, questionId: string, text: string) => {
          if (!request.requestId || !questionId) {
            return;
          }

          if (submittingRequestIdsRef.current.has(request.requestId)) {
            return;
          }

          setSelectedUserInputAnswers((previous) => {
            const currentAnswers = previous[request.requestId] ?? {};
            const currentDraft = currentAnswers[questionId] ?? {
              optionLabel: "",
              otherText: "",
            };

            return {
              ...previous,
              [request.requestId]: {
                ...currentAnswers,
                [questionId]: {
                  ...currentDraft,
                  otherText: text,
                },
              },
            };
          });
        },
        [],
      );

      const handleSubmitUserInputAnswers = useCallback(
        (request: CodexUserInputRequest) => {
          if (!request.requestId) {
            return;
          }
          if (submittingRequestIdsRef.current.has(request.requestId)) {
            return;
          }

          const drafts = selectedUserInputAnswers[request.requestId] ?? {};
          const payload = buildUserInputResponsePayload(request, drafts);
          if (Object.keys(payload.answers).length === 0) {
            return;
          }
          void submitUserInputResponse(request, payload);
        },
        [selectedUserInputAnswers, submitUserInputResponse],
      );

      const scrollToBottom = useCallback(() => {
        if (!containerRef.current) {
          return;
        }
        isScrollingProgrammaticallyRef.current = true;
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
        requestAnimationFrame(() => {
          isScrollingProgrammaticallyRef.current = false;
        });
      }, []);

      const navigateConversationSearchMatch = useCallback(
        (direction: SearchDirection) => {
          setAutoScroll(false);
          shouldFollowActiveSearchMatchRef.current = true;
          setActiveSearchMatchIndex((currentIndex) => {
            const matchCount = conversationSearchMatchCountRef.current;
            if (matchCount === 0) {
              return null;
            }

            if (currentIndex === null) {
              return direction === "previous" ? matchCount - 1 : 0;
            }

            if (direction === "previous") {
              return (currentIndex - 1 + matchCount) % matchCount;
            }

            return (currentIndex + 1) % matchCount;
          });
        },
        [],
      );

      useImperativeHandle(
        ref,
        () => ({
          navigateConversationSearchMatch,
        }),
        [navigateConversationSearchMatch],
      );

      useEffect(() => {
        if (railCollapsedByDefaultRef.current === railCollapsedByDefault) {
          return;
        }

        railCollapsedByDefaultRef.current = railCollapsedByDefault;
        shouldFollowActiveSearchMatchRef.current = false;
        collapsedDefaultSegmentKeysRef.current = {};
        setCollapsedDefaultSegmentKeys({});
        setCurrentPage(totalPagesRef.current);
        setAutoScroll(true);
        requestAnimationFrame(() => {
          scrollToBottom();
        });
      }, [railCollapsedByDefault, scrollToBottom]);

      const registerRailButtonRef = useCallback(
        (segmentKey: string, node: HTMLButtonElement | null) => {
          if (node) {
            railButtonRefsRef.current.set(segmentKey, node);
          } else {
            railButtonRefsRef.current.delete(segmentKey);
          }
        },
        [],
      );

      const scheduleCollapsedRailAlignment = useCallback(
        (segmentKey: string, pointerY: number | null) => {
          const alignmentEpoch = railAlignmentEpochRef.current;
          requestAnimationFrame(() => {
            if (
              alignmentEpoch !== railAlignmentEpochRef.current ||
              !mountedRef.current
            ) {
              return;
            }

            const container = containerRef.current;
            const railButton = railButtonRefsRef.current.get(segmentKey);
            if (!container || !railButton) {
              return;
            }

            const previousOverflowAnchor = container.style.overflowAnchor;
            container.style.overflowAnchor = "none";
            let didProgrammaticScroll = false;

            const applyAlignmentPass = (): void => {
              if (
                alignmentEpoch !== railAlignmentEpochRef.current ||
                !mountedRef.current
              ) {
                return;
              }

              const currentContainer = containerRef.current;
              const currentRailButton =
                railButtonRefsRef.current.get(segmentKey);
              if (!currentContainer || !currentRailButton) {
                return;
              }

              const containerRect = currentContainer.getBoundingClientRect();
              const railRect = currentRailButton.getBoundingClientRect();
              const delta = computeRailScrollDelta({
                railTop: railRect.top,
                railBottom: railRect.bottom,
                pointerY,
                viewportCenterY: containerRect.top + containerRect.height / 2,
              });
              if (delta === null) {
                return;
              }

              if (!didProgrammaticScroll) {
                isScrollingProgrammaticallyRef.current = true;
                didProgrammaticScroll = true;
              }

              currentContainer.scrollTop -= delta;
            };

            const finalizeAlignment = () => {
              container.style.overflowAnchor = previousOverflowAnchor;
              if (didProgrammaticScroll) {
                requestAnimationFrame(() => {
                  if (
                    alignmentEpoch === railAlignmentEpochRef.current &&
                    mountedRef.current
                  ) {
                    isScrollingProgrammaticallyRef.current = false;
                  }
                });
              }
            };

            applyAlignmentPass();
            requestAnimationFrame(() => {
              if (
                alignmentEpoch !== railAlignmentEpochRef.current ||
                !mountedRef.current
              ) {
                finalizeAlignment();
                return;
              }
              applyAlignmentPass();
              requestAnimationFrame(() => {
                if (
                  alignmentEpoch !== railAlignmentEpochRef.current ||
                  !mountedRef.current
                ) {
                  finalizeAlignment();
                  return;
                }
                applyAlignmentPass();
                finalizeAlignment();
              });
            });
          });
        },
        [],
      );

      const handleScroll = () => {
        if (!containerRef.current || isScrollingProgrammaticallyRef.current) {
          return;
        }

        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        const isAtBottom =
          scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD_PX;
        setAutoScroll(isAtBottom);
      };

      const {
        resolvedUserInputAnswersByItemId,
        suppressedRequestUserInputResultIds,
        toolMapByCallId,
        toolInputMapByCallId,
        toolTimestampMapByCallId,
      } = useMemo(() => {
        const toolNameByCallId = new Map<string, string>();
        const toolInputByCallId = new Map<string, Record<string, unknown>>();
        const toolTimestampByCallId = new Map<string, string>();
        const resolvedAnswersByItemId = new Map<
          string,
          Record<string, UserInputAnswerDraft>
        >();
        const suppressedResultIds = new Set<string>();

        for (const message of messages) {
          const content = message.message?.content;
          if (!Array.isArray(content)) {
            continue;
          }

          for (const block of content) {
            if (block.type === "tool_use" && block.id && block.name) {
              toolNameByCallId.set(block.id, block.name);
              if (
                block.input &&
                typeof block.input === "object" &&
                !Array.isArray(block.input)
              ) {
                toolInputByCallId.set(
                  block.id,
                  block.input as Record<string, unknown>,
                );
              }
              if (
                typeof block.timestamp === "string" &&
                block.timestamp.trim().length > 0
              ) {
                toolTimestampByCallId.set(block.id, block.timestamp);
              }
              continue;
            }

            if (block.type !== "tool_result" || !block.tool_use_id) {
              continue;
            }

            const toolName = (
              block.name ||
              toolNameByCallId.get(block.tool_use_id) ||
              ""
            ).toLowerCase();
            if (toolName !== "request_user_input" || block.is_error === true) {
              continue;
            }

            const parsed = parseResolvedUserInputAnswers(block.content);
            if (!parsed) {
              continue;
            }

            resolvedAnswersByItemId.set(block.tool_use_id, parsed);
            suppressedResultIds.add(block.tool_use_id);
          }
        }

        return {
          resolvedUserInputAnswersByItemId: resolvedAnswersByItemId,
          suppressedRequestUserInputResultIds: suppressedResultIds,
          toolMapByCallId: toolNameByCallId,
          toolInputMapByCallId: toolInputByCallId,
          toolTimestampMapByCallId: toolTimestampByCallId,
        };
      }, [messages]);

      const summary = messages.find((m) => m.type === "summary");
      const visibleMessages = messages.filter(isVisibleConversationMessage);
      const visibleMessageEntries = useMemo<PagedMessageEntry[]>(() => {
        return visibleMessages.map((message, visibleIndex) => {
          const usesUserInputState = messageUsesUserInputState(message);
          const isLastVisibleMessage =
            visibleIndex === visibleMessages.length - 1;
          const shouldShowTimestamp =
            message.type === "user" ||
            message.type === "system_error" ||
            message.type === "token_limit_notice" ||
            message.type === "turn_aborted" ||
            isLastVisibleMessage;
          const timestampText = shouldShowTimestamp
            ? formatLocalTimestamp(message.timestamp)
            : null;
          const timestampAlignment =
            message.type === "user" ? "justify-end pr-2" : "justify-start pl-2";

          return {
            entryKey: getConversationEntryKey(message, visibleIndex),
            page: Math.floor(visibleIndex / MESSAGES_PER_PAGE) + 1,
            visibleIndex,
            message,
            usesUserInputState,
            timestampText,
            timestampAlignment,
            group: getViewportMessageGroup(message),
          };
        });
      }, [visibleMessages]);
      const latestAiTerminalPlanEntryKey = useMemo(() => {
        for (
          let index = visibleMessageEntries.length - 1;
          index >= 0;
          index -= 1
        ) {
          const entry = visibleMessageEntries[index];
          const parsed = parseAiTerminalMessage(
            extractConversationMessageText(entry.message),
          );
          if (parsed?.directive.kind === "plan") {
            return entry.entryKey;
          }
        }
        return null;
      }, [visibleMessageEntries]);
      const persistedAiTerminalStepStatesByMessageKey = useMemo(
        () =>
          deriveAiTerminalStepStatesByMessageKey(visibleMessageEntries, {
            getMessage: (entry) => entry.message,
            getMessageKey: (entry) =>
              getAiTerminalMessageKey(entry.message) ?? entry.entryKey,
          }),
        [visibleMessageEntries],
      );
      const chatMessages = visibleMessages.filter(
        (m) => m.type === "user" || m.type === "assistant",
      );
      const totalPages = getTotalPages(
        visibleMessages.length,
        MESSAGES_PER_PAGE,
      );
      const safeCurrentPage = clampPage(currentPage, totalPages);
      const isLatestPage = safeCurrentPage === totalPages;
      const { start: pageStart, end: pageEnd } = getPageSliceBounds(
        safeCurrentPage,
        MESSAGES_PER_PAGE,
        visibleMessages.length,
      );
      const pagedMessageEntries = visibleMessageEntries.slice(
        pageStart,
        pageEnd,
      );
      const pagedMessageChunks = useMemo<MessageViewportChunk[]>(() => {
        const chunks: MessageViewportChunk[] = [];
        let defaultRun: PagedMessageEntry[] = [];

        const flushDefaultRun = () => {
          if (defaultRun.length === 0) {
            return;
          }

          const firstEntry = defaultRun[0];
          chunks.push({
            kind: "default-segment",
            segmentKey: `default:${firstEntry.entryKey}`,
            entries: defaultRun,
          });
          defaultRun = [];
        };

        for (const entry of pagedMessageEntries) {
          if (entry.group === "default") {
            defaultRun.push(entry);
            continue;
          }

          flushDefaultRun();
          chunks.push({
            kind: "important",
            entry,
          });
        }

        flushDefaultRun();
        return chunks;
      }, [pagedMessageEntries]);
      const pagedEntrySegmentKeys = useMemo(() => {
        const next = new Map<string, string>();

        for (const chunk of pagedMessageChunks) {
          if (chunk.kind !== "default-segment") {
            continue;
          }

          for (const entry of chunk.entries) {
            next.set(entry.entryKey, chunk.segmentKey);
          }
        }

        return next;
      }, [pagedMessageChunks]);
      const pageDigits = Math.max(String(totalPages).length, 2);
      const handleChangePage = useCallback(
        (nextPage: number) => {
          shouldFollowActiveSearchMatchRef.current = false;
          const safeNextPage = clampPage(nextPage, totalPages);
          setCurrentPage(safeNextPage);

          if (safeNextPage === totalPages) {
            setAutoScroll(true);
            requestAnimationFrame(() => {
              scrollToBottom();
            });
            return;
          }

          setAutoScroll(false);
          if (containerRef.current) {
            containerRef.current.scrollTop = 0;
          }
        },
        [scrollToBottom, totalPages],
      );
      const applyManualPageInput = useCallback(() => {
        const parsed = Number.parseInt(pageInputValue.trim(), 10);
        const nextPage = Number.isFinite(parsed)
          ? clampPage(parsed, totalPages)
          : safeCurrentPage;

        setPageInputValue(String(nextPage));
        if (nextPage !== safeCurrentPage) {
          handleChangePage(nextPage);
        }
      }, [handleChangePage, pageInputValue, safeCurrentPage, totalPages]);
      const agentsBootstrapMessage =
        chatMessages.length >= 2 &&
        chatMessages[0].type === "user" &&
        chatMessages[1].type === "user"
          ? chatMessages[0]
          : null;
      const conversationSearchMatches = useMemo<
        ConversationSearchMatchTarget[]
      >(() => {
        const normalizedQuery = conversationSearchQuery.trim();
        if (!conversationSearchOpen || normalizedQuery.length === 0) {
          return [];
        }

        const matches: ConversationSearchMatchTarget[] = [];
        const pageMatchCounts = new Map<number, number>();
        const targetMatchCounts = new Map<string, number>();

        const appendSearchableText = (
          entry: PagedMessageEntry,
          text: string,
          options?: {
            forcePrimaryExpanded?: boolean;
            forceBlockIndex?: number | null;
          },
        ) => {
          const normalizedText = sanitizeText(text).trim();
          if (normalizedText.length === 0) {
            return;
          }

          const fragmentMatches = findConversationSearchMatches(
            [normalizedText],
            normalizedQuery,
          );
          for (const _match of fragmentMatches) {
            const pageMatchIndex = pageMatchCounts.get(entry.page) ?? 0;
            const targetKey = `${entry.entryKey}:${options?.forcePrimaryExpanded === true ? "primary" : "content"}:${options?.forceBlockIndex ?? "none"}`;
            const targetMatchIndex = targetMatchCounts.get(targetKey) ?? 0;
            matches.push({
              entryKey: entry.entryKey,
              page: entry.page,
              pageMatchIndex,
              targetMatchIndex,
              forcePrimaryExpanded: options?.forcePrimaryExpanded === true,
              forceBlockIndex: options?.forceBlockIndex ?? null,
            });
            pageMatchCounts.set(entry.page, pageMatchIndex + 1);
            targetMatchCounts.set(targetKey, targetMatchIndex + 1);
          }
        };

        for (const entry of visibleMessageEntries) {
          const content = entry.message.message?.content;

          if (typeof content === "string") {
            appendSearchableText(entry, content, {
              forcePrimaryExpanded: true,
            });
            continue;
          }

          if (!Array.isArray(content)) {
            continue;
          }

          for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
            const block = content[blockIndex];

            if (block.type === "image") {
              continue;
            }

            if (
              block.type === "tool_result" &&
              block.tool_use_id &&
              suppressedRequestUserInputResultIds.has(block.tool_use_id) &&
              block.is_error !== true
            ) {
              continue;
            }

            if (block.type === "text") {
              appendSearchableText(entry, block.text ?? "", {
                forcePrimaryExpanded: true,
              });
              continue;
            }

            if (block.type === "thinking") {
              appendSearchableText(entry, block.thinking ?? "", {
                forceBlockIndex: blockIndex,
              });
              continue;
            }

            if (
              block.type === "reasoning" ||
              block.type === "agent_reasoning"
            ) {
              appendSearchableText(
                entry,
                formatSearchableReasoningText(block.text ?? ""),
                {
                  forceBlockIndex: blockIndex,
                },
              );
              continue;
            }

            if (block.type === "tool_use") {
              appendSearchableText(entry, getSearchableToolUseText(block), {
                forceBlockIndex: blockIndex,
              });
              continue;
            }

            if (block.type === "tool_result") {
              appendSearchableText(
                entry,
                stringifySearchableContent(block.content),
                {
                  forceBlockIndex: blockIndex,
                },
              );
            }
          }
        }

        return matches;
      }, [
        conversationSearchOpen,
        conversationSearchQuery,
        suppressedRequestUserInputResultIds,
        visibleMessageEntries,
      ]);
      conversationSearchMatchCountRef.current =
        conversationSearchMatches.length;
      const activeSearchMatch =
        activeSearchMatchIndex === null
          ? null
          : (conversationSearchMatches[activeSearchMatchIndex] ?? null);
      const handlePlanAction = useCallback(
        (action: "implement" | "stay") => {
          onPlanAction?.(sessionId, action);
        },
        [onPlanAction, sessionId],
      );
      const toggleDefaultSegment = useCallback(
        (segmentKey: string, pointerY: number | null) => {
          const currentCollapsed = Object.prototype.hasOwnProperty.call(
            collapsedDefaultSegmentKeysRef.current,
            segmentKey,
          )
            ? collapsedDefaultSegmentKeysRef.current[segmentKey] === true
            : railCollapsedByDefault;
          const nextCollapsed = !currentCollapsed;
          setCollapsedDefaultSegmentKeys((previous) => {
            if (nextCollapsed === railCollapsedByDefault) {
              const next = { ...previous };
              delete next[segmentKey];
              return next;
            }

            return {
              ...previous,
              [segmentKey]: nextCollapsed,
            };
          });

          if (nextCollapsed) {
            scheduleCollapsedRailAlignment(segmentKey, pointerY);
          }
        },
        [railCollapsedByDefault, scheduleCollapsedRailAlignment],
      );
      const expandDefaultSegmentForSearch = useCallback(
        (segmentKey: string) => {
          setCollapsedDefaultSegmentKeys((previous) => {
            const currentCollapsed = Object.prototype.hasOwnProperty.call(
              previous,
              segmentKey,
            )
              ? previous[segmentKey] === true
              : railCollapsedByDefault;

            if (!currentCollapsed) {
              return previous;
            }

            if (railCollapsedByDefault) {
              return {
                ...previous,
                [segmentKey]: false,
              };
            }

            const next = { ...previous };
            delete next[segmentKey];
            return next;
          });
        },
        [railCollapsedByDefault],
      );
      const renderMessageEntry = useCallback(
        (entry: PagedMessageEntry) => {
          const {
            message,
            usesUserInputState,
            timestampText,
            timestampAlignment,
          } = entry;
          const isActiveSearchEntry =
            activeSearchMatch?.entryKey === entry.entryKey;
          const aiTerminalMessageKey =
            getAiTerminalMessageKey(message) ?? entry.entryKey;
          const aiTerminalContext =
            message.type === "assistant" &&
            aiTerminalTerminalId &&
            entry.entryKey === latestAiTerminalPlanEntryKey
              ? {
                  sessionId,
                  terminalId: aiTerminalTerminalId,
                  messageKey: aiTerminalMessageKey,
                  isActionable: true,
                  stepStates:
                    persistedAiTerminalStepStatesByMessageKey[
                      aiTerminalMessageKey
                    ],
                  onApproveStep: onApproveAiTerminalStep,
                  onRejectStep: onRejectAiTerminalStep,
                }
              : undefined;

          return (
            <div key={entry.entryKey} data-search-entry={entry.entryKey}>
              <MessageBlock
                message={message}
                aiTerminalContext={aiTerminalContext}
                isAgentsBootstrap={message === agentsBootstrapMessage}
                searchForcePrimaryExpanded={
                  isActiveSearchEntry &&
                  activeSearchMatch?.forcePrimaryExpanded === true
                }
                searchForceBlockIndex={
                  isActiveSearchEntry
                    ? (activeSearchMatch?.forceBlockIndex ?? null)
                    : null
                }
                fallbackToolMap={toolMapByCallId}
                fallbackToolInputMap={toolInputMapByCallId}
                fallbackToolTimestampMap={toolTimestampMapByCallId}
                onPlanAction={onPlanAction ? handlePlanAction : undefined}
                onFilePathLinkClick={onFilePathLinkClick}
                pendingUserInputRequests={
                  usesUserInputState ? pendingUserInputRequests : undefined
                }
                pendingApprovalRequests={
                  messageUsesApprovalState(message)
                    ? pendingApprovalRequests
                    : undefined
                }
                selectedUserInputAnswers={
                  usesUserInputState ? selectedUserInputAnswers : undefined
                }
                submittingUserInputRequestIds={
                  usesUserInputState ? submittingUserInputRequestIds : undefined
                }
                submittingApprovalRequestIds={
                  messageUsesApprovalState(message)
                    ? submittingApprovalRequestIds
                    : undefined
                }
                onSelectUserInputOption={
                  usesUserInputState ? handleSelectUserInputOption : undefined
                }
                onChangeUserInputOtherText={
                  usesUserInputState
                    ? handleChangeUserInputOtherText
                    : undefined
                }
                onSubmitUserInputAnswers={
                  usesUserInputState ? handleSubmitUserInputAnswers : undefined
                }
                onRespondApprovalRequest={
                  messageUsesApprovalState(message)
                    ? submitApprovalResponse
                    : undefined
                }
                resolvedUserInputAnswersByItemId={
                  resolvedUserInputAnswersByItemId
                }
                suppressedRequestUserInputResultIds={
                  suppressedRequestUserInputResultIds
                }
              />
              {timestampText && (
                <div
                  className={`mt-1 flex ${timestampAlignment} text-[10px] font-mono leading-none text-zinc-500/90`}
                >
                  {timestampText}
                </div>
              )}
            </div>
          );
        },
        [
          activeSearchMatch,
          aiTerminalTerminalId,
          agentsBootstrapMessage,
          handleChangeUserInputOtherText,
          handlePlanAction,
          handleSelectUserInputOption,
          handleSubmitUserInputAnswers,
          latestAiTerminalPlanEntryKey,
          onApproveAiTerminalStep,
          onFilePathLinkClick,
          onPlanAction,
          onRejectAiTerminalStep,
          pendingUserInputRequests,
          pendingApprovalRequests,
          resolvedUserInputAnswersByItemId,
          sessionId,
          submitApprovalResponse,
          selectedUserInputAnswers,
          submittingApprovalRequestIds,
          submittingUserInputRequestIds,
          suppressedRequestUserInputResultIds,
          toolInputMapByCallId,
          toolMapByCallId,
          toolTimestampMapByCallId,
        ],
      );
      const shouldAutoForceBlockModeForEntries = useCallback(
        (entries: readonly PagedMessageEntry[]) => {
          if (entries.length === 0 || pendingApprovalByItemId.size === 0) {
            return false;
          }

          return entries.some((entry) =>
            messageHasPendingExecApproval(
              entry.message,
              pendingApprovalByItemId,
            ),
          );
        },
        [pendingApprovalByItemId],
      );

      useEffect(() => {
        const activeSegmentKeys = new Set(
          pagedMessageChunks
            .filter(
              (
                chunk,
              ): chunk is Extract<
                MessageViewportChunk,
                { kind: "default-segment" }
              > => chunk.kind === "default-segment",
            )
            .map((chunk) => chunk.segmentKey),
        );

        setCollapsedDefaultSegmentKeys((previous) => {
          let changed = false;
          const next: Record<string, boolean> = {};
          for (const [segmentKey, isCollapsed] of Object.entries(previous)) {
            if (activeSegmentKeys.has(segmentKey)) {
              next[segmentKey] = isCollapsed;
            } else {
              changed = true;
            }
          }
          return changed ? next : previous;
        });
      }, [pagedMessageChunks]);

      useEffect(() => {
        if (safeCurrentPage !== currentPage) {
          setCurrentPage(safeCurrentPage);
        }
      }, [currentPage, safeCurrentPage]);

      useEffect(() => {
        setPageInputValue(String(safeCurrentPage));
      }, [safeCurrentPage]);

      useEffect(() => {
        const history = extractUserInputHistory(messages);
        const confirmedUserMessageCount =
          getComposerUserMessages(messages).length;
        const nextHistoryKey = JSON.stringify(history);
        if (nextHistoryKey === lastReportedHistoryKeyRef.current) {
          onMessageHistoryChangeRef.current?.(
            sessionId,
            history,
            confirmedUserMessageCount,
          );
          return;
        }

        lastReportedHistoryKeyRef.current = nextHistoryKey;
        onMessageHistoryChangeRef.current?.(
          sessionId,
          history,
          confirmedUserMessageCount,
        );
      }, [messages, sessionId]);

      useEffect(() => {
        const previousTotalPages = totalPagesRef.current;
        if (previousTotalPages === totalPages) {
          return;
        }

        if (remoteBootstrapInProgressRef.current) {
          totalPagesRef.current = totalPages;
          return;
        }

        const wasOnLatestPage = currentPage >= previousTotalPages;
        if (totalPages > previousTotalPages && wasOnLatestPage) {
          setCurrentPage(totalPages);
          setAutoScroll(true);
        } else if (currentPage > totalPages) {
          setCurrentPage(totalPages);
        }

        totalPagesRef.current = totalPages;
      }, [currentPage, totalPages]);

      useEffect(() => {
        if (autoScroll && isLatestPage) {
          scrollToBottom();
        }
      }, [
        messages,
        pendingUserMessages,
        autoScroll,
        isLatestPage,
        scrollToBottom,
      ]);

      useEffect(() => {
        const normalizedQuery = conversationSearchQuery.trim();
        const queryChanged =
          normalizedQuery !== lastNormalizedConversationSearchQueryRef.current;
        lastNormalizedConversationSearchQueryRef.current = normalizedQuery;

        if (!conversationSearchOpen || normalizedQuery.length === 0) {
          shouldFollowActiveSearchMatchRef.current = false;
          setActiveSearchMatchIndex(null);
          return;
        }

        if (conversationSearchMatches.length === 0) {
          shouldFollowActiveSearchMatchRef.current = false;
          setActiveSearchMatchIndex(null);
          return;
        }

        if (queryChanged) {
          shouldFollowActiveSearchMatchRef.current = true;
        }

        setActiveSearchMatchIndex((currentIndex) => {
          if (
            currentIndex === null ||
            currentIndex >= conversationSearchMatches.length
          ) {
            return 0;
          }

          return currentIndex;
        });
      }, [
        conversationSearchMatches.length,
        conversationSearchOpen,
        conversationSearchQuery,
      ]);

      useEffect(() => {
        if (!activeSearchMatch) {
          return;
        }

        if (!shouldFollowActiveSearchMatchRef.current) {
          return;
        }

        if (activeSearchMatch.page !== safeCurrentPage) {
          setAutoScroll(false);
          setCurrentPage(activeSearchMatch.page);
          if (containerRef.current) {
            containerRef.current.scrollTop = 0;
          }
          return;
        }

        const segmentKey = pagedEntrySegmentKeys.get(
          activeSearchMatch.entryKey,
        );
        if (segmentKey) {
          expandDefaultSegmentForSearch(segmentKey);
        }
      }, [
        activeSearchMatch,
        expandDefaultSegmentForSearch,
        pagedEntrySegmentKeys,
        safeCurrentPage,
      ]);

      useLayoutEffect(() => {
        const contentNode = contentRef.current;
        if (!contentNode) {
          searchMatchGroupsRef.current = [];
          return;
        }

        clearConversationSearchHighlights(contentNode);
        searchMatchGroupsRef.current = [];

        const normalizedQuery = conversationSearchQuery.trim();
        if (!conversationSearchOpen || normalizedQuery.length === 0) {
          return;
        }

        const textNodes = collectSearchableTextNodes(contentNode);
        const matches = findConversationSearchMatches(
          textNodes.map((node) => node.data),
          normalizedQuery,
        );
        const matchGroups = wrapConversationSearchSegments(textNodes, matches);
        searchMatchGroupsRef.current = matchGroups;

        return () => {
          clearConversationSearchHighlights(contentNode);
          searchMatchGroupsRef.current = [];
        };
      }, [
        conversationSearchOpen,
        conversationSearchQuery,
        messages,
        pendingUserMessages,
        pagedMessageChunks,
        safeCurrentPage,
        summary,
      ]);

      useEffect(() => {
        onConversationSearchStatusChangeRef.current?.({
          totalMatches: conversationSearchMatches.length,
          activeMatchIndex: activeSearchMatchIndex,
        });
      }, [activeSearchMatchIndex, conversationSearchMatches.length]);

      useLayoutEffect(() => {
        const container = containerRef.current;
        const matchGroups = searchMatchGroupsRef.current;
        if (!container || matchGroups.length === 0) {
          return;
        }

        if (!activeSearchMatch || activeSearchMatch.page !== safeCurrentPage) {
          updateConversationSearchMatchFocus(matchGroups, null);
          return;
        }

        const contentNode = contentRef.current;
        const entryRoot =
          contentNode &&
          Array.from(
            contentNode.querySelectorAll<HTMLElement>("[data-search-entry]"),
          ).find(
            (node) =>
              node.getAttribute("data-search-entry") ===
              activeSearchMatch.entryKey,
          );
        const scopedRoot =
          entryRoot && activeSearchMatch.forceBlockIndex !== null
            ? (entryRoot.querySelector<HTMLElement>(
                `[data-search-block-index="${activeSearchMatch.forceBlockIndex}"]`,
              ) ?? entryRoot)
            : entryRoot;

        const scopedMatches = scopedRoot
          ? Array.from(
              scopedRoot.querySelectorAll<HTMLElement>(SEARCH_MATCH_SELECTOR),
            )
          : [];
        const uniqueMatchIndexes = Array.from(
          new Set(
            scopedMatches
              .map((node) =>
                Number.parseInt(
                  node.dataset.conversationSearchMatch ?? "-1",
                  10,
                ),
              )
              .filter((value) => Number.isFinite(value) && value >= 0),
          ),
        );
        const activePageMatchIndex =
          uniqueMatchIndexes[activeSearchMatch.targetMatchIndex] ?? null;

        updateConversationSearchMatchFocus(matchGroups, activePageMatchIndex);

        if (
          activePageMatchIndex === null ||
          !shouldFollowActiveSearchMatchRef.current
        ) {
          return;
        }

        const activeMatch = matchGroups[activePageMatchIndex]?.[0];
        if (!activeMatch) {
          return;
        }

        scrollSearchMatchWithinNestedContainers(container, activeMatch);

        const containerRect = container.getBoundingClientRect();
        const matchRect = activeMatch.getBoundingClientRect();
        const targetScrollTop =
          container.scrollTop +
          (matchRect.top - containerRect.top) -
          container.clientHeight / 2 +
          matchRect.height / 2;

        setAutoScroll(false);
        isScrollingProgrammaticallyRef.current = true;
        container.scrollTop = Math.max(targetScrollTop, 0);
        requestAnimationFrame(() => {
          isScrollingProgrammaticallyRef.current = false;
        });
        shouldFollowActiveSearchMatchRef.current = false;
      }, [activeSearchMatch, safeCurrentPage]);

      const pendingEntriesOnLatestPage = useMemo(() => {
        if (!isLatestPage || pendingUserMessages.length === 0) {
          return [];
        }

        return pendingUserMessages.map((pendingMessage, index) => {
          const contentBlocks: NonNullable<
            ConversationMessage["message"]
          >["content"] = [
            ...(pendingMessage.text.trim().length > 0
              ? [{ type: "text" as const, text: pendingMessage.text }]
              : []),
            ...pendingMessage.images
              .filter(
                (imageUrl) =>
                  typeof imageUrl === "string" && imageUrl.trim().length > 0,
              )
              .map((imageUrl) => ({
                type: "image" as const,
                image_url: imageUrl,
              })),
          ];

          return {
            entryKey: `pending:${pendingMessage.pendingId}:${index}`,
            message: {
              type: "user" as const,
              uuid: `pending:${pendingMessage.pendingId}`,
              message: {
                role: "user",
                content: contentBlocks,
              },
            } satisfies ConversationMessage,
          };
        });
      }, [isLatestPage, pendingUserMessages]);
      const hasSessionShortcut =
        workflowShortcut !== null || terminalShortcut !== null;

      if (loading) {
        return (
          <div className="flex h-full items-center justify-center text-zinc-500">
            Loading...
          </div>
        );
      }

      return (
        <div className="relative h-full">
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto bg-zinc-950"
          >
            {hasSessionShortcut ? (
              <div className="sticky top-0 z-20 px-4 pt-3">
                <div className="mx-auto flex max-w-[96rem] items-start justify-start gap-2">
                  {workflowShortcut ? (
                    <button
                      type="button"
                      onClick={workflowShortcut.onClick}
                      title={workflowShortcut.title ?? workflowShortcut.label}
                      className="group inline-flex max-w-full items-center gap-3 rounded-full border border-emerald-400/20 bg-zinc-900/30 px-4 py-2 text-left shadow-lg shadow-black/30 ring-1 ring-black/30 transition-all hover:-translate-y-0.5 hover:border-emerald-300/35 hover:bg-zinc-900/40"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-400/12 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
                        WF
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium text-zinc-100">
                        Workflow
                      </span>
                      <span className="shrink-0 text-sm text-emerald-200 transition-transform group-hover:translate-x-0.5">
                        &gt;
                      </span>
                    </button>
                  ) : null}
                  {terminalShortcut ? (
                    <button
                      type="button"
                      onClick={terminalShortcut.onClick}
                      title={terminalShortcut.title ?? terminalShortcut.label}
                      className="group inline-flex max-w-full items-center gap-3 rounded-full border border-cyan-400/25 bg-zinc-900/30 px-4 py-2 text-left shadow-lg shadow-black/30 ring-1 ring-black/30 transition-all hover:-translate-y-0.5 hover:border-cyan-300/40 hover:bg-zinc-900/40"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
                        TM
                      </span>
                      <span className="min-w-0 truncate text-sm font-medium text-zinc-100">
                        Terminal
                      </span>
                      <span className="shrink-0 text-sm text-cyan-200 transition-transform group-hover:translate-x-0.5">
                        &gt;
                      </span>
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div
              ref={contentRef}
              className={`mx-auto max-w-[96rem] px-4 pb-12 ${
                hasSessionShortcut ? "pt-3" : "pt-4"
              }`}
            >
              {summary && (
                <div className="mb-6 rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-4">
                  <h2 className="text-sm font-medium text-zinc-200 leading-relaxed">
                    {summary.summary}
                  </h2>
                  <p className="mt-2 text-[11px] text-zinc-500">
                    {chatMessages.length} messages
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {pagedMessageChunks.map((chunk) => {
                  if (chunk.kind === "important") {
                    return renderMessageEntry(chunk.entry);
                  }

                  const autoForceBlockMode = shouldAutoForceBlockModeForEntries(
                    chunk.entries,
                  );
                  const isCollapsedByPreference =
                    Object.prototype.hasOwnProperty.call(
                      collapsedDefaultSegmentKeys,
                      chunk.segmentKey,
                    )
                      ? collapsedDefaultSegmentKeys[chunk.segmentKey] === true
                      : railCollapsedByDefault;
                  const isCollapsed = autoForceBlockMode
                    ? false
                    : isCollapsedByPreference;
                  const collapsedEntries = chunk.entries.map((entry) => ({
                    entry,
                    line: getCollapsedViewportLine(entry.message, {
                      projectPath,
                      toolMapByCallId,
                      toolInputMapByCallId,
                    }),
                  }));
                  const collapsedLines = collapsedEntries.filter(
                    (
                      item,
                    ): item is {
                      entry: PagedMessageEntry;
                      line: NonNullable<
                        ReturnType<typeof getCollapsedViewportLine>
                      >;
                    } => item.line !== null,
                  );
                  const hiddenTimestampEntries = collapsedEntries
                    .filter(
                      (
                        item,
                      ): item is {
                        entry: PagedMessageEntry & { timestampText: string };
                        line: null;
                      } =>
                        item.line === null &&
                        typeof item.entry.timestampText === "string",
                    )
                    .map((item) => item.entry);

                  return (
                    <div
                      key={chunk.segmentKey}
                      className="flex min-w-0 items-stretch gap-3"
                    >
                      <button
                        type="button"
                        ref={(node) =>
                          registerRailButtonRef(chunk.segmentKey, node)
                        }
                        onClick={(event: MouseEvent<HTMLButtonElement>) => {
                          if (autoForceBlockMode) {
                            return;
                          }
                          const pointerY =
                            event.detail === 0 ? null : event.clientY;
                          toggleDefaultSegment(chunk.segmentKey, pointerY);
                        }}
                        className={`relative w-4 shrink-0 rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${
                          autoForceBlockMode
                            ? "cursor-not-allowed opacity-70"
                            : ""
                        }`}
                        disabled={autoForceBlockMode}
                        title={
                          autoForceBlockMode
                            ? "Block mode is temporarily forced while a permission approval is pending"
                            : isCollapsed
                              ? "Expand this default block group"
                              : "Collapse this default block group"
                        }
                        aria-label={
                          autoForceBlockMode
                            ? "Block mode is temporarily forced while a permission approval is pending"
                            : isCollapsed
                              ? "Expand this default block group"
                              : "Collapse this default block group"
                        }
                      >
                        <span
                          className={`absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 rounded-full transition-colors ${
                            isCollapsed
                              ? "bg-sky-300/95"
                              : "bg-zinc-600/95 hover:bg-zinc-400/95"
                          }`}
                        />
                      </button>

                      <div
                        className="min-w-0 flex-1"
                        onClick={(event: MouseEvent<HTMLDivElement>) => {
                          if (autoForceBlockMode) {
                            return;
                          }
                          if (
                            !shouldToggleCollapsedSegmentFromContentClick({
                              isCollapsed,
                              target: event.target,
                              currentTarget: event.currentTarget,
                            })
                          ) {
                            return;
                          }
                          const pointerY =
                            event.detail === 0 ? null : event.clientY;
                          toggleDefaultSegment(chunk.segmentKey, pointerY);
                        }}
                      >
                        {isCollapsed ? (
                          <div className="flex flex-col gap-1.5">
                            {collapsedLines.length > 0 ||
                            hiddenTimestampEntries.length > 0 ? (
                              <>
                                {collapsedLines.map(({ entry, line }) => (
                                  <div
                                    key={entry.entryKey}
                                    className={`flex min-w-0 items-center gap-2 text-[11px] leading-relaxed ${getCollapsedLineToneClasses(line.tone)}`}
                                    title={line.text}
                                  >
                                    <CollapsedViewportSummary line={line} />
                                    {entry.timestampText && (
                                      <span className="shrink-0 text-[10px] font-mono text-zinc-400/90">
                                        {entry.timestampText}
                                      </span>
                                    )}
                                  </div>
                                ))}
                                {hiddenTimestampEntries.map((entry) => (
                                  <div
                                    key={`${entry.entryKey}:hidden-timestamp`}
                                    className="flex min-w-0 items-center gap-2 text-[11px] leading-relaxed text-zinc-400/90"
                                  >
                                    <span className="min-w-0 flex-1 truncate text-zinc-500">
                                      Hidden block
                                    </span>
                                    <span className="shrink-0 text-[10px] font-mono text-zinc-400/90">
                                      {entry.timestampText}
                                    </span>
                                  </div>
                                ))}
                              </>
                            ) : (
                              <div className="text-[11px] leading-relaxed text-zinc-500">
                                All blocks in this group are hidden in text
                                mode.
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {chunk.entries.map((entry) =>
                              renderMessageEntry(entry),
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {pendingEntriesOnLatestPage.map((entry) => (
                  <div key={entry.entryKey}>
                    <MessageBlock message={entry.message} userTone="pending" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {totalPages > 1 ? (
            <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg px-2 py-1">
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => handleChangePage(safeCurrentPage - 1)}
                  disabled={safeCurrentPage <= 1}
                  className="h-7 min-w-[30px] px-2 inline-flex items-center justify-center rounded border border-zinc-500/90 bg-zinc-900/55 text-[14px] font-black leading-none text-zinc-50 hover:bg-zinc-800/55 disabled:border-zinc-700/60 disabled:bg-zinc-900/55 disabled:text-zinc-50 disabled:opacity-100 disabled:cursor-not-allowed"
                  style={{
                    WebkitTextFillColor: "var(--app-page-control-foreground)",
                    color: "var(--app-page-control-foreground)",
                  }}
                  aria-label="Previous page"
                >
                  <span
                    style={{
                      color: "var(--app-page-control-foreground)",
                      WebkitTextFillColor: "var(--app-page-control-foreground)",
                      opacity: safeCurrentPage <= 1 ? 0.45 : 1,
                    }}
                  >
                    &lt;
                  </span>
                </button>
                <div
                  className="h-7 px-3 inline-flex items-center justify-center rounded border border-zinc-700/70 bg-zinc-900/60 text-[11px] font-mono font-bold text-zinc-50 tabular-nums"
                  style={{ minWidth: `${pageDigits * 2 + 6}ch` }}
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    value={pageInputValue}
                    onChange={(event) => {
                      const digits = event.target.value.replace(/\D+/g, "");
                      setPageInputValue(digits);
                    }}
                    onBlur={applyManualPageInput}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        applyManualPageInput();
                      }
                    }}
                    className="border-0 bg-transparent p-0 text-right text-zinc-50 outline-none"
                    style={{ width: `${pageDigits}ch` }}
                    aria-label="Current page"
                  />
                  <span className="px-1 text-zinc-400">/</span>
                  <span
                    style={{ width: `${pageDigits}ch` }}
                    className="text-left"
                  >
                    {totalPages}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleChangePage(safeCurrentPage + 1)}
                  disabled={safeCurrentPage >= totalPages}
                  className="h-7 min-w-[30px] px-2 inline-flex items-center justify-center rounded border border-zinc-500/90 bg-zinc-900/55 text-[14px] font-black leading-none text-zinc-50 hover:bg-zinc-800/55 disabled:border-zinc-700/60 disabled:bg-zinc-900/55 disabled:text-zinc-50 disabled:opacity-100 disabled:cursor-not-allowed"
                  style={{
                    WebkitTextFillColor: "var(--app-page-control-foreground)",
                    color: "var(--app-page-control-foreground)",
                  }}
                  aria-label="Next page"
                >
                  <span
                    style={{
                      color: "var(--app-page-control-foreground)",
                      WebkitTextFillColor: "var(--app-page-control-foreground)",
                      opacity: safeCurrentPage >= totalPages ? 0.45 : 1,
                    }}
                  >
                    &gt;
                  </span>
                </button>
              </div>
            </div>
          ) : null}

          {(!isLatestPage || !autoScroll) && (
            <ScrollToBottomButton
              direction={isLatestPage ? "down" : "down-right"}
              bottomOffsetPx={latestButtonBottomOffsetPx}
              onClick={() => handleChangePage(totalPages)}
            />
          )}
        </div>
      );
    },
  ),
);

export default SessionView;
