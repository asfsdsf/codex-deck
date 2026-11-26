import type { Context } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../api/codex-app-server";
import { responseStatusForError, toErrorMessage } from "../api/server/utils";

export interface BuiltinCodexRouteOptions {
  subscribe?: () => void;
  getClient?: () => Partial<CodexAppServerClientFacade>;
}

/** Native routes keep validation in their feature module and share error transport. */
export function builtinCodexRouteRunner(deps: BuiltinCodexRouteOptions) {
  return async (
    c: Context,
    work: (client: Partial<CodexAppServerClientFacade>) => Promise<unknown>,
  ) => {
    try {
      deps.subscribe?.();
      const result = await work((deps.getClient ?? getCodexAppServerClient)());
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  };
}
