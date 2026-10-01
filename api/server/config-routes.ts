import type { Hono } from "hono";
import { resolveConversationHoverSettings } from "../conversation-hover-settings";
import {
  loadCodexDeckConfig,
  MAX_CODEX_DECK_CONFIG_BYTES,
  readCodexDeckHomeConfigFile,
  writeCodexDeckHomeConfigFile,
  type CodexDeckConfig,
} from "../config";
import type {
  CodexDeckConfigFileResponse,
  CodexDeckConfigWriteRequest,
  CodexDeckConfigWriteResponse,
  CodexHomeDescriptor,
} from "../storage";
import { responseStatusForError, toErrorMessage } from "./utils";

export interface CodexDeckConfigApplyResult {
  appliedKeys: string[];
  restartRequiredKeys: string[];
  homes: CodexHomeDescriptor[];
  mainHomeId: string;
}

export interface ConfigRouteOptions {
  codexHome: string;
  applyConfig: (
    previousConfig: CodexDeckConfig,
    nextConfig: CodexDeckConfig,
  ) => Promise<CodexDeckConfigApplyResult>;
}

function createSerializedRunner() {
  let tail = Promise.resolve();

  return async function runSerialized<T>(operation: () => Promise<T>) {
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

export function registerConfigRoutes(
  app: Hono,
  options: ConfigRouteOptions,
): void {
  const runSerialized = createSerializedRunner();

  app.get("/api/codex-deck/config", async (c) => {
    try {
      const file = await readCodexDeckHomeConfigFile(options.codexHome);
      const response: CodexDeckConfigFileResponse = {
        ...file,
        hoverSettings: resolveConversationHoverSettings(
          loadCodexDeckConfig(process.cwd(), options.codexHome).config
            .conversationHover,
        ),
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex-deck/config", async (c) => {
    let body: Partial<CodexDeckConfigWriteRequest> | null = null;
    try {
      body = (await c.req.json()) as Partial<CodexDeckConfigWriteRequest>;
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }
    if (!body || typeof body.content !== "string") {
      return c.json({ error: "content must be a string" }, 400);
    }
    if (typeof body.revision !== "string" || !body.revision.trim()) {
      return c.json({ error: "revision must be a non-empty string" }, 400);
    }
    if (body.content.includes("\0")) {
      return c.json({ error: "content must not contain null bytes" }, 400);
    }
    if (
      Buffer.byteLength(body.content, "utf-8") > MAX_CODEX_DECK_CONFIG_BYTES
    ) {
      return c.json(
        {
          error: `content must be at most ${MAX_CODEX_DECK_CONFIG_BYTES} bytes`,
        },
        413,
      );
    }

    try {
      const response = await runSerialized(async () => {
        const currentFile = await readCodexDeckHomeConfigFile(
          options.codexHome,
        );
        if (currentFile.revision !== body.revision) {
          return null;
        }
        const previousConfig = loadCodexDeckConfig(
          process.cwd(),
          options.codexHome,
        ).config;
        const file = await writeCodexDeckHomeConfigFile(
          options.codexHome,
          body.content as string,
        );
        const nextConfig = loadCodexDeckConfig(
          process.cwd(),
          options.codexHome,
        ).config;
        const applied = await options.applyConfig(previousConfig, nextConfig);
        return {
          ok: true,
          ...file,
          ...applied,
          hoverSettings: resolveConversationHoverSettings(
            nextConfig.conversationHover,
          ),
        } satisfies CodexDeckConfigWriteResponse;
      });

      if (!response) {
        return c.json(
          {
            error:
              "Config changed after it was opened. Reload it before applying your changes.",
          },
          409,
        );
      }
      return c.json(response);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });
}
