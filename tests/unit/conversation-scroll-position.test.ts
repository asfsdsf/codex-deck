import test from "node:test";
import assert from "node:assert/strict";
import {
  captureConversationScrollAnchor,
  getTopVisibleMessageNumber,
  restoreConversationScrollAnchor,
} from "../../web/conversation-scroll-position";

function viewport(
  messages: { number: number; top: number; bottom: number }[],
  top = 100,
  height = 300,
  onMeasure = () => {},
): HTMLElement {
  return {
    clientTop: 0,
    clientHeight: height,
    getBoundingClientRect: () => ({ top }),
    querySelectorAll: () =>
      messages.map((message) => ({
        dataset: { conversationMessage: String(message.number) },
        getBoundingClientRect: () => {
          onMeasure();
          return { ...message, height: message.bottom - message.top };
        },
      })),
  } as unknown as HTMLElement;
}

test("the position counter includes the partly clipped topmost message", () => {
  assert.equal(
    getTopVisibleMessageNumber(
      viewport([
        { number: 341, top: 0, bottom: 70 },
        { number: 342, top: 80, bottom: 180 },
        { number: 343, top: 190, bottom: 270 },
      ]),
    ),
    342,
  );
});

test("a message that ends at the viewport edge is excluded, including gaps and empty blocks", () => {
  assert.equal(
    getTopVisibleMessageNumber(
      viewport([
        { number: 441, top: 20, bottom: 100 },
        { number: 442, top: 110, bottom: 110 },
        { number: 443, top: 130, bottom: 200 },
      ]),
    ),
    443,
  );
});

test("a tall message remains current until its bottom leaves the viewport", () => {
  assert.equal(
    getTopVisibleMessageNumber(
      viewport([
        { number: 342, top: -3000, bottom: 5000 },
        { number: 343, top: 5010, bottom: 5100 },
      ]),
    ),
    342,
  );
});

test("empty viewports do not report offscreen cached messages", () => {
  assert.equal(getTopVisibleMessageNumber(viewport([])), null);
  assert.equal(
    getTopVisibleMessageNumber(
      viewport([
        { number: 342, top: 0, bottom: 50 },
        { number: 343, top: 450, bottom: 500 },
      ]),
    ),
    null,
  );
});

test("finding the topmost block avoids measuring the entire rendered cache", () => {
  let measurements = 0;
  const container = viewport(
    Array.from({ length: 1000 }, (_, index) => ({
      number: index + 1,
      top: index * 40,
      bottom: index * 40 + 30,
    })),
    20005,
    300,
    () => {
      measurements += 1;
    },
  );
  assert.equal(getTopVisibleMessageNumber(container), 501);
  assert.ok(measurements < 20);
});

test("a reading anchor preserves a clipped message when earlier content grows or shrinks", () => {
  let messageTop = 280;
  const container = {
    scrollTop: 200,
    clientTop: 2,
    clientHeight: 300,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [message],
    querySelector: () => message,
  } as unknown as HTMLElement;
  const message = {
    dataset: { conversationMessage: "342" },
    getBoundingClientRect: () => ({
      top: messageTop - container.scrollTop,
      bottom: messageTop - container.scrollTop + 150,
      height: 150,
    }),
  };
  const anchor = captureConversationScrollAnchor(container)!;
  assert.deepEqual(anchor, { messageNumber: 342, offset: -22 });

  messageTop += 240;
  restoreConversationScrollAnchor(container, anchor);
  assert.equal(container.scrollTop, 440);
  assert.deepEqual(captureConversationScrollAnchor(container), anchor);

  messageTop -= 120;
  restoreConversationScrollAnchor(container, anchor);
  assert.equal(container.scrollTop, 320);
  assert.deepEqual(captureConversationScrollAnchor(container), anchor);

  // Appending or resizing below the anchor doesn't move the viewport.
  restoreConversationScrollAnchor(container, anchor);
  assert.equal(container.scrollTop, 320);
});

test("an anchor whose message was removed leaves the scroll position alone", () => {
  const container = {
    scrollTop: 200,
    querySelector: () => null,
  } as unknown as HTMLElement;
  restoreConversationScrollAnchor(container, {
    messageNumber: 342,
    offset: -22,
  });
  assert.equal(container.scrollTop, 200);
  assert.equal(captureConversationScrollAnchor(viewport([])), null);
});
