import { useRef, useState } from "react";
import { translateText } from "../api";
import { translateMarkdown } from "../markdown-translation";
import {
  getCachedTranslation,
  setCachedTranslation,
  type TranslationFormat,
} from "../translation-cache";

export type BlockTranslationStatus = "idle" | "loading" | "ready" | "error";

export interface BlockTranslationState {
  status: BlockTranslationStatus;
  /** Accumulated output while loading, or the completed cached translation. */
  translated: string | null;
  error: string | null;
  /** Whether the translated text (vs. the original) is currently shown. */
  showing: boolean;
  toggle: () => void;
}

interface TranslationState extends Omit<BlockTranslationState, "toggle"> {
  key: string;
  request: object;
}

/** Translation state stays tied to its source even when live messages change. */
export function useBlockTranslation(
  sourceText: string | null,
  inputLang: string,
  outputLang: string,
  format: TranslationFormat = "text",
): BlockTranslationState {
  const key = JSON.stringify([sourceText, inputLang, outputLang, format]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState<TranslationState | null>(null);
  const cached = sourceText
    ? getCachedTranslation(sourceText, inputLang, outputLang, format)
    : undefined;
  const current =
    state?.key === key
      ? state
      : {
          key,
          request: {},
          status: cached !== undefined ? ("ready" as const) : ("idle" as const),
          translated: cached ?? null,
          error: null,
          showing: false,
        };

  const toggle = () => {
    if (!sourceText || current.status === "loading") return;
    if (current.status === "ready") {
      setState({ ...current, showing: !current.showing });
      return;
    }
    const pending: TranslationState = {
      key,
      request: {},
      status: "loading",
      translated: null,
      error: null,
      showing: false,
    };
    setState(pending);
    const update = (changes: Partial<TranslationState>) => {
      setState((latest) =>
        currentKey.current === key && latest?.request === pending.request
          ? { ...latest, ...changes }
          : latest,
      );
    };
    const onProgress = (text: string) => {
      update({ translated: text, showing: true });
    };
    const translate = async (
      text: string,
      progress?: (text: string) => void,
    ) => {
      const response = await translateText(
        { text, inputLang, outputLang },
        progress,
      );
      return response.translatedText;
    };
    void (
      format === "markdown"
        ? translateMarkdown(sourceText, translate, onProgress)
        : translate(sourceText, onProgress)
    )
      .then((translatedText) => {
        if (!translatedText.trim()) throw new Error("Translation is empty.");
        setCachedTranslation(
          sourceText,
          inputLang,
          outputLang,
          translatedText,
          format,
        );
        update({ translated: translatedText, status: "ready", showing: true });
      })
      .catch((error: unknown) => {
        update({
          status: "error",
          translated: null,
          showing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return { ...current, toggle };
}
