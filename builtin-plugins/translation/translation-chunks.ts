// Leave room for shell-escaped UTF-8 when translation_command embeds the
// prompt in a command-line argument. Shared by the server and browser.
const MAX_TRANSLATION_CHUNK_LENGTH = 16_000;

type TranslateChunk = (
  text: string,
  onProgress?: (text: string) => void,
) => Promise<string>;

/** Translate a complete source while bounding each backend invocation. */
export async function translateTextInChunks(
  source: string,
  translateChunk: TranslateChunk,
  onProgress?: (text: string) => void,
): Promise<string> {
  if (source.length <= MAX_TRANSLATION_CHUNK_LENGTH || !source.trim()) {
    return translateChunk(source, onProgress);
  }

  let translatedText = "";
  for (const chunk of translationChunks(source)) {
    const text = chunk.trimEnd();
    const separator = chunk.slice(text.length);
    if (text.trim()) {
      const prefix = translatedText;
      const translated = await translateChunk(
        text,
        onProgress ? (partial) => onProgress(prefix + partial) : undefined,
      );
      if (!translated.trim()) throw new Error("Translation is empty.");
      translatedText += separator ? translated.trimEnd() : translated;
    }
    // Translation backends may strip trailing newlines. Preserve the source
    // separators between paragraphs, code blocks, and export sections.
    translatedText += separator;
    onProgress?.(translatedText);
  }
  return translatedText;
}

function* translationChunks(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_TRANSLATION_CHUNK_LENGTH, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const minimum = MAX_TRANSLATION_CHUNK_LENGTH / 2;
      const paragraph = window.lastIndexOf("\n\n");
      const line = window.lastIndexOf("\n");
      const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
      if (paragraph >= minimum) end = start + paragraph + 2;
      else if (line >= minimum) end = start + line + 1;
      else if (space >= minimum) end = start + space + 1;
      // Never split a Unicode surrogate pair or a Windows newline.
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (
        (previous >= 0xd800 &&
          previous <= 0xdbff &&
          next >= 0xdc00 &&
          next <= 0xdfff) ||
        (previous === 13 && next === 10)
      )
        end -= 1;
    }
    yield text.slice(start, end);
    start = end;
  }
}
