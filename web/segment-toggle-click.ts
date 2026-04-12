const INTERACTIVE_CLICK_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
  "[data-segment-toggle-ignore='true']",
].join(", ");

interface SegmentContentToggleInput {
  isCollapsed: boolean;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}

interface ClosestCapable {
  closest: (selector: string) => unknown;
}

interface ParentElementCapable {
  parentElement: unknown;
}

interface ContainsCapable {
  contains: (node: unknown) => boolean;
}

function hasClosest(value: unknown): value is ClosestCapable {
  return (
    value !== null &&
    typeof value === "object" &&
    "closest" in value &&
    typeof (value as { closest?: unknown }).closest === "function"
  );
}

function hasParentElement(value: unknown): value is ParentElementCapable {
  return (
    value !== null && typeof value === "object" && "parentElement" in value
  );
}

function hasContains(value: unknown): value is ContainsCapable {
  return (
    value !== null &&
    typeof value === "object" &&
    "contains" in value &&
    typeof (value as { contains?: unknown }).contains === "function"
  );
}

function getSearchElementFromTarget(
  target: EventTarget | null,
): ClosestCapable | null {
  if (hasClosest(target)) {
    return target;
  }

  if (hasParentElement(target) && hasClosest(target.parentElement)) {
    return target.parentElement;
  }

  return null;
}

function getContainerFromTarget(
  target: EventTarget | null,
): ContainsCapable | null {
  if (hasContains(target)) {
    return target;
  }
  return null;
}

function isInteractiveTargetWithinContainer(
  target: ClosestCapable,
  container: ContainsCapable,
): boolean {
  const interactiveAncestor = target.closest(INTERACTIVE_CLICK_SELECTOR);
  return (
    interactiveAncestor !== null && container.contains(interactiveAncestor)
  );
}

export function shouldToggleCollapsedSegmentFromContentClick(
  input: SegmentContentToggleInput,
): boolean {
  const { isCollapsed, target, currentTarget } = input;
  if (!isCollapsed) {
    return false;
  }

  const targetElement = getSearchElementFromTarget(target);
  const containerElement = getContainerFromTarget(currentTarget);
  if (!targetElement || !containerElement) {
    return true;
  }

  if (isInteractiveTargetWithinContainer(targetElement, containerElement)) {
    return false;
  }

  return true;
}
