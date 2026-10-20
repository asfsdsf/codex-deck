import type {
  TranslateTextRequest,
  TranslateTextResponse,
} from "@codex-deck/api";
import {
  getCachedTranslation,
  setCachedTranslation,
} from "./translation-cache";

const REQUEST_TYPE = "codex-deck:diff-guide:translate";
const RESPONSE_TYPE = "codex-deck:diff-guide:translation";
const AUTO_TRANSLATE_TYPE = "codex-deck:diff-guide:auto-translate";
const MAX_TEXT_LENGTH = 200_000;
interface PendingTranslation {
  promise: Promise<string>;
  listeners: Set<(text: string) => void>;
  partial?: string;
}
const pendingTranslations = new Map<string, PendingTranslation>();

type Translate = (
  request: TranslateTextRequest,
  onProgress?: (text: string) => void,
) => Promise<TranslateTextResponse>;

export function setDiffGuideAutoTranslate(
  frame: Window | null,
  token: string,
  enabled: boolean,
): void {
  frame?.postMessage({ type: AUTO_TRANSLATE_TYPE, token, enabled }, "*");
}

export function createDiffGuideFrameToken(): string {
  // getRandomValues is also available when viewing the app over plain LAN HTTP.
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  )
    return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
      value.toString(16).padStart(8, "0"),
    ).join("");
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function translateCached(
  text: string,
  translate: Translate,
  onProgress: (text: string) => void,
): Promise<string> {
  if (!text.trim()) return Promise.resolve(text);
  const cached = getCachedTranslation(text, "en", "zh");
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = pendingTranslations.get(text);
  if (pending) {
    pending.listeners.add(onProgress);
    if (pending.partial !== undefined) onProgress(pending.partial);
    return pending.promise.finally(() => pending.listeners.delete(onProgress));
  }
  const entry: PendingTranslation = {
    promise: Promise.resolve(""),
    listeners: new Set([onProgress]),
  };
  const request = Promise.resolve()
    .then(() =>
      translate({ text, inputLang: "en", outputLang: "zh" }, (partial) => {
        entry.partial = partial;
        for (const listener of entry.listeners) listener(partial);
      }),
    )
    .then(({ translatedText }) => {
      if (typeof translatedText !== "string" || !translatedText.trim())
        throw new Error("Translation returned no text.");
      setCachedTranslation(text, "en", "zh", translatedText);
      return translatedText;
    })
    .finally(() => {
      entry.listeners.clear();
      if (pendingTranslations.get(text) === entry)
        pendingTranslations.delete(text);
    });
  entry.promise = request;
  pendingTranslations.set(text, entry);
  return request;
}

/** The sandboxed guide requests translations through the app's normal transport. */
export function createDiffGuideTranslationBridge({
  getFrameWindow,
  token,
  translate,
}: {
  getFrameWindow: () => Window | null;
  token: string;
  translate: Translate;
}) {
  let active = true;
  const requests = new Set<string>();
  const onMessage = (event: MessageEvent): void => {
    const frame = getFrameWindow();
    if (!active || !frame || event.source !== frame) return;
    const data = event.data;
    if (
      !data ||
      data.type !== REQUEST_TYPE ||
      data.token !== token ||
      typeof data.requestId !== "string" ||
      !data.requestId ||
      data.requestId.length > 128 ||
      !Array.isArray(data.texts) ||
      data.texts.length < 1 ||
      data.texts.length > 2 ||
      !data.texts.every((text: unknown) => typeof text === "string") ||
      requests.has(data.requestId)
    )
      return;

    const { requestId } = data;
    const texts = data.texts as string[];
    let settled = false;
    const respond = (
      result: { texts: string[]; partial?: boolean } | { error: string },
    ) => {
      if (!active || frame !== getFrameWindow()) return;
      // srcdoc has an opaque origin; source-window and token checks bind the channel.
      frame.postMessage(
        { type: RESPONSE_TYPE, token, requestId, ...result },
        "*",
      );
    };
    if (texts.some((text) => text.length > MAX_TEXT_LENGTH)) {
      respond({ error: "Text is too long to translate." });
      return;
    }
    if (requests.size >= 32) {
      respond({ error: "Too many pending translations. Try again shortly." });
      return;
    }
    requests.add(requestId);
    const partials = [...texts];
    void Promise.all(
      texts.map((text, index) =>
        translateCached(text, translate, (partial) => {
          if (settled) return;
          partials[index] = partial;
          respond({ texts: [...partials], partial: true });
        }),
      ),
    )
      .then((translated) => {
        settled = true;
        respond({ texts: translated });
      })
      .catch((error: unknown) => {
        settled = true;
        respond({
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            1000,
          ),
        });
      })
      .finally(() => requests.delete(requestId));
  };
  return {
    onMessage,
    dispose: () => {
      active = false;
      requests.clear();
    },
  };
}
