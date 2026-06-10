import { useCallback, useEffect, useMemo, useState } from "react";
import type { CodexPetMetadata } from "@codex-deck/api";
import { getCodexPets, selectCodexPet } from "../api";

interface UseCodexPetsInput {
  apiReady: boolean;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

interface UseCodexPetsResult {
  pets: CodexPetMetadata[];
  currentPetId: string | null;
  loadingPets: boolean;
  petsError: string | null;
  showPetPicker: boolean;
  setShowPetPicker: (open: boolean) => void;
  refreshPets: () => Promise<void>;
  selectPet: (petId: string) => Promise<boolean>;
  activePet: CodexPetMetadata | null;
}

export function useCodexPets(input: UseCodexPetsInput): UseCodexPetsResult {
  const { apiReady, onError, onNotice } = input;
  const [pets, setPets] = useState<CodexPetMetadata[]>([]);
  const [currentPetId, setCurrentPetId] = useState<string | null>(null);
  const [loadingPets, setLoadingPets] = useState(false);
  const [petsError, setPetsError] = useState<string | null>(null);
  const [showPetPicker, setShowPetPicker] = useState(false);

  const refreshPets = useCallback(async () => {
    setLoadingPets(true);
    setPetsError(null);
    try {
      const response = await getCodexPets();
      setPets(response.pets);
      setCurrentPetId(response.currentPetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPetsError(message);
    } finally {
      setLoadingPets(false);
    }
  }, []);

  useEffect(() => {
    if (!apiReady) {
      return;
    }
    void refreshPets();
  }, [apiReady, refreshPets]);

  const selectPet = useCallback(
    async (petId: string): Promise<boolean> => {
      onError("");
      setPetsError(null);
      try {
        const response = await selectCodexPet({ petId });
        const selectedPet = response.pet;
        setCurrentPetId(response.currentPetId);
        if (selectedPet) {
          setPets((current) => {
            const next = current.filter((pet) => pet.id !== selectedPet.id);
            next.push(selectedPet);
            return next.sort((left, right) => {
              if (left.source === "disabled") {
                return -1;
              }
              if (right.source === "disabled") {
                return 1;
              }
              return left.displayName.localeCompare(right.displayName);
            });
          });
          onNotice(`Selected pet: ${selectedPet.displayName}.`);
        } else {
          onNotice("Closed pet.");
        }
        setShowPetPicker(false);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPetsError(message);
        onError(message);
        return false;
      }
    },
    [onError, onNotice],
  );

  const activePet = useMemo(() => {
    if (!currentPetId || currentPetId === "disabled" || showPetPicker) {
      return null;
    }
    return pets.find((pet) => pet.id === currentPetId) ?? null;
  }, [currentPetId, pets, showPetPicker]);

  return {
    pets,
    currentPetId,
    loadingPets,
    petsError,
    showPetPicker,
    setShowPetPicker,
    refreshPets,
    selectPet,
    activePet,
  };
}
