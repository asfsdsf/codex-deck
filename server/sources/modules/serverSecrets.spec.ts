import { beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

describe("serverSecrets", () => {
  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.CODEXDECK_MASTER_SECRET;
    delete process.env.CODEXDECK_TOKEN_SIGNING_SECRET;
    delete process.env.CODEXDECK_SERVER_ENCRYPTION_SECRET;

    vi.resetModules();
  });

  it("rejects the removed CODEXDECK_MASTER_SECRET fallback", async () => {
    process.env.CODEXDECK_MASTER_SECRET = "legacy-secret";

    const mod = await import("./serverSecrets");

    await expect(mod.getServerSecrets()).rejects.toThrow(
      "CODEXDECK_MASTER_SECRET has been removed",
    );
  });

  it("uses explicit split secrets when provided", async () => {
    process.env.CODEXDECK_TOKEN_SIGNING_SECRET = "token-secret";
    process.env.CODEXDECK_SERVER_ENCRYPTION_SECRET = "encryption-secret";

    const mod = await import("./serverSecrets");
    const secrets = await mod.getServerSecrets();

    expect(secrets.tokenSigningSecret).toBe("token-secret");
    expect(secrets.serverEncryptionSecret).toBe("encryption-secret");
  });
});
