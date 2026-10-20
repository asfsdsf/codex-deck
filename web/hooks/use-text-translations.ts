import { useRef, useState } from "react";
import { translateText } from "../api";
import {
  getCachedTranslation,
  setCachedTranslation,
} from "../translation-cache";
import type { BlockTranslationStatus } from "./use-block-translation";

interface TranslationState {
  key: string;
  request: object;
  status: BlockTranslationStatus;
  translations: Map<string, string>;
  showing: boolean;
  error: string | null;
}

/** Translate display fields together without changing IDs, statuses, or answers. */
export function useTextTranslations(texts: string[]) {
  const sources = [...new Set(texts.filter((text) => text.trim()))];
  const key = JSON.stringify(sources);
  const currentKey = useRef(key);
  currentKey.current = key;
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
      request: {},
      status: "loading",
      translations: new Map(),
      showing: false,
      error: null,
    };
    setState(pending);

    const translations = new Map<string, string>();
    let failed = false;
    const update = (changes: Partial<TranslationState>) => {
      setState((latest) =>
        currentKey.current === key && latest?.request === pending.request
          ? { ...latest, ...changes }
          : latest,
      );
    };
    const show = (source: string, text: string) => {
      if (failed) return;
      translations.set(source, text);
      update({ translations: new Map(translations), showing: true });
    };
    let nextIndex = 0;
    const worker = async () => {
      while (!failed && nextIndex < sources.length) {
        const source = sources[nextIndex++];
        let translated = getCachedTranslation(source, "en", "zh");
        if (translated === undefined) {
          const response = await translateText(
            {
              text: source,
              inputLang: "en",
              outputLang: "zh",
            },
            (text) => show(source, text),
          );
          translated = response.translatedText;
          if (!translated.trim()) throw new Error("Translation is empty.");
          setCachedTranslation(source, "en", "zh", translated);
        }
        show(source, translated);
      }
    };

    // Bound requests for plans and questionnaires with many display fields.
    void Promise.all(
      Array.from({ length: Math.min(4, sources.length) }, worker),
    )
      .then(() => {
        update({
          status: "ready",
          translations: new Map(translations),
          showing: true,
        });
      })
      .catch((error: unknown) => {
        failed = true;
        update({
          status: "error",
          showing: false,
          error: error instanceof Error ? error.message : String(error),
        });
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
