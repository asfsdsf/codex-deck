import { Fastify } from "../types";
import { log } from "@/utils/log";
import { auth, type VerifiedAuthToken } from "@/app/auth/auth";
import { parseCookieHeader } from "@/app/auth/httpCookies";
import { REMOTE_BROWSER_SESSION_COOKIE } from "@/app/auth/remoteAuthConstants";

export function enableAuthentication(app: Fastify) {
  app.decorate("authenticate", async function (request: any, reply: any) {
    try {
      const authHeader = request.headers.authorization;
      const cookieToken = parseCookieHeader(request.headers.cookie)[
        REMOTE_BROWSER_SESSION_COOKIE
      ];

      const setAuthContextFromVerified = (
        verified: VerifiedAuthToken,
        source: "bearer" | "cookie",
      ) => {
        request.userId = verified.userId;
        request.authContext = {
          authVersion: verified.authVersion,
          clientKind:
            source === "cookie" ? "browser" : verified.extras?.clientKind,
          issuedVia: verified.extras?.issuedVia,
          machineId: verified.extras?.machineId,
          session:
            source === "cookie" ? "browser-cookie" : verified.extras?.session,
        };
      };

      log(
        { module: "auth-decorator" },
        `Auth check - path: ${request.url}, has header: ${!!authHeader}, has cookie: ${!!cookieToken}`,
      );

      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.substring(7);
        const verifiedBearer =
          (await auth.verifyToken(token)) ||
          (await auth.verifyBrowserSessionToken(token));
        if (verifiedBearer) {
          log(
            { module: "auth-decorator" },
            `Auth success via bearer - user: ${verifiedBearer.userId}`,
          );
          setAuthContextFromVerified(verifiedBearer, "bearer");
          return;
        }

        if (cookieToken) {
          const verifiedCookie =
            await auth.verifyBrowserSessionToken(cookieToken);
          if (verifiedCookie) {
            log(
              { module: "auth-decorator" },
              `Auth success via cookie fallback after bearer rejection - user: ${verifiedCookie.userId}`,
            );
            setAuthContextFromVerified(verifiedCookie, "cookie");
            return;
          }
        }

        log({ module: "auth-decorator" }, `Auth failed - invalid bearer token`);
        return reply.code(401).send({ error: "Invalid token" });
      }

      if (!cookieToken) {
        log(
          { module: "auth-decorator" },
          `Auth failed - missing bearer token and browser session cookie`,
        );
        return reply.code(401).send({ error: "Missing authorization header" });
      }

      const verified = await auth.verifyBrowserSessionToken(cookieToken);
      if (!verified) {
        log(
          { module: "auth-decorator" },
          `Auth failed - invalid browser session cookie`,
        );
        return reply.code(401).send({ error: "Invalid token" });
      }

      log(
        { module: "auth-decorator" },
        `Auth success via cookie - user: ${verified.userId}`,
      );
      setAuthContextFromVerified(verified, "cookie");
    } catch (error) {
      return reply.code(401).send({ error: "Authentication failed" });
    }
  });
}
