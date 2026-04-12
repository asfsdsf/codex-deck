import {
  createRemoteOpaqueServerSetup,
  getRemoteOpaqueServerPublicKey,
} from "@codex-deck/wire";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

const REMOTE_AUTH_CONFIG_KEY = "remote-auth-config:v1";
const REMOTE_SETUP_TOKENS_KEY = "remote-setup-tokens:v1";
const REMOTE_ADMIN_PASSWORD_ENV = "CODEXDECK_REMOTE_ADMIN_PASSWORD";
const REMOTE_SETUP_TOKENS_ENV = "CODEXDECK_REMOTE_SETUP_TOKENS";
const REMOTE_BROWSER_PERSISTENCE_ENV =
  "CODEXDECK_REMOTE_BROWSER_AUTH_PERSISTENCE";
const REMOTE_AUTH_VERSION = 2;

const BrowserPersistenceModeSchema = z.enum(["session", "remember"]);
const RemoteAuthConfigSchema = z.object({
  realmId: z.string(),
  opaqueServerSetup: z.string(),
  adminPasswordHash: z.string(),
  adminPasswordSalt: z.string(),
  adminAuthVersion: z.number().int().nonnegative(),
  initializedAt: z.number().int().nonnegative(),
});
const RemoteSetupTokenRecordSchema = z.object({
  id: z.string(),
  label: z.string(),
  tokenHash: z.string(),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
});
const RemoteSetupTokenListSchema = z.array(RemoteSetupTokenRecordSchema);

export type BrowserPersistenceMode = z.infer<
  typeof BrowserPersistenceModeSchema
>;
export type RemoteAuthConfig = z.infer<typeof RemoteAuthConfigSchema>;
export type RemoteSetupTokenRecord = z.infer<
  typeof RemoteSetupTokenRecordSchema
>;

function parseSetupTokensFromEnv(): string[] {
  const configured = process.env[REMOTE_SETUP_TOKENS_ENV] || "";
  return configured
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getConfiguredBrowserPersistence(): BrowserPersistenceMode {
  const parsed = BrowserPersistenceModeSchema.safeParse(
    process.env[REMOTE_BROWSER_PERSISTENCE_ENV] || "remember",
  );
  return parsed.success ? parsed.data : "remember";
}

function normalizeAdminPassword(password: string): string {
  const normalized = password.normalize("NFKC");
  if (!normalized.trim()) {
    throw new Error("Admin password must not be empty");
  }
  return normalized;
}

function hashSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashAdminPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("base64");
}

function buildAdminPasswordRecord(password: string): {
  hash: string;
  salt: string;
} {
  const normalized = normalizeAdminPassword(password);
  const salt = randomBytes(16).toString("base64");
  return {
    salt,
    hash: hashAdminPassword(normalized, salt),
  };
}

async function readJsonCache<T>(
  key: string,
  schema: z.ZodSchema<T>,
): Promise<T | null> {
  const entry = await db.simpleCache.findUnique({
    where: { key },
    select: { value: true },
  });
  if (!entry) {
    return null;
  }

  try {
    return schema.parse(JSON.parse(entry.value));
  } catch {
    return null;
  }
}

async function writeJsonCache(key: string, value: unknown): Promise<void> {
  await db.simpleCache.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { key, value: JSON.stringify(value) },
  });
}

async function seedSetupTokensIfNeeded(): Promise<RemoteSetupTokenRecord[]> {
  const existing = await readJsonCache(
    REMOTE_SETUP_TOKENS_KEY,
    RemoteSetupTokenListSchema,
  );
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const seeded = parseSetupTokensFromEnv().map((token, index) => ({
    id: randomKeyNaked(12),
    label: `token-${index + 1}`,
    tokenHash: hashSetupToken(token),
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  })) satisfies RemoteSetupTokenRecord[];

  await writeJsonCache(REMOTE_SETUP_TOKENS_KEY, seeded);
  return seeded;
}

async function writeSetupTokens(
  tokens: RemoteSetupTokenRecord[],
): Promise<void> {
  await writeJsonCache(REMOTE_SETUP_TOKENS_KEY, tokens);
}

export async function getOrInitializeRemoteAuthConfig(): Promise<RemoteAuthConfig> {
  const existing = await readJsonCache(
    REMOTE_AUTH_CONFIG_KEY,
    RemoteAuthConfigSchema,
  );
  if (existing) {
    await seedSetupTokensIfNeeded();
    return existing;
  }

  const adminPassword = process.env[REMOTE_ADMIN_PASSWORD_ENV];
  if (!adminPassword || !adminPassword.trim()) {
    throw new Error(
      `${REMOTE_ADMIN_PASSWORD_ENV} must be set before using remote auth.`,
    );
  }

  const adminPasswordRecord = buildAdminPasswordRecord(adminPassword);
  const config: RemoteAuthConfig = {
    realmId: randomBytes(18).toString("base64url"),
    opaqueServerSetup: await createRemoteOpaqueServerSetup(),
    adminPasswordHash: adminPasswordRecord.hash,
    adminPasswordSalt: adminPasswordRecord.salt,
    adminAuthVersion: 0,
    initializedAt: Date.now(),
  };

  await writeJsonCache(REMOTE_AUTH_CONFIG_KEY, config);
  await seedSetupTokensIfNeeded();
  return config;
}

