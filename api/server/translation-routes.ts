import type { Hono } from "hono";
import type { TranslateTextRequest, TranslateTextResponse } from "../storage";
import {
  TranslationUnavailableError,
  translateText,
} from "../translation";
import { responseStatusForError, toErrorMessage } from "./utils";

const DEFAULT_INPUT_LANG = "en";
const DEFAULT_OUTPUT_LANG = "zh";
const MAX_TRANSLATE_TEXT_LENGTH = 200_000;

export interface TranslationRouteOptions {
  translationCommand?: string;
}

export function registerTranslationRoutes(
  app: Hono,
  options: TranslationRouteOptions,
): void {
  app.post("/api/translate", async (c) => {
    try {
      const body = (await c.req.json()) as Partial<TranslateTextRequest>;
      if (typeof body.text !== "string" || !body.text.trim()) {
        return c.json({ error: "text must be a non-empty string" }, 400);
      }
      if (body.text.length > MAX_TRANSLATE_TEXT_LENGTH) {
        return c.json({ error: "text is too long to translate" }, 413);
      }
      if (body.inputLang !== undefined && typeof body.inputLang !== "string") {
        return c.json({ error: "inputLang must be a string" }, 400);
      }
      if (body.outputLang !== undefined && typeof body.outputLang !== "string") {
        return c.json({ error: "outputLang must be a string" }, 400);
      }
      const translated = await translateText({
        text: body.text,
        inputLang: body.inputLang?.trim() || DEFAULT_INPUT_LANG,
        outputLang: body.outputLang?.trim() || DEFAULT_OUTPUT_LANG,
        command: options.translationCommand,
      });
      const response: TranslateTextResponse = { translatedText: translated };
      return c.json(response);
    } catch (error) {
      const status =
        error instanceof TranslationUnavailableError
          ? 503
          : responseStatusForError(error);
      return c.json({ error: toErrorMessage(error) }, status);
    }
  });
}
