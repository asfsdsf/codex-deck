import {
  AudioAttachButton,
  AudioAttachmentList,
  VoiceToggleButton,
  useAudioAttachments,
} from "./audio-attachments";
import RunningTurnComposerActions from "./running-turn-composer-actions";
import {
  OutputSchemaChip,
  OutputSchemaPanel,
  OutputSchemaToggleButton,
  type AttachedOutputSchema,
} from "./output-schema-attachment";
import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  type ChangeEvent as ReactChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type DragEvent as ReactDragEvent,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import type { CodexSkillMetadata } from "@codex-deck/api";
import {
  ImagePlus,
  Camera,
  Images,
  X,
  Languages,
  Loader2,
  ArrowUp,
  Square,
} from "lucide-react";
import ComposerPicker, { type ComposerPickerItem } from "./composer-picker";
import {
  subscribeComposerDraftRequests,
  takeComposerDraft,
} from "../composer-draft-requests";
import SlashCommandPalette from "./slash-command-palette";
import SkillSelectorPalette from "./skill-selector-palette";
import { findActiveFileMentionToken } from "../file-mentions";
import {
  findActiveSkillSelectorToken,
  getSkillSelectorSuggestions,
  type SkillSelectorOption,
} from "../skill-selector";
import {
  getSlashPaletteCommands,
  parseSlashCommandInvocation,
  parseSlashCommandQuery,
  type SlashCommandDefinition,
} from "../slash-commands";
import { resolveComposerPrimaryActionState } from "../message-composer-actions";
import { searchSessionFiles, getSessionSkills, translateText } from "../api";
import { detectMobilePhone } from "../detect-mobile-phone";

const FILE_MENTION_LOADING_ITEM_ID = "__loading__";
const FILE_MENTION_EMPTY_ITEM_ID = "__empty__";
const SKILL_SELECTOR_LOADING_ITEM_ID = "__skill-loading__";
const SKILL_SELECTOR_EMPTY_ITEM_ID = "__skill-empty__";
const SKILL_SELECTOR_ERROR_ITEM_ID = "__skill-error__";

interface HistoryNavigationState {
  index: number | null;
  draftBeforeNavigation: string;
}

export interface MessageComposerSubmitPayload {
  text: string;
  images: string[];
  /** Final-answer JSON schema for the turn this message starts. */
  outputSchema?: Record<string, unknown>;
}

interface ComposerImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

interface MessageComposerProps {
  sessionId: string | null;
  draftResetKey?: string;
  history: string[];
  slashCommands: SlashCommandDefinition[];
  isGeneratingForSelectedSession: boolean;
  isSendingLocked: boolean;
  sendingMessage: boolean;
  stoppingTurn: boolean;
  idlePrimaryActionLabel?: string;
  idlePrimaryActionBusy?: boolean;
  idlePrimaryActionBusyLabel?: string;
  allowIdlePrimaryActionWithoutContent?: boolean;
  idlePrimaryActionOnlyWithoutContent?: boolean;
  onIdlePrimaryAction?:
    | ((payload: MessageComposerSubmitPayload) => Promise<boolean>)
    | null;
  messageBoxHeight: number;
  onResizeMessageBoxStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSendMessage: (payload: MessageComposerSubmitPayload) => Promise<boolean>;
  /** Queue for after the running turn (Codex TUI Tab). */
  onQueueMessage?:
    | ((payload: MessageComposerSubmitPayload) => Promise<boolean>)
    | null;
  /** Interrupt the running turn, then send as a new turn. */
  onInterruptAndSend?:
    | ((payload: MessageComposerSubmitPayload) => Promise<boolean>)
    | null;
  onRunSlashCommand: (commandName: string, args: string) => Promise<boolean>;
  onStopConversation: () => Promise<void>;
  /** Offer attaching a final-answer JSON schema to the next turn. */
  allowOutputSchema?: boolean;
  /** Shows audio attachments; a non-null reason disables them. */
  audioInput?: { unavailableReason: string | null };
}

type ComposerSendTrigger = "textarea-enter" | "send-button" | "other";

function createComposerAttachmentId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isImageFile(file: File): boolean {
  return typeof file.type === "string" && file.type.startsWith("image/");
}

function getSkillDisplayName(skill: CodexSkillMetadata): string {
  const displayName = skill.interface?.displayName?.trim();
  return displayName || skill.name;
}

function getSkillDescription(skill: CodexSkillMetadata): string {
  return (
    skill.interface?.shortDescription?.trim() ||
    skill.shortDescription?.trim() ||
    skill.description
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string" && result.trim().length > 0) {
        resolve(result);
        return;
      }
      reject(new Error("Failed to read image data"));
    };
    reader.onerror = () => {
      reject(new Error("Failed to read image data"));
    };
    reader.readAsDataURL(file);
  });
}

function dataTransferHasImage(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }

  if (
    Array.from(dataTransfer.items ?? []).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    )
  ) {
    return true;
  }

  return Array.from(dataTransfer.files ?? []).some(isImageFile);
}

function isFileMentionPlaceholderItem(itemId: string): boolean {
  return (
    itemId === FILE_MENTION_LOADING_ITEM_ID ||
    itemId === FILE_MENTION_EMPTY_ITEM_ID
  );
}

function isSkillSelectorPlaceholderItem(itemId: string): boolean {
  return (
    itemId === SKILL_SELECTOR_LOADING_ITEM_ID ||
    itemId === SKILL_SELECTOR_EMPTY_ITEM_ID ||
    itemId === SKILL_SELECTOR_ERROR_ITEM_ID
  );
}

