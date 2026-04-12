import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { getTokenSigningSecret } from "@/modules/serverSecrets";

interface TokenCacheEntry {
  userId: string;
  authVersion: number;
  extras?: AuthTokenExtras;
  cachedAt: number;
}

export type AuthClientKind = "browser" | "cli" | "api";

export interface AuthTokenExtras extends Record<string, unknown> {
  clientKind?: AuthClientKind;
  issuedVia?: "setup-token" | "signature" | "opaque";
  machineId?: string;
  session?: string;
}

export interface VerifiedAuthToken {
  userId: string;
  authVersion: number;
  extras?: AuthTokenExtras;
}

export interface VerifiedAdminSessionToken {
  authVersion: number;
}

interface AuthTokens {
  generator: Awaited<
    ReturnType<typeof privacyKit.createPersistentTokenGenerator>
  >;
  verifier: Awaited<
    ReturnType<typeof privacyKit.createPersistentTokenVerifier>
  >;
  browserSessionGenerator: Awaited<
    ReturnType<typeof privacyKit.createEphemeralTokenGenerator>
  >;
  browserRememberGenerator: Awaited<
    ReturnType<typeof privacyKit.createEphemeralTokenGenerator>
  >;
  browserSessionVerifier: Awaited<
    ReturnType<typeof privacyKit.createEphemeralTokenVerifier>
  >;
  adminSessionGenerator: Awaited<
    ReturnType<typeof privacyKit.createEphemeralTokenGenerator>
  >;
  adminSessionVerifier: Awaited<
    ReturnType<typeof privacyKit.createEphemeralTokenVerifier>
  >;
  githubVerifier: Awaited<
    ReturnType<typeof privacyKit.createEphemeralTokenVerifier>
  >;
  githubGenerator: Awaited<
    ReturnType<typeof privacyKit.createEphemeralTokenGenerator>
  >;
}

class AuthModule {
  private tokenCache = new Map<string, TokenCacheEntry>();
  private tokens: AuthTokens | null = null;

  async init(): Promise<void> {
    if (this.tokens) {
      return; // Already initialized
    }

    log({ module: "auth" }, "Initializing auth module...");
    const tokenSigningSecret = await getTokenSigningSecret();

    const generator = await privacyKit.createPersistentTokenGenerator({
      service: "codexdeck",
      seed: tokenSigningSecret,
    });

    const verifier = await privacyKit.createPersistentTokenVerifier({
      service: "codexdeck",
      publicKey: Uint8Array.from(generator.publicKey),
    });

    const browserSessionGenerator =
      await privacyKit.createEphemeralTokenGenerator({
        service: "codexdeck-browser-session",
        seed: tokenSigningSecret,
        ttl: 7 * 24 * 60 * 60 * 1000,
      });

    const browserRememberGenerator =
      await privacyKit.createEphemeralTokenGenerator({
        service: "codexdeck-browser-session",
        seed: tokenSigningSecret,
        ttl: 30 * 24 * 60 * 60 * 1000,
      });

    const browserSessionVerifier =
      await privacyKit.createEphemeralTokenVerifier({
        service: "codexdeck-browser-session",
        publicKey: Uint8Array.from(browserSessionGenerator.publicKey),
      });

    const adminSessionGenerator =
      await privacyKit.createEphemeralTokenGenerator({
        service: "codexdeck-admin-session",
        seed: tokenSigningSecret,
        ttl: 12 * 60 * 60 * 1000,
      });

    const adminSessionVerifier = await privacyKit.createEphemeralTokenVerifier({
      service: "codexdeck-admin-session",
      publicKey: Uint8Array.from(adminSessionGenerator.publicKey),
    });

    const githubGenerator = await privacyKit.createEphemeralTokenGenerator({
      service: "github-codexdeck",
      seed: tokenSigningSecret,
      ttl: 5 * 60 * 1000, // 5 minutes
    });

    const githubVerifier = await privacyKit.createEphemeralTokenVerifier({
      service: "github-codexdeck",
      publicKey: Uint8Array.from(githubGenerator.publicKey),
    });

    this.tokens = {
      generator,
      verifier,
      browserSessionGenerator,
      browserRememberGenerator,
      browserSessionVerifier,
      adminSessionGenerator,
      adminSessionVerifier,
      githubVerifier,
      githubGenerator,
    };

    log({ module: "auth" }, "Auth module initialized");
  }

