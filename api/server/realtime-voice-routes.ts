import type { Context, Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import { RealtimeVoiceError } from "../codex-realtime";
import { isRealtimePosition } from "../codex-voice-history";
import { responseStatusForError, toErrorMessage } from "./utils";

type VoiceClient = Pick<CodexAppServerClientFacade, "getRealtimeVoice">;

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new RealtimeVoiceError("Expected a JSON object body.", 400);
  return body as Record<string, unknown>;
}

function clientIdFrom(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new RealtimeVoiceError("A client ID is required.", 400);
  return value.trim();
}

export function registerRealtimeVoiceRoutes(
  app: Hono,
  deps: { subscribe?: () => void; getClient?: () => VoiceClient } = {},
) {
  const run = async (
    c: Context,
    work: (
      voice: ReturnType<NonNullable<VoiceClient["getRealtimeVoice"]>>,
    ) => Promise<unknown>,
  ) => {
    try {
      deps.subscribe?.();
      const client = (deps.getClient ?? getCodexAppServerClient)();
      if (!client.getRealtimeVoice)
        return c.json({ error: "Realtime voice is unavailable." }, 501);
      return c.json(await work(client.getRealtimeVoice()));
    } catch (error) {
      if (error instanceof RealtimeVoiceError)
        return c.json({ error: error.message }, error.status);
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  };

  app.get("/api/codex/realtime/voices", (c) =>
    run(c, (voice) => voice.listVoices(c.req.query("threadId") || null)),
  );
  app.post("/api/codex/realtime/voice", (c) =>
    run(c, async (voice) => {
      const body = await readJsonObject(c);
      if (body.voice !== null && typeof body.voice !== "string")
        throw new RealtimeVoiceError("Expected a voice name or null.", 400);
      return voice.setVoice(
        body.voice as string | null,
        typeof body.threadId === "string" ? body.threadId : null,
      );
    }),
  );
  app.get("/api/codex/threads/:id/realtime", (c) =>
    run(c, async (voice) =>
      voice.snapshot(c.req.param("id"), c.req.query("clientId") || null),
    ),
  );
  app.get("/api/codex/threads/:id/realtime/history", (c) =>
    run(c, async (voice) => {
      const cursor = c.req.query("cursor");
      const position = (value: string | undefined) => {
        if (value === undefined) return undefined;
        if (!/^\d+$/.test(value) || !isRealtimePosition(Number(value))) {
          throw new RealtimeVoiceError(
            "Invalid realtime history position.",
            400,
          );
        }
        return Number(value);
      };
      const snapshotEnd = position(c.req.query("snapshotEnd"));
      const requiredThroughPosition = position(
        c.req.query("requiredThroughPosition"),
      );
      if (
        cursor !== undefined &&
        (!cursor || cursor.length > 4096 || snapshotEnd === undefined)
      ) {
        throw new RealtimeVoiceError(
          "A cursor requires its original realtime snapshot.",
          400,
        );
      }
      return voice.listHistory(c.req.param("id"), {
        ...(cursor ? { cursor } : {}),
        ...(snapshotEnd !== undefined ? { snapshotEnd } : {}),
        ...(requiredThroughPosition !== undefined
          ? { requiredThroughPosition }
          : {}),
      });
    }),
  );
  app.post("/api/codex/threads/:id/realtime/start", (c) =>
    run(c, async (voice) => {
      const body = await readJsonObject(c);
      if (body.voice != null && typeof body.voice !== "string")
        throw new RealtimeVoiceError("Expected a voice name.", 400);
      return voice.start(c.req.param("id"), {
        clientId: clientIdFrom(body.clientId),
        sdp: typeof body.sdp === "string" ? body.sdp : "",
        voice: (body.voice as string | null | undefined) ?? null,
      });
    }),
  );
  app.post("/api/codex/threads/:id/realtime/heartbeat", (c) =>
    run(c, async (voice) => {
      const body = await readJsonObject(c);
      return voice.heartbeat(c.req.param("id"), clientIdFrom(body.clientId));
    }),
  );
  app.post("/api/codex/threads/:id/realtime/stop", (c) =>
    run(c, async (voice) => {
      const body = await readJsonObject(c);
      if (body.error != null && typeof body.error !== "string")
        throw new RealtimeVoiceError("Expected an error message string.", 400);
      return voice.stop(c.req.param("id"), clientIdFrom(body.clientId), {
        error: typeof body.error === "string" ? body.error : null,
      });
    }),
  );
}
