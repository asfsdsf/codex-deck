import type { Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import {
  applyIdeContextToInput,
  fetchIdeContext,
  ideContextPromptSkipHint,
  ideContextUserFacingHint,
  IdeContextError,
  summarizeIdeContext,
  toIdeContextError,
  type FetchIdeContextOptions,
  type IdeContext,
  type IdeContextStatus,
} from "../codex-ide-context";
import type {
  SendCodexMessageIdeContextResult,
  SendCodexMessageInputItem,
} from "../storage";
import { getCodexDir } from "../storage";
import { normalizeCwdPath } from "./utils";

type Fetcher = (options: FetchIdeContextOptions) => Promise<IdeContext>;

export interface IdeContextDeps {
  fetch?: Fetcher;
  codexHome?: () => string;
}

/** Fetches context for an outgoing message; never throws. */
export async function applyIdeContextForSend(
  input: SendCodexMessageInputItem[],
  workspaceRoot: string | null | undefined,
  deps: IdeContextDeps = {},
): Promise<{
  input: SendCodexMessageInputItem[];
  ideContext: SendCodexMessageIdeContextResult;
}> {
  try {
    if (!workspaceRoot) {
      throw new IdeContextError("no-workspace", "no workspace root");
    }
    const context = await (deps.fetch ?? fetchIdeContext)({
      workspaceRoot,
      codexHome: (deps.codexHome ?? getCodexDir)(),
    });
    const applied = applyIdeContextToInput(context, input);
    return {
      input: applied.input,
      ideContext: {
        applied: applied.applied,
        summary: summarizeIdeContext(context),
      },
    };
  } catch (error) {
    return {
      input,
      ideContext: {
        applied: false,
        skippedHint: ideContextPromptSkipHint(toIdeContextError(error)),
      },
    };
  }
}

export function registerIdeContextRoutes(
  app: Hono,
  deps: IdeContextDeps & {
    getClient?: () => Pick<CodexAppServerClientFacade, "getThreadSummary">;
  } = {},
) {
  app.get("/api/codex/ide-context", async (c) => {
    const rawCwd = c.req.query("cwd")?.trim();
    const threadId = c.req.query("threadId")?.trim();
    let workspaceRoot = rawCwd ? normalizeCwdPath(rawCwd) : null;
    if (!workspaceRoot && threadId) {
      try {
        const client = (deps.getClient ?? getCodexAppServerClient)();
        workspaceRoot =
          (await client.getThreadSummary?.(threadId))?.cwd?.trim() || null;
      } catch {
        workspaceRoot = null;
      }
    }
    let status: IdeContextStatus;
    try {
      if (!workspaceRoot) {
        throw new IdeContextError("no-workspace", "no workspace root");
      }
      const context = await (deps.fetch ?? fetchIdeContext)({
        workspaceRoot,
        codexHome: (deps.codexHome ?? getCodexDir)(),
      });
      status = { available: true, summary: summarizeIdeContext(context) };
    } catch (error) {
      const ideError = toIdeContextError(error);
      status = {
        available: false,
        reason: ideError.kind,
        hint: ideContextUserFacingHint(ideError),
      };
    }
    return c.json(status);
  });
}