export async function getRemoteBootstrapConfig(): Promise<{
  remoteAuthVersion: 2;
  realmId: string;
  opaqueServerPublicKey: string;
  browserPersistence: BrowserPersistenceMode;
}> {
  const config = await getOrInitializeRemoteAuthConfig();
  return {
    remoteAuthVersion: REMOTE_AUTH_VERSION,
    realmId: config.realmId,
    opaqueServerPublicKey: await getRemoteOpaqueServerPublicKey(
      config.opaqueServerSetup,
    ),
    browserPersistence: getConfiguredBrowserPersistence(),
  };
}

export async function getRemoteOpaqueServerSetup(): Promise<string> {
  return (await getOrInitializeRemoteAuthConfig()).opaqueServerSetup;
}

export async function verifyRemoteAdminPassword(
  password: string,
): Promise<boolean> {
  const config = await getOrInitializeRemoteAuthConfig();
  const normalized = normalizeAdminPassword(password);
  const expected = Buffer.from(config.adminPasswordHash, "base64");
  const actual = Buffer.from(
    hashAdminPassword(normalized, config.adminPasswordSalt),
    "base64",
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function rotateRemoteAdminPassword(
  newPassword: string,
): Promise<RemoteAuthConfig> {
  const config = await getOrInitializeRemoteAuthConfig();
  const nextPasswordRecord = buildAdminPasswordRecord(newPassword);
  const nextConfig: RemoteAuthConfig = {
    ...config,
    adminPasswordHash: nextPasswordRecord.hash,
    adminPasswordSalt: nextPasswordRecord.salt,
    adminAuthVersion: config.adminAuthVersion + 1,
  };
  await writeJsonCache(REMOTE_AUTH_CONFIG_KEY, nextConfig);
  return nextConfig;
}

export async function listRemoteSetupTokens(): Promise<
  RemoteSetupTokenRecord[]
> {
  const tokens = await seedSetupTokensIfNeeded();
  return [...tokens].sort((left, right) => left.createdAt - right.createdAt);
}

export async function findRemoteSetupToken(
  rawToken: string,
): Promise<RemoteSetupTokenRecord | null> {
  if (!rawToken.trim()) {
    return null;
  }
  const tokens = await seedSetupTokensIfNeeded();
  const tokenHash = hashSetupToken(rawToken.trim());
  const record = tokens.find((token) => token.tokenHash === tokenHash);
  return record && record.enabled ? record : null;
}

export async function markRemoteSetupTokenUsed(tokenId: string): Promise<void> {
  const tokens = await seedSetupTokensIfNeeded();
  const now = Date.now();
  await writeSetupTokens(
    tokens.map((token) =>
      token.id === tokenId
        ? {
            ...token,
            updatedAt: now,
            lastUsedAt: now,
          }
        : token,
    ),
  );
}

function createRawSetupToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function createRemoteSetupToken(label: string): Promise<{
  record: RemoteSetupTokenRecord;
  rawToken: string;
}> {
  const tokens = await seedSetupTokensIfNeeded();
  const rawToken = createRawSetupToken();
  const now = Date.now();
  const record: RemoteSetupTokenRecord = {
    id: randomKeyNaked(12),
    label: label.trim() || `token-${tokens.length + 1}`,
    tokenHash: hashSetupToken(rawToken),
    enabled: true,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };

  await writeSetupTokens([...tokens, record]);
  return { record, rawToken };
}

export async function updateRemoteSetupToken(
  id: string,
  patch: {
    label?: string;
    enabled?: boolean;
  },
): Promise<RemoteSetupTokenRecord | null> {
  const tokens = await seedSetupTokensIfNeeded();
  const target = tokens.find((token) => token.id === id);
  if (!target) {
    return null;
  }

  const next: RemoteSetupTokenRecord = {
    ...target,
    label:
      typeof patch.label === "string"
        ? patch.label.trim() || target.label
        : target.label,
    enabled:
      typeof patch.enabled === "boolean" ? patch.enabled : target.enabled,
    updatedAt: Date.now(),
  };
  await writeSetupTokens(
    tokens.map((token) => (token.id === id ? next : token)),
  );
  return next;
}

export async function deleteRemoteSetupToken(id: string): Promise<boolean> {
  const tokens = await seedSetupTokensIfNeeded();
  const nextTokens = tokens.filter((token) => token.id !== id);
  if (nextTokens.length === tokens.length) {
    return false;
  }
  await writeSetupTokens(nextTokens);
  return true;
}

export async function regenerateRemoteSetupToken(id: string): Promise<{
  record: RemoteSetupTokenRecord;
  rawToken: string;
} | null> {
  const tokens = await seedSetupTokensIfNeeded();
  const target = tokens.find((token) => token.id === id);
  if (!target) {
    return null;
  }

  const rawToken = createRawSetupToken();
  const next: RemoteSetupTokenRecord = {
    ...target,
    tokenHash: hashSetupToken(rawToken),
    updatedAt: Date.now(),
    lastUsedAt: null,
  };
  await writeSetupTokens(
    tokens.map((token) => (token.id === id ? next : token)),
  );
  return { record: next, rawToken };
}
