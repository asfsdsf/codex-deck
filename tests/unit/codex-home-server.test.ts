import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../api/server";

test("server exposes the home catalog and rejects invalid selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-home-server-"));
  const mainHome = join(root, "main");
  const workHome = join(root, "work");
  await mkdir(mainHome, { recursive: true });
  await mkdir(workHome, { recursive: true });

  const server = createServer({
    port: 0,
    codexDir: mainHome,
    open: false,
    additionalCodexHomes: [
      {
        id: "work",
        label: "Work",
        path: workHome,
        isMain: false,
        available: true,
        unavailableReason: null,
      },
      {
        id: "missing",
        label: "Missing",
        path: join(root, "missing"),
        isMain: false,
        available: false,
        unavailableReason: "Directory does not exist",
      },
    ],
  });

  try {
    const catalog = await server.app.request("/api/codex-homes");
    assert.equal(catalog.status, 200);
    assert.deepEqual(await catalog.json(), {
      homes: [
        {
          id: "main",
          label: "Main",
          isMain: true,
          available: true,
          unavailableReason: null,
        },
        {
          id: "work",
          label: "Work",
          isMain: false,
          available: true,
          unavailableReason: null,
        },
        {
          id: "missing",
          label: "Missing",
          isMain: false,
          available: false,
          unavailableReason: "Directory does not exist",
        },
      ],
      mainHomeId: "main",
    });

    assert.equal(
      (await server.app.request("/api/projects?codexHome=unknown")).status,
      404,
    );
    assert.equal(
      (await server.app.request("/api/projects?codexHome=missing")).status,
      409,
    );
    assert.equal(
      (await server.app.request("/api/projects?codexHome=work")).status,
      503,
    );
    assert.equal(
      (await server.app.request("/api/projects?codexHome=main")).status,
      200,
    );

    const httpServer = await server.start();
    const address = httpServer.address();
    assert.equal(typeof address, "object");
    assert.ok(address && typeof address === "object" && address.port > 0);
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
