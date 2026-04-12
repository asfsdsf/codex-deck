export interface RailScrollDeltaInput {
  railTop: number;
  railBottom: number;
  pointerY?: number | null;
  viewportCenterY?: number | null;
}

const SCROLL_EPSILON_PX = 0.5;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function computeRailScrollDelta(
  input: RailScrollDeltaInput,
): number | null {
  const { railTop, railBottom, pointerY, viewportCenterY } = input;
  if (!isFiniteNumber(railTop) || !isFiniteNumber(railBottom)) {
    return null;
  }
  if (railBottom < railTop) {
    return null;
  }

  const railCenter = (railTop + railBottom) / 2;

  if (isFiniteNumber(pointerY)) {
    if (pointerY >= railTop && pointerY <= railBottom) {
      return null;
    }
    const delta = pointerY - railCenter;
    return Math.abs(delta) < SCROLL_EPSILON_PX ? null : delta;
  }

  if (!isFiniteNumber(viewportCenterY)) {
    return null;
  }

  const fallbackDelta = viewportCenterY - railCenter;
  return Math.abs(fallbackDelta) < SCROLL_EPSILON_PX ? null : fallbackDelta;
}
