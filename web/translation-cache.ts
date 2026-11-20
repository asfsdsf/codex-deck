/**
 * In-memory cache for translated text. Entries survive component unmounts
 * (message paging unmounts MessageBlocks) but are never persisted to
 * cookies/storage, so a page refresh or a new tab loses all translations.
 */

const MAX_CACHE_ENTRIES = 200;

const translationCache = new Map<string, string>();

export type TranslationFormat = "text" | "markdown";

function cacheKey(
  sourceText: string,
  inputLang: string,
  outputLang: string,
  format: TranslationFormat,
): string {
  return `${format}:${inputLang}→${outputLang}:${sourceText}`;
}

export function getCachedTranslation(
  sourceText: string,
  inputLang: string,
  outputLang: string,
  format: TranslationFormat = "text",
): string | undefined {
  return translationCache.get(
    cacheKey(sourceText, inputLang, outputLang, format),
  );
}

export function setCachedTranslation(
  sourceText: string,
  inputLang: string,
  outputLang: string,
  translated: string,
  format: TranslationFormat = "text",
): void {
  const key = cacheKey(sourceText, inputLang, outputLang, format);
  if (translationCache.has(key)) {
    translationCache.delete(key);
  }
  translationCache.set(key, translated);
  while (translationCache.size > MAX_CACHE_ENTRIES) {
    const oldest = translationCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    translationCache.delete(oldest);
  }
}
