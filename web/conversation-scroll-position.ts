export const CONVERSATION_MESSAGE_SELECTOR = "[data-conversation-message]";

/** Message markers are flat and ordered by their vertical position. */
function getTopVisibleMessage(container: HTMLElement): HTMLElement | null {
  const viewport = container.getBoundingClientRect();
  const top = viewport.top + container.clientTop;
  const bottom = top + container.clientHeight;
  const messages = container.querySelectorAll<HTMLElement>(
    CONVERSATION_MESSAGE_SELECTOR,
  );
  let start = 0;
  let end = messages.length;

  // Read only O(log n) rectangles rather than measuring every cached block.
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (messages[middle].getBoundingClientRect().bottom <= top + 0.5) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }

  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    const rect = message.getBoundingClientRect();
    if (rect.top >= bottom) break;
    if (rect.height <= 0) continue;
    const number = Number(message.dataset.conversationMessage);
    if (Number.isInteger(number) && number > 0) return message;
  }
  return null;
}

export function getTopVisibleMessageNumber(
  container: HTMLElement,
): number | null {
  const message = getTopVisibleMessage(container);
  return message ? Number(message.dataset.conversationMessage) : null;
}

export interface ConversationScrollAnchor {
  messageNumber: number;
  offset: number;
}

export function captureConversationScrollAnchor(
  container: HTMLElement,
): ConversationScrollAnchor | null {
  const message = getTopVisibleMessage(container);
  if (!message) return null;
  return {
    messageNumber: Number(message.dataset.conversationMessage),
    offset:
      message.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      container.clientTop,
  };
}

export function restoreConversationScrollAnchor(
  container: HTMLElement,
  anchor: ConversationScrollAnchor,
): void {
  const message = container.querySelector<HTMLElement>(
    `[data-conversation-message="${anchor.messageNumber}"]`,
  );
  if (!message) return;
  const delta =
    message.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    container.clientTop -
    anchor.offset;
  if (Math.abs(delta) > 0.5) container.scrollTop += delta;
}