const MessageComposer = memo(function MessageComposer(
  props: MessageComposerProps,
) {
  const {
    sessionId,
    draftResetKey,
    history,
    slashCommands,
    isGeneratingForSelectedSession,
    isSendingLocked,
    sendingMessage,
    stoppingTurn,
    idlePrimaryActionLabel,
    idlePrimaryActionBusy = false,
    idlePrimaryActionBusyLabel,
    allowIdlePrimaryActionWithoutContent = false,
    idlePrimaryActionOnlyWithoutContent = false,
    onIdlePrimaryAction,
    messageBoxHeight,
    onResizeMessageBoxStart,
    onSendMessage,
    onQueueMessage,
    onInterruptAndSend,
    onRunSlashCommand,
    onStopConversation,
    allowOutputSchema = false,
    audioInput,
  } = props;
  const audio = useAudioAttachments();
  const clearAudioAttachments = audio.clear;
  const composerResetKey = draftResetKey ?? sessionId ?? "";
  const [outputSchema, setOutputSchema] = useState<AttachedOutputSchema | null>(
    null,
  );
  const [outputSchemaEditorOpen, setOutputSchemaEditorOpen] = useState(false);
  useEffect(() => {
    setOutputSchema(null);
    setOutputSchemaEditorOpen(false);
  }, [composerResetKey]);
  const [draft, setDraft] = useState("");
  const [draftTranslation, setDraftTranslation] = useState<{
    status: "idle" | "loading" | "active" | "error";
    original: string | null;
    error: string | null;
  }>({ status: "idle", original: null, error: null });
  const draftTranslationRequestRef = useRef(0);
  const resetDraftTranslation = useCallback(() => {
    draftTranslationRequestRef.current += 1;
    setDraftTranslation({ status: "idle", original: null, error: null });
  }, []);
  const [historyNavigation, setHistoryNavigation] =
    useState<HistoryNavigationState>({
      index: null,
      draftBeforeNavigation: "",
    });
  const [imageAttachments, setImageAttachments] = useState<
    ComposerImageAttachment[]
  >([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isMobilePhone, setIsMobilePhone] = useState(false);
  const [showMobileAttachMenu, setShowMobileAttachMenu] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [slashPaletteDismissed, setSlashPaletteDismissed] = useState(false);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [fileMentionResults, setFileMentionResults] = useState<string[]>([]);
  const [fileMentionSearchLoading, setFileMentionSearchLoading] =
    useState(false);
  const [dismissedFileMentionQuery, setDismissedFileMentionQuery] = useState<
    string | null
  >(null);
  const [selectedFileMentionIndex, setSelectedFileMentionIndex] = useState(0);
  const [skillSelectorOptions, setSkillSelectorOptions] = useState<
    SkillSelectorOption[]
  >([]);
  const [skillSelectorLoading, setSkillSelectorLoading] = useState(false);
  const [skillSelectorError, setSkillSelectorError] = useState<string | null>(
    null,
  );
  const [skillSelectorLoadedSessionId, setSkillSelectorLoadedSessionId] =
    useState<string | null>(null);
  const [dismissedSkillSelectorQuery, setDismissedSkillSelectorQuery] =
    useState<string | null>(null);
  const [selectedSkillSelectorIndex, setSelectedSkillSelectorIndex] =
    useState(0);
  const dragDepthRef = useRef(0);
  const imageAttachmentsRef = useRef<ComposerImageAttachment[]>([]);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const composerActionsRef = useRef<HTMLDivElement | null>(null);

  // The toolbar below the textarea reserves room for the floating action
  // buttons; labeled buttons (Run, Continue, Sending...) are wider than the
  // icon-only Send/Stop, so publish the real width to the composer card.
  useLayoutEffect(() => {
    const actions = composerActionsRef.current;
    const card = actions?.closest<HTMLElement>(".composer-card");
    if (!actions || !card) {
      return;
    }
    const update = () => {
      card.style.setProperty(
        "--composer-actions-width",
        `${actions.offsetWidth}px`,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return () => card.style.removeProperty("--composer-actions-width");
    }
    const observer = new ResizeObserver(update);
    observer.observe(actions);
    return () => {
      observer.disconnect();
      card.style.removeProperty("--composer-actions-width");
    };
  }, []);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const fileMentionSearchRequestIdRef = useRef(0);
  const skillSelectorRequestIdRef = useRef(0);

  const clearImageAttachments = useCallback(() => {
    setImageAttachments((current) => {
      for (const attachment of current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
  }, []);

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  useEffect(() => {
    setDraft("");
    resetDraftTranslation();
    setHistoryNavigation({
      index: null,
      draftBeforeNavigation: "",
    });
    setCursorPosition(0);
    setSlashPaletteDismissed(false);
    setSelectedSlashCommandIndex(0);
    setDismissedFileMentionQuery(null);
    setSelectedFileMentionIndex(0);
    setFileMentionResults([]);
    setFileMentionSearchLoading(false);
    fileMentionSearchRequestIdRef.current += 1;
    setSkillSelectorOptions([]);
    setSkillSelectorLoading(false);
    setSkillSelectorError(null);
    setSkillSelectorLoadedSessionId(null);
    setDismissedSkillSelectorQuery(null);
    setSelectedSkillSelectorIndex(0);
    skillSelectorRequestIdRef.current += 1;
    clearImageAttachments();
    clearAudioAttachments();
    dragDepthRef.current = 0;
    setIsDragActive(false);
    setShowMobileAttachMenu(false);
  }, [
    clearAudioAttachments,
    clearImageAttachments,
    composerResetKey,
    resetDraftTranslation,
  ]);

  useEffect(() => {
    if (!sessionId) return;
    const apply = () => {
      const text = takeComposerDraft(sessionId);
      if (text === null) return;
      resetDraftTranslation();
      setHistoryNavigation({ index: null, draftBeforeNavigation: "" });
      setDraft(text);
      setCursorPosition(text.length);
      requestAnimationFrame(() => {
        const textarea = composerTextareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(text.length, text.length);
      });
    };
    apply();
    return subscribeComposerDraftRequests((requestedSessionId) => {
      if (requestedSessionId === sessionId) apply();
    });
  }, [composerResetKey, resetDraftTranslation, sessionId]);

  useEffect(() => {
    const updateMobilePhoneState = () => {
      setIsMobilePhone(detectMobilePhone());
    };

    updateMobilePhoneState();
    window.addEventListener("resize", updateMobilePhoneState);
    window.addEventListener("orientationchange", updateMobilePhoneState);
    return () => {
      window.removeEventListener("resize", updateMobilePhoneState);
      window.removeEventListener("orientationchange", updateMobilePhoneState);
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const attachment of imageAttachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  const addImageFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter(isImageFile);
    if (imageFiles.length === 0) {
      return;
    }

    const nextAttachments = imageFiles.map((file) => ({
      id: createComposerAttachmentId(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setImageAttachments((current) => [...current, ...nextAttachments]);
  }, []);

  const removeImageAttachment = useCallback((id: string) => {
    setImageAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const handleMobileFileInputChange = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length > 0) {
        addImageFiles(files);
      }
      event.target.value = "";
      setShowMobileAttachMenu(false);
    },
    [addImageFiles],
  );

  const handleOpenCameraPicker = useCallback(() => {
    cameraInputRef.current?.click();
  }, []);

  const handleOpenGalleryPicker = useCallback(() => {
    galleryInputRef.current?.click();
  }, []);

  const handleComposerDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragActive(true);
    },
    [],
  );

  const handleComposerDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleComposerDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!isDragActive) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragActive(false);
      }
    },
    [isDragActive],
  );

  const handleComposerDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(event.dataTransfer) && !isDragActive) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragActive(false);
      addImageFiles(Array.from(event.dataTransfer.files ?? []));
    },
    [addImageFiles, isDragActive],
  );

  const handleComposerPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files ?? []).filter(
        isImageFile,
      );
      if (files.length === 0) {
        return;
      }
      addImageFiles(files);
    },
    [addImageFiles],
  );

  const hasDraftText = draft.trim().length > 0;
  const hasMessageContent =
    hasDraftText ||
    imageAttachments.length > 0 ||
    (!!audioInput && audio.attachments.length > 0);
  const shouldUseStopAction =
    isGeneratingForSelectedSession && !hasMessageContent;
  const steerWhileGenerating =
    isGeneratingForSelectedSession && hasMessageContent;
  const hasIdlePrimaryAction = typeof onIdlePrimaryAction === "function";
  const idlePrimaryActionButtonLabel = idlePrimaryActionLabel || "Send";
  const composerBusy = sendingMessage || idlePrimaryActionBusy;
  const primaryActionState = resolveComposerPrimaryActionState({
    hasMessageContent,
    hasIdlePrimaryAction,
    idlePrimaryActionButtonLabel,
    idlePrimaryActionBusy,
    idlePrimaryActionBusyLabel,
    idlePrimaryActionOnlyWithoutContent,
    allowIdlePrimaryActionWithoutContent,
    sendingMessage,
    shouldUseStopAction,
    stoppingTurn,
    steerWhileGenerating,
  });

  const slashInvocationReady =
    parseSlashCommandInvocation(draft, slashCommands) !== null;
  const primaryButtonLabel = slashInvocationReady
    ? "Run"
    : primaryActionState.label;
  // Send and Stop render as Codex-style round icon buttons; other actions
  // (Run, Init, ...) keep a short text label.
  const primaryButtonIconOnly =
    !slashInvocationReady &&
    (primaryActionState.kind === "stop" ||
      (primaryActionState.kind === "send" && !steerWhileGenerating));
  const showRunningTurnActions =
    steerWhileGenerating &&
    !slashInvocationReady &&
    primaryActionState.kind === "send";

  const normalizedImageFiles = useMemo(
    () => imageAttachments.map((attachment) => attachment.file),
    [imageAttachments],
  );

  const clearAfterSendSuccess = useCallback(() => {
    setDraft("");
    resetDraftTranslation();
    setHistoryNavigation({
      index: null,
      draftBeforeNavigation: "",
    });
    setCursorPosition(0);
    setSlashPaletteDismissed(false);
    setSelectedSlashCommandIndex(0);
    setDismissedFileMentionQuery(null);
    setSelectedFileMentionIndex(0);
    setDismissedSkillSelectorQuery(null);
    setSelectedSkillSelectorIndex(0);
    clearImageAttachments();
    setOutputSchema(null);
    setOutputSchemaEditorOpen(false);
    clearAudioAttachments();
  }, [clearAudioAttachments, clearImageAttachments, resetDraftTranslation]);

  const focusComposerInput = useCallback(() => {
    const applyFocus = () => {
      const textarea = composerTextareaRef.current;
      if (!textarea) {
        return;
      }
      if (textarea.disabled) {
        window.requestAnimationFrame(applyFocus);
        return;
      }
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    };

    window.requestAnimationFrame(applyFocus);
  }, []);

  const handleTranslateDraft = useCallback(() => {
    if (draftTranslation.status === "loading") {
      return;
    }
    if (draftTranslation.status === "active") {
      setDraft(draftTranslation.original ?? "");
      setDraftTranslation({ status: "idle", original: null, error: null });
      focusComposerInput();
      return;
    }
    const source = draft;
    if (!source.trim()) {
      return;
    }
    const requestId = (draftTranslationRequestRef.current += 1);
    setDraftTranslation({ status: "loading", original: null, error: null });
    // Reverse of message-block translation: user language -> LLM language.
    translateText(
      { text: source, inputLang: "zh", outputLang: "en" },
      (text) => {
        if (draftTranslationRequestRef.current === requestId) setDraft(text);
      },
    )
      .then((response) => {
        if (draftTranslationRequestRef.current !== requestId) {
          return;
        }
        setDraft(response.translatedText);
        setDraftTranslation({
          status: "active",
          original: source,
          error: null,
        });
        focusComposerInput();
      })
      .catch((err: unknown) => {
        if (draftTranslationRequestRef.current !== requestId) {
          return;
        }
        setDraft(source);
        setDraftTranslation({
          status: "error",
          original: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [draft, draftTranslation, focusComposerInput]);

  const activeFileMention = useMemo(
    () => findActiveFileMentionToken(draft, cursorPosition),
    [cursorPosition, draft],
  );
  const fileMentionPaletteItems = useMemo<ComposerPickerItem[]>(() => {
    if (!activeFileMention) {
      return [];
    }

    const normalizedQuery = activeFileMention.query
      .trim()
      .replace(/^["']+/, "");
    if (!normalizedQuery) {
      return [
        {
          id: FILE_MENTION_EMPTY_ITEM_ID,
          label: "Type to search files",
          description: "Continue typing after @",
        },
      ];
    }

    if (fileMentionSearchLoading && fileMentionResults.length === 0) {
      return [
        {
          id: FILE_MENTION_LOADING_ITEM_ID,
          label: "Searching files...",
        },
      ];
    }

    if (!fileMentionSearchLoading && fileMentionResults.length === 0) {
      return [
        {
          id: FILE_MENTION_EMPTY_ITEM_ID,
          label: "No matching files",
          description: "Try another path fragment",
        },
      ];
    }

    return fileMentionResults.map((path) => {
      const slashIndex = path.lastIndexOf("/");
      return {
        id: path,
        label: path,
        description: slashIndex > 0 ? path.slice(0, slashIndex) : "file",
      };
    });
  }, [activeFileMention, fileMentionResults, fileMentionSearchLoading]);
  const activeSkillSelector = useMemo(
    () => findActiveSkillSelectorToken(draft, cursorPosition),
    [cursorPosition, draft],
  );
  const filteredSkillSelectorOptions = useMemo<SkillSelectorOption[]>(() => {
    if (!activeSkillSelector) {
      return [];
    }
    return getSkillSelectorSuggestions(
      activeSkillSelector.query,
      skillSelectorOptions,
    );
  }, [activeSkillSelector, skillSelectorOptions]);
  const skillSelectorPlaceholderItems = useMemo<ComposerPickerItem[]>(() => {
    if (!activeSkillSelector) {
      return [];
    }

    if (skillSelectorLoading && skillSelectorOptions.length === 0) {
      return [
        {
          id: SKILL_SELECTOR_LOADING_ITEM_ID,
          label: "Loading skills...",
        },
      ];
    }

    if (skillSelectorError && skillSelectorOptions.length === 0) {
      return [
        {
          id: SKILL_SELECTOR_ERROR_ITEM_ID,
          label: "Skills unavailable",
          description: skillSelectorError,
        },
      ];
    }

    if (filteredSkillSelectorOptions.length === 0) {
      return [
        {
          id: SKILL_SELECTOR_EMPTY_ITEM_ID,
          label: "No matching skills",
          description: "Try another skill name after $",
        },
      ];
    }

    return [];
  }, [
    activeSkillSelector,
    filteredSkillSelectorOptions.length,
    skillSelectorError,
    skillSelectorLoading,
    skillSelectorOptions.length,
  ]);
  const skillSelectorPaletteSize =
    filteredSkillSelectorOptions.length > 0
      ? filteredSkillSelectorOptions.length
      : skillSelectorPlaceholderItems.length;

  const slashQuery = useMemo(() => parseSlashCommandQuery(draft), [draft]);
  const slashPaletteCommands = useMemo(
    () => getSlashPaletteCommands(draft, slashCommands),
    [draft, slashCommands],
  );
  const showFileMentionPalette =
    !!activeFileMention &&
    dismissedFileMentionQuery !== activeFileMention.query;
  const showSkillSelectorPalette =
    !showFileMentionPalette &&
    !!activeSkillSelector &&
    dismissedSkillSelectorQuery !== activeSkillSelector.query;
  const showSlashPalette =
    !showFileMentionPalette &&
    !showSkillSelectorPalette &&
    !!slashQuery &&
    !slashQuery.hasArguments &&
    slashPaletteCommands.length > 0 &&
    !slashPaletteDismissed;

  useEffect(() => {
    if (!activeFileMention) {
      setFileMentionResults([]);
      setFileMentionSearchLoading(false);
      return;
    }
    if (!sessionId) {
      setFileMentionResults([]);
      setFileMentionSearchLoading(false);
      return;
    }

    const query = activeFileMention.query;
    const normalizedQuery = query.trim().replace(/^["']+/, "");
    const requestId = fileMentionSearchRequestIdRef.current + 1;
    fileMentionSearchRequestIdRef.current = requestId;

    if (!normalizedQuery) {
      setFileMentionResults([]);
      setFileMentionSearchLoading(false);
      return;
    }

    setFileMentionSearchLoading(true);
    searchSessionFiles(sessionId, query, 40)
      .then((response) => {
        if (fileMentionSearchRequestIdRef.current !== requestId) {
          return;
        }
        setFileMentionResults(
          Array.isArray(response.files) ? response.files : [],
        );
      })
      .catch(() => {
        if (fileMentionSearchRequestIdRef.current !== requestId) {
          return;
        }
        setFileMentionResults([]);
      })
      .finally(() => {
        if (fileMentionSearchRequestIdRef.current === requestId) {
          setFileMentionSearchLoading(false);
        }
      });
  }, [activeFileMention, sessionId]);

  useEffect(() => {
    if (!showSkillSelectorPalette) {
      return;
    }
    if (!sessionId) {
      setSkillSelectorLoading(false);
      setSkillSelectorError(null);
      setSkillSelectorOptions([]);
      setSkillSelectorLoadedSessionId(null);
      return;
    }
    if (skillSelectorLoadedSessionId === sessionId) {
      return;
    }

    const requestId = skillSelectorRequestIdRef.current + 1;
    skillSelectorRequestIdRef.current = requestId;
    setSkillSelectorLoading(true);
    setSkillSelectorError(null);

    getSessionSkills(sessionId)
      .then((response) => {
        if (skillSelectorRequestIdRef.current !== requestId) {
          return;
        }
        const options = response.skills
          .filter((skill) => skill.enabled)
          .map((skill) => ({
            name: skill.name,
            displayName: getSkillDisplayName(skill),
            description: getSkillDescription(skill),
          }));
        setSkillSelectorOptions(options);
        setSkillSelectorError(response.unavailableReason);
        setSkillSelectorLoadedSessionId(sessionId);
      })
      .catch((error) => {
        if (skillSelectorRequestIdRef.current !== requestId) {
          return;
        }
        setSkillSelectorOptions([]);
        setSkillSelectorError(
          error instanceof Error ? error.message : String(error),
        );
        setSkillSelectorLoadedSessionId(sessionId);
      })
      .finally(() => {
        if (skillSelectorRequestIdRef.current === requestId) {
          setSkillSelectorLoading(false);
        }
      });
  }, [sessionId, showSkillSelectorPalette, skillSelectorLoadedSessionId]);

  useEffect(() => {
    if (!showSlashPalette) {
      setSelectedSlashCommandIndex(0);
      return;
    }

    setSelectedSlashCommandIndex((current) =>
      Math.min(current, slashPaletteCommands.length - 1),
    );
  }, [showSlashPalette, slashPaletteCommands.length]);

  useEffect(() => {
    if (!showFileMentionPalette) {
      setSelectedFileMentionIndex(0);
      return;
    }

    setSelectedFileMentionIndex((current) =>
      Math.min(current, fileMentionPaletteItems.length - 1),
    );
  }, [showFileMentionPalette, fileMentionPaletteItems.length]);

  useEffect(() => {
    if (!showSkillSelectorPalette) {
      setSelectedSkillSelectorIndex(0);
      return;
    }

    setSelectedSkillSelectorIndex((current) =>
      Math.min(current, Math.max(0, skillSelectorPaletteSize - 1)),
    );
  }, [showSkillSelectorPalette, skillSelectorPaletteSize]);

  useEffect(() => {
    if (
      !showSlashPalette &&
      !showFileMentionPalette &&
      !showSkillSelectorPalette
    ) {
      return;
    }

    const handlePointerDownOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (!composerContainerRef.current?.contains(target)) {
        if (showSlashPalette) {
          setSlashPaletteDismissed(true);
        }
        if (showFileMentionPalette && activeFileMention) {
          setDismissedFileMentionQuery(activeFileMention.query);
        }
        if (showSkillSelectorPalette && activeSkillSelector) {
          setDismissedSkillSelectorQuery(activeSkillSelector.query);
        }
      }
    };

    document.addEventListener("mousedown", handlePointerDownOutside);
    document.addEventListener("touchstart", handlePointerDownOutside);
    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside);
      document.removeEventListener("touchstart", handlePointerDownOutside);
    };
  }, [
    activeFileMention,
    activeSkillSelector,
    showFileMentionPalette,
    showSkillSelectorPalette,
    showSlashPalette,
  ]);

  const insertSelectedFileMention = useCallback(
    (path: string) => {
      if (!activeFileMention) {
        return;
      }

      const needsQuotes = path.split("").some((char) => /\s/u.test(char));
      const inserted = needsQuotes && !path.includes('"') ? `"${path}"` : path;
      const nextDraft = `${draft.slice(0, activeFileMention.start)}${inserted} ${draft.slice(activeFileMention.end)}`;
      const nextCursor = activeFileMention.start + inserted.length + 1;
      setDraft(nextDraft);
      if (historyNavigation.index !== null) {
        setHistoryNavigation({
          index: null,
          draftBeforeNavigation: "",
        });
      }
      setCursorPosition(nextCursor);
      setDismissedFileMentionQuery(null);
      setSelectedFileMentionIndex(0);

      window.requestAnimationFrame(() => {
        const textarea = composerTextareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [activeFileMention, draft, historyNavigation.index],
  );

  const insertSelectedSkillSelector = useCallback(
    (skillName: string) => {
      if (!activeSkillSelector) {
        return;
      }

      const inserted = `$${skillName}`;
      const nextDraft = `${draft.slice(0, activeSkillSelector.start)}${inserted} ${draft.slice(activeSkillSelector.end)}`;
      const nextCursor = activeSkillSelector.start + inserted.length + 1;
      setDraft(nextDraft);
      if (historyNavigation.index !== null) {
        setHistoryNavigation({
          index: null,
          draftBeforeNavigation: "",
        });
      }
      setCursorPosition(nextCursor);
      setDismissedSkillSelectorQuery(null);
      setSelectedSkillSelectorIndex(0);

      window.requestAnimationFrame(() => {
        const textarea = composerTextareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [activeSkillSelector, draft, historyNavigation.index],
  );

  const slashCommandBusyRef = useRef(false);
  const executeSlashCommand = useCallback(
    async (
      command: SlashCommandDefinition,
      args: string,
      options?: { fromPalette?: boolean },
    ): Promise<void> => {
      if (command.name === "/mention") {
        const mentionQuery = args.trim();
        const nextDraft = mentionQuery ? `@${mentionQuery}` : "@";
        setDraft(nextDraft);
        setCursorPosition(nextDraft.length);
        setHistoryNavigation({
          index: null,
          draftBeforeNavigation: "",
        });
        setSlashPaletteDismissed(true);
        setSelectedSlashCommandIndex(0);
        setDismissedFileMentionQuery(null);
        setSelectedFileMentionIndex(0);
        setDismissedSkillSelectorQuery(null);
        setSelectedSkillSelectorIndex(0);

        window.requestAnimationFrame(() => {
          const textarea = composerTextareaRef.current;
          if (!textarea) {
            return;
          }
          textarea.focus();
          textarea.setSelectionRange(nextDraft.length, nextDraft.length);
        });
        return;
      }

      if (options?.fromPalette && command.supportsInlineArgs) {
        const nextDraft = `${command.name} `;
        setDraft(nextDraft);
        setCursorPosition(nextDraft.length);
        setHistoryNavigation({
          index: null,
          draftBeforeNavigation: "",
        });
        setSlashPaletteDismissed(true);
        setSelectedSlashCommandIndex(0);
        return;
      }

      if (slashCommandBusyRef.current) return;
      slashCommandBusyRef.current = true;
      try {
        const handled = await onRunSlashCommand(command.name, args);
        if (handled) clearAfterSendSuccess();
      } finally {
        slashCommandBusyRef.current = false;
      }
    },
    [clearAfterSendSuccess, onRunSlashCommand],
  );

  const handleSendMessage = useCallback(
    async (
      trigger: ComposerSendTrigger = "other",
      submit: (
        payload: MessageComposerSubmitPayload,
      ) => Promise<boolean> = onSendMessage,
    ) => {
      const invocation = parseSlashCommandInvocation(draft, slashCommands);
      if (invocation) {
        await executeSlashCommand(invocation.command, invocation.args);
        return;
      }
      if (!hasMessageContent) {
        return;
      }

      let imageDataUrls: string[] = [];
      try {
        imageDataUrls = await Promise.all(
          normalizedImageFiles.map((file) => fileToDataUrl(file)),
        );
      } catch {
        return;
      }

      // Audio rides in `images` as data:audio URLs; the send path maps them
      // to `{ type: "audio" }` inputs.
      const sent = await submit({
        text: draft,
        images: [
          ...imageDataUrls,
          ...(audioInput && !audioInput.unavailableReason
            ? audio.attachments.map((attachment) => attachment.dataUrl)
            : []),
        ],
        ...(allowOutputSchema && outputSchema
          ? { outputSchema: outputSchema.value }
          : {}),
      });
      if (!sent) {
        return;
      }

      clearAfterSendSuccess();
      if (trigger === "textarea-enter" || trigger === "send-button") {
        focusComposerInput();
      }
    },
    [
      allowOutputSchema,
      clearAfterSendSuccess,
      draft,
      focusComposerInput,
      hasMessageContent,
      normalizedImageFiles,
      onSendMessage,
      outputSchema,
      slashCommands,
      executeSlashCommand,
      audioInput,
      audio.attachments,
    ],
  );
  const handleIdlePrimaryAction = useCallback(
    async (trigger: ComposerSendTrigger = "other") => {
      if (!onIdlePrimaryAction) {
        return;
      }

      let imageDataUrls: string[] = [];
      try {
        imageDataUrls = await Promise.all(
          normalizedImageFiles.map((file) => fileToDataUrl(file)),
        );
      } catch {
        return;
      }

      const handled = await onIdlePrimaryAction({
        text: draft,
        images: imageDataUrls,
      });
      if (!handled) {
        return;
      }

      clearAfterSendSuccess();
      if (trigger === "textarea-enter" || trigger === "send-button") {
        focusComposerInput();
      }
    },
    [
      clearAfterSendSuccess,
      draft,
      focusComposerInput,
      normalizedImageFiles,
      onIdlePrimaryAction,
    ],
  );
  const navigateInputHistory = useCallback(
    (direction: "up" | "down") => {
      if (history.length === 0) {
        return;
      }

      if (direction === "up") {
        if (historyNavigation.index === null) {
          const nextDraft = history[history.length - 1];
          setHistoryNavigation({
            index: history.length - 1,
            draftBeforeNavigation: draft,
          });
          setDraft(nextDraft);
          setCursorPosition(nextDraft.length);
          return;
        }

        if (historyNavigation.index > 0) {
          const nextIndex = historyNavigation.index - 1;
          const nextDraft = history[nextIndex];
          setHistoryNavigation((current) => ({
            ...current,
            index: nextIndex,
          }));
          setDraft(nextDraft);
          setCursorPosition(nextDraft.length);
        }
        return;
      }

      if (historyNavigation.index === null) {
        return;
      }

      if (historyNavigation.index < history.length - 1) {
        const nextIndex = historyNavigation.index + 1;
        const nextDraft = history[nextIndex];
        setHistoryNavigation((current) => ({
          ...current,
          index: nextIndex,
        }));
        setDraft(nextDraft);
        setCursorPosition(nextDraft.length);
        return;
      }

      const restoredDraft = historyNavigation.draftBeforeNavigation;
      setHistoryNavigation({
        index: null,
        draftBeforeNavigation: "",
      });
      setDraft(restoredDraft);
      setCursorPosition(restoredDraft.length);
    },
    [draft, history, historyNavigation],
  );

  return (
    <>
      <div
        onPointerDown={onResizeMessageBoxStart}
        className="group flex cursor-ns-resize select-none items-end justify-center touch-action-none pt-1.5"
        title="Drag to resize"
      >
        <div className="composer-resize-bar h-1 w-9 rounded-full bg-zinc-700/60 transition-colors group-hover:bg-zinc-500" />
      </div>
      {draftTranslation.status === "error" && draftTranslation.error && (
        <div className="mx-3 mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200">
          Translation failed: {draftTranslation.error}
        </div>
      )}
      <div>
        <div
          ref={composerContainerRef}
          className="relative"
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
        >
          {imageAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-2">
              {imageAttachments.map((attachment, index) => (
                <div
                  key={attachment.id}
                  className="group relative overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-950"
                >
                  <img
                    src={attachment.previewUrl}
                    alt={`Attached image ${index + 1}`}
                    className="h-20 w-20 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImageAttachment(attachment.id)}
                    disabled={isSendingLocked || composerBusy}
                    className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/85 text-zinc-200 opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-60"
                    title="Remove image"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {allowOutputSchema && outputSchemaEditorOpen ? (
            <OutputSchemaPanel
              key={outputSchema?.text ?? "new"}
              attached={outputSchema}
              onAttach={(schema) => {
                setOutputSchema(schema);
                setOutputSchemaEditorOpen(false);
                focusComposerInput();
              }}
              onRemove={() => {
                setOutputSchema(null);
                setOutputSchemaEditorOpen(false);
              }}
              onClose={() => setOutputSchemaEditorOpen(false)}
            />
          ) : allowOutputSchema && outputSchema ? (
            <OutputSchemaChip
              schema={outputSchema}
              disabled={composerBusy}
              onEdit={() => setOutputSchemaEditorOpen(true)}
              onRemove={() => setOutputSchema(null)}
            />
          ) : null}
          {showRunningTurnActions && (
            <RunningTurnComposerActions
              touch={isMobilePhone}
              disabled={composerBusy || stoppingTurn}
              onQueue={
                onQueueMessage
                  ? () => void handleSendMessage("send-button", onQueueMessage)
                  : null
              }
              onInterruptAndSend={
                onInterruptAndSend
                  ? () =>
                      void handleSendMessage("send-button", onInterruptAndSend)
                  : null
              }
            />
          )}
          {audioInput && (
            <AudioAttachmentList
              attachments={audio.attachments}
              disabled={isSendingLocked || composerBusy}
              onRemove={audio.remove}
            />
          )}
          {audioInput && audio.error && (
            <div role="alert" className="px-4 pt-2 text-xs text-red-300">
              {audio.error}
            </div>
          )}
          {audioInput?.unavailableReason && audio.attachments.length > 0 && (
            <div className="px-4 pt-2 text-xs text-amber-200">
              {audioInput.unavailableReason} Attached audio will not be sent.
            </div>
          )}
          {isDragActive && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[18px] border border-dashed border-cyan-500/70 bg-cyan-600/10 text-xs text-cyan-200">
              <span className="inline-flex items-center gap-1.5">
                <ImagePlus className="h-3.5 w-3.5" />
                Drop images to attach
              </span>
            </div>
          )}
          {showSlashPalette && (
            <SlashCommandPalette
              commands={slashPaletteCommands}
              selectedIndex={selectedSlashCommandIndex}
              onSelect={(command) => {
                void executeSlashCommand(command, "", { fromPalette: true });
              }}
            />
          )}
          {showFileMentionPalette && (
            <ComposerPicker
              ariaLabel="Project files"
              items={fileMentionPaletteItems}
              selectedIndex={selectedFileMentionIndex}
              onSelect={(item) => {
                if (!isFileMentionPlaceholderItem(item.id)) {
                  insertSelectedFileMention(item.id);
                }
              }}
            />
          )}
          {showSkillSelectorPalette &&
            (filteredSkillSelectorOptions.length > 0 ? (
              <SkillSelectorPalette
                skills={filteredSkillSelectorOptions.map((skill) => ({
                  name: skill.name,
                  description: skill.description ?? undefined,
                }))}
                selectedIndex={selectedSkillSelectorIndex}
                onSelect={(skill) => {
                  insertSelectedSkillSelector(skill.name);
                }}
              />
            ) : (
              <ComposerPicker
                ariaLabel="Skills"
                items={skillSelectorPlaceholderItems}
                selectedIndex={selectedSkillSelectorIndex}
                onSelect={(item) => {
                  if (!isSkillSelectorPlaceholderItem(item.id)) {
                    insertSelectedSkillSelector(item.id);
                  }
                }}
              />
            ))}
          <textarea
            ref={composerTextareaRef}
            value={draft}
            onChange={(event) => {
              const nextDraft = event.target.value;
              if (draftTranslation.status !== "idle") {
                // Editing the draft invalidates any translated/restored text.
                resetDraftTranslation();
              }
              if (historyNavigation.index !== null) {
                setHistoryNavigation({
                  index: null,
                  draftBeforeNavigation: "",
                });
              }
              if (slashPaletteDismissed && nextDraft !== draft) {
                setSlashPaletteDismissed(false);
              }
              if (dismissedFileMentionQuery !== null && nextDraft !== draft) {
                setDismissedFileMentionQuery(null);
              }
              if (dismissedSkillSelectorQuery !== null && nextDraft !== draft) {
                setDismissedSkillSelectorQuery(null);
              }
              setDraft(nextDraft);
              setCursorPosition(
                event.target.selectionStart ?? nextDraft.length,
              );
            }}
            onSelect={(event) => {
              setCursorPosition(
                event.currentTarget.selectionStart ??
                  event.currentTarget.value.length,
              );
            }}
            onKeyUp={(event) => {
              setCursorPosition(
                event.currentTarget.selectionStart ??
                  event.currentTarget.value.length,
              );
            }}
            disabled={composerBusy}
            onKeyDown={(event) => {
              if (showFileMentionPalette) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (activeFileMention) {
                    setDismissedFileMentionQuery(activeFileMention.query);
                  }
                  return;
                }

                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedFileMentionIndex((current) =>
                    current >= fileMentionPaletteItems.length - 1
                      ? 0
                      : current + 1,
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedFileMentionIndex((current) =>
                    current <= 0
                      ? fileMentionPaletteItems.length - 1
                      : current - 1,
                  );
                  return;
                }

                if (
                  (event.key === "Enter" || event.key === "Tab") &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  const selectedPath =
                    fileMentionPaletteItems[selectedFileMentionIndex]?.id ??
                    fileMentionPaletteItems[0]?.id;
                  if (!selectedPath) {
                    event.preventDefault();
                    return;
                  }
                  if (isFileMentionPlaceholderItem(selectedPath)) {
                    event.preventDefault();
                    return;
                  }
                  if (selectedPath) {
                    event.preventDefault();
                    insertSelectedFileMention(selectedPath);
                    return;
                  }
                }
              }

              if (showSkillSelectorPalette) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (activeSkillSelector) {
                    setDismissedSkillSelectorQuery(activeSkillSelector.query);
                  }
                  return;
                }

                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedSkillSelectorIndex((current) =>
                    current >= skillSelectorPaletteSize - 1 ? 0 : current + 1,
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedSkillSelectorIndex((current) =>
                    current <= 0 ? skillSelectorPaletteSize - 1 : current - 1,
                  );
                  return;
                }

                if (
                  (event.key === "Enter" || event.key === "Tab") &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  const selectedSkill =
                    filteredSkillSelectorOptions[selectedSkillSelectorIndex]
                      ?.name ?? filteredSkillSelectorOptions[0]?.name;
                  if (selectedSkill) {
                    event.preventDefault();
                    insertSelectedSkillSelector(selectedSkill);
                    return;
                  }

                  const selectedPlaceholderId =
                    skillSelectorPlaceholderItems[selectedSkillSelectorIndex]
                      ?.id ?? skillSelectorPlaceholderItems[0]?.id;
                  if (
                    selectedPlaceholderId &&
                    isSkillSelectorPlaceholderItem(selectedPlaceholderId)
                  ) {
                    event.preventDefault();
                    return;
                  }
                }
              }

              if (showSlashPalette) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashPaletteDismissed(true);
                  return;
                }

                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedSlashCommandIndex((current) =>
                    current >= slashPaletteCommands.length - 1
                      ? 0
                      : current + 1,
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedSlashCommandIndex((current) =>
                    current <= 0
                      ? slashPaletteCommands.length - 1
                      : current - 1,
                  );
                  return;
                }

                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  const selectedCommand =
                    slashPaletteCommands[selectedSlashCommandIndex] ??
                    slashPaletteCommands[0];
                  if (selectedCommand) {
                    event.preventDefault();
                    void executeSlashCommand(selectedCommand, "", {
                      fromPalette: true,
                    });
                    return;
                  }
                }
              }

              const selectionStart = event.currentTarget.selectionStart;
              const selectionEnd = event.currentTarget.selectionEnd;
              const hasSelection = selectionStart !== selectionEnd;

              if (event.key === "ArrowUp" && !hasSelection) {
                const isOnFirstLine = !event.currentTarget.value
                  .slice(0, selectionStart)
                  .includes("\n");
                if (isOnFirstLine) {
                  event.preventDefault();
                  navigateInputHistory("up");
                  return;
                }
              }

              if (event.key === "ArrowDown" && !hasSelection) {
                const isOnLastLine = !event.currentTarget.value
                  .slice(selectionStart)
                  .includes("\n");
                if (isOnLastLine) {
                  event.preventDefault();
                  navigateInputHistory("down");
                  return;
                }
              }

              if (
                event.key === "Tab" &&
                !event.shiftKey &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.nativeEvent.isComposing &&
                showRunningTurnActions &&
                onQueueMessage
              ) {
                // Codex TUI: Tab queues the draft while a task runs.
                event.preventDefault();
                void handleSendMessage("textarea-enter", onQueueMessage);
                return;
              }

              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                const invocation = parseSlashCommandInvocation(
                  draft,
                  slashCommands,
                );
                if (invocation) {
                  void executeSlashCommand(invocation.command, invocation.args);
                  return;
                }
                if (primaryActionState.kind === "idle") {
                  void handleIdlePrimaryAction("textarea-enter");
                  return;
                }
                void handleSendMessage("textarea-enter");
              }
            }}
            onPaste={handleComposerPaste}
            placeholder="Ask Codex anything..."
            rows={2}
            style={{ height: `${messageBoxHeight}px` }}
            className="block w-full min-h-[36px] resize-none border-0 bg-transparent px-4 pt-1.5 pb-1 text-[14px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
        </div>
        <div
          ref={composerActionsRef}
          className="composer-actions absolute bottom-2 right-2 z-10 flex items-center gap-1"
        >
          {audioInput && (
            <VoiceToggleButton
              onToggle={() => void onRunSlashCommand("/voice", "")}
            />
          )}
          {audioInput && !audioInput.unavailableReason && (
            <AudioAttachButton
              disabled={isSendingLocked || composerBusy}
              onAdd={(entries) => void audio.addBlobs(entries)}
              onError={audio.setError}
            />
          )}
          <div className="relative flex">
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleMobileFileInputChange}
              className="hidden"
            />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleMobileFileInputChange}
              className="hidden"
            />
            {isMobilePhone && showMobileAttachMenu && (
              <div className="absolute bottom-10 right-0 z-30 min-w-[9rem] rounded-xl border border-zinc-700/70 bg-zinc-900 p-1.5 shadow-xl">
                <button
                  type="button"
                  onClick={handleOpenCameraPicker}
                  disabled={isSendingLocked || composerBusy}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  <Camera className="h-3.5 w-3.5" />
                  Camera
                </button>
                <button
                  type="button"
                  onClick={handleOpenGalleryPicker}
                  disabled={isSendingLocked || composerBusy}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  <Images className="h-3.5 w-3.5" />
                  Photos
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                if (isMobilePhone) {
                  setShowMobileAttachMenu((value) => !value);
                  return;
                }
                handleOpenGalleryPicker();
              }}
              disabled={isSendingLocked || composerBusy}
              className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
              title="Attach image"
              aria-label="Attach image"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="h-[18px] w-[18px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <circle cx="9" cy="10" r="1.6" />
                <path d="M5.5 17.5l4.6-4.8a1 1 0 011.46.02l2.3 2.45a1 1 0 001.45.03l1.6-1.6a1 1 0 011.41 0l2.2 2.2" />
              </svg>
            </button>
          </div>
          {allowOutputSchema ? (
            <OutputSchemaToggleButton
              attached={!!outputSchema}
              open={outputSchemaEditorOpen}
              disabled={isSendingLocked || composerBusy}
              onClick={() => setOutputSchemaEditorOpen((open) => !open)}
            />
          ) : null}
          <button
            type="button"
            onClick={handleTranslateDraft}
            disabled={
              isSendingLocked ||
              composerBusy ||
              draftTranslation.status === "loading" ||
              (!hasDraftText && draftTranslation.status !== "active")
            }
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            title={
              draftTranslation.status === "active"
                ? "Show original"
                : draftTranslation.status === "error"
                  ? (draftTranslation.error ?? "Translation failed")
                  : "Translate to English"
            }
            aria-label={
              draftTranslation.status === "active"
                ? "Show original"
                : "Translate to English"
            }
            aria-pressed={draftTranslation.status === "active"}
          >
            {draftTranslation.status === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Languages
                className={`h-4 w-4 ${
                  draftTranslation.status === "active"
                    ? "text-cyan-300"
                    : draftTranslation.status === "error"
                      ? "text-rose-400"
                      : ""
                }`}
              />
            )}
          </button>
          <button
            onMouseDown={(event) => {
              if (event.button === 0) {
                event.preventDefault();
              }
            }}
            onClick={() => {
              const invocation = parseSlashCommandInvocation(
                draft,
                slashCommands,
              );
              if (invocation) {
                void executeSlashCommand(invocation.command, invocation.args);
                return;
              }
              if (primaryActionState.kind === "stop") {
                void onStopConversation();
                return;
              }
              if (primaryActionState.kind === "idle") {
                void handleIdlePrimaryAction("send-button");
                return;
              }
              void handleSendMessage("send-button");
            }}
            disabled={
              composerBusy ||
              (primaryActionState.disabled &&
                !parseSlashCommandInvocation(draft, slashCommands))
            }
            title={primaryButtonLabel}
            aria-label={primaryButtonLabel}
            className={`ml-0.5 flex h-8 items-center justify-center rounded-full text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer ${
              primaryButtonIconOnly ? "w-8" : "px-3.5"
            } ${
              isGeneratingForSelectedSession && !shouldUseStopAction
                ? "bg-zinc-700 text-zinc-100 hover:bg-zinc-600"
                : "bg-zinc-100 text-zinc-950 hover:bg-zinc-300"
            }`}
          >
            {primaryButtonIconOnly ? (
              primaryActionState.kind === "stop" ? (
                stoppingTurn ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-3 w-3 fill-current" />
                )
              ) : sendingMessage ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.25} />
              )
            ) : (
              primaryButtonLabel
            )}
          </button>
        </div>
      </div>
    </>
  );
});

export default MessageComposer;
