import { useEffect, useState } from "react";
import {
  DEFAULT_CONVERSATION_HOVER_SETTINGS,
  resolveConversationHoverSettings,
} from "../../api/conversation-hover-settings";
import { subscribeConversationHoverSettings } from "../transport";
import { usePageVisibility } from "./use-page-visibility";

export function useConversationHoverSettings() {
  const [settings, setSettings] = useState(DEFAULT_CONVERSATION_HOVER_SETTINGS);
  const isPageVisible = usePageVisibility();
  useEffect(
    () =>
      isPageVisible
        ? subscribeConversationHoverSettings({
            onSettings: (next) =>
              setSettings((previous) => {
                const resolved = resolveConversationHoverSettings(next);
                return JSON.stringify(previous) === JSON.stringify(resolved)
                  ? previous
                  : resolved;
              }),
          })
        : undefined,
    [isPageVisible],
  );
  return settings;
}
