import { useCallback, useState } from "react";
import { translateText } from "../api";
import {
  getCachedTranslation,
  setCachedTranslation,
} from "../translation-cache";

export type BlockTranslationStatus = "idle" | "loading" | "ready" | "error";

export interface BlockTranslationState {
  status: BlockTranslationStatus;
  /** Translated text once fetched; kept in component state + module cache. */
  translated: string | null;
  error: string | null;
  /** Whether the translated text (vs. the original) is currently shown. */
  showing: boolean;
  toggle: () => void;
}

/**
 * Translation state for one message/content block. The first toggle click
 * fetches the translation from the server; later clicks only flip between
 * translated and original text. State is ephemeral (never persisted).
 */
export function useBlockTranslation(
  sourceText: string | null,
  inputLang: string,
  outputLang: string,
): BlockTranslationState {
  const [status, setStatus] = useState<BlockTranslationStatus>(() => {
    if (!sourceText) {
      return "idle";
    }
    return getCachedTranslation(sourceText, inputLang, outputLang) !==
      undefined
      ? "ready"
      : "idle";
  });
  const [translated, setTranslated] = useState<string | null>(() => {
    if (!sourceText) {
      return null;
    }
    return (
      getCachedTranslation(sourceText, inputLang, outputLang) ?? null
    );
  });
  const [error, setError] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);

  const toggle = useCallback(() => {
    if (!sourceText) {
      return;
    }
    if (status === "loading") {
      return;
    }
    if (status === "ready") {
      setShowing((current) => !current);
      return;
    }
    setStatus("loading");
    setError(null);
    translateText({ text: sourceText, inputLang, outputLang })
      .then((response) => {
        setCachedTranslation(
          sourceText,
          inputLang,
          outputLang,
          response.translatedText,
        );
        setTranslated(response.translatedText);
        setStatus("ready");
        setShowing(true);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
      });
  }, [sourceText, inputLang, outputLang, status]);

  return { status, translated, error, showing, toggle };
}
