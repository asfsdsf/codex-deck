import type { Hono } from "hono";
import { getSystemContextSnapshot } from "../system-context";
import type { SystemContextResponse } from "../storage";

export function registerSystemRoutes(app: Hono): void {
  app.get("/api/system/context", async (c) => {
    const response: SystemContextResponse = getSystemContextSnapshot();
    return c.json(response);
  });
}
