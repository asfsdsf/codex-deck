import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCodexMemoriesSettings,
  resetCodexMemories,
  writeCodexMemoriesSettings,
} from "../api";

interface UseCodexMemoriesInput {
  activeSessionId: string | null;
  homeId: string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

interface UseCodexMemoriesResult {
  showMemoriesModal: boolean;
  setShowMemoriesModal: (open: boolean) => void;
  memoriesUseEnabled: boolean;
  setMemoriesUseEnabled: (value: boolean) => void;
  memoriesGenerateEnabled: boolean;
  setMemoriesGenerateEnabled: (value: boolean) => void;
  loadingMemoriesSettings: boolean;
  savingMemoriesSettings: boolean;
  resettingMemories: boolean;
  showMemoriesResetConfirm: boolean;
  setShowMemoriesResetConfirm: (open: boolean) => void;
  openMemoriesModalFromCommand: (
    threadId: string,
    cwd: string | null | undefined,
  ) => Promise<void>;
  saveMemoriesSettings: () => Promise<void>;
  confirmResetMemories: () => Promise<void>;
}

export function useCodexMemories(
  input: UseCodexMemoriesInput,
): UseCodexMemoriesResult {
  const { activeSessionId, homeId, onError, onNotice } = input;
  const [showMemoriesModal, setShowMemoriesModal] = useState(false);
  const [memoriesUseEnabled, setMemoriesUseEnabled] = useState(false);
  const [memoriesGenerateEnabled, setMemoriesGenerateEnabled] = useState(false);
  const [loadingMemoriesSettings, setLoadingMemoriesSettings] = useState(false);
  const [savingMemoriesSettings, setSavingMemoriesSettings] = useState(false);
  const [resettingMemories, setResettingMemories] = useState(false);
  const [showMemoriesResetConfirm, setShowMemoriesResetConfirm] =
    useState(false);
  const homeIdRef = useRef(homeId);
  homeIdRef.current = homeId;

  useEffect(() => {
    setShowMemoriesModal(false);
    setShowMemoriesResetConfirm(false);
    setMemoriesUseEnabled(false);
    setMemoriesGenerateEnabled(false);
    setLoadingMemoriesSettings(false);
    setSavingMemoriesSettings(false);
    setResettingMemories(false);
  }, [homeId]);

  const openMemoriesModalFromCommand = useCallback(
    async (_threadId: string, cwd: string | null | undefined) => {
      const requestHomeId = homeId;
      setShowMemoriesModal(true);
      setShowMemoriesResetConfirm(false);
      setLoadingMemoriesSettings(true);
      onError("");
      try {
        const settings = await getCodexMemoriesSettings(cwd ?? null);
        if (homeIdRef.current !== requestHomeId) {
          return;
        }
        setMemoriesUseEnabled(settings.useMemories);
        setMemoriesGenerateEnabled(settings.generateMemories);
      } catch (error) {
        if (homeIdRef.current === requestHomeId) {
          onError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (homeIdRef.current === requestHomeId) {
          setLoadingMemoriesSettings(false);
        }
      }
    },
    [homeId, onError],
  );

  const saveMemoriesSettings = useCallback(async () => {
    if (!activeSessionId) {
      onError("Select a session before saving memory settings.");
      return;
    }

    const requestHomeId = homeId;
    setSavingMemoriesSettings(true);
    onError("");
    try {
      const settings = await writeCodexMemoriesSettings({
        useMemories: memoriesUseEnabled,
        generateMemories: memoriesGenerateEnabled,
        threadId: activeSessionId,
      });
      if (homeIdRef.current !== requestHomeId) {
        return;
      }
      setMemoriesUseEnabled(settings.useMemories);
      setMemoriesGenerateEnabled(settings.generateMemories);
      setShowMemoriesModal(false);
      onNotice("Saved memory settings.");
    } catch (error) {
      if (homeIdRef.current === requestHomeId) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (homeIdRef.current === requestHomeId) {
        setSavingMemoriesSettings(false);
      }
    }
  }, [
    activeSessionId,
    homeId,
    memoriesGenerateEnabled,
    memoriesUseEnabled,
    onError,
    onNotice,
  ]);

  const confirmResetMemories = useCallback(async () => {
    const requestHomeId = homeId;
    setResettingMemories(true);
    onError("");
    try {
      await resetCodexMemories();
      if (homeIdRef.current !== requestHomeId) {
        return;
      }
      setShowMemoriesResetConfirm(false);
      setShowMemoriesModal(false);
      onNotice("Reset local memories.");
    } catch (error) {
      if (homeIdRef.current === requestHomeId) {
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (homeIdRef.current === requestHomeId) {
        setResettingMemories(false);
      }
    }
  }, [homeId, onError, onNotice]);

  return {
    showMemoriesModal,
    setShowMemoriesModal,
    memoriesUseEnabled,
    setMemoriesUseEnabled,
    memoriesGenerateEnabled,
    setMemoriesGenerateEnabled,
    loadingMemoriesSettings,
    savingMemoriesSettings,
    resettingMemories,
    showMemoriesResetConfirm,
    setShowMemoriesResetConfirm,
    openMemoriesModalFromCommand,
    saveMemoriesSettings,
    confirmResetMemories,
  };
}
