import { createDeckPlugin } from "./browser.mjs";
const deck = createDeckPlugin();
function theme(message) {
  if (message.theme)
    document.body.classList.toggle("dark", message.theme === "dark");
}
deck.onEvent(theme);
const initial = await deck.ready;
theme(initial);
async function refresh() {
  const result = document.querySelector("#result");
  try {
    const context = await deck.context();
    const response = await deck.service("codex-deck.diagnostics", "request", {
      path: `/api/codex/warnings${context.threadId ? `?threadId=${encodeURIComponent(context.threadId)}` : ""}`,
    });
    if (response.status !== 200) throw new Error(response.body.error);
    result.textContent = JSON.stringify(response.body, null, 2);
  } catch (error) {
    result.textContent = error.message;
  }
}
document.querySelector("#refresh").addEventListener("click", refresh);
await refresh();
