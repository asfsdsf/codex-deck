import type { Context, Hono } from "hono";
import { getCodexAppServerClient } from "../codex-app-server";
import { parseBedrockSetup, parseLoginRequest } from "../codex-account";
import type { CodexExtensions } from "../codex-extensions";
import { CodexInputError } from "../codex-input-error";
import { responseStatusForError, toErrorMessage } from "./utils";

/**
 * Native Codex account and extension administration routes (`/presets`,
 * Codex account, `/import`, `/apps`, `/plugins`). Every mutation is broadcast
 * by the app-server bridge as `native_state_changed`.
 */
export function registerExtensionRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    getExtensions?: () => CodexExtensions | undefined;
  } = {},
) {
  const extensions = () => {
    const resolved = deps.getExtensions
      ? deps.getExtensions()
      : getCodexAppServerClient().getExtensions?.();
    if (!resolved)
      throw new Error("Codex extension administration is unavailable.");
    return resolved;
  };
  const run = async (
    c: Context,
    work: (target: CodexExtensions) => Promise<unknown>,
  ) => {
    try {
      deps.subscribe?.();
      const result = await work(extensions());
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        error instanceof CodexInputError ? 400 : responseStatusForError(error),
      );
    }
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const value = await c.req.json().catch(() => null);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new CodexInputError("Expected a JSON object body.");
    return value as Record<string, unknown>;
  };
  const optionalString = (value: unknown, name: string) => {
    if (value == null) return null;
    if (typeof value !== "string")
      throw new CodexInputError(`${name} must be a string.`);
    return value.trim() || null;
  };

  app.get("/api/codex/presets", (c) =>
    run(c, (target) => target.readPresets(c.req.query("cwd") || null)),
  );
  app.post("/api/codex/presets/:slot", (c) =>
    run(c, async (target) => {
      const input = await body(c);
      return target.writePreset(
        c.req.param("slot"),
        {
          input: typeof input.input === "string" ? input.input : "",
          label: optionalString(input.label, "label"),
        },
        {
          expectedVersion: optionalString(
            input.expectedVersion,
            "expectedVersion",
          ),
          cwd: optionalString(input.cwd, "cwd"),
        },
      );
    }),
  );
  app.delete("/api/codex/presets/:slot", (c) =>
    run(c, (target) =>
      target.writePreset(c.req.param("slot"), null, {
        expectedVersion: c.req.query("expectedVersion") || null,
        cwd: c.req.query("cwd") || null,
      }),
    ),
  );

  // Codex account (the Codex CLI login, not Deck's remote-server login).
  // Credentials in request bodies are forwarded to app-server only.
  app.get("/api/codex/account", (c) =>
    run(c, (target) => target.account.read()),
  );
  app.post("/api/codex/account/login", (c) =>
    run(c, async (target) =>
      target.account.startLogin(parseLoginRequest(await body(c))),
    ),
  );
  app.post("/api/codex/account/login/cancel", (c) =>
    run(c, async (target) => {
      const input = await body(c);
      return target.account.cancelLogin(optionalString(input.id, "id"));
    }),
  );
  app.post("/api/codex/account/logout", (c) =>
    run(c, (target) => target.account.logout()),
  );
  app.get("/api/codex/account/bedrock", (c) =>
    run(c, (target) => target.account.discoverBedrock()),
  );
  app.post("/api/codex/account/bedrock", (c) =>
    run(c, async (target) => {
      const input = await body(c);
      return target.account.configureBedrock(
        input.type === "profile" || input.type === "environment"
          ? parseBedrockSetup(input)
          : parseLoginRequest(input),
      );
    }),
  );
  app.post("/api/codex/account/gateway/login", (c) =>
    run(c, (target) => target.account.startGatewayLogin()),
  );
  app.post("/api/codex/account/gateway/cancel", (c) =>
    run(c, (target) => target.account.cancelGatewayLogin()),
  );
}
