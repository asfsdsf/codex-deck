import type {
  TranslateTextProgress,
  TranslateTextRequest,
  TranslateTextResponse,
} from "@codex-deck/api";

interface TranslationTransportOptions {
  requestJson: <T>(url: string, init?: RequestInit) => Promise<T>;
  createEventSource?: (url: string) => EventSource;
  onProgress?: (text: string) => void;
}

// Leave room for conversation/global SSE on browsers using HTTP/1.1.
const MAX_CONCURRENT_TRANSLATIONS = 4;
let activeTranslations = 0;
const waitingTranslations: (() => void)[] = [];

/** Local SSE and encrypted remote polling consume the same accumulated output. */
export async function requestTranslation(
  request: TranslateTextRequest,
  options: TranslationTransportOptions,
): Promise<TranslateTextResponse> {
  await new Promise<void>((resolve) => {
    if (activeTranslations < MAX_CONCURRENT_TRANSLATIONS) {
      activeTranslations += 1;
      resolve();
    } else waitingTranslations.push(resolve);
  });
  try {
    return await readTranslation(request, options);
  } finally {
    const next = waitingTranslations.shift();
    if (next) next();
    else activeTranslations -= 1;
  }
}

async function readTranslation(
  request: TranslateTextRequest,
  { requestJson, createEventSource, onProgress }: TranslationTransportOptions,
): Promise<TranslateTextResponse> {
  let progress = await requestJson<
    TranslateTextResponse | TranslateTextProgress
  >("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, stream: !!onProgress }),
  });
  let previous: string | undefined;
  const accept = (next: typeof progress) => {
    progress = next;
    if ("error" in next && next.error) throw new Error(next.error);
    if (next.translatedText && next.translatedText !== previous) {
      previous = next.translatedText;
      onProgress?.(next.translatedText);
    }
    return !("done" in next) || next.done;
  };
  if (accept(progress)) return { translatedText: progress.translatedText };
  const path = `/api/translations/${encodeURIComponent((progress as TranslateTextProgress).translationId)}`;

  if (createEventSource) {
    const completed = await new Promise<boolean>((resolve, reject) => {
      const source = createEventSource(`${path}/stream`);
      source.addEventListener("translation", (event) => {
        try {
          if (accept(JSON.parse((event as MessageEvent).data))) {
            source.close();
            resolve(true);
          }
        } catch (error) {
          source.close();
          reject(error);
        }
      });
      source.onerror = () => {
        source.close();
        resolve(false); // Recover via snapshots if the SSE connection drops.
      };
    });
    if (completed) return { translatedText: progress.translatedText };
  }

  while (true) {
    const next = await requestJson<TranslateTextProgress>(path);
    if (accept(next)) return { translatedText: next.translatedText };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
