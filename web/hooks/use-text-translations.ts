import { useState } from "react";
import { translateText } from "../api";
import {
  getCachedTranslation,
  setCachedTranslation,
} from "../translation-cache";
import type { BlockTranslationStatus } from "./use-block-translation";

interface TranslationState {
  key: string;
  status: BlockTranslationStatus;
  translations: Map<string, string>;
  showing: boolean;
  error: string | null;
}

/** Translate display fields together without changing IDs, statuses, or answers. */
export function useTextTranslations(texts: string[]) {
  const sources = [...new Set(texts.filter((text) => text.trim()))];
  const key = JSON.stringify(sources);
  const [state, setState] = useState<TranslationState | null>(null);
  // Live tool updates can replace the content while a translation is pending.
  const current = state?.key === key ? state : null;

  const toggle = () => {
    if (!sources.length || current?.status === "loading") return;
    if (current?.status === "ready") {
      setState({ ...current, showing: !current.showing });
      return;
    }

    const pending: TranslationState = {
      key,
      status: "loading",
      translations: new Map(),
      showing: false,
      error: null,
    };
    setState(pending);

    const translations = new Map<string, string>();
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < sources.length) {
        const source = sources[nextIndex++];
        let translated = getCachedTranslation(source, "en", "zh");
        if (translated === undefined) {
          const response = await translateText({
            text: source,
            inputLang: "en",
            outputLang: "zh",
          });
          translated = response.translatedText;
          if (!translated.trim()) throw new Error("Translation is empty.");
          setCachedTranslation(source, "en", "zh", translated);
        }
        translations.set(source, translated);
      }
    };

    // Bound requests for plans and questionnaires with many display fields.
    void Promise.all(
      Array.from({ length: Math.min(4, sources.length) }, worker),
    )
      .then(() => {
        setState((latest) =>
          latest === pending
            ? { ...latest, status: "ready", translations, showing: true }
            : latest,
        );
      })
      .catch((error: unknown) => {
        setState((latest) =>
          latest === pending
            ? {
                ...latest,
                status: "error",
                error: error instanceof Error ? error.message : String(error),
              }
            : latest,
        );
      });
  };

  return {
    status: current?.status ?? "idle",
    showing: current?.showing ?? false,
    error: current?.error ?? null,
    toggle,
    text: (source: string) =>
      current?.showing ? (current.translations.get(source) ?? source) : source,
  };
}
