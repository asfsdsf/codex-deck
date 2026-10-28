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
import type { MouseEvent, UIEvent } from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Virtualizer,
} from "@tanstack/react-virtual";
import type {
  ConversationMessage,
  CodexApprovalRequest,
  CodexApprovalResponsePayload,
  CodexUserInputRequest,
  CodexUserInputResponsePayload,
} from "@codex-deck/api";
import MessageBlock from "./message-block";
import { PendingElicitations } from "./pending-elicitations";
import { PendingUserInputRequests } from "./pending-user-input-requests";
import { PendingApprovalRequests } from "./pending-approval-requests";
import { UserInputResizeContainer } from "./user-input-textarea";
import {
  buildAsyncUserInputMessage,
  buildUserInputResponsePayload,
  getAsyncUserInputState,
  getUnattachedUserInputRequests,
  isMessageUserInputRequest,
  isUserInputQuestionAnswered,
  isUserInputToolName,
} from "../user-input";
import ScrollToBottomButton from "./scroll-to-bottom-button";
import ConversationPager from "./conversation-pager";
import ConversationMessageHover from "./conversation-message-hover";
import { getConversationHoverMetadata } from "../conversation-hover-metadata";
import { useConversationHoverSettings } from "../hooks/use-conversation-hover-settings";
import {
  editConversationMessage as editConversationHistoryMessage,
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
  getTotalPages,
  parseResolvedUserInputAnswers,
  sanitizeText,
  USER_INPUT_OTHER_OPTION_LABEL,
  type UserInputAnswerDraft,
} from "../utils";
import { getSearchableToolUseText } from "../message-block-utils";
import { normalizeToolUse } from "../tool-use-normalization";
import {
  getCollapsedViewportLine,
  getViewportMessageGroup,
  type ViewportTextTone,
} from "../message-viewport-groups";
import { mergeDisplayConversationMessages } from "../conversation-message-merge";
import { computeRailScrollDelta } from "../rail-scroll-utils";
import { shouldToggleCollapsedSegmentFromContentClick } from "../segment-toggle-click";
import { findConversationSearchMatches } from "../conversation-search";
import { isVisibleConversationMessage } from "../../api/conversation-pagination";
import {
  deriveAiTerminalStepStatesByMessageKey,
  extractConversationMessageText,
  getAiTerminalMessageKey,
  parseAiTerminalMessage,
  type AiTerminalStepDirective,
} from "../ai-terminal";
import { CollapsedViewportSummary } from "./collapsed-viewport-summary";
import type { PendingUserMessage } from "../pending-user-messages";
import { STEERED_MESSAGE_CAPTION } from "../running-turn-send";
import { mergePendingConversationMessages } from "../pending-conversation-messages";
import { getCompletedTaskAnswers } from "../task-answer";
import { TaskAnswerActions } from "./task-answer-actions";
import {
  captureConversationScrollAnchor,
  restoreConversationScrollAnchor,
  type ConversationScrollAnchor,
} from "../conversation-scroll-position";

const SCROLL_THRESHOLD_PX = 1;
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
  pendingUserMessage: PendingUserMessage | null;
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
    (message.sequence === undefined
      ? undefined
      : `message:${message.sequence}`) ??
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
    return "text-zinc-200";
  }
  if (tone === "assistant") {
    return "text-zinc-300";
  }
  if (tone === "tool") {
    return "text-zinc-400";
  }
  if (tone === "plan") {
    return "text-zinc-300";
  }
  if (tone === "goal") {
    return "text-emerald-200";
  }
  return "text-rose-200";
}

interface SessionViewProps {
  sessionId: string;
  projectPath?: string | null;
  pendingUserMessages?: PendingUserMessage[];
  onForceSendPendingUserMessage?: (
    sessionId: string,
    pendingId: string,
  ) => Promise<boolean>;
  onCancelPendingUserMessage?: (sessionId: string, pendingId: string) => void;
  onAnswerAsyncQuestion?: (sessionId: string, text: string) => Promise<boolean>;
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
  diffGuideShortcut?: {
    label: string;
    title?: string;
    onClick: () => void;
  } | null;
  originSessionShortcut?: {
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
    clientId?: string;
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
      left.isBlocking !== right.isBlocking ||
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

function messageUsesUserInputState(message: ConversationMessage): boolean {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some(
    (block) =>
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      isUserInputToolName(block.name),
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
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string"
        ? [block.text.trim()]
        : [],
    )
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

  const displayMessages = messages.filter(
    (message) =>
      message.type !== "task_started" && message.type !== "task_complete",
  );
  const firstMessage = displayMessages[0];
  const secondMessage = displayMessages[1];
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
        onForceSendPendingUserMessage,
        onCancelPendingUserMessage,
        onAnswerAsyncQuestion,
        railCollapsedByDefault = false,
        latestButtonBottomOffsetPx,
        conversationSearchOpen = false,
        conversationSearchQuery = "",
        workflowShortcut = null,
        terminalShortcut = null,
        diffGuideShortcut = null,
        originSessionShortcut = null,
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
      const [elicitationRevision, setElicitationRevision] = useState(0);
      const [pendingUserInputRequests, setPendingUserInputRequests] = useState<
        CodexUserInputRequest[]
      >([]);
      const [userInputErrors, setUserInputErrors] = useState<
        Record<string, string>
      >({});
      const [pendingApprovalRequests, setPendingApprovalRequests] = useState<
        CodexApprovalRequest[]
      >([]);
      const [approvalErrors, setApprovalErrors] = useState<
        Record<string, string>
      >({});
      const [selectedUserInputAnswers, setSelectedUserInputAnswers] = useState<
        Record<string, Record<string, UserInputAnswerDraft>>
      >({});
      const [submittingUserInputRequestIds, setSubmittingUserInputRequestIds] =
        useState<string[]>([]);
      const asyncUserInputState = useMemo(
        () => getAsyncUserInputState(messages, sessionId, pendingUserMessages),
        [messages, sessionId, pendingUserMessages],
      );
      const answerableUserInputRequests = useMemo(() => {
        const liveItemIds = new Set(
          pendingUserInputRequests.map((request) => request.itemId),
        );
        return [
          ...pendingUserInputRequests,
          ...(onAnswerAsyncQuestion
            ? asyncUserInputState.requests.filter(
                (request) =>
                  !liveItemIds.has(request.itemId) &&
                  !asyncUserInputState.resolvedAnswersByItemId.has(
                    request.itemId,
                  ),
              )
            : []),
        ];
      }, [
        pendingUserInputRequests,
        asyncUserInputState,
        onAnswerAsyncQuestion,
      ]);
      const [submittingApprovalRequestIds, setSubmittingApprovalRequestIds] =
        useState<string[]>([]);
      const [forceSendingPendingId, setForceSendingPendingId] = useState<
        string | null
      >(null);
      const [loading, setLoading] = useState(true);
      const [autoScroll, setAutoScrollState] = useState(true);
      const [resizingAnswer, setResizingAnswer] = useState(false);
      const answerResizeCleanupRef = useRef<(() => void) | null>(null);
      const answerResizeAnchorRef = useRef<(() => void) | null>(null);
      const answerResizeSpaceCleanupRef = useRef<(() => void) | null>(null);
      const [currentPage, setCurrentPage] = useState(1);
      const [messageJumpTarget, setMessageJumpTarget] = useState<number | null>(
        null,
      );
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
      const hoverSettings = useConversationHoverSettings();
      const contentRef = useRef<HTMLDivElement>(null);
      const pendingUserInputRef = useRef<HTMLDivElement>(null);
      const pagesRef = useRef<HTMLDivElement>(null);
      const pageVirtualizerRef = useRef<Virtualizer<
        HTMLDivElement,
        HTMLDivElement
      > | null>(null);
      const [pagesScrollMargin, setPagesScrollMargin] = useState(0);
      const offsetRef = useRef(0);
      const historyStartSequenceRef = useRef<number | undefined>(undefined);
      const conversationFileIdRef = useRef<string | undefined>(undefined);
      const [serverMessageCount, setServerMessageCount] = useState<
        number | undefined
      >(undefined);
      const serverMessageCountRef = useRef<number | undefined>(undefined);
      const isScrollingProgrammaticallyRef = useRef(false);
      const readingAnchorRef = useRef<ConversationScrollAnchor | null>(null);
      const programmaticScrollTopRef = useRef<number | null>(null);
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
      const setAutoScroll = useCallback((enabled: boolean) => {
        autoScrollRef.current = enabled;
        setAutoScrollState(enabled);
      }, []);
      const remoteBootstrapInProgressRef = useRef(false);
      const lastReportedHistoryKeyRef = useRef("");
      const refreshUserInputRequestsRef = useRef<() => void>(() => {});
      const userInputPollInFlightRef = useRef(false);
      const userInputPollRerunRequestedRef = useRef(false);
      const approvalPollInFlightRef = useRef(false);
      const approvalGenerationRef = useRef(0);
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
        collapsedDefaultSegmentKeysRef.current = collapsedDefaultSegmentKeys;
      }, [collapsedDefaultSegmentKeys]);