  async createToken(userId: string, extras?: AuthTokenExtras): Promise<string> {
    if (!this.tokens) {
      throw new Error("Auth module not initialized");
    }

    const account = await db.account.findUnique({
      where: { id: userId },
      select: { authVersion: true },
    });
    if (!account) {
      throw new Error(`Account not found for token creation: ${userId}`);
    }

    const token = await this.tokens.generator.new({
      user: userId,
      extras: {
        ...(extras || {}),
        av: account.authVersion,
      },
    } as unknown as {
      user?: string;
      extras?: Record<string, unknown>;
    });

    // Cache the token immediately
    this.tokenCache.set(token, {
      userId,
      authVersion: account.authVersion,
      extras,
      cachedAt: Date.now(),
    });

    return token;
  }

  async verifyToken(token: string): Promise<VerifiedAuthToken | null> {
    // Check cache first
    const cached = this.tokenCache.get(token);
    if (cached) {
      return this.validateCachedToken(cached);
    }

    // Cache miss - verify token
    if (!this.tokens) {
      throw new Error("Auth module not initialized");
    }

    try {
      const verifiedPayload = await this.tokens.verifier.verify(token);
      if (!verifiedPayload) {
        return null;
      }
      const verified = verifiedPayload as {
        user?: string | null;
        av?: number;
        extras?: Record<string, unknown>;
      };

      const userId = verified.user as string;
      const authVersion =
        typeof verified.av === "number"
          ? verified.av
          : typeof verified.extras?.av === "number"
            ? (verified.extras.av as number)
            : null;
      if (authVersion === null) {
        return null;
      }
      const extras = verified.extras as AuthTokenExtras | undefined;

      const validated = await this.validateAccountVersion(
        userId,
        authVersion,
        extras,
      );
      if (!validated) {
        return null;
      }

      // Cache the result permanently
      this.tokenCache.set(token, {
        userId,
        authVersion,
        extras,
        cachedAt: Date.now(),
      });

      return validated;
    } catch (error) {
      log(
        { module: "auth", level: "error" },
        `Token verification failed: ${error}`,
      );
      return null;
    }
  }

  invalidateUserTokens(userId: string): void {
    // Remove all tokens for a specific user
    // This is expensive but rarely needed
    for (const [token, entry] of this.tokenCache.entries()) {
      if (entry.userId === userId) {
        this.tokenCache.delete(token);
      }
    }

    log({ module: "auth" }, `Invalidated tokens for user: ${userId}`);
  }

  invalidateToken(token: string): void {
    this.tokenCache.delete(token);
  }

  getCacheStats(): { size: number; oldestEntry: number | null } {
    if (this.tokenCache.size === 0) {
      return { size: 0, oldestEntry: null };
    }

    let oldest = Date.now();
    for (const entry of this.tokenCache.values()) {
      if (entry.cachedAt < oldest) {
        oldest = entry.cachedAt;
      }
    }

    return {
      size: this.tokenCache.size,
      oldestEntry: oldest,
    };
  }

  async createGithubToken(userId: string): Promise<string> {
    if (!this.tokens) {
      throw new Error("Auth module not initialized");
    }

    const payload = { user: userId, purpose: "github-oauth" };
    const token = await this.tokens.githubGenerator.new(payload);

    return token;
  }

  async verifyGithubToken(token: string): Promise<{ userId: string } | null> {
    if (!this.tokens) {
      throw new Error("Auth module not initialized");
    }

    try {
      const verified = await this.tokens.githubVerifier.verify(token);
      if (!verified) {
        return null;
      }

      return { userId: verified.user as string };
    } catch (error) {
      log(
        { module: "auth", level: "error" },
        `GitHub token verification failed: ${error}`,
      );
      return null;
    }
  }

