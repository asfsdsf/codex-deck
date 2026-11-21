const channel = "codex-deck-plugin";
const pending = new Map();
let nextRequestId = 0;

function request(method, params) {
  const requestId = String(++nextRequestId);
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    parent.postMessage(
      { channel, type: "request", requestId, method, params },
      "*",
    );
  });
}

window.addEventListener("message", async (event) => {
  const message = event.data;
  if (message?.channel !== channel) return;
  if (message.type === "response") {
    const operation = pending.get(message.requestId);
    if (!operation) return;
    pending.delete(message.requestId);
    if (message.error) operation.reject(new Error(message.error));
    else operation.resolve(message.result);
    return;
  }
  if (message.type !== "initialize") return;

  const context = await request("getContext");
  const state = await request("getState");
  const show = (savedState) => {
    document.querySelector("#status").textContent = JSON.stringify({
      context,
      state: savedState,
    });
  };
  show(state);
  if (!state.savedNote) {
    const savedState = await request("setState", {
      state: { savedNote: "Saved plugin note", threadId: context.threadId },
    });
    show(savedState);
  }
});
