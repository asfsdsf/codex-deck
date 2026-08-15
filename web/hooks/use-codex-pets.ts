import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodexPetMetadata } from "@codex-deck/api";
import { getCodexPets, selectCodexPet } from "../api";

interface UseCodexPetsInput {
  apiReady: boolean;
  homeId: string;
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
  const { apiReady, homeId, onError, onNotice } = input;
  const [pets, setPets] = useState<CodexPetMetadata[]>([]);
  const [currentPetId, setCurrentPetId] = useState<string | null>(null);
  const [loadingPets, setLoadingPets] = useState(false);
  const [petsError, setPetsError] = useState<string | null>(null);
  const [showPetPicker, setShowPetPicker] = useState(false);
  const homeIdRef = useRef(homeId);
  const refreshRequestIdRef = useRef(0);
  homeIdRef.current = homeId;

  const refreshPets = useCallback(async () => {
    const requestHomeId = homeIdRef.current;
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    setLoadingPets(true);
    setPetsError(null);
    try {
      const response = await getCodexPets();
      if (
        homeIdRef.current !== requestHomeId ||
        refreshRequestIdRef.current !== requestId
      ) {
        return;
      }
      setPets(response.pets);
      setCurrentPetId(response.currentPetId);
    } catch (error) {
      if (
        homeIdRef.current !== requestHomeId ||
        refreshRequestIdRef.current !== requestId
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setPetsError(message);
    } finally {
      if (
        homeIdRef.current === requestHomeId &&
        refreshRequestIdRef.current === requestId
      ) {
        setLoadingPets(false);
      }
    }
  }, []);

  useEffect(() => {
    setPets([]);
    setCurrentPetId(null);
    setPetsError(null);
    setShowPetPicker(false);
    if (!apiReady) {
      refreshRequestIdRef.current += 1;
      setLoadingPets(false);
      return;
    }
    void refreshPets();
  }, [apiReady, homeId, refreshPets]);

  const selectPet = useCallback(
    async (petId: string): Promise<boolean> => {
      const requestHomeId = homeId;
      onError("");
      setPetsError(null);
      try {
        const response = await selectCodexPet({ petId });
        if (homeIdRef.current !== requestHomeId) {
          return false;
        }
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
        if (homeIdRef.current !== requestHomeId) {
          return false;
        }
        const message = error instanceof Error ? error.message : String(error);
        setPetsError(message);
        onError(message);
        return false;
      }
    },
    [homeId, onError, onNotice],
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
