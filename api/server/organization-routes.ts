import type { Context, Hono } from "hono";
import { getCodexAppServerClient } from "../codex-app-server";
import type { CodexOrganizationService } from "../codex-organization";
import { responseStatusForError, toErrorMessage } from "./utils";

type OrganizationService = Pick<CodexOrganizationService, "readState">;

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
  const run = async (
    c: Context,
    work: (service: OrganizationService) => Promise<unknown>,
  ) => {
    try {
      deps.subscribe?.();
      const current = service();
      if (!current)
        return c.json(
          { error: "Codex organization APIs are unavailable on this server." },
          501,
        );
      const result = await work(current);
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
    run(c, (current) => current.readState.list()),
  );
  app.post("/api/codex/threads/:id/read-state", (c) =>
    run(c, async (current) => {
      const body = await readBody(c);
      const operation = body.operation;
      if (operation !== "read" && operation !== "unread")
        invalid('Expected operation "read" or "unread".');
      const expectedRevision = requireId(
        body.expectedRevision,
        "expected revision",
      );
      return current.readState.update(
        requireId(c.req.param("id"), "thread ID"),
        operation,
        expectedRevision,
      );
    }),
  );
}
