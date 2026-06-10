import { createReadStream } from "fs";
import type { Hono } from "hono";
import type {
  CodexMemoriesResetResponse,
  CodexMemoriesSettingsWriteRequest,
  CodexMemoriesSettingsWriteResponse,
} from "../storage";
import { getCodexAppServerClient, type CodexThreadMemoryMode } from "../codex-app-server";
import { listCodexPets, petAssetEtag, resolveCodexPetAsset, selectCodexPet } from "../pets";
import { normalizeCwdPath, parseOptionalString, responseStatusForError, toErrorMessage } from "./utils";

export function registerSettingsRoutes(app: Hono): void {
  app.get("/api/codex/pets", async (c) => {
    try {
      return c.json(await listCodexPets());
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/pets", async (c) => {
    try {
      const body = await c.req.json().catch(() => null);
      const petId =
        body && typeof body === "object" && "petId" in body
          ? String((body as { petId?: unknown }).petId ?? "")
          : "";
      return c.json(await selectCodexPet(petId));
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/pets/:petId/spritesheet", async (c) => {
    try {
      const petId = decodeURIComponent(c.req.param("petId"));
      const asset = await resolveCodexPetAsset(petId);
      const headers = new Headers();
      headers.set("Content-Type", asset.contentType);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("ETag", `"${petAssetEtag(asset.path)}"`);
      return new Response(createReadStream(asset.path) as unknown as BodyInit, {
        headers,
      });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/memories", async (c) => {
    try {
      const client = getCodexAppServerClient();
      if (!client.readMemorySettings) {
        return c.json(
          {
            error: "Memory settings are not available for this codex client",
          },
          503,
        );
      }

      const cwdParam = parseOptionalString(c.req.query("cwd"));
      const cwd =
        typeof cwdParam === "string" ? normalizeCwdPath(cwdParam) : cwdParam;
      const settings = await client.readMemorySettings(cwd);
      return c.json(settings);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/memories", async (c) => {
    try {
      const body =
        (await c.req.json()) as Partial<CodexMemoriesSettingsWriteRequest>;
      if (typeof body.useMemories !== "boolean") {
        return c.json({ error: "useMemories must be a boolean" }, 400);
      }
      if (typeof body.generateMemories !== "boolean") {
        return c.json({ error: "generateMemories must be a boolean" }, 400);
      }

      const client = getCodexAppServerClient();
      if (
        !client.readMemorySettings ||
        !client.writeMemorySettings ||
        !client.setThreadMemoryMode
      ) {
        return c.json(
          {
            error: "Memory settings are not available for this codex client",
          },
          503,
        );
      }

      const before = await client.readMemorySettings();
      const settings = await client.writeMemorySettings({
        useMemories: body.useMemories,
        generateMemories: body.generateMemories,
      });

      const threadId = parseOptionalString(body.threadId);
      if (threadId && before.generateMemories !== settings.generateMemories) {
        const mode: CodexThreadMemoryMode = settings.generateMemories
          ? "enabled"
          : "disabled";
        await client.setThreadMemoryMode(threadId, mode);
      }

      const response: CodexMemoriesSettingsWriteResponse = {
        ok: true,
        ...settings,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/memories/reset", async (c) => {
    try {
      const client = getCodexAppServerClient();
      if (!client.resetMemories) {
        return c.json(
          {
            error: "Memory reset is not available for this codex client",
          },
          503,
        );
      }

      await client.resetMemories();
      const response: CodexMemoriesResetResponse = {
        ok: true,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });
}
