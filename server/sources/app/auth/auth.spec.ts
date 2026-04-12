import { beforeEach, describe, expect, it, vi } from "vitest";

type AccountRecord = {
  id: string;
  authVersion: number;
};

const { state, resetState } = vi.hoisted(() => {
  const state = {
    accounts: new Map<string, AccountRecord>(),
  };

  const resetState = () => {
    state.accounts = new Map<string, AccountRecord>();
  };

  return { state, resetState };
});

vi.mock("@/storage/db", () => ({
  db: {
    account: {
      findUnique: vi.fn(async (args: any) => {
        const accountId = args?.where?.id as string | undefined;
        if (!accountId) {
          return null;
        }
        const account = state.accounts.get(accountId);
        if (!account) {
          return null;
        }
        if (args?.select?.authVersion) {
          return { authVersion: account.authVersion };
        }
        return { ...account };
      }),
    },
  },
}));

import { auth } from "./auth";

describe("auth", () => {
  beforeEach(async () => {
    resetState();
    state.accounts.set("account-1", { id: "account-1", authVersion: 0 });
    process.env.CODEXDECK_TOKEN_SIGNING_SECRET = "test-token-signing-secret";
    process.env.CODEXDECK_SERVER_ENCRYPTION_SECRET =
      "test-server-encryption-secret";
    delete process.env.CODEXDECK_MASTER_SECRET;
    auth.invalidateUserTokens("account-1");
    await auth.init();
  });

  it("creates tokens that verify against the current authVersion", async () => {
    const token = await auth.createToken("account-1", {
      clientKind: "browser",
    });
    const verified = await auth.verifyToken(token);

    expect(verified).toMatchObject({
      userId: "account-1",
      authVersion: 0,
      extras: {
        clientKind: "browser",
      },
    });
  });

  it("rejects tokens after authVersion changes", async () => {
    const token = await auth.createToken("account-1", {
      clientKind: "browser",
    });
    expect(await auth.verifyToken(token)).not.toBeNull();

    state.accounts.set("account-1", { id: "account-1", authVersion: 1 });

    await expect(auth.verifyToken(token)).resolves.toBeNull();
  });
});
