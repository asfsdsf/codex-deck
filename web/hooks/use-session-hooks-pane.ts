import { useCallback, useEffect, useState } from "react";
import type { CodexHookMetadata, SessionHooksResponse } from "@codex-deck/api";
import {
  getSessionHooks,
  getWorkflowProjectHooks,
  setSessionHookState,
  setWorkflowProjectHookState,
} from "../api";
import type { RightPaneMode } from "../components/diff-pane";
import type { RightPaneTarget } from "../right-pane-routing";

interface UseSessionHooksPaneInput {
  rightPaneTarget: RightPaneTarget;
  selectedPaneMode: RightPaneMode;
  diffPaneCollapsed: boolean;
}

interface UseSessionHooksPaneResult {
  sessionHooks: SessionHooksResponse | null;
  loadingSessionHooks: boolean;
  sessionHooksError: string | null;
  selectedHookKey: string | null;
  updatingHookKey: string | null;
  refreshHooks: () => void;
  selectHookKey: (key: string | null) => void;
  toggleHookEnabled: (
    hook: CodexHookMetadata,
    enabled: boolean,
  ) => Promise<void>;
  trustHook: (hook: CodexHookMetadata) => Promise<void>;
  trustAllHooks: () => Promise<void>;
  resetHooksPane: () => void;
}

function hookNeedsReview(hook: CodexHookMetadata): boolean {
  return hook.trustStatus === "untrusted" || hook.trustStatus === "modified";
}

export function useSessionHooksPane(
  input: UseSessionHooksPaneInput,
): UseSessionHooksPaneResult {
  const { rightPaneTarget, selectedPaneMode, diffPaneCollapsed } = input;
  const [sessionHooks, setSessionHooks] = useState<SessionHooksResponse | null>(
    null,
  );
  const [loadingSessionHooks, setLoadingSessionHooks] = useState(false);
  const [sessionHooksError, setSessionHooksError] = useState<string | null>(
    null,
  );
  const [selectedHookKey, setSelectedHookKey] = useState<string | null>(null);
  const [updatingHookKey, setUpdatingHookKey] = useState<string | null>(null);
  const [hooksRefreshVersion, setHooksRefreshVersion] = useState(0);

  const resetHooksPane = useCallback(() => {
    setSessionHooks(null);
    setLoadingSessionHooks(false);
    setSessionHooksError(null);
    setSelectedHookKey(null);
    setUpdatingHookKey(null);
  }, []);

  const refreshHooks = useCallback(() => {
    setHooksRefreshVersion((value) => value + 1);
  }, []);

  const selectHookKey = useCallback((key: string | null) => {
    setSelectedHookKey(key);
  }, []);

  const toggleHookEnabled = useCallback(
    async (hook: CodexHookMetadata, enabled: boolean) => {
      if (!rightPaneTarget) {
        return;
      }

      setUpdatingHookKey(hook.key);
      setSessionHooksError(null);

      try {
        const input = {
          updates: [{ key: hook.key, enabled }],
        };
        await (rightPaneTarget.kind === "session"
          ? setSessionHookState(rightPaneTarget.sessionId, input)
          : setWorkflowProjectHookState(rightPaneTarget.workflowKey, input));
        setSessionHooks((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            hooks: current.hooks.map((currentHook) =>
              currentHook.key === hook.key
                ? { ...currentHook, enabled }
                : currentHook,
            ),
          };
        });
        setSelectedHookKey(hook.key);
        setHooksRefreshVersion((value) => value + 1);
      } catch (error) {
        setSessionHooksError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setUpdatingHookKey(null);
      }
    },
    [rightPaneTarget],
  );

  const trustHook = useCallback(
    async (hook: CodexHookMetadata) => {
      if (!rightPaneTarget) {
        return;
      }

      setUpdatingHookKey(hook.key);
      setSessionHooksError(null);

      try {
        const input = {
          updates: [{ key: hook.key, trustedHash: hook.currentHash }],
        };
        await (rightPaneTarget.kind === "session"
          ? setSessionHookState(rightPaneTarget.sessionId, input)
          : setWorkflowProjectHookState(rightPaneTarget.workflowKey, input));
        setSessionHooks((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            hooks: current.hooks.map((currentHook) =>
              currentHook.key === hook.key
                ? { ...currentHook, trustStatus: "trusted" }
                : currentHook,
            ),
          };
        });
        setSelectedHookKey(hook.key);
        setHooksRefreshVersion((value) => value + 1);
      } catch (error) {
        setSessionHooksError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setUpdatingHookKey(null);
      }
    },
    [rightPaneTarget],
  );

  const trustAllHooks = useCallback(async () => {
    if (!rightPaneTarget || !sessionHooks) {
      return;
    }

    const updates = sessionHooks.hooks
      .filter((hook) => hookNeedsReview(hook) && !hook.isManaged)
      .map((hook) => ({
        key: hook.key,
        trustedHash: hook.currentHash,
      }));

    if (updates.length === 0) {
      return;
    }

    setUpdatingHookKey("__all__");
    setSessionHooksError(null);

    try {
      await (rightPaneTarget.kind === "session"
        ? setSessionHookState(rightPaneTarget.sessionId, { updates })
        : setWorkflowProjectHookState(rightPaneTarget.workflowKey, {
            updates,
          }));
      setSessionHooks((current) => {
        if (!current) {
          return current;
        }
        const trustedKeys = new Set(updates.map((update) => update.key));
        return {
          ...current,
          hooks: current.hooks.map((hook) =>
            trustedKeys.has(hook.key)
              ? { ...hook, trustStatus: "trusted" }
              : hook,
          ),
        };
      });
      setHooksRefreshVersion((value) => value + 1);
    } catch (error) {
      setSessionHooksError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setUpdatingHookKey(null);
    }
  }, [rightPaneTarget, sessionHooks]);

  useEffect(() => {
    if (
      !rightPaneTarget ||
      diffPaneCollapsed ||
      selectedPaneMode !== "hooks"
    ) {
      setLoadingSessionHooks(false);
      return;
    }

    let cancelled = false;
    setLoadingSessionHooks(true);
    setSessionHooksError(null);

    (rightPaneTarget.kind === "session"
      ? getSessionHooks(rightPaneTarget.sessionId)
      : getWorkflowProjectHooks(rightPaneTarget.workflowKey)
    )
      .then((response) => {
        if (cancelled) {
          return;
        }
        setSessionHooks(response);
        setSelectedHookKey((current) => {
          if (current && response.hooks.some((hook) => hook.key === current)) {
            return current;
          }
          return response.hooks[0]?.key ?? null;
        });
        if (response.unavailableReason) {
          setSessionHooksError(response.unavailableReason);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setSessionHooks(null);
        setSelectedHookKey(null);
        setSessionHooksError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSessionHooks(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    rightPaneTarget,
    selectedPaneMode,
    diffPaneCollapsed,
    hooksRefreshVersion,
  ]);

  return {
    sessionHooks,
    loadingSessionHooks,
    sessionHooksError,
    selectedHookKey,
    updatingHookKey,
    refreshHooks,
    selectHookKey,
    toggleHookEnabled,
    trustHook,
    trustAllHooks,
    resetHooksPane,
  };
}
