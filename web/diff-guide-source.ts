import type { DiffGuideSourceResponse } from "@codex-deck/api";
export interface DiffGuideSourceRequest {
  path: string;
  side: "left" | "right";
  start: number;
  limit: number;
}
export function createDiffGuideSourceBridge({
  getFrameWindow,
  token,
  load,
}: {
  getFrameWindow: () => Window | null;
  token: string;
  load: (input: DiffGuideSourceRequest) => Promise<DiffGuideSourceResponse>;
}) {
  let active = true;
  const pending = new Set<string>();
  const onMessage = (event: MessageEvent) => {
    const frame = getFrameWindow();
    if (!active || !frame || event.source !== frame) return;
    const data = event.data;
    if (
      !data ||
      data.type !== "codex-deck:diff-guide:source" ||
      data.token !== token ||
      typeof data.requestId !== "string" ||
      !data.requestId ||
      data.requestId.length > 128 ||
      pending.has(data.requestId)
    )
      return;
    const respond = (
      payload: { source: DiffGuideSourceResponse } | { error: string },
    ) => {
      if (active && getFrameWindow() === frame)
        frame.postMessage(
          {
            type: "codex-deck:diff-guide:source-result",
            token,
            requestId: data.requestId,
            ...payload,
          },
          "*",
        );
    };
    const { path, side, start, limit } = data;
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 4096 ||
      !["left", "right"].includes(side) ||
      !Number.isSafeInteger(start) ||
      start < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      respond({ error: "Invalid source request" });
      return;
    }
    if (pending.size >= 32) {
      respond({
        error: "Too many pending source requests. Try again shortly.",
      });
      return;
    }
    pending.add(data.requestId);
    void Promise.resolve()
      .then(() => load({ path, side, start, limit }))
      .then((source) => respond({ source }))
      .catch((error: unknown) =>
        respond({
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            1000,
          ),
        }),
      )
      .finally(() => pending.delete(data.requestId));
  };
  return {
    onMessage,
    dispose: () => {
      active = false;
      pending.clear();
    },
  };
}
