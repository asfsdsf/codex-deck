import type { Context, Hono } from "hono";
import { getCodexAppServerClient } from "../codex-app-server";
import type { CodexOrganizationService } from "../codex-organization";
import { responseStatusForError, toErrorMessage } from "./utils";

type OrganizationService = Partial<
  Pick<
    CodexOrganizationService,
    "readState" | "remoteControl" | "environments" | "projects"
  >
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

function optionalText(value: unknown, label: string, max = 4096) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max)
    invalid(`Expected ${label} to be a string.`);
  return value;
}

function requireName(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    invalid(`A ${label} of at most 200 characters is required.`);
  return value.trim();
}

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;

function requireRoots(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 32 ||
    value.some(
      (root) =>
        typeof root !== "string" ||
        root.length > 4096 ||
        !ABSOLUTE_PATH.test(root.trim()),
    )
  )
    invalid("Expected one to 32 absolute project root paths.");
  return (value as string[]).map((root) => root.trim());
}

function optionalIdList(value: unknown, label: string): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 1000)
    invalid(`Expected ${label} list.`);
  return [...new Set(value.map((id) => requireId(id, label)))];
}

function nullableId(value: unknown, label: string): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : requireId(value, label);
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

  app.get("/api/codex/environments", (c) =>
    run(c, "environments", (environments) =>
      environments.snapshot(c.req.query("threadId") || null),
    ),
  );
  app.post("/api/codex/environments", (c) =>
    run(c, "environments", async (environments) => {
      const body = await readBody(c);
      const environmentId = requireId(body.environmentId, "environment ID");
      if (!/^[A-Za-z0-9._:-]+$/.test(environmentId))
        invalid(
          "Environment IDs may contain letters, digits, '.', '_', ':', and '-'.",
        );
      const execServerUrl = requireId(body.execServerUrl, "exec-server URL");
      let url: URL;
      try {
        url = new URL(execServerUrl);
      } catch {
        invalid("Expected a ws:// or wss:// exec-server URL.");
      }
      if (url.protocol !== "ws:" && url.protocol !== "wss:")
        invalid("Expected a ws:// or wss:// exec-server URL.");
      const timeout = body.connectTimeoutMs;
      if (
        timeout != null &&
        (typeof timeout !== "number" ||
          !Number.isInteger(timeout) ||
          timeout <= 0 ||
          timeout > 600_000)
      )
        invalid("Expected a connection timeout between 1 and 600000 ms.");
      const skills = body.requiredSkills;
      if (
        skills != null &&
        (!Array.isArray(skills) ||
          skills.length > 100 ||
          skills.some((skill) => typeof skill !== "string" || !skill.trim()))
      )
        invalid("Expected required skills to be a list of names.");
      return {
        registration: await environments.add({
          environmentId,
          execServerUrl,
          authBearerToken: optionalText(body.authBearerToken, "bearer token"),
          connectTimeoutMs: (timeout as number | null | undefined) ?? null,
          requiredSkills: ((skills as string[] | null) ?? []).map((skill) =>
            skill.trim(),
          ),
        }),
      };
    }),
  );
  app.post("/api/codex/threads/:id/environment-selection", (c) =>
    run(c, "environments", async (environments) => {
      const body = await readBody(c);
      const threadId = requireId(c.req.param("id"), "thread ID");
      if (body.environmentId == null) {
        environments.setPendingSelection(threadId, null);
        return { ok: true };
      }
      const cwd = optionalText(body.cwd, "working directory");
      if (!cwd?.trim()) invalid("A working directory is required.");
      environments.setPendingSelection(threadId, [
        {
          environmentId: requireId(body.environmentId, "environment ID"),
          cwd: cwd.trim(),
        },
      ]);
      return { ok: true };
    }),
  );
  app.get("/api/codex/projects", (c) =>
    run(c, "projects", (projects) => projects.snapshot()),
  );
  app.post("/api/codex/projects", (c) =>
    run(c, "projects", async (projects) => {
      const body = await readBody(c);
      return {
        project: await projects.createProject({
          name: requireName(body.name, "project name"),
          roots: requireRoots(body.roots),
          idempotencyKey: requireId(body.idempotencyKey, "idempotency key"),
          threadIds: optionalIdList(body.threadIds, "thread ID"),
        }),
      };
    }),
  );
  app.post("/api/codex/projects/:id/update", (c) =>
    run(c, "projects", async (projects) => {
      const body = await readBody(c);
      const name =
        body.name == null ? null : requireName(body.name, "project name");
      const roots = body.roots == null ? null : requireRoots(body.roots);
      if (!name && !roots) invalid("Expected a new name or roots.");
      return {
        project: await projects.updateProject(
          requireId(c.req.param("id"), "project ID"),
          { name, roots },
        ),
      };
    }),
  );
  app.post("/api/codex/projects/:id/move", (c) =>
    run(c, "projects", async (projects) => {
      const body = await readBody(c);
      await projects.moveProject(
        requireId(c.req.param("id"), "project ID"),
        nullableId(body.beforeProjectId, "project ID"),
      );
      return { ok: true };
    }),
  );
  app.post("/api/codex/projects/:id/delete", (c) =>
    run(c, "projects", async (projects) => {
      await projects.deleteProject(requireId(c.req.param("id"), "project ID"));
      return { ok: true };
    }),
  );
  app.post("/api/codex/threads/:id/project", (c) =>
    run(c, "projects", async (projects) => {
      const body = await readBody(c);
      await projects.assignThread(
        requireId(c.req.param("id"), "thread ID"),
        nullableId(body.projectId, "project ID"),
      );
      return { ok: true };
    }),
  );
  app.post("/api/codex/threads/:id/section", (c) =>
    run(c, "projects", async (projects) => {
      const body = await readBody(c);
      await projects.moveThreadToSection(
        requireId(c.req.param("id"), "thread ID"),
        nullableId(body.sectionId, "section ID"),
      );
      return { ok: true };
    }),
  );
  app.post("/api/codex/thread-sections", (c) =>
    run(c, "projects", async (projects) => {
      const body = await readBody(c);
      return {
        section: await projects.createSection(
          requireName(body.name, "section name"),
        ),
      };
    }),
  );
  app.post("/api/codex/thread-sections/:id/update", (c) =>
    run(c, "projects", async (projects) => {
      const body = await readBody(c);
      return {
        section: await projects.renameSection(
          requireId(c.req.param("id"), "section ID"),
          requireName(body.name, "section name"),
        ),
      };
    }),
  );
  app.post("/api/codex/thread-sections/:id/delete", (c) =>
    run(c, "projects", async (projects) => {
      await projects.deleteSection(requireId(c.req.param("id"), "section ID"));
      return { ok: true };
    }),
  );
}
