import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  DiffGuideStore,
  type DiffGuideRecord,
} from "../../api/diff-guide-store";
import {
  DiffGuideService,
  buildDiffGuidePrompt,
  checkDiffGuideTools,
} from "../../api/diff-guide";
import { registerDiffGuideRoutes } from "../../api/server/diff-guide-routes";
import { createServer } from "../../api/server";
import {
  initStorage,
  loadStorage,
  archiveSession,
  deleteSession,
} from "../../api/storage";
import {
  setCodexAppServerClientForTests,
  type CodexAppServerClientFacade,
} from "../../api/codex-app-server";

function fixture() {
  let forks = 0;
  const forkSources: string[] = [];
  const messages: Parameters<CodexAppServerClientFacade["sendMessage"]>[0][] =
    [];
  let installed = true;
  let enabled = true;
  let failing = false;
  let running = true;
  const client = {
    listSkills: async () => [
      {
        cwd: "/repo",
        errors: [],
        skills: installed
          ? [
              {
                name: "codex-deck-diff",
                enabled,
                path: "/skills/codex-deck-diff/SKILL.md",
                scope: "user",
              },
            ]
          : [],
      },
    ],
    forkThread: async (sourceSessionId: string) => {
      forkSources.push(sourceSessionId);
      return {
        threadId: `fork-${++forks}`,
        cwd: "/repo",
        name: null,
      };
    },
    sendMessage: async (
      input: Parameters<CodexAppServerClientFacade["sendMessage"]>[0],
    ) => {
      messages.push(input);
      if (failing) throw new Error("Send failed");
      return { turnId: `turn-${messages.length}` };
    },
    getThreadState: async () => ({
      isGenerating: running,
      requestedTurnStatus: running ? "inProgress" : "completed",
    }),
  } as unknown as CodexAppServerClientFacade;
  return {
    client,
    messages,
    forkSources,
    get forks() {
      return forks;
    },
    setInstalled(value: boolean) {
      installed = value;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
    setFailing(value: boolean) {
      failing = value;
    },
    setRunning(value: boolean) {
      running = value;
    },
  };
}

async function withService(
  run: (
    service: DiffGuideService,
    mock: ReturnType<typeof fixture>,
    home: string,
  ) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "diff-guide-test-"));
  const mock = fixture();
  const service = new DiffGuideService(
    new DiffGuideStore(home),
    () => mock.client,
    async () => "/repo",
    async () => "/repo",
  );
  try {
    await run(service, mock, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const request = {
  sourceSessionId: "source-session",
  requestId: "request-one",
  prompt: "--branch main\nExplain the tests in Korean.",
};

test("archiving preserves diff artifacts and session deletion removes them", async () => {
  await withService(async (service, _mock, home) => {
    await service.start(request);
    const record = (await service.store.records())[0];
    await publish(service.store, record);
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    await writeFile(
      join(sessions, `${record.sessionId}.jsonl`),
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: record.sessionId,
          cwd: "/repo",
          timestamp: new Date().toISOString(),
        },
      }) + "\n",
    );
    initStorage(home);
    await loadStorage();
    await archiveSession(record.sessionId);
    assert.ok(await service.store.content(record));
    await deleteSession(record.sessionId);
    assert.equal(await service.store.read(record.sessionId), null);
  });
});

test("session deletion honors the guide cleanup choice and rejects invalid choices before deleting", async () => {
  for (const choice of ["false", "true", undefined]) {
    await withService(async (service, _mock, home) => {
      await service.start(request);
      const record = (await service.store.records())[0];
      await publish(service.store, record);
      const sessions = join(home, "sessions");
      await mkdir(sessions);
      for (const id of [record.sessionId, record.parentSessionId]) {
        await writeFile(
          join(sessions, `${id}.jsonl`),
          JSON.stringify({
            type: "session_meta",
            payload: {
              id,
              cwd: "/repo",
              timestamp: new Date().toISOString(),
            },
          }) + "\n",
        );
      }
      const server = createServer({ port: 0, codexDir: home, open: false });
      await loadStorage();
      try {
        const invalid = await server.app.request(
          `/api/sessions/${record.sessionId}?deleteDiffGuide=invalid`,
          { method: "DELETE" },
        );
        assert.equal(invalid.status, 400);
        assert.ok(await readFile(join(sessions, `${record.sessionId}.jsonl`)));
        assert.ok(await service.store.read(record.sessionId));
        const query = choice === undefined ? "" : `?deleteDiffGuide=${choice}`;
        const response = await server.app.request(
          `/api/sessions/${record.sessionId}${query}`,
          { method: "DELETE" },
        );
        assert.equal(response.status, 200);
        await assert.rejects(
          readFile(join(sessions, `${record.sessionId}.jsonl`)),
          { code: "ENOENT" },
        );
        assert.ok(
          await readFile(join(sessions, `${record.parentSessionId}.jsonl`)),
        );
        if (choice === "false") {
          assert.ok(await service.store.read(record.sessionId));
          const guideResponse = await server.app.request(
            `/api/diff-guides/${record.sessionId}`,
          );
          const body = await guideResponse.json();
          assert.equal(body.guide.status, "ready");
          assert.match(body.html, /Guide/);
        } else {
          assert.equal(await service.store.read(record.sessionId), null);
          await assert.rejects(
            readFile(
              join(service.store.directory(record.sessionId), "diff-tour.html"),
            ),
            { code: "ENOENT" },
          );
        }
      } finally {
        server.stop();
      }
    });
  }
});