      const appendDisplayMessages = useCallback(
        (
          displayMessages: ConversationMessage[],
          options?: {
            phase?: ConversationStreamPhase;
            done?: boolean;
            insertion?: "append" | "prepend";
            totalMessages?: number;
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

          if (options?.totalMessages !== undefined) {
            const previousCount = serverMessageCountRef.current;
            const nextCount = Math.max(
              options.totalMessages,
              previousCount ?? 0,
            );
            serverMessageCountRef.current = nextCount;
            setServerMessageCount(nextCount);
            const previousPages = getTotalPages(
              previousCount ?? 0,
              MESSAGES_PER_PAGE,
            );
            const nextPages = getTotalPages(nextCount, MESSAGES_PER_PAGE);
            // Select the final page in the same render as its first messages.
            setCurrentPage((page) =>
              autoScrollRef.current &&
              (phase === "bootstrap" || page >= previousPages)
                ? nextPages
                : page,
            );
          }

          if (phase === "bootstrap" && options?.done) {
            remoteBootstrapInProgressRef.current = false;
            if (autoScrollRef.current && options?.totalMessages === undefined) {
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
              if (batch?.historyStartSequence !== undefined) {
                historyStartSequenceRef.current = batch.historyStartSequence;
              }
              if (batch?.fileId) {
                conversationFileIdRef.current = batch.fileId;
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

              setLoading(false);
              appendDisplayMessages(newMessages, {
                phase,
                done: batch?.done,
                insertion: batch?.insertion,
                totalMessages: batch?.totalMessages,
              });
            },
            onHeartbeat: () => {
              lastEventAtRef.current = Date.now();
              setLoading(false);
            },
            onReset: () => {
              offsetRef.current = 0;
              historyStartSequenceRef.current = undefined;
              conversationFileIdRef.current = undefined;
              serverMessageCountRef.current = undefined;
              setServerMessageCount(undefined);

              messagesRef.current = [];
              setMessages([]);
              setLoading(true);
            },
            onError: () => {
              if (messagesRef.current.length > 0) {
                setLoading(false);
              }
            },
          },
          {
            onCodexAppServerEvent: (event) => {
              if (event.type === "elicitation_requests_changed")
                setElicitationRevision((current) => current + 1);
              if (event.type === "user_input_requests_changed") {
                refreshUserInputRequestsRef.current();
              }
            },
            initialOffset: offsetRef.current,
            initialHistoryStartSequence: historyStartSequenceRef.current,
            initialFileId: conversationFileIdRef.current,
          },
        );
      }, [appendDisplayMessages, sessionId]);

      const handleEditMessage = useCallback(
        async (message: ConversationMessage, text: string) => {
          const editId = message.editId?.trim() ?? "";
          const expectedText = message.editText ?? "";
          if (!editId || !expectedText) {
            throw new Error("This message is no longer editable.");
          }

          await editConversationHistoryMessage(
            sessionId,
            editId,
            expectedText,
            text,
          );
          if (!mountedRef.current) {
            return;
          }

          streamCleanupRef.current?.();
          streamCleanupRef.current = null;
          offsetRef.current = 0;
          historyStartSequenceRef.current = undefined;
          conversationFileIdRef.current = undefined;
          serverMessageCountRef.current = undefined;
          setServerMessageCount(undefined);

          messagesRef.current = [];
          setMessages([]);
          setLoading(true);
          connect();
        },
        [connect, sessionId],
      );

      useEffect(() => {
        mountedRef.current = true;
        railAlignmentEpochRef.current += 1;
        setLoading(true);
        setAutoScroll(true);
        readingAnchorRef.current = null;
        programmaticScrollTopRef.current = null;

        messagesRef.current = [];
        setMessages([]);
        setPendingUserInputRequests([]);
        setUserInputErrors({});
        setPendingApprovalRequests([]);
        setApprovalErrors({});
        setSelectedUserInputAnswers({});
        setSubmittingUserInputRequestIds([]);
        setSubmittingApprovalRequestIds([]);
        setCollapsedDefaultSegmentKeys({});
        setCurrentPage(1);
        setMessageJumpTarget(null);
        setActiveSearchMatchIndex(null);
        submittingRequestIdsRef.current.clear();
        offsetRef.current = 0;
        historyStartSequenceRef.current = undefined;
        conversationFileIdRef.current = undefined;
        serverMessageCountRef.current = undefined;
        setServerMessageCount(undefined);
        totalPagesRef.current = 1;
        remoteBootstrapInProgressRef.current = false;
        lastReportedHistoryKeyRef.current = "";
        userInputPollInFlightRef.current = false;
        userInputPollRerunRequestedRef.current = false;
        approvalPollInFlightRef.current = false;
        approvalGenerationRef.current += 1;
        approvalPollRerunRequestedRef.current = false;
        submittingApprovalRequestIdsRef.current.clear();
        railButtonRefsRef.current.clear();
        collapsedDefaultSegmentKeysRef.current = {};
        isScrollingProgrammaticallyRef.current = false;
        searchMatchGroupsRef.current = [];
        if (containerRef.current) {
          containerRef.current.style.overflowAnchor = "none";
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
            [
              ...requests,
              ...getAsyncUserInputState(messagesRef.current, sessionId)
                .requests,
            ].map((request) => request.requestId),
          );
          setUserInputErrors((previous) => {
            if (Object.keys(previous).every((id) => activeIds.has(id)))
              return previous;
            return Object.fromEntries(
              Object.entries(previous).filter(([id]) => activeIds.has(id)),
            );
          });

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

      useEffect(() => {
        refreshUserInputRequestsRef.current = () => {
          void pollPendingUserInputRequests();
        };
      }, [pollPendingUserInputRequests]);

      const pollPendingApprovalRequests = useCallback(async () => {
        if (approvalPollInFlightRef.current) {
          approvalPollRerunRequestedRef.current = true;
          return;
        }

        approvalPollInFlightRef.current = true;
        const generation = approvalGenerationRef.current;
        try {
          const requests = await listCodexApprovalRequests(sessionId);
          if (
            !mountedRef.current ||
            generation !== approvalGenerationRef.current
          ) {
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
          setApprovalErrors((previous) => {
            if (Object.keys(previous).every((id) => activeIds.has(id)))
              return previous;
            return Object.fromEntries(
              Object.entries(previous).filter(([id]) => activeIds.has(id)),
            );
          });
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
          if (generation !== approvalGenerationRef.current) return;
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
          setUserInputErrors((previous) => {
            const next = { ...previous };
            delete next[requestId];
            return next;
          });
          setSubmittingUserInputRequestIds((previous) =>
            previous.includes(requestId) ? previous : [...previous, requestId],
          );

          try {
            if (isMessageUserInputRequest(request)) {
              const sent = await onAnswerAsyncQuestion?.(
                sessionId,
                buildAsyncUserInputMessage(request, response),
              );
              if (!sent) throw new Error("Could not send async answer");
            } else {
              await respondCodexUserInputRequest(
                sessionId,
                requestId,
                response,
              );
            }
          } catch {
            setUserInputErrors((previous) => ({
              ...previous,
              [requestId]: "Could not send your answer. Try again.",
            }));
          } finally {
            submittingRequestIdsRef.current.delete(requestId);
            setSubmittingUserInputRequestIds((previous) =>
              previous.filter((id) => id !== requestId),
            );
            void pollPendingUserInputRequests();
          }
        },
        [onAnswerAsyncQuestion, pollPendingUserInputRequests, sessionId],
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

          const generation = approvalGenerationRef.current;
          submittingApprovalRequestIdsRef.current.add(requestId);
          setApprovalErrors((previous) => {
            const next = { ...previous };
            delete next[requestId];
            return next;
          });
          setSubmittingApprovalRequestIds((previous) =>
            previous.includes(requestId) ? previous : [...previous, requestId],
          );

          try {
            await respondCodexApprovalRequest(sessionId, requestId, response);
          } catch (error) {
            if (
              mountedRef.current &&
              generation === approvalGenerationRef.current
            ) {
              setApprovalErrors((previous) => ({
                ...previous,
                [requestId]: `Could not send your approval response: ${
                  error instanceof Error ? error.message : String(error)
                }. Try again.`,
              }));
            }
          } finally {
            if (
              !mountedRef.current ||
              generation !== approvalGenerationRef.current
            )
              return;
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

            const allAnswered = request.questions.every((question) =>
              isUserInputQuestionAnswered(question, nextAnswers[question.id]),
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
                  optionLabel: USER_INPUT_OTHER_OPTION_LABEL,
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
          if (
            !request.questions.every((question) =>
              isUserInputQuestionAnswered(question, drafts[question.id]),
            )
          )
            return;
          const payload = buildUserInputResponsePayload(request, drafts);
          if (Object.keys(payload.answers).length === 0) {
            return;
          }
          void submitUserInputResponse(request, payload);
        },
        [selectedUserInputAnswers, submitUserInputResponse],
      );

      const scrollToBottom = useCallback(() => {
        if (!containerRef.current || answerResizeCleanupRef.current) {
          return;
        }
        answerResizeSpaceCleanupRef.current?.();
        const tailElement =
          pendingUserInputRef.current?.lastElementChild ??
          pagesRef.current?.lastElementChild;
        const bottomOffset = tailElement
          ? containerRef.current.scrollTop +
            tailElement.getBoundingClientRect().bottom -
            containerRef.current.getBoundingClientRect().top +
            Number.parseFloat(
              getComputedStyle(contentRef.current!).paddingBottom,
            )
          : containerRef.current.scrollHeight;
        const target = Math.max(
          0,
          bottomOffset - containerRef.current.clientHeight,
        );
        if (Math.abs(containerRef.current.scrollTop - target) <= 0.5) return;
        isScrollingProgrammaticallyRef.current = true;
        pageVirtualizerRef.current?.scrollToOffset(target);
        programmaticScrollTopRef.current = containerRef.current.scrollTop;
        requestAnimationFrame(() => {
          isScrollingProgrammaticallyRef.current = false;
        });
      }, []);

      const navigateConversationSearchMatch = useCallback(
        (direction: SearchDirection) => {
          answerResizeSpaceCleanupRef.current?.();
          setMessageJumpTarget(null);
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
        setMessageJumpTarget(null);
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
              programmaticScrollTopRef.current = currentContainer.scrollTop;
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

      // Capture before the virtualizer's scroll listener can render a new
      // window, so that a user's scroll replaces the previous reading anchor.
      const handleScroll = (event: UIEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (answerResizeAnchorRef.current) {
          answerResizeAnchorRef.current();
          return;
        }
        const container = containerRef.current;
        if (!container || answerResizeCleanupRef.current) {
          return;
        }
        if (
          messageJumpTarget !== null ||
          shouldFollowActiveSearchMatchRef.current
        ) {
          return;
        }

        readingAnchorRef.current = captureConversationScrollAnchor(container);
        const programmaticScrollTop = programmaticScrollTopRef.current;
        programmaticScrollTopRef.current = null;
        // Navigation can clamp again while pages are measured. While following
        // the bottom, ignore only the offset we wrote so users can scroll away.
        if (
          (programmaticScrollTop !== null &&
            Math.abs(container.scrollTop - programmaticScrollTop) <= 0.5) ||
          (!autoScrollRef.current && isScrollingProgrammaticallyRef.current)
        ) {
          return;
        }

        isScrollingProgrammaticallyRef.current = false;
        const { scrollTop, scrollHeight, clientHeight } = container;
        const isAtBottom =
          scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD_PX;
        setAutoScroll(isAtBottom);
      };

      const handleAnswerResizeStart = useCallback(
        (textarea: HTMLTextAreaElement) => {
          const content = contentRef.current;
          const container = containerRef.current;
          if (!content || !container) return () => {};
          answerResizeCleanupRef.current?.();
          if (!answerResizeSpaceCleanupRef.current) {
            const previousMinHeight = content.style.minHeight;
            answerResizeSpaceCleanupRef.current = () => {
              content.style.minHeight = previousMinHeight;
              answerResizeSpaceCleanupRef.current = null;
            };
          }
          // Retain the scroll range when shrinking, including after release.
          // The next explicit scroll/navigation can reclaim the trailing space.
          content.style.minHeight = `${content.getBoundingClientRect().height}px`;
          const top = textarea.getBoundingClientRect().top;
          const anchor = () => {
            if (!textarea.isConnected) return;
            const delta = textarea.getBoundingClientRect().top - top;
            if (Math.abs(delta) > 0.5) container.scrollTop += delta;
          };
          answerResizeAnchorRef.current = anchor;
          const observer = new ResizeObserver(anchor);
          observer.observe(content);
          if (pagesRef.current) observer.observe(pagesRef.current);
          const virtualizer = pageVirtualizerRef.current;
          // Apply synchronously, before the first height change is measured.
          if (virtualizer)
            virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () =>
              false;
          const finish = () => {
            if (answerResizeCleanupRef.current !== finish) return;
            window.removeEventListener("blur", finish);
            // Flush the final page size while compensation is still disabled.
            for (const page of pagesRef.current?.querySelectorAll<HTMLDivElement>(
              "[data-conversation-page]",
            ) ?? []) {
              virtualizer?.resizeItem(
                Number(page.dataset.index),
                page.offsetHeight,
              );
            }
            anchor();
            observer.disconnect();
            answerResizeAnchorRef.current = null;
            answerResizeCleanupRef.current = null;
            setResizingAnswer(false);
          };
          answerResizeCleanupRef.current = finish;
          window.addEventListener("blur", finish);
          setAutoScroll(false);
          setResizingAnswer(true);
          return finish;
        },
        [],
      );

      useEffect(
        () => () => {
          answerResizeCleanupRef.current?.();
          answerResizeSpaceCleanupRef.current?.();
        },
        [sessionId],
      );

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
        const resolvedAnswersByItemId = new Map(
          asyncUserInputState.resolvedAnswersByItemId,
        );
        const suppressedResultIds = new Set<string>();

        for (const message of messages) {
          const content = message.message?.content;
          if (!Array.isArray(content)) {
            continue;
          }

          for (const block of content) {
            if (block.type === "tool_use" && block.id && block.name) {
              if (
                block.input &&
                typeof block.input === "object" &&
                !Array.isArray(block.input)
              ) {
                const normalized = normalizeToolUse(
                  block.name,
                  block.input as Record<string, unknown>,
                );
                toolNameByCallId.set(block.id, normalized.name);
                toolInputByCallId.set(block.id, normalized.input);
              } else {
                toolNameByCallId.set(block.id, block.name);
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
            if (!isUserInputToolName(toolName) || block.is_error === true) {
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
      }, [messages, asyncUserInputState]);

      const unattachedUserInputRequests = useMemo(
        () =>
          getUnattachedUserInputRequests(messages, answerableUserInputRequests),
        [messages, answerableUserInputRequests],
      );
      const summary = messages.find((m) => m.type === "summary");
      const displayConversationMessages = useMemo(
        () => mergePendingConversationMessages(messages, pendingUserMessages),
        [messages, pendingUserMessages],
      );
      const visibleConversationMessages = useMemo(
        () =>
          displayConversationMessages.filter((entry) =>
            isVisibleConversationMessage(entry.message),
          ),
        [displayConversationMessages],
      );
      const visibleMessages = useMemo(
        () => visibleConversationMessages.map((entry) => entry.message),
        [visibleConversationMessages],
      );
      const completedTaskAnswers = useMemo(
        () => getCompletedTaskAnswers(messages),
        [messages],
      );
      const visibleMessageEntries = useMemo<PagedMessageEntry[]>(() => {
        let transientCount = 0;
        return visibleConversationMessages.map((displayEntry, visibleIndex) => {
          const { message, pendingUserMessage } = displayEntry;
          if (message.sequence === undefined) transientCount += 1;
          const messageNumber =
            message.messageNumber ??
            (serverMessageCount === undefined
              ? visibleIndex + 1
              : serverMessageCount + transientCount);
          const usesUserInputState = messageUsesUserInputState(message);
          const isLastVisibleMessage =
            visibleIndex === visibleConversationMessages.length - 1;
          const shouldShowTimestamp =
            message.type === "user" ||
            message.type === "system_error" ||
            message.type === "token_limit_notice" ||
            message.type === "turn_aborted" ||
            message.type === "thread_goal" ||
            isLastVisibleMessage;
          const timestampText = shouldShowTimestamp
            ? formatLocalTimestamp(message.timestamp)
            : null;
          const timestampAlignment =
            message.type === "user" ? "justify-end pr-2" : "justify-start pl-2";

          return {
            entryKey: getConversationEntryKey(message, visibleIndex),
            page: Math.floor((messageNumber - 1) / MESSAGES_PER_PAGE) + 1,
            visibleIndex: messageNumber - 1,
            message,
            usesUserInputState,
            timestampText,
            timestampAlignment,
            group: completedTaskAnswers.has(message)
              ? "important"
              : getViewportMessageGroup(message),
            pendingUserMessage,
          };
        });
      }, [
        visibleConversationMessages,
        serverMessageCount,
        completedTaskAnswers,
      ]);
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
      const chatMessages = useMemo(
        () =>
          visibleMessages.filter(
            (m) => m.type === "user" || m.type === "assistant",
          ),
        [visibleMessages],
      );
      const totalMessageCount =
        serverMessageCount === undefined
          ? visibleMessages.length
          : serverMessageCount +
            visibleMessages.filter((message) => message.sequence === undefined)
              .length;
      const totalPages = getTotalPages(totalMessageCount, MESSAGES_PER_PAGE);
      // Follow page growth synchronously; effects run after a stale page could paint.
      const followingLatest =
        autoScroll && currentPage >= totalPagesRef.current;
      const safeCurrentPage = clampPage(
        followingLatest ? totalPages : currentPage,
        totalPages,
      );
      const isLatestPage = safeCurrentPage === totalPages;
      const getPageKey = useCallback(
        (index: number) => `${sessionId}:${railCollapsedByDefault}:${index}`,
        [sessionId, railCollapsedByDefault],
      );
      const extractPageRange = useCallback<typeof defaultRangeExtractor>(
        (range) => {
          // Estimated offsets may still point at an earlier page while the
          // tail is being measured. Keep its blocks mounted during that gap.
          if (autoScroll && isLatestPage && range.endIndex < range.count - 1) {
            return Array.from(
              { length: Math.min(2, range.count) },
              (_, index) => Math.max(0, range.count - 2) + index,
            );
          }
          return defaultRangeExtractor(range);
        },
        [autoScroll, isLatestPage],
      );
      // Virtualize whole pages: every intersecting page plus one on either side.
      // Only numeric height measurements survive after a page is unmounted.
      const pageVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: totalMessageCount > 0 ? totalPages : 0,
        getScrollElement: () => containerRef.current,
        getItemKey: getPageKey,
        estimateSize: () =>
          MESSAGES_PER_PAGE * (railCollapsedByDefault ? 24 : 120),
        overscan: 1,
        rangeExtractor: extractPageRange,
        scrollMargin: pagesScrollMargin,
        enabled: !loading,
      });
      // A page can contain both the reading position and growing blocks below
      // it. Compensating for its whole height moves the reader unnecessarily.
      // Restore the top visible message after the page layout commits instead.
      pageVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
      useLayoutEffect(() => {
        pageVirtualizerRef.current = pageVirtualizer;
        return () => {
          pageVirtualizerRef.current = null;
        };
      }, [pageVirtualizer]);
      const virtualPages = pageVirtualizer.getVirtualItems();
      const firstCachedPage =
        (virtualPages[0]?.index ?? safeCurrentPage - 1) + 1;
      const lastCachedPage =
        (virtualPages[virtualPages.length - 1]?.index ?? safeCurrentPage - 1) +
        1;
      const firstVisiblePage =
        (pageVirtualizer.range?.startIndex ?? safeCurrentPage - 1) + 1;
      const pagesHeight = pageVirtualizer.getTotalSize();
      useLayoutEffect(() => {
        pageVirtualizer.measure();
      }, [pageVirtualizer, sessionId, railCollapsedByDefault]);
      const pagedMessageEntries = useMemo(
        () =>
          visibleMessageEntries.filter(
            (entry) =>
              entry.page >= firstCachedPage && entry.page <= lastCachedPage,
          ),
        [visibleMessageEntries, firstCachedPage, lastCachedPage],
      );
      const committedMessageChunksRef = useRef<{
        sessionId: string;
        chunks: MessageViewportChunk[];
      }>({ sessionId, chunks: [] });
      const pagedMessageChunks = useMemo<MessageViewportChunk[]>(() => {
        const chunks: MessageViewportChunk[] = [];
        let defaultRun: PagedMessageEntry[] = [];
        const previousSegmentByEntry = new Map<string, string>();
        const retainedSegmentKeys = new Set<string>();
        if (committedMessageChunksRef.current.sessionId === sessionId) {
          for (const chunk of committedMessageChunksRef.current.chunks) {
            if (chunk.kind !== "default-segment") continue;
            for (const entry of chunk.entries) {
              previousSegmentByEntry.set(entry.entryKey, chunk.segmentKey);
            }
          }
        }

        const flushDefaultRun = () => {
          if (defaultRun.length === 0) {
            return;
          }

          const firstEntry = defaultRun[0];
          // A byte-limited history window can begin inside a page/group.
          // Reuse its committed identity when earlier entries arrive, keeping
          // the visible MessageBlocks and their local state mounted.
          const retainedKey = defaultRun
            .map((entry) => previousSegmentByEntry.get(entry.entryKey))
            .find((key) => key !== undefined && !retainedSegmentKeys.has(key));
          const segmentKey = retainedKey ?? `default:${firstEntry.entryKey}`;
          retainedSegmentKeys.add(segmentKey);
          chunks.push({
            kind: "default-segment",
            segmentKey,
            entries: defaultRun,
          });
          defaultRun = [];
        };

        for (const entry of pagedMessageEntries) {
          if (defaultRun.length > 0 && defaultRun[0].page !== entry.page) {
            flushDefaultRun();
          }
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
      }, [pagedMessageEntries, sessionId]);
      useLayoutEffect(() => {
        committedMessageChunksRef.current = {
          sessionId,
          chunks: pagedMessageChunks,
        };
      }, [pagedMessageChunks, sessionId]);
      const chunksByPage = useMemo(() => {
        const pages = new Map<number, MessageViewportChunk[]>();
        for (const chunk of pagedMessageChunks) {
          const page =
            chunk.kind === "important"
              ? chunk.entry.page
              : chunk.entries[0].page;
          const chunks = pages.get(page) ?? [];
          chunks.push(chunk);
          pages.set(page, chunks);
        }
        return pages;
      }, [pagedMessageChunks]);
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
      const jumpToMessage = useCallback(
        (messageNumber: number) => {
          readingAnchorRef.current = null;
          answerResizeSpaceCleanupRef.current?.();
          const target = Math.max(
            1,
            Math.min(totalMessageCount, messageNumber),
          );
          const page = Math.floor((target - 1) / MESSAGES_PER_PAGE) + 1;
          shouldFollowActiveSearchMatchRef.current = false;
          setAutoScroll(false);
          setCurrentPage(page);
          setMessageJumpTarget(target);
          if (!chunksByPage.has(page)) {
            pageVirtualizer.scrollToIndex(page - 1, { align: "start" });
            programmaticScrollTopRef.current =
              containerRef.current?.scrollTop ?? null;
          }
        },
        [chunksByPage, pageVirtualizer, totalMessageCount],
      );
      const jumpToLatest = useCallback(() => {
        readingAnchorRef.current = null;
        shouldFollowActiveSearchMatchRef.current = false;
        setMessageJumpTarget(null);
        setCurrentPage(totalPages);
        setAutoScroll(true);
        requestAnimationFrame(scrollToBottom);
      }, [scrollToBottom, totalPages]);
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
      useLayoutEffect(() => {
        if (messageJumpTarget === null) return;
        const container = containerRef.current;
        if (!container) return;
        const pageIndex = Math.floor(
          (messageJumpTarget - 1) / MESSAGES_PER_PAGE,
        );
        const target = container.querySelector<HTMLElement>(
          `[data-conversation-message="${messageJumpTarget}"]`,
        );
        if (!target) {
          const entry = pagedMessageEntries.find(
            (entry) => entry.visibleIndex + 1 === messageJumpTarget,
          );
          const segmentKey = entry && pagedEntrySegmentKeys.get(entry.entryKey);
          if (segmentKey) expandDefaultSegmentForSearch(segmentKey);
          return;
        }

        for (const page of container.querySelectorAll<HTMLDivElement>(
          "[data-conversation-page]",
        )) {
          pageVirtualizer.measureElement(page);
        }
        const renderedPage = virtualPages.find(
          (page) => page.index === pageIndex,
        );
        const measuredPage = pageVirtualizer
          .getVirtualItems()
          .find((page) => page.index === pageIndex);
        if (
          !renderedPage ||
          !measuredPage ||
          renderedPage.start !== measuredPage.start ||
          renderedPage.size !== measuredPage.size
        ) {
          return;
        }

        const targetTop =
          container.scrollTop +
          target.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          container.clientTop;
        // Stop at the natural bottom instead of adding space below the final message.
        const maxScrollTop = Math.max(
          0,
          container.scrollHeight - container.clientHeight,
        );
        isScrollingProgrammaticallyRef.current = true;
        pageVirtualizer.scrollToOffset(
          messageJumpTarget >= totalMessageCount
            ? maxScrollTop
            : Math.max(0, Math.min(targetTop, maxScrollTop)),
        );
        programmaticScrollTopRef.current = container.scrollTop;
        setMessageJumpTarget(null);
        requestAnimationFrame(() => {
          isScrollingProgrammaticallyRef.current = false;
        });
      }, [
        messageJumpTarget,
        pagedMessageEntries,
        pagedEntrySegmentKeys,
        collapsedDefaultSegmentKeys,
        expandDefaultSegmentForSearch,
        pageVirtualizer,
        virtualPages,
        totalMessageCount,
      ]);
      const cachedMessagesByNumber = useMemo(
        () =>
          new Map(
            pagedMessageEntries.map((entry) => [
              entry.visibleIndex + 1,
              entry.message,
            ]),
          ),
        [pagedMessageEntries],
      );
      const getHoverMetadata = useCallback(
        (messageNumber: number, blockIndex: number | null) => {
          if (!hoverSettings.enabled) return null;
          const message = cachedMessagesByNumber.get(messageNumber);
          return message
            ? getConversationHoverMetadata(
                message,
                blockIndex,
                toolTimestampMapByCallId,
                hoverSettings,
              )
            : null;
        },
        [cachedMessagesByNumber, toolTimestampMapByCallId, hoverSettings],
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
                  showStepActions: false,
                  stepStates:
                    persistedAiTerminalStepStatesByMessageKey[
                      aiTerminalMessageKey
                    ],
                  onApproveStep: onApproveAiTerminalStep,
                  onRejectStep: onRejectAiTerminalStep,
                }
              : undefined;

          if (entry.pendingUserMessage) {
            const pendingMessage = entry.pendingUserMessage;
            return (
              <div
                key={entry.entryKey}
                data-search-entry={entry.entryKey}
                data-conversation-message={entry.visibleIndex + 1}
                data-message-hover
              >
                <MessageBlock message={message} userTone="pending" />
                {pendingMessage.steered &&
                pendingMessage.status !== "queued" ? (
                  <div className="mt-1 text-right text-[11px] text-zinc-500">
                    {STEERED_MESSAGE_CAPTION}
                  </div>
                ) : null}
                {pendingMessage.status === "queued" &&
                (onForceSendPendingUserMessage ||
                  onCancelPendingUserMessage) ? (
                  <div className="mt-1 flex items-center justify-end gap-2">
                    <span className="text-[11px] text-zinc-500">
                      Queued — sends when the current turn finishes
                    </span>
                    {onForceSendPendingUserMessage ? (
                      <button
                        type="button"
                        disabled={forceSendingPendingId !== null}
                        onClick={() => {
                          setForceSendingPendingId(pendingMessage.pendingId);
                          void onForceSendPendingUserMessage(
                            sessionId,
                            pendingMessage.pendingId,
                          ).finally(() => {
                            setForceSendingPendingId((current) =>
                              current === pendingMessage.pendingId
                                ? null
                                : current,
                            );
                          });
                        }}
                        className="rounded border border-indigo-400/40 bg-indigo-600/20 px-2.5 py-1 text-[11px] text-indigo-200 transition-colors hover:bg-indigo-600/35 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {forceSendingPendingId === pendingMessage.pendingId
                          ? "Sending..."
                          : "Send now"}
                      </button>
                    ) : null}
                    {onCancelPendingUserMessage ? (
                      <button
                        type="button"
                        disabled={
                          forceSendingPendingId === pendingMessage.pendingId
                        }
                        onClick={() =>
                          onCancelPendingUserMessage(
                            sessionId,
                            pendingMessage.pendingId,
                          )
                        }
                        className="rounded border border-zinc-500/50 bg-zinc-800/40 px-2.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-700/50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          }

          const taskCompletion = completedTaskAnswers.get(message);
          return (
            <div
              key={entry.entryKey}
              data-search-entry={entry.entryKey}
              data-conversation-message={entry.visibleIndex + 1}
              data-message-hover
            >
              <MessageBlock
                message={message}
                sessionId={sessionId}
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
                onEditMessage={handleEditMessage}
                pendingUserInputRequests={
                  usesUserInputState ? answerableUserInputRequests : undefined
                }
                selectedUserInputAnswers={
                  usesUserInputState ? selectedUserInputAnswers : undefined
                }
                submittingUserInputRequestIds={
                  usesUserInputState ? submittingUserInputRequestIds : undefined
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
                resolvedUserInputAnswersByItemId={
                  resolvedUserInputAnswersByItemId
                }
                suppressedRequestUserInputResultIds={
                  suppressedRequestUserInputResultIds
                }
              />
              {taskCompletion && (
                <TaskAnswerActions
                  key={`${sessionId}:${taskCompletion.sequence ?? taskCompletion.uuid ?? taskCompletion.turnId}`}
                  sessionId={sessionId}
                  completion={taskCompletion}
                  onFilePathLinkClick={onFilePathLinkClick}
                />
              )}
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
          completedTaskAnswers,
          forceSendingPendingId,
          handleChangeUserInputOtherText,
          handleEditMessage,
          handlePlanAction,
          handleSelectUserInputOption,
          handleSubmitUserInputAnswers,
          latestAiTerminalPlanEntryKey,
          onApproveAiTerminalStep,
          onCancelPendingUserMessage,
          onFilePathLinkClick,
          onForceSendPendingUserMessage,
          onPlanAction,
          onRejectAiTerminalStep,
          answerableUserInputRequests,
          resolvedUserInputAnswersByItemId,
          sessionId,
          selectedUserInputAnswers,
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
        if (!autoScroll) {
          setCurrentPage(firstVisiblePage);
        }
      }, [autoScroll, firstVisiblePage]);

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

        const wasOnLatestPage = autoScroll && currentPage >= previousTotalPages;
        if (totalPages > previousTotalPages && wasOnLatestPage) {
          setCurrentPage(totalPages);
          setAutoScroll(true);
        } else if (currentPage > totalPages) {
          setCurrentPage(totalPages);
        }

        totalPagesRef.current = totalPages;
      }, [autoScroll, currentPage, totalPages]);

      useLayoutEffect(() => {
        if (autoScroll && isLatestPage) {
          // Backfill can change an already mounted page. Measure it before
          // painting instead of waiting for ResizeObserver. Follow the actual
          // tail element while React commits the newly measured offsets.
          for (const page of pagesRef.current?.querySelectorAll<HTMLDivElement>(
            "[data-conversation-page]",
          ) ?? []) {
            pageVirtualizer.resizeItem(
              Number(page.dataset.index),
              page.offsetHeight,
            );
          }
          scrollToBottom();
        }
      }, [
        messages,
        pendingUserMessages,
        pendingUserInputRequests,
        pendingApprovalRequests,
        approvalErrors,
        autoScroll,
        isLatestPage,
        pagesHeight,
        pageVirtualizer,
        virtualPages,
        loading,
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

        if (!chunksByPage.has(activeSearchMatch.page)) {
          setAutoScroll(false);
          setCurrentPage(activeSearchMatch.page);
          pageVirtualizer.scrollToIndex(activeSearchMatch.page - 1, {
            align: "start",
          });
          programmaticScrollTopRef.current =
            containerRef.current?.scrollTop ?? null;
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
        chunksByPage,
        pageVirtualizer,
        pagedEntrySegmentKeys,
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
        collapsedDefaultSegmentKeys,
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

        if (!activeSearchMatch) {
          updateConversationSearchMatchFocus(matchGroups, null);
          return;
        }

        if (shouldFollowActiveSearchMatchRef.current) {
          // A newly mounted neighbor can replace an estimated height. Wait for
          // its measured offsets to paint before centering the search result.
          for (const page of container.querySelectorAll<HTMLDivElement>(
            "[data-conversation-page]",
          )) {
            pageVirtualizer.measureElement(page);
          }
          const renderedPage = virtualPages.find(
            (page) => page.index === activeSearchMatch.page - 1,
          );
          const measuredPage = pageVirtualizer
            .getVirtualItems()
            .find((page) => page.index === activeSearchMatch.page - 1);
          if (
            !renderedPage ||
            !measuredPage ||
            renderedPage.start !== measuredPage.start ||
            renderedPage.size !== measuredPage.size
          ) {
            return;
          }
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
        // Replace the page jump's pending alignment with the match position.
        pageVirtualizer.scrollToOffset(Math.max(targetScrollTop, 0));
        programmaticScrollTopRef.current = container.scrollTop;
        requestAnimationFrame(() => {
          isScrollingProgrammaticallyRef.current = false;
        });
        shouldFollowActiveSearchMatchRef.current = false;
      }, [
        activeSearchMatch,
        pagedMessageChunks,
        collapsedDefaultSegmentKeys,
        pageVirtualizer,
        virtualPages,
      ]);

      const hasSessionShortcut =
        workflowShortcut !== null ||
        terminalShortcut !== null ||
        diffGuideShortcut !== null ||
        originSessionShortcut !== null;

      const stabilizeScrollPosition = useCallback(() => {
        const container = containerRef.current;
        if (!container || answerResizeCleanupRef.current) return;
        if (
          messageJumpTarget !== null ||
          shouldFollowActiveSearchMatchRef.current ||
          isScrollingProgrammaticallyRef.current
        ) {
          return;
        }
        if (autoScrollRef.current) {
          scrollToBottom();
        } else if (readingAnchorRef.current) {
          const previousScrollTop = container.scrollTop;
          restoreConversationScrollAnchor(container, readingAnchorRef.current);
          if (container.scrollTop !== previousScrollTop) {
            programmaticScrollTopRef.current = container.scrollTop;
          }
        }
        readingAnchorRef.current = captureConversationScrollAnchor(container);
      }, [messageJumpTarget, scrollToBottom]);

      // React updates and asynchronous block resizes both preserve the same
      // message and pixel offset; only a reader already at the bottom follows.
      useLayoutEffect(stabilizeScrollPosition);
      useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const observer = new ResizeObserver(stabilizeScrollPosition);
        observer.observe(container);
        if (contentRef.current) observer.observe(contentRef.current);
        for (const page of pagesRef.current?.children ?? []) {
          observer.observe(page);
        }
        return () => observer.disconnect();
      }, [loading, virtualPages, stabilizeScrollPosition]);

      useLayoutEffect(() => {
        const container = containerRef.current;
        const pages = pagesRef.current;
        if (!container || !pages) return;
        const updateMargin = () => {
          setPagesScrollMargin(
            pages.getBoundingClientRect().top -
              container.getBoundingClientRect().top +
              container.scrollTop,
          );
        };
        updateMargin();
        const observer = new ResizeObserver(updateMargin);
        observer.observe(container);
        if (contentRef.current) observer.observe(contentRef.current);
        return () => observer.disconnect();
      }, [loading, hasSessionShortcut, summary]);

      if (loading) {
        return (
          <div className="flex h-full items-center justify-center text-zinc-500">
            Loading...
          </div>
        );
      }

      return (
        <UserInputResizeContainer
          className="relative h-full"
          onResizeStart={handleAnswerResizeStart}
        >
          <div
            ref={containerRef}
            onScrollCapture={handleScroll}
            onWheelCapture={() => {
              if (!answerResizeCleanupRef.current)
                answerResizeSpaceCleanupRef.current?.();
            }}
            onTouchStartCapture={() => {
              if (!answerResizeCleanupRef.current)
                answerResizeSpaceCleanupRef.current?.();
            }}
            data-conversation-scroll
            style={{ overflowAnchor: "none" }}
            className="h-full overflow-y-auto bg-zinc-950"
          >
            {hasSessionShortcut ? (
              <div className="sticky top-0 z-20 px-4 pt-3 md:px-6">
                <div
                  className={`flex items-start justify-between gap-2 ${
                    diffGuideShortcut || originSessionShortcut
                      ? ""
                      : "mx-auto max-w-4xl"
                  }`}
                >
                  <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
                    {originSessionShortcut ? (
                      <button
                        type="button"
                        onClick={originSessionShortcut.onClick}
                        aria-label={originSessionShortcut.label}
                        title={
                          originSessionShortcut.title ??
                          originSessionShortcut.label
                        }
                        className="group inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-cyan-400/25 bg-zinc-900/30 px-3 py-2 text-left shadow-lg shadow-black/10 ring-1 ring-black/10 transition-all hover:-translate-y-0.5 hover:border-cyan-300/40 hover:bg-zinc-900/40 sm:gap-3 sm:px-4"
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 text-cyan-200 sm:h-8 sm:w-8">
                          <svg
                            aria-hidden="true"
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path
                              d="m12 5-7 7 7 7M5 12h14"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                        <span className="min-w-0 truncate text-xs font-medium text-zinc-100 sm:text-sm">
                          {originSessionShortcut.label}
                        </span>
                      </button>
                    ) : null}
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
                  {diffGuideShortcut ? (
                    <button
                      type="button"
                      onClick={diffGuideShortcut.onClick}
                      aria-label={diffGuideShortcut.label}
                      title={diffGuideShortcut.title ?? diffGuideShortcut.label}
                      className="group ml-auto inline-flex min-w-0 max-w-[55%] items-center gap-2 rounded-full border border-violet-400/35 bg-zinc-900/30 px-3 py-2 text-left shadow-lg shadow-black/10 ring-1 ring-black/10 transition-all hover:-translate-y-0.5 hover:border-violet-400/60 hover:bg-zinc-900/40 sm:gap-3 sm:px-4"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-400/15 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-200 sm:h-8 sm:w-8">
                        DF
                      </span>
                      <span className="min-w-0 truncate text-xs font-medium text-zinc-100 sm:text-sm">
                        {diffGuideShortcut.label}
                      </span>
                      <span className="shrink-0 text-sm text-violet-200 transition-transform group-hover:translate-x-0.5">
                        &gt;
                      </span>
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div
              ref={contentRef}
              className={`mx-auto max-w-4xl px-4 pb-12 md:px-6 ${
                hasSessionShortcut ? "pt-3" : "pt-5"
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

              <div
                ref={pagesRef}
                className="relative"
                style={{ height: pagesHeight }}
              >
                {virtualPages.map((virtualPage) => (
                  <div
                    key={virtualPage.key}
                    ref={pageVirtualizer.measureElement}
                    data-index={virtualPage.index}
                    data-conversation-page={virtualPage.index + 1}
                    className="absolute left-0 top-0 w-full flex flex-col gap-3 pb-3"
                    style={{
                      transform: `translateY(${virtualPage.start - pagesScrollMargin}px)`,
                      minHeight: chunksByPage.has(virtualPage.index + 1)
                        ? undefined
                        : virtualPage.size,
                    }}
                  >
                    {(chunksByPage.get(virtualPage.index + 1) ?? []).map(
                      (chunk) => {
                        if (chunk.kind === "important") {
                          return renderMessageEntry(chunk.entry);
                        }

                        const autoForceBlockMode =
                          shouldAutoForceBlockModeForEntries(chunk.entries);
                        const isCollapsedByPreference =
                          Object.prototype.hasOwnProperty.call(
                            collapsedDefaultSegmentKeys,
                            chunk.segmentKey,
                          )
                            ? collapsedDefaultSegmentKeys[chunk.segmentKey] ===
                              true
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
                              entry: PagedMessageEntry & {
                                timestampText: string;
                              };
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
                              onClick={(
                                event: MouseEvent<HTMLButtonElement>,
                              ) => {
                                if (autoForceBlockMode) {
                                  return;
                                }
                                const pointerY =
                                  event.detail === 0 ? null : event.clientY;
                                toggleDefaultSegment(
                                  chunk.segmentKey,
                                  pointerY,
                                );
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
                                    ? "bg-zinc-600 hover:bg-zinc-400"
                                    : "bg-zinc-800 hover:bg-zinc-500"
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
                                  !shouldToggleCollapsedSegmentFromContentClick(
                                    {
                                      isCollapsed,
                                      target: event.target,
                                      currentTarget: event.currentTarget,
                                    },
                                  )
                                ) {
                                  return;
                                }
                                const pointerY =
                                  event.detail === 0 ? null : event.clientY;
                                toggleDefaultSegment(
                                  chunk.segmentKey,
                                  pointerY,
                                );
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
                                          data-conversation-message={
                                            entry.visibleIndex + 1
                                          }
                                          className={`flex min-w-0 items-center gap-2 text-[12px] leading-relaxed ${getCollapsedLineToneClasses(line.tone)}`}
                                          title={line.text}
                                        >
                                          <CollapsedViewportSummary
                                            line={line}
                                          />
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
                                          data-conversation-message={
                                            entry.visibleIndex + 1
                                          }
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
                                    <div
                                      data-conversation-message={
                                        chunk.entries[0].visibleIndex + 1
                                      }
                                      className="text-[11px] leading-relaxed text-zinc-500"
                                    >
                                      All blocks in this group are hidden in
                                      text mode.
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
                      },
                    )}
                  </div>
                ))}
              </div>
              <div ref={pendingUserInputRef}>
                <PendingApprovalRequests
                  requests={pendingApprovalRequests}
                  submittingRequestIds={submittingApprovalRequestIds}
                  errors={approvalErrors}
                  onRespond={submitApprovalResponse}
                />
                <PendingElicitations
                  key={sessionId}
                  sessionId={sessionId}
                  revision={elicitationRevision}
                />
                <PendingUserInputRequests
                  requests={unattachedUserInputRequests}
                  selectedAnswers={selectedUserInputAnswers}
                  submittingRequestIds={submittingUserInputRequestIds}
                  onSelectOption={handleSelectUserInputOption}
                  onChangeOtherText={handleChangeUserInputOtherText}
                  onSubmitAnswers={handleSubmitUserInputAnswers}
                />
                {Object.entries(userInputErrors).map(([requestId, error]) => (
                  <p
                    key={requestId}
                    role="alert"
                    className="mt-2 text-xs text-red-400"
                  >
                    {error}
                  </p>
                ))}
              </div>
            </div>
          </div>

          <ConversationMessageHover
            key={`${sessionId}:${railCollapsedByDefault}`}
            containerRef={containerRef}
            getMetadata={getHoverMetadata}
          />

          {totalMessageCount > 0 && (
            <ConversationPager
              key={sessionId}
              containerRef={containerRef}
              totalMessages={totalMessageCount}
              messagesPerPage={MESSAGES_PER_PAGE}
              onJumpToMessage={jumpToMessage}
            />
          )}

          {!resizingAnswer && (!isLatestPage || !autoScroll) && (
            <ScrollToBottomButton
              direction={isLatestPage ? "down" : "down-right"}
              bottomOffsetPx={latestButtonBottomOffsetPx}
              onClick={jumpToLatest}
            />
          )}
        </UserInputResizeContainer>
      );
    },
  ),
);

export default SessionView;
