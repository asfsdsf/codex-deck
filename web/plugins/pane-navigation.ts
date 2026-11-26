import { createContext } from "react";
import type { DeckPluginView } from "../../api/deck-plugin-manifest";
export const PaneNavigation = createContext<
  ((pluginId: string, view: DeckPluginView) => boolean) | null
>(null);
