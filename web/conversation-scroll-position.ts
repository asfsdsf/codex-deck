export const CONVERSATION_MESSAGE_SELECTOR = "[data-conversation-message]";

/** Message markers are flat and ordered by their vertical position. */
export function getTopVisibleMessageNumber(
  container: HTMLElement,
): number | null {
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
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}