test("diff start checks installation and disabled skills before creating a fork", async () => {
  await withService(async (service, mock) => {
    mock.setInstalled(false);
    assert.deepEqual(await service.start(request), {
      status: "needs_skill_install",
      projectRoot: "/repo",
    });
    assert.equal(mock.forks, 0);
    assert.deepEqual(await service.store.records(), []);
    mock.setInstalled(true);
    mock.setEnabled(false);
    await assert.rejects(service.start(request), /disabled/);
    assert.equal(mock.forks, 0);
  });
});

test("diff start deduplicates concurrent calls, preserves prompts, and forces default mode on the fork", async () => {
  await withService(async (service, mock, home) => {
    const [first, second] = await Promise.all([
      service.start(request),
      service.start(request),
    ]);
    assert.deepEqual(first, second);
    assert.notEqual(first.status, "needs_skill_install");
    assert.equal(mock.forks, 1);
    assert.deepEqual(mock.forkSources, [request.sourceSessionId]);
    assert.equal(
      (await service.store.records())[0].parentSessionId,
      request.sourceSessionId,
    );
    assert.equal(mock.messages.length, 1);
    const message = mock.messages[0];
    assert.ok(message.input);
    assert.equal(message.threadId, "fork-1");
    assert.equal(message.collaborationMode?.mode, "default");
    const text = message.input[0].type === "text" ? message.input[0].text : "";
    assert.ok(text.endsWith(request.prompt));
    assert.ok(
      text.includes(
        join(home, "codex-deck", "diff", "sessions", "fork-1", "guide.json"),
      ),
    );
    assert.match(text, /--snapshot and --manifest/);
    const recreated = new DiffGuideService(
      new DiffGuideStore(home),
      () => mock.client,
      async () => "/repo",
      async () => "/repo",
    );
    await recreated.start(request);
    assert.equal(mock.forks, 1);
    assert.equal(mock.messages.length, 1);
    await assert.rejects(
      recreated.start({ ...request, sourceSessionId: "other" }),
      /different/,
    );
    await assert.rejects(
      recreated.start({ ...request, prompt: "another prompt" }),
      /different/,
    );
  });
});

test("selected install scope is included only for a missing skill", async () => {
  await withService(async (service, mock) => {
    mock.setInstalled(false);
    await service.start({ ...request, skillInstallChoice: "global" });
    const record = (await service.store.records())[0];
    const prompt = buildDiffGuidePrompt(
      record,
      service.store.directory(record.sessionId),
    );
    assert.match(prompt, /^\$skill-installer/);
    assert.match(prompt, /active CODEX_HOME global/);
    assert.match(prompt, /Stop and explain if installation fails/);
  });
});

test("startup failure retains fork metadata and explicit retry uses the same fork", async () => {
  await withService(async (service, mock) => {
    mock.setFailing(true);
    const result = await service.start(request);
    assert.equal(result.status, "failed");
    assert.equal((await service.store.records())[0].error, "Send failed");
    mock.setFailing(false);
    mock.setRunning(false);
    const retried = await service.start({ ...request, retry: true });
    assert.equal(retried.status, "started");
    assert.equal(mock.forks, 1);
    assert.equal(mock.messages.length, 2);
    mock.setRunning(true);
    await service.start({ ...request, retry: true });
    assert.equal(mock.messages.length, 2);
  });
});

test("preflight failures create no fork and non-Git directories produce a useful error", async () => {
  await withService(async (service, mock, home) => {
    const broken = new DiffGuideService(
      service.store,
      () => mock.client,
      async () => null,
    );
    await assert.rejects(broken.start(request), /project directory/);
    await assert.rejects(checkDiffGuideTools(home), /Git working tree/);
    assert.equal(mock.forks, 0);
  });
});

async function publish(store: DiffGuideStore, record: DiffGuideRecord) {
  const dir = store.directory(record.sessionId);
  const comparison = { kind: "worktree", fingerprint: "abc" };
  await writeFile(
    join(dir, "guide.json"),
    JSON.stringify({ comparison, steps: [{ id: "one" }] }),
  );
  await writeFile(join(dir, "snapshot.json"), JSON.stringify({ comparison }));
  await writeFile(
    join(dir, "diff-tour.html"),
    "<!doctype html><html><body>Guide</body></html>",
  );
}

