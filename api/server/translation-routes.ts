import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import type {
  TranslateTextRequest,
  TranslateTextResponse,
  TranslateTextProgress,
} from "../storage";
import { TranslationUnavailableError, translateText } from "../translation";
import { responseStatusForError, toErrorMessage } from "./utils";

const DEFAULT_INPUT_LANG = "en";
const DEFAULT_OUTPUT_LANG = "zh";
const MAX_TRANSLATE_TEXT_LENGTH = 200_000;

export interface TranslationRouteOptions {
  translationCommand?: string;
  getTranslationCommand?: () => string | undefined;
}

export function registerTranslationRoutes(
  app: Hono,
  options: TranslationRouteOptions,
): void {
  const jobs = new Map<
    string,
    { progress: TranslateTextProgress; listeners: Set<() => void> }
  >();

  app.get("/api/translations/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "Translation not found" }, 404);
    return c.json(job.progress);
  });

  app.get("/api/translations/:id/stream", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "Translation not found" }, 404);
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        let writes = Promise.resolve();
        let stopped = false;
        const cleanup = () => {
          stopped = true;
          job.listeners.delete(send);
          clearInterval(heartbeat);
          resolve();
        };
        const send = () => {
          const progress = { ...job.progress };
          writes = writes
            .then(async () => {
              if (stopped) return;
              await stream.writeSSE({
                event: "translation",
                data: JSON.stringify(progress),
              });
              if (progress.done) cleanup();
            })
            .catch(cleanup);
        };
        const heartbeat = setInterval(() => {
          writes = writes
            .then(async () => {
              if (!stopped)
                await stream.writeSSE({ event: "heartbeat", data: "" });
            })
            .catch(cleanup);
        }, 15_000);
        job.listeners.add(send);
        stream.onAbort(cleanup);
        send(); // Reconnects replay the latest accumulated output.
      });
    });
  });

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
      if (
        body.outputLang !== undefined &&
        typeof body.outputLang !== "string"
      ) {
        return c.json({ error: "outputLang must be a string" }, 400);
      }
      if (body.stream !== undefined && typeof body.stream !== "boolean") {
        return c.json({ error: "stream must be a boolean" }, 400);
      }
      const translationOptions = {
        text: body.text,
        inputLang: body.inputLang?.trim() || DEFAULT_INPUT_LANG,
        outputLang: body.outputLang?.trim() || DEFAULT_OUTPUT_LANG,
        command:
          options.getTranslationCommand?.() ?? options.translationCommand,
      };
      if (body.stream) {
        // Keep active jobs safe for concurrent callers and bound retained output.
        if (jobs.size >= 64) {
          for (const [id, job] of jobs) {
            if (job.progress.done) jobs.delete(id);
            if (jobs.size < 64) break;
          }
        }
        if (jobs.size >= 64)
          return c.json({ error: "Too many pending translations" }, 429);
        const translationId = randomUUID();
        const job = {
          progress: {
            translationId,
            translatedText: "",
            done: false,
          } as TranslateTextProgress,
          listeners: new Set<() => void>(),
        };
        jobs.set(translationId, job);
        const publish = () => {
          for (const listener of job.listeners) listener();
        };
        void translateText({
          ...translationOptions,
          onProgress: (translatedText) => {
            job.progress.translatedText = translatedText;
            publish();
          },
        })
          .then((translatedText) => {
            job.progress.translatedText = translatedText;
          })
          .catch((error: unknown) => {
            job.progress.error = toErrorMessage(error);
          })
          .finally(() => {
            job.progress.done = true;
            publish();
            // Briefly retain completed jobs so reconnecting/polling clients catch up.
            setTimeout(() => jobs.delete(translationId), 120_000).unref();
          });
        return c.json(job.progress);
      }
      const translated = await translateText(translationOptions);
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
