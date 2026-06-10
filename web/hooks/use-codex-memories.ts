import { useCallback, useState } from "react";
import {
  getCodexMemoriesSettings,
  resetCodexMemories,
  writeCodexMemoriesSettings,
} from "../api";

interface UseCodexMemoriesInput {
  activeSessionId: string | null;
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
  const { activeSessionId, onError, onNotice } = input;
  const [showMemoriesModal, setShowMemoriesModal] = useState(false);
  const [memoriesUseEnabled, setMemoriesUseEnabled] = useState(false);
  const [memoriesGenerateEnabled, setMemoriesGenerateEnabled] = useState(false);
  const [loadingMemoriesSettings, setLoadingMemoriesSettings] = useState(false);
  const [savingMemoriesSettings, setSavingMemoriesSettings] = useState(false);
  const [resettingMemories, setResettingMemories] = useState(false);
  const [showMemoriesResetConfirm, setShowMemoriesResetConfirm] =
    useState(false);

  const openMemoriesModalFromCommand = useCallback(
    async (_threadId: string, cwd: string | null | undefined) => {
      setShowMemoriesModal(true);
      setShowMemoriesResetConfirm(false);
      setLoadingMemoriesSettings(true);
      onError("");
      try {
        const settings = await getCodexMemoriesSettings(cwd ?? null);
        setMemoriesUseEnabled(settings.useMemories);
        setMemoriesGenerateEnabled(settings.generateMemories);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoadingMemoriesSettings(false);
      }
    },
    [onError],
  );

  const saveMemoriesSettings = useCallback(async () => {
    if (!activeSessionId) {
      onError("Select a session before saving memory settings.");
      return;
    }

    setSavingMemoriesSettings(true);
    onError("");
    try {
      const settings = await writeCodexMemoriesSettings({
        useMemories: memoriesUseEnabled,
        generateMemories: memoriesGenerateEnabled,
        threadId: activeSessionId,
      });
      setMemoriesUseEnabled(settings.useMemories);
      setMemoriesGenerateEnabled(settings.generateMemories);
      setShowMemoriesModal(false);
      onNotice("Saved memory settings.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingMemoriesSettings(false);
    }
  }, [
    activeSessionId,
    memoriesGenerateEnabled,
    memoriesUseEnabled,
    onError,
    onNotice,
  ]);

  const confirmResetMemories = useCallback(async () => {
    setResettingMemories(true);
    onError("");
    try {
      await resetCodexMemories();
      setShowMemoriesResetConfirm(false);
      setShowMemoriesModal(false);
      onNotice("Reset local memories.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setResettingMemories(false);
    }
  }, [onError, onNotice]);

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
