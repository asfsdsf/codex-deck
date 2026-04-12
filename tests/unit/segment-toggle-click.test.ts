import test from "node:test";
import assert from "node:assert/strict";
import { shouldToggleCollapsedSegmentFromContentClick } from "../../web/segment-toggle-click";

class FakeElement {
  parentElement: FakeElement | null;
  interactive: boolean;

  constructor(options?: {
    parentElement?: FakeElement | null;
    interactive?: boolean;
  }) {
    this.parentElement = options?.parentElement ?? null;
    this.interactive = options?.interactive ?? false;
  }

  closest(): FakeElement | null {
    let current: FakeElement | null = this;
    while (current) {
      if (current.interactive) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  contains(node: unknown): boolean {
    if (!(node instanceof FakeElement)) {
      return false;
    }

    let current: FakeElement | null = node;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parentElement;
    }

    return false;
  }
}

test("returns true for non-interactive content clicks when collapsed", () => {
  const container = new FakeElement();
  const child = new FakeElement({ parentElement: container });

  const shouldToggle = shouldToggleCollapsedSegmentFromContentClick({
    isCollapsed: true,
    target: child as unknown as EventTarget,
    currentTarget: container as unknown as EventTarget,
  });

  assert.equal(shouldToggle, true);
});

test("returns false when segment is expanded", () => {
  const container = new FakeElement();
  const child = new FakeElement({ parentElement: container });

  const shouldToggle = shouldToggleCollapsedSegmentFromContentClick({
    isCollapsed: false,
    target: child as unknown as EventTarget,
    currentTarget: container as unknown as EventTarget,
  });

  assert.equal(shouldToggle, false);
});

test("returns false when click originates from an interactive descendant", () => {
  const container = new FakeElement();
  const button = new FakeElement({
    parentElement: container,
    interactive: true,
  });

  const shouldToggle = shouldToggleCollapsedSegmentFromContentClick({
    isCollapsed: true,
    target: button as unknown as EventTarget,
    currentTarget: container as unknown as EventTarget,
  });

  assert.equal(shouldToggle, false);
});

test("uses parentElement when target itself has no closest method", () => {
  const container = new FakeElement();
  const link = new FakeElement({
    parentElement: container,
    interactive: true,
  });
  const textNodeLike = {
    parentElement: link,
  };

  const shouldToggle = shouldToggleCollapsedSegmentFromContentClick({
    isCollapsed: true,
    target: textNodeLike as unknown as EventTarget,
    currentTarget: container as unknown as EventTarget,
  });

  assert.equal(shouldToggle, false);
});
