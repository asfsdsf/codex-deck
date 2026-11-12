import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { getTopVisibleMessageNumber } from "../conversation-scroll-position";

export interface ConversationNavigationItem {
  messageNumber: number;
  preview: string;
}

const MARK_SPACING = 12;

export default function ConversationNavigator({
  containerRef,
  items,
  onNavigate,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  items: readonly ConversationNavigationItem[];
  onNavigate: (messageNumber: number) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pointerInsideRef = useRef(false);
  const pendingFocusRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const [topMessage, setTopMessage] = useState(1);
  const [previewMessage, setPreviewMessage] = useState<number | null>(null);
  const [focusedMessage, setFocusedMessage] = useState<number | null>(null);
  const previewId = useId();
  const itemIndexes = useMemo(
    () => new Map(items.map((item, index) => [item.messageNumber, index])),
    [items],
  );
  const previewIndex =
    previewMessage === null ? undefined : itemIndexes.get(previewMessage);
  const focusedIndex =
    focusedMessage === null ? undefined : itemIndexes.get(focusedMessage);

  const updatePosition = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const container = containerRef.current;
      const number = container && getTopVisibleMessageNumber(container);
      if (number) setTopMessage(number);
    });
  }, [containerRef]);

  // Page measurements, collapsed blocks, and streamed messages can move anchors.
  useLayoutEffect(updatePosition);
  useEffect(() => {
    const container = containerRef.current;
    container?.addEventListener("scroll", updatePosition, { passive: true });
    const observer = new ResizeObserver(updatePosition);
    if (container) observer.observe(container);
    return () => {
      observer.disconnect();
      container?.removeEventListener("scroll", updatePosition);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [containerRef, updatePosition]);

  const activeIndex = useMemo(() => {
    let start = 0;
    let end = items.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (items[middle].messageNumber <= topMessage) start = middle + 1;
      else end = middle;
    }
    return Math.max(0, start - 1);
  }, [items, topMessage]);

  const tabIndex = focusedIndex ?? activeIndex;
  const getItemKey = useCallback(
    (index: number) => items[index].messageNumber,
    [items],
  );
  const extractRange = useCallback<typeof defaultRangeExtractor>(
    (range) => {
      const indexes = defaultRangeExtractor(range);
      // Keep the keyboard entry point mounted while browsing the rail.
      if (tabIndex < range.count && !indexes.includes(tabIndex)) {
        indexes.push(tabIndex);
        indexes.sort((left, right) => left - right);
      }
      return indexes;
    },
    [tabIndex],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLButtonElement>({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    getItemKey,
    estimateSize: () => MARK_SPACING,
    overscan: 3,
    rangeExtractor: extractRange,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const railHeight = virtualizer.scrollRect?.height ?? 0;
  const railOffset = virtualizer.scrollOffset ?? 0;

  useLayoutEffect(() => {
    if (railHeight && !pointerInsideRef.current && focusedIndex === undefined) {
      virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    }
  }, [activeIndex, items.length, railHeight, focusedIndex, virtualizer]);

  useLayoutEffect(() => {
    const messageNumber = pendingFocusRef.current;
    if (messageNumber === null) return;
    const button = scrollerRef.current?.querySelector<HTMLButtonElement>(
      `[data-navigator-message="${messageNumber}"]`,
    );
    if (button) {
      pendingFocusRef.current = null;
      button.focus({ preventScroll: true });
    }
  }, [focusedIndex, virtualItems]);

  if (items.length < 2) return null;
  const preview = previewIndex === undefined ? undefined : items[previewIndex];
  const previewMark = virtualItems.find((item) => item.index === previewIndex);

  return (
    <nav
      className="conversation-navigator"
      aria-label="User message navigation"
      onPointerEnter={() => (pointerInsideRef.current = true)}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
        setPreviewMessage(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setPreviewMessage(null);
          return;
        }
        const index = focusedIndex ?? activeIndex;
        const target = {
          ArrowUp: index - 1,
          ArrowDown: index + 1,
          Home: 0,
          End: items.length - 1,
        }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        const next = Math.max(0, Math.min(items.length - 1, target));
        const messageNumber = items[next].messageNumber;
        pendingFocusRef.current = messageNumber;
        setFocusedMessage(messageNumber);
        setPreviewMessage(messageNumber);
        virtualizer.scrollToIndex(next, { align: "auto" });
      }}
    >
      <div className="conversation-navigator-frame">
        <div
          ref={scrollerRef}
          className="conversation-navigator-scroll"
          onScroll={() => {
            if (focusedIndex === undefined) setPreviewMessage(null);
          }}
        >
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map(({ index, key, start }) => (
              <button
                key={key}
                type="button"
                className="conversation-navigator-mark"
                style={{ transform: `translateY(${start}px)` }}
                data-navigator-message={items[index].messageNumber}
                aria-label={`Jump to user message ${index + 1}`}
                aria-current={index === activeIndex ? "true" : undefined}
                aria-describedby={
                  index === previewIndex ? previewId : undefined
                }
                tabIndex={index === tabIndex ? 0 : -1}
                onPointerMove={() =>
                  setPreviewMessage(items[index].messageNumber)
                }
                onFocus={(event) => {
                  setFocusedMessage(items[index].messageNumber);
                  if (event.currentTarget.matches(":focus-visible")) {
                    setPreviewMessage(items[index].messageNumber);
                  }
                }}
                onBlur={() => {
                  setFocusedMessage(null);
                  setPreviewMessage(null);
                }}
                onClick={() => onNavigate(items[index].messageNumber)}
              />
            ))}
          </div>
        </div>
        {preview && previewMark && (
          <div
            id={previewId}
            role="tooltip"
            className="conversation-navigator-preview"
            style={{
              top: Math.max(
                0,
                Math.min(
                  railHeight - 112,
                  previewMark.start + MARK_SPACING / 2 - railOffset - 56,
                ),
              ),
            }}
          >
            <div className="mb-1 text-xs font-medium text-zinc-100">
              User message {previewIndex! + 1}
            </div>
            <p className="line-clamp-3 text-xs leading-relaxed text-zinc-400">
              {preview.preview}
            </p>
          </div>
        )}
      </div>
    </nav>
  );
}
