import type { Hono } from "hono";
import {
  builtinServerModules,
  type BuiltinServerOptions,
} from "../../builtin-plugins/server";
import { registerNativeWorkflowRoutes as mcp } from "../../api/server/native-workflow-routes";

export function registerNativeWorkflowRoutes(
  app: Hono,
  options: Parameters<typeof mcp>[1] = {},
) {
  mcp(app, options);
  for (const module of builtinServerModules(options as BuiltinServerOptions)) {
    module.apply({
      routes: app,
      signal: new AbortController().signal,
      services: { provide: () => {}, call: async () => null, list: () => [] },
      effect: () => {},
      onEvent: () => {},
    });
  }
}