test("readiness requires matching valid JSON and complete HTML; missing output after a completed turn is unavailable", async () => {
  await withService(async (service, mock) => {
    await service.start(request);
    const record = (await service.store.records())[0];
    const dir = service.store.directory(record.sessionId);
    mock.setRunning(false);
    assert.equal((await service.summary(record)).status, "unavailable");
    await writeFile(join(dir, "diff-tour.html"), "<html>");
    assert.equal(await service.store.content(record), null);
    await publish(service.store, record);
    assert.equal((await service.summary(record)).status, "ready");
    await writeFile(
      join(dir, "snapshot.json"),
      '{"comparison":{"fingerprint":"changed"}}',
    );
    assert.equal(await service.store.content(record), null);
    await writeFile(join(dir, "snapshot.json"), "{");
    assert.equal(await service.store.content(record), null);
  });
});

test("large repository snapshots remain ready and load through the guide route without regeneration", async () => {
  await withService(async (service, mock, home) => {
    await service.start(request);
    const record = (await service.store.records())[0];
    await publish(service.store, record);
    const dir = service.store.directory(record.sessionId);
    const snapshot = {
      comparison: { kind: "worktree", fingerprint: "abc" },
      right: {
        "large.txt": {
          mode: "100644",
          content: "A".repeat(33 * 1024 * 1024),
        },
      },
    };
    await writeFile(join(dir, "snapshot.json"), JSON.stringify(snapshot));
    mock.setRunning(false);
    assert.equal((await service.summary(record)).status, "ready");

    // A fresh route store also recognizes the files after a server restart.
    initStorage(home);
    setCodexAppServerClientForTests(mock.client);
    const app = new Hono();
    registerDiffGuideRoutes(app);
    try {
      const response = await app.request(
        `/api/diff-guides/${record.sessionId}`,
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.guide.status, "ready");
      assert.match(body.html, /Guide/);
      assert.equal("snapshot" in body, false);
      await app.request(`/api/diff-guides/${record.sessionId}/retry`, {
        method: "POST",
      });
      assert.equal(mock.messages.length, 1);
    } finally {
      setCodexAppServerClientForTests(null);
    }
  });
});

test("artifact directories are home-isolated, reject symlinks/traversal, and delete only owned files", async () => {
  await withService(async (service, mock, home) => {
    await service.start(request);
    const record = (await service.store.records())[0];
    await publish(service.store, record);
    const html = join(
      service.store.directory(record.sessionId),
      "diff-tour.html",
    );
    const otherHome = join(home, "other-home");
    await mkdir(otherHome);
    const otherStore = new DiffGuideStore(otherHome);
    assert.deepEqual(await otherStore.records(), []);
    await assert.rejects(service.store.read("../outside"), /Invalid/);
    const outside = join(home, "outside.html");
    await writeFile(outside, "private");
    await rm(html);
    await symlink(outside, html);
    await assert.rejects(service.store.content(record), /symbolic links/);
    await service.store.remove(record.sessionId);
    assert.equal(await readFile(outside, "utf8"), "private");
    assert.deepEqual(await service.store.records(), []);
    assert.equal(mock.forks, 1);
  });
});

test("artifact and retry routes return transport-compatible JSON and validate requests", async () => {
  await withService(async (service, mock, home) => {
    initStorage(home);
    setCodexAppServerClientForTests(mock.client);
    const app = new Hono();
    registerDiffGuideRoutes(app);
    try {
      let response = await app.request("/api/diff-guides/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: "source-session",
          requestId: "../escape",
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(mock.forks, 0);
      await service.start(request);
      const record = (await service.store.records())[0];
      response = await app.request(`/api/diff-guides/${record.sessionId}`);
      assert.equal((await response.json()).html, null);
      await publish(service.store, record);
      response = await app.request(`/api/diff-guides/${record.sessionId}`);
      assert.equal(response.headers.get("content-type"), "application/json");
      const body = await response.json();
      assert.equal(body.guide.status, "ready");
      assert.match(body.html, /Guide/);
      response = await app.request("/api/diff-guides");
      assert.equal(
        (await response.json())[0].parentSessionId,
        request.sourceSessionId,
      );
      response = await app.request(
        `/api/diff-guides/${record.sessionId}/retry`,
        { method: "POST" },
      );
      assert.equal(response.status, 200);
      assert.equal(mock.messages.length, 1);
      response = await app.request("/api/diff-guides/nonexistent");
      assert.equal(response.status, 404);
    } finally {
      setCodexAppServerClientForTests(null);
    }
  });
});
