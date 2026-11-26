import { lazy } from "react";

export const builtinClientModules = {
  "codex-deck.diagnostics": lazy(() => import("./diagnostics/client")),
  "codex-deck.daybreak": lazy(() => import("./daybreak/client")),
  "codex-deck.experimental": lazy(() => import("./experimental/client")),
  "codex-deck.export": lazy(() => import("./export/client")),
  "codex-deck.recap": lazy(() => import("./recap/client")),
  "codex-deck.usage": lazy(() => import("./usage/client")),
  "codex-deck.memory": lazy(() => import("./memory/client")),
  "codex-deck.manager": lazy(() => import("./manager/client")),
};
