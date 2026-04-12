import fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fastify } from "../types";
import { REMOTE_BROWSER_SESSION_COOKIE } from "@/app/auth/remoteAuthConstants";

const authMock = vi.hoisted(() => ({
  verifyToken: vi.fn(async (_token: string) => null),
  verifyBrowserSessionToken: vi.fn<(token: string) => Promise<any>>(
    async (_token: string) => null,
  ),
}));

vi.mock("@/app/auth/auth", () => ({
  auth: authMock,
}));

import { enableAuthentication } from "./enableAuthentication";

describe("enableAuthentication", () => {
  let app: Fastify;

  beforeEach(async () => {
    authMock.verifyToken.mockReset();
    authMock.verifyBrowserSessionToken.mockReset();
    authMock.verifyToken.mockResolvedValue(null);
    authMock.verifyBrowserSessionToken.mockResolvedValue(null);

    const instance = fastify();
    app = instance as unknown as Fastify;
    enableAuthentication(app);

    app.get(
      "/protected",
      {
        preHandler: (app as any).authenticate,
      },
      async (request: any) => ({
        userId: request.userId,
        clientKind: request.authContext?.clientKind,
        session: request.authContext?.session,
      }),
    );

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("falls back to browser session cookie when bearer auth fails", async () => {
    authMock.verifyBrowserSessionToken
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async (token: string) => {
        if (token === "cookie-token") {
          return {
            userId: "account-1",
            authVersion: 0,
            extras: {
              clientKind: "browser",
              session: "browser-cookie",
            },
          };
        }
        return null;
      });

    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: "Bearer stale-bearer-token",
        cookie: `${REMOTE_BROWSER_SESSION_COOKIE}=cookie-token`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: "account-1",
      clientKind: "browser",
      session: "browser-cookie",
    });
    expect(authMock.verifyToken).toHaveBeenCalledWith("stale-bearer-token");
    expect(authMock.verifyBrowserSessionToken).toHaveBeenNthCalledWith(
      1,
      "stale-bearer-token",
    );
    expect(authMock.verifyBrowserSessionToken).toHaveBeenNthCalledWith(
      2,
      "cookie-token",
    );
  });

  it("returns 401 when both bearer token and cookie are invalid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: "Bearer stale-bearer-token",
        cookie: `${REMOTE_BROWSER_SESSION_COOKIE}=invalid-cookie-token`,
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "Invalid token",
    });
  });
});
