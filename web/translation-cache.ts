/**
 * In-memory cache for translated text. Entries survive component unmounts
 * (message paging unmounts MessageBlocks) but are never persisted to
 * cookies/storage, so a page refresh or a new tab loses all translations.
 */

const MAX_CACHE_ENTRIES = 200;

const translationCache = new Map<string, string>();

function cacheKey(
  sourceText: string,
  inputLang: string,
  outputLang: string,
): string {
  return `${inputLang}→${outputLang}:${sourceText}`;
}

export function getCachedTranslation(
  sourceText: string,
  inputLang: string,
  outputLang: string,
): string | undefined {
  return translationCache.get(cacheKey(sourceText, inputLang, outputLang));
}

export function setCachedTranslation(
  sourceText: string,
  inputLang: string,
  outputLang: string,
  translated: string,
): void {
  const key = cacheKey(sourceText, inputLang, outputLang);
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
