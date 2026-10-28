import type { Context, Hono } from "hono";
import { getCodexAppServerClient } from "../codex-app-server";
import type { CodexOrganizationService } from "../codex-organization";
import { responseStatusForError, toErrorMessage } from "./utils";

type OrganizationService = Partial<
  Pick<CodexOrganizationService, "readState" | "remoteControl">
>;

class RouteInputError extends Error {}

function invalid(message: string): never {
  throw new RouteInputError(message);
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    invalid("Expected a JSON request body.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    invalid("Expected a JSON object.");
  return body as Record<string, unknown>;
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") invalid(`Expected ${label} to be a boolean.`);
  return value;
}

function optionalCode(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireId(value, label);
}

export function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    invalid(`A valid ${label} is required.`);
  return value.trim();
}

export function registerOrganizationRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    getService?: () => OrganizationService | null | undefined;
  } = {},
) {
  const service = (): OrganizationService | null =>
    deps.getService
      ? (deps.getService() ?? null)
      : (getCodexAppServerClient().organization?.() ?? null);
  const run = async <K extends keyof OrganizationService>(
    c: Context,
    feature: K,
    work: (service: NonNullable<OrganizationService[K]>) => Promise<unknown>,
  ) => {
    try {
      deps.subscribe?.();
      const current = service()?.[feature];
      if (!current)
        return c.json(
          { error: "This Codex integration is unavailable on this server." },
          501,
        );
      const result = await work(current as NonNullable<OrganizationService[K]>);
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      if (error instanceof RouteInputError)
        return c.json({ error: error.message }, 400);
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  };

  app.get("/api/codex/read-states", (c) =>
    run(c, "readState", (readState) => readState.list()),
  );
  app.post("/api/codex/threads/:id/read-state", (c) =>
    run(c, "readState", async (readState) => {
      const body = await readBody(c);
      const operation = body.operation;
      if (operation !== "read" && operation !== "unread")
        invalid('Expected operation "read" or "unread".');
      const expectedRevision = requireId(
        body.expectedRevision,
        "expected revision",
      );
      return readState.update(
        requireId(c.req.param("id"), "thread ID"),
        operation,
        expectedRevision,
      );
    }),
  );

  app.get("/api/codex/remote-control", (c) =>
    run(c, "remoteControl", (remote) => remote.snapshot()),
  );
  for (const action of ["enable", "disable"] as const)
    app.post(`/api/codex/remote-control/${action}`, (c) =>
      run(c, "remoteControl", async (remote) => {
        const body = await readBody(c);
        return {
          status: await remote.setEnabled(
            action === "enable",
            optionalBoolean(body.ephemeral, "ephemeral"),
          ),
        };
      }),
    );
  app.post("/api/codex/remote-control/pairing", (c) =>
    run(c, "remoteControl", (remote) => remote.startPairing()),
  );
  // Pairing codes travel in the body, never in a URL.
  app.post("/api/codex/remote-control/pairing/status", (c) =>
    run(c, "remoteControl", async (remote) => {
      const body = await readBody(c);
      const pairingCode = optionalCode(body.pairingCode, "pairing code");
      const manualPairingCode = optionalCode(
        body.manualPairingCode,
        "manual pairing code",
      );
      if (!pairingCode && !manualPairingCode)
        invalid("A pairing code is required.");
      return remote.pairingStatus({ pairingCode, manualPairingCode });
    }),
  );
  app.post("/api/codex/remote-control/clients/revoke", (c) =>
    run(c, "remoteControl", async (remote) => {
      const body = await readBody(c);
      await remote.revokeClient(
        requireId(body.environmentId, "environment ID"),
        requireId(body.clientId, "client ID"),
      );
      return { ok: true };
    }),
  );
}
