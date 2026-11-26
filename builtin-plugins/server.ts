import type { DeckBuiltinModule } from "../api/deck-builtin-runtime";
import type { CodexAppServerClientFacade } from "../api/codex-app-server";
import { registerFeatureRoutes as diagnostics } from "./diagnostics/server";
import { registerFeatureRoutes as daybreak } from "./daybreak/server";
import { registerFeatureRoutes as experimental } from "./experimental/server";
import { registerFeatureRoutes as recap } from "./recap/server";
import { registerFeatureRoutes as usage } from "./usage/server";
import { registerTranslationRoutes } from "./translation/server";
import { registerMemoryInsightRoutes } from "./memory/server";

export interface BuiltinServerOptions {
  subscribe?: () => void;
  getClient?: () => CodexAppServerClientFacade;
  getTranslationCommand?: () => string | undefined;
}

export function builtinServerModules(
  options: BuiltinServerOptions,
): DeckBuiltinModule[] {
  return [
    {
      id: "codex-deck.diagnostics",
      apply: (ctx) => diagnostics(ctx.routes, options),
    },
    {
      id: "codex-deck.daybreak",
      apply: (ctx) => daybreak(ctx.routes, options),
    },
    {
      id: "codex-deck.experimental",
      apply: (ctx) => experimental(ctx.routes, options),
    },
    { id: "codex-deck.recap", apply: (ctx) => recap(ctx.routes, options) },
    { id: "codex-deck.usage", apply: (ctx) => usage(ctx.routes, options) },
    {
      id: "codex-deck.translation",
      apply: (ctx) =>
        registerTranslationRoutes(ctx.routes, {
          ...options,
          signal: ctx.signal,
        }),
    },
    {
      id: "codex-deck.memory",
      apply: (ctx) =>
        registerMemoryInsightRoutes(ctx.routes, options.getClient),
    },
  ];
}
