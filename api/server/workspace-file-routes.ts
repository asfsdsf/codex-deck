import { randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  stat,
  writeFile,
  rename,
  unlink,
  mkdir,
  open,
  chmod,
} from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import type { Hono } from "hono";
import { isPathWithinDirectory, splitPathSegments } from "../path-utils";

export function registerWorkspaceFileRoutes(
  app: Hono,
  options: {
    resolveSessionProjectPath: (
      key: string,
    ) => Promise<string | null | undefined>;
    resolveWorkflowProjectPath: (
      key: string,
    ) => Promise<string | null | undefined>;
    workflowRouteUnavailable: (headers: Headers) => boolean;
    onChanged: (projectPath: string, key: string) => void;
  },
) {
  // Serialize compare-and-save for the same file across tabs and devices.
  const writes = new Map<string, Promise<unknown>>();
  for (const [scope, resolver] of [
    ["sessions", options.resolveSessionProjectPath],
    ["workflow-project", options.resolveWorkflowProjectPath],
  ] as const) {
    app.post(`/api/${scope}/:id/file-upload`, async (c) => {
      if (
        scope === "workflow-project" &&
        options.workflowRouteUnavailable(c.req.raw.headers)
      )
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          409,
        );
      const body = await c.req.json().catch(() => null);
      if (
        !body ||
        typeof body.path !== "string" ||
        !body.path ||
        typeof body.data !== "string" ||
        body.data.length > 12 * 1024 * 1024 ||
        !/^[a-z\d+/]*={0,2}$/i.test(body.data)
      )
        return c.json(
          { error: "A file path and base64 data (up to 8 MB) are required." },
          400,
        );
      const parts = splitPathSegments(body.path);
      if (
        isAbsolute(body.path) ||
        /^[a-z]:/i.test(body.path) ||
        body.path.includes("\0") ||
        parts.some((part) => part === ".." || part === ".git")
      )
        return c.json(
          { error: "Path is outside the allowed workspace tree." },
          403,
        );
      const key = c.req.param("id");
      const project = await resolver(key);
      if (!project) return c.json({ error: "Workspace not found." }, 404);
      try {
        const root = await realpath(project);
        let parent = root;
        for (const part of parts.slice(0, -1)) {
          const directory = join(parent, part);
          await mkdir(directory, { recursive: false }).catch((error) => {
            if (error.code !== "EEXIST") throw error;
          });
          parent = await realpath(directory);
          if (
            !isPathWithinDirectory(parent, root) ||
            splitPathSegments(parent.slice(root.length)).includes(".git")
          )
            return c.json({ error: "Path is outside the workspace." }, 403);
        }
        const path = join(parent, parts.at(-1) ?? "");
        const bytes = Buffer.from(body.data, "base64");
        if (bytes.length > 8 * 1024 * 1024)
          return c.json(
            { error: "Files larger than 8 MB cannot be uploaded." },
            413,
          );
        const handle = await open(path, "wx");
        try {
          await handle.writeFile(bytes);
        } catch (error) {
          await unlink(path).catch(() => {});
          throw error;
        } finally {
          await handle.close();
        }
        options.onChanged(project, key);
        return c.json({ saved: true });
      } catch (error) {
        const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
        return c.json(
          {
            error: exists
              ? "A file with this name already exists."
              : "Could not upload the file.",
          },
          exists ? 409 : 500,
        );
      }
    });
    app.put(`/api/${scope}/:id/file-content`, async (c) => {
      if (
        scope === "workflow-project" &&
        options.workflowRouteUnavailable(c.req.raw.headers)
      )
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          409,
        );
      const body = await c.req.json().catch(() => null);
      if (
        !body ||
        typeof body.path !== "string" ||
        !body.path ||
        body.path.includes("\0") ||
        typeof body.content !== "string" ||
        typeof body.expectedContent !== "string" ||
        Buffer.byteLength(body.content) > 2 * 1024 * 1024 ||
        Buffer.byteLength(body.expectedContent) > 2 * 1024 * 1024
      )
        return c.json(
          {
            error:
              "A path, text content, and original content (up to 2 MB) are required.",
          },
          400,
        );
      if (splitPathSegments(body.path).includes(".git"))
        return c.json({ error: "Git metadata cannot be edited." }, 403);
      const key = c.req.param("id");
      const project = await resolver(key);
      if (!project) return c.json({ error: "Workspace not found." }, 404);
      try {
        const root = await realpath(project);
        const path = await realpath(resolve(root, body.path));
        if (
          !isPathWithinDirectory(path, root) ||
          splitPathSegments(path.slice(root.length)).includes(".git")
        )
          return c.json({ error: "Path is outside the workspace." }, 403);
        const pending = writes.get(path) ?? Promise.resolve();
        const save = pending
          .catch(() => {})
          .then(async () => {
            const metadata = await stat(path);
            if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024)
              return "unsupported";
            const original = await readFile(path);
            if (
              original.includes(0) ||
              !original.equals(Buffer.from(original.toString("utf8")))
            )
              return "unsupported";
            if (original.toString("utf8") !== body.expectedContent)
              return "conflict";
            const temporary = join(
              dirname(path),
              `.codex-deck-save-${randomUUID()}`,
            );
            try {
              await writeFile(temporary, body.content, {
                encoding: "utf8",
                flag: "wx",
                mode: metadata.mode,
              });
              await chmod(temporary, metadata.mode);
              // Also detect a CLI/editor changing the file during our asynchronous write.
              if (!(await readFile(path)).equals(original)) return "conflict";
              await rename(temporary, path);
            } finally {
              await unlink(temporary).catch(() => {});
            }
            options.onChanged(project, key);
            return "saved";
          });
        writes.set(path, save);
        try {
          const result = await save;
          if (result === "conflict")
            return c.json(
              { error: "The file changed on disk. Refresh it before saving." },
              409,
            );
          if (result === "unsupported")
            return c.json(
              {
                error:
                  "Only complete UTF-8 text files up to 2 MB can be edited.",
              },
              400,
            );
          return c.json({ saved: true });
        } finally {
          if (writes.get(path) === save) writes.delete(path);
        }
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        return c.json(
          {
            error:
              code === "ENOENT"
                ? "File not found."
                : "Could not save the file.",
          },
          code === "ENOENT" ? 404 : 500,
        );
      }
    });
  }
}
