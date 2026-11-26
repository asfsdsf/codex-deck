import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { HTTPException } from "hono/http-exception";
import type { CodexHomeDescriptor } from "./storage";
import type {
  LlmConversation,
  LlmProviderInput,
  LlmProviderSettings,
  LlmTurn,
} from "./llm-types";
import { createSerializedRunner } from "./serialized-runner";

type StoredProvider = LlmProviderInput & { revision?: string };
// Providers created before settings were editable have no revision on disk.
const INITIAL_REVISION = "initial";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

function validId(id: string) {
  if (!UUID.test(id)) throw new HTTPException(404, { message: "Unknown ID" });
  return id;
}

function hasCode(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException)?.code === code;
}

async function entries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function writeJson(path: string, value: unknown, exclusive = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    // Publishing a complete file with link() claims a turn across daemon processes.
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function endpoint(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HTTPException(400, {
      message: "Enter an HTTP or HTTPS API URL.",
    });
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new HTTPException(400, {
      message:
        "Use an HTTP or HTTPS API URL without embedded credentials or fragments.",
    });
  }
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = base.endsWith("/chat/completions")
    ? base
    : (base || "/v1") + "/chat/completions";
  return url.href;
}

function describe(id: string, provider: StoredProvider): CodexHomeDescriptor {
  return {
    id: "llm:" + id,
    kind: "llm",
    label: provider.label,
    model: provider.model,
    providerRevision: provider.revision ?? INITIAL_REVISION,
    isMain: false,
    available: true,
    unavailableReason: null,
  };
}

async function readTurn(path: string): Promise<LlmTurn> {
  const turn: LlmTurn = JSON.parse(await readFile(path, "utf8"));
  // A daemon may have exited while the upstream request was running.
  if (
    !turn.assistant &&
    !turn.error &&
    Date.now() - turn.startedAt > REQUEST_TIMEOUT_MS + 10_000
  ) {
    turn.error =
      "The provider request was interrupted. Send the message again to retry.";
  }
  return turn;
}

export class LlmConversations {
  private readonly changeProvider = createSerializedRunner();
  private readonly providersDir: string;
  private readonly historyDir: string;
  constructor(codexHome: string) {
    this.providersDir = join(codexHome, "codex-deck", "providers");
    this.historyDir = join(codexHome, "codex-deck", "conversation");
  }

  private async provider(id: string): Promise<StoredProvider> {
    try {
      return JSON.parse(
        await readFile(join(this.providersDir, validId(id) + ".json"), "utf8"),
      );
    } catch (error) {
      if (hasCode(error, "ENOENT"))
        throw new HTTPException(404, { message: "Provider not found" });
      throw error;
    }
  }

