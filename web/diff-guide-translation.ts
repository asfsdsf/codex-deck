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
const MAX_TEXT_LENGTH = 200_000;
const pendingTranslations = new Map<string, Promise<string>>();

type Translate = (
  request: TranslateTextRequest,
) => Promise<TranslateTextResponse>;

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

function translateCached(text: string, translate: Translate): Promise<string> {
  if (!text.trim()) return Promise.resolve(text);
  const cached = getCachedTranslation(text, "en", "zh");
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = pendingTranslations.get(text);
  if (pending) return pending;
  const request = Promise.resolve()
    .then(() => translate({ text, inputLang: "en", outputLang: "zh" }))
    .then(({ translatedText }) => {
      if (typeof translatedText !== "string" || !translatedText.trim())
        throw new Error("Translation returned no text.");
      setCachedTranslation(text, "en", "zh", translatedText);
      return translatedText;
    })
    .finally(() => {
      if (pendingTranslations.get(text) === request)
        pendingTranslations.delete(text);
    });
  pendingTranslations.set(text, request);
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
    const respond = (result: { texts: string[] } | { error: string }) => {
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
    void Promise.all(texts.map((text) => translateCached(text, translate)))
      .then((translated) => respond({ texts: translated }))
      .catch((error: unknown) =>
        respond({
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            1000,
          ),
        }),
      )
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
