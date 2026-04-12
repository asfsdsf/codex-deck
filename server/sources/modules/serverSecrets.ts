import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { log } from "@/utils/log";

const TOKEN_SIGNING_SECRET_ENV = "CODEXDECK_TOKEN_SIGNING_SECRET";
const SERVER_ENCRYPTION_SECRET_ENV = "CODEXDECK_SERVER_ENCRYPTION_SECRET";
const REMOVED_MASTER_SECRET_ENV = "CODEXDECK_MASTER_SECRET";
const DEFAULT_DATA_DIR = "./data";
const SERVER_SECRETS_FILE = "server-secrets.json";

const ServerSecretsSchema = z.object({
  version: z.literal(1),
  tokenSigningSecret: z.string().min(1),
  serverEncryptionSecret: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});

export type ServerSecrets = z.infer<typeof ServerSecretsSchema>;

let cachedSecrets: ServerSecrets | null = null;
let loadingSecrets: Promise<ServerSecrets> | null = null;

function getDataDir(): string {
  return process.env.DATA_DIR || DEFAULT_DATA_DIR;
}

function getSecretsFilePath(): string {
  return path.join(getDataDir(), SERVER_SECRETS_FILE);
}

function normalizeOptionalSecret(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

function ensureDataDir(): void {
  fs.mkdirSync(getDataDir(), { recursive: true });
}

function readPersistedSecrets(): ServerSecrets | null {
  const filePath = getSecretsFilePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return ServerSecretsSchema.parse(parsed);
  } catch {
    return null;
  }
}

function writePersistedSecrets(secrets: ServerSecrets): void {
  ensureDataDir();
  const filePath = getSecretsFilePath();
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(secrets, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort only on platforms/filesystems that support chmod.
  }
}

function loadSecretsFromStorage(): ServerSecrets {
  const persisted = readPersistedSecrets();
  if (persisted) {
    return persisted;
  }

  const created = {
    version: 1 as const,
    tokenSigningSecret: generateSecret(),
    serverEncryptionSecret: generateSecret(),
    createdAt: Date.now(),
  };
  writePersistedSecrets(created);
  log(
    { module: "server-secrets" },
    `Generated persistent server secrets at ${getSecretsFilePath()}`,
  );
  return created;
}

function resolveServerSecrets(): ServerSecrets {
  const explicitTokenSigningSecret = normalizeOptionalSecret(
    process.env[TOKEN_SIGNING_SECRET_ENV],
  );
  const explicitServerEncryptionSecret = normalizeOptionalSecret(
    process.env[SERVER_ENCRYPTION_SECRET_ENV],
  );
  if (normalizeOptionalSecret(process.env[REMOVED_MASTER_SECRET_ENV])) {
    throw new Error(
      `${REMOVED_MASTER_SECRET_ENV} has been removed. Unset it and use ${TOKEN_SIGNING_SECRET_ENV}/${SERVER_ENCRYPTION_SECRET_ENV}, or let the server persist internal secrets automatically.`,
    );
  }

  const needsPersistedSecrets =
    !explicitTokenSigningSecret || !explicitServerEncryptionSecret;
  const persistedSecrets = needsPersistedSecrets
    ? loadSecretsFromStorage()
    : null;

  return {
    version: 1,
    tokenSigningSecret:
      explicitTokenSigningSecret || persistedSecrets!.tokenSigningSecret,
    serverEncryptionSecret:
      explicitServerEncryptionSecret ||
      persistedSecrets!.serverEncryptionSecret,
    createdAt: persistedSecrets?.createdAt || Date.now(),
  };
}

export async function getServerSecrets(): Promise<ServerSecrets> {
  if (cachedSecrets) {
    return cachedSecrets;
  }
  if (loadingSecrets) {
    return loadingSecrets;
  }

  loadingSecrets = Promise.resolve(resolveServerSecrets()).then((secrets) => {
    cachedSecrets = secrets;
    loadingSecrets = null;
    return secrets;
  });
  return loadingSecrets;
}

export async function getTokenSigningSecret(): Promise<string> {
  return (await getServerSecrets()).tokenSigningSecret;
}

export async function getServerEncryptionSecret(): Promise<string> {
  return (await getServerSecrets()).serverEncryptionSecret;
}