  async createBrowserSessionToken(
    userId: string,
    remember: boolean,
  ): Promise<string> {
    if (!this.tokens) {
      throw new Error("Auth module not initialized");
    }

    const account = await db.account.findUnique({
      where: { id: userId },
      select: { authVersion: true },
    });
    if (!account) {
      throw new Error(`Account not found for browser session: ${userId}`);
    }

    const generator = remember
      ? this.tokens.browserRememberGenerator
      : this.tokens.browserSessionGenerator;
    return generator.new({
      user: userId,
      extras: {
        clientKind: "browser",
        issuedVia: "opaque",
        session: "browser-cookie",
        av: account.authVersion,
      },
    });
  }

  async verifyBrowserSessionToken(
    token: string,
  ): Promise<VerifiedAuthToken | null> {
    if (!this.tokens) {
      throw new Error("Auth module not initialized");
    }

    try {
      const verifiedPayload =
        await this.tokens.browserSessionVerifier.verify(token);
      if (!verifiedPayload) {
        return null;
      }
      const verified = verifiedPayload as {
        user?: string | null;
        av?: number;
        extras?: Record<string, unknown>;
      };
      const userId = verified.user as string;
      const authVersion =
        typeof verified.av === "number"
          ? verified.av
          : typeof verified.extras?.av === "number"
            ? (verified.extras.av as number)
            : null;
      if (authVersion === null) {
        return null;
      }

      return this.validateAccountVersion(
        userId,
        authVersion,
        verified.extras as AuthTokenExtras | undefined,
      );
    } catch (error) {
      log(
        { module: "auth", level: "error" },
        `Browser session verification failed: ${error}`,
      );
      return null;
    }
  }

  async createAdminSessionToken(authVersion: number): Promise<string> {
    if (!this.tokens) {
      throw new Error("Auth module not initialized");
    }
    return this.tokens.adminSessionGenerator.new({
      user: "remote-admin",
      extras: {
        purpose: "remote-admin",
        av: authVersion,
      },
    });
  }

  async verifyAdminSessionToken(
    token: string,
  ): Promise<VerifiedAdminSessionToken | null> {
    if (!this.tokens) {
      throw new Error("Auth module not initialized");
    }

    try {
      const verifiedPayload =
        await this.tokens.adminSessionVerifier.verify(token);
      if (!verifiedPayload) {
        return null;
      }
      const verified = verifiedPayload as {
        user?: string | null;
        av?: number;
        extras?: Record<string, unknown>;
      };
      const authVersion =
        typeof verified.av === "number"
          ? verified.av
          : typeof verified.extras?.av === "number"
            ? (verified.extras.av as number)
            : null;
      if (verified.user !== "remote-admin" || authVersion === null) {
        return null;
      }
      if (verified.extras?.purpose !== "remote-admin") {
        return null;
      }
      return { authVersion };
    } catch (error) {
      log(
        { module: "auth", level: "error" },
        `Admin session verification failed: ${error}`,
      );
      return null;
    }
  }

  // Cleanup old entries (optional - can be called periodically)
  cleanup(): void {
    // Note: Since tokens are cached "forever" as requested,
    // we don't do automatic cleanup. This method exists if needed later.
    const stats = this.getCacheStats();
    log({ module: "auth" }, `Token cache size: ${stats.size} entries`);
  }

  private async validateCachedToken(
    entry: TokenCacheEntry,
  ): Promise<VerifiedAuthToken | null> {
    return this.validateAccountVersion(
      entry.userId,
      entry.authVersion,
      entry.extras,
    );
  }

  private async validateAccountVersion(
    userId: string,
    authVersion: number,
    extras?: AuthTokenExtras,
  ): Promise<VerifiedAuthToken | null> {
    const account = await db.account.findUnique({
      where: { id: userId },
      select: { authVersion: true },
    });
    if (!account || account.authVersion !== authVersion) {
      return null;
    }
    return {
      userId,
      authVersion,
      extras,
    };
  }
}

// Global instance
export const auth = new AuthModule();
