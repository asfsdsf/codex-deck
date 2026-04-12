export interface SegmentToggleScrollTargetInput {
  currentScrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  beforeScrollTop: number;
  beforeSegmentTop: number;
  afterSegmentTop: number;
  afterSegmentBottom: number;
}

const SCROLL_VISIBILITY_TOLERANCE_PX = 10;
const MIN_VISIBLE_SEGMENT_PX = 40;
const SCROLL_EPSILON_PX = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getSegmentToggleScrollTarget(
  input: SegmentToggleScrollTargetInput,
): number | null {
  const {
    currentScrollTop,
    clientHeight,
    scrollHeight,
    beforeScrollTop,
    beforeSegmentTop,
    afterSegmentTop,
    afterSegmentBottom,
  } = input;

  if (
    !Number.isFinite(currentScrollTop) ||
    !Number.isFinite(clientHeight) ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(beforeScrollTop) ||
    !Number.isFinite(beforeSegmentTop) ||
    !Number.isFinite(afterSegmentTop) ||
    !Number.isFinite(afterSegmentBottom)
  ) {
    return null;
  }

  if (clientHeight <= 0) {
    return null;
  }

  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const safeCurrentScrollTop = clamp(currentScrollTop, 0, maxScrollTop);
  const viewportTop = safeCurrentScrollTop;
  const viewportBottom = viewportTop + clientHeight;
  const segmentHeight = Math.max(0, afterSegmentBottom - afterSegmentTop);

  if (segmentHeight <= 0) {
    return null;
  }

  const visibleHeight = Math.max(
    0,
    Math.min(afterSegmentBottom, viewportBottom) -
      Math.max(afterSegmentTop, viewportTop),
  );
  const requiredVisibleHeight = Math.min(segmentHeight, MIN_VISIBLE_SEGMENT_PX);

  if (visibleHeight >= requiredVisibleHeight) {
    return null;
  }

  let targetScrollTop: number | null = null;

  if (afterSegmentTop < viewportTop + SCROLL_VISIBILITY_TOLERANCE_PX) {
    targetScrollTop = afterSegmentTop - SCROLL_VISIBILITY_TOLERANCE_PX;
  } else if (
    afterSegmentBottom >
    viewportBottom - SCROLL_VISIBILITY_TOLERANCE_PX
  ) {
    targetScrollTop =
      afterSegmentBottom - clientHeight + SCROLL_VISIBILITY_TOLERANCE_PX;
  }

  if (targetScrollTop === null) {
    const previousOffset = beforeSegmentTop - beforeScrollTop;
    targetScrollTop = afterSegmentTop - previousOffset;
  }

  const clampedTarget = clamp(targetScrollTop, 0, maxScrollTop);
  if (Math.abs(clampedTarget - safeCurrentScrollTop) < SCROLL_EPSILON_PX) {
    return null;
  }

  return clampedTarget;
}