  async providers() {
    const files = (await entries(this.providersDir)).filter(
      (file) =>
        file.isFile() &&
        file.name.endsWith(".json") &&
        UUID.test(file.name.slice(0, -5)),
    );
    const providers = await Promise.all(
      files.map(async (file) => {
        const id = file.name.slice(0, -5);
        try {
          return describe(id, await this.provider(id));
        } catch (error) {
          if (error instanceof HTTPException && error.status === 404)
            return null;
          throw error;
        }
      }),
    );
    return providers
      .filter((p) => p !== null)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  private normalizeProvider(input: Partial<LlmProviderInput>) {
    const { label, url, model, apiKey } = input;
    if (
      typeof label !== "string" ||
      !label.trim() ||
      typeof model !== "string" ||
      !model.trim() ||
      typeof url !== "string" ||
      (apiKey != null && (typeof apiKey !== "string" || /[\r\n]/.test(apiKey)))
    ) {
      throw new HTTPException(400, {
        message: "Enter a provider name, API URL and model ID.",
      });
    }
    return {
      label: label.trim(),
      url: endpoint(url),
      model: model.trim(),
      apiKey: apiKey?.trim(),
      revision: randomUUID(),
    };
  }

  async addProvider(input: Partial<LlmProviderInput>) {
    const provider = this.normalizeProvider(input);
    const id = randomUUID();
    await writeJson(join(this.providersDir, id + ".json"), provider, true);
    return describe(id, provider);
  }

  async settings(id: string): Promise<LlmProviderSettings> {
    const { label, model, url, apiKey, revision } = await this.provider(id);
    return {
      label,
      model,
      url,
      hasApiKey: Boolean(apiKey),
      revision: revision ?? INITIAL_REVISION,
    };
  }

  private async providerAtRevision(id: string, revision: unknown) {
    const current = await this.provider(id);
    if (revision !== (current.revision ?? INITIAL_REVISION)) {
      throw new HTTPException(409, {
        message:
          "Provider settings changed. Reopen the provider to use the latest settings.",
      });
    }
    return current;
  }

  updateProvider(
    id: string,
    input: Partial<LlmProviderInput> & { revision?: string },
  ) {
    return this.changeProvider(async () => {
      const current = await this.providerAtRevision(id, input.revision);
      const next = this.normalizeProvider(input);
      if (
        input.apiKey === undefined &&
        new URL(next.url).origin === new URL(current.url).origin
      ) {
        next.apiKey = current.apiKey;
      }
      await writeJson(join(this.providersDir, id + ".json"), next);
      return describe(id, next);
    });
  }

  removeProvider(id: string, revision: string | undefined) {
    return this.changeProvider(async () => {
      await this.providerAtRevision(id, revision);
      await rm(join(this.providersDir, id + ".json"));
    });
  }

  private directory(providerId: string, conversationId: string) {
    return join(this.historyDir, validId(providerId), validId(conversationId));
  }

  private async turnFiles(dir: string) {
    return (await entries(dir))
      .filter((file) => file.isFile() && /^\d+\.json$/.test(file.name))
      .map((file) => file.name)
      .sort((a, b) => parseInt(a) - parseInt(b));
  }

  async list(providerId: string) {
    await this.provider(providerId);
    const dirs = await entries(join(this.historyDir, providerId));
    const summaries = await Promise.all(
      dirs
        .filter((entry) => entry.isDirectory() && UUID.test(entry.name))
        .map(async ({ name: id }) => {
          const dir = this.directory(providerId, id);
          const files = await this.turnFiles(dir);
          if (!files.length) return null;
          const first = await readTurn(join(dir, files[0]));
          const last =
            files.length === 1
              ? first
              : await readTurn(join(dir, files[files.length - 1]));
          return {
            id,
            title: first.user.slice(0, 100),
            updatedAt: last.startedAt,
          };
        }),
    );
    return summaries
      .filter((s) => s !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(providerId: string, id: string): Promise<LlmConversation> {
    const dir = this.directory(providerId, id);
    const files = await this.turnFiles(dir);
    if (!files.length)
      throw new HTTPException(404, { message: "Conversation not found" });
    const turns = await Promise.all(
      files.map((file) => readTurn(join(dir, file))),
    );
    return {
      id,
      title: turns[0].user.slice(0, 100),
      updatedAt: turns[turns.length - 1].startedAt,
      turns,
    };
  }

  async send(
    providerId: string,
    id: string,
    input: { requestId?: unknown; message?: unknown; expectedTurns?: unknown },
  ) {
    const { message, requestId, expectedTurns } = input;
    if (
      typeof message !== "string" ||
      !message.trim() ||
      typeof requestId !== "string" ||
      !requestId ||
      requestId.length > 128 ||
      typeof expectedTurns !== "number" ||
      !Number.isSafeInteger(expectedTurns) ||
      expectedTurns < 0
    ) {
      throw new HTTPException(400, { message: "Invalid conversation turn" });
    }
    const provider = await this.provider(providerId);
    const dir = this.directory(providerId, id);
    const files = await this.turnFiles(dir);
    const conflict = new HTTPException(409, {
      message:
        "This conversation changed. Review the latest reply before sending.",
    });
    if (files[expectedTurns]) {
      const existing = await readTurn(join(dir, files[expectedTurns]));
      if (existing.requestId === requestId && existing.user === message) return;
      throw conflict;
    }
    if (files.length !== expectedTurns) throw conflict;
    const history = await Promise.all(
      files.map((file) => readTurn(join(dir, file))),
    );
    if (history.some((turn) => !turn.assistant && !turn.error)) throw conflict;
    const path = join(dir, expectedTurns + ".json");
    const turn = { requestId, startedAt: Date.now(), user: message };
    try {
      await writeJson(path, turn, true);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await readTurn(path);
      if (existing.requestId === requestId && existing.user === message) return;
      throw conflict;
    }
    // Return the receipt before waiting on inference, including for short-lived relay RPCs.
    void this.complete(provider, history, turn, path).catch(() => {
      console.error(
        "[codex-deck] Could not persist a provider reply for conversation",
        id,
      );
    });
  }

  private async complete(
    provider: LlmProviderInput,
    history: LlmTurn[],
    turn: LlmTurn,
    path: string,
  ) {
    const messages = history.flatMap((previous) =>
      previous.assistant
        ? [
            { role: "user", content: previous.user },
            { role: "assistant", content: previous.assistant },
          ]
        : [],
    );
    messages.push({ role: "user", content: turn.user });
    let result: Pick<LlmTurn, "assistant" | "error">;
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey && {
            Authorization: "Bearer " + provider.apiKey,
          }),
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          stream: false,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        result = { error: "Provider returned HTTP " + response.status + "." };
      } else {
        const payload = await response.json();
        const message = payload?.choices?.[0]?.message;
        const content = message?.content || message?.refusal;
        result =
          typeof content === "string" && content.trim()
            ? { assistant: content }
            : { error: "The provider returned an empty or unsupported reply." };
      }
    } catch {
      result = {
        error:
          "Could not read a reply from the provider. Check the API URL and connection.",
      };
    }
    await writeJson(path, { ...turn, ...result });
  }
}
