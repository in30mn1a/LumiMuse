import { useCallback, useRef, useState } from 'react';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';

export interface MemoryManagementCharacter {
  id: string;
  name: string;
}

interface MemoryManagementLoadCallbacks {
  loadMemoryDiagnostics: () => Promise<void> | void;
  loadMemoryProfile: (characterId: string) => Promise<void> | void;
  loadMemoryArchiveMemories: (characterId: string) => Promise<void> | void;
  loadMemoryArchiveBatches: (characterId: string) => Promise<void> | void;
}

export interface MemoryManagementCharacterChangeCallbacks extends MemoryManagementLoadCallbacks {
  resetProfile: () => void;
  resetArchiveForCharacterChange: () => void;
}

export function useMemoryManagementCharacters() {
  const [memoryManagementCharacters, setMemoryManagementCharacters] = useState<MemoryManagementCharacter[]>([]);
  const [memoryManagementCharacterId, setMemoryManagementCharacterId] = useState('');
  const [memoryManagementLoading, setMemoryManagementLoading] = useState(false);
  const [memoryManagementError, setMemoryManagementError] = useState<string | null>(null);
  const memoryManagementCharacterIdRef = useRef('');

  const loadMemoryManagementCharacters = useCallback(async (
    callbacks: MemoryManagementLoadCallbacks,
    preferredCharacterId = '',
  ) => {
    setMemoryManagementLoading(true);
    setMemoryManagementError(null);
    try {
      const characters = await parseJsonResponse<MemoryManagementCharacter[]>(await fetch('/api/characters'));
      setMemoryManagementCharacters(characters);
      const currentSelected = memoryManagementCharacterIdRef.current;
      const nextCharacterId = preferredCharacterId
        || (currentSelected && characters.some(character => character.id === currentSelected) ? currentSelected : '')
        || characters[0]?.id || '';
      if (nextCharacterId) {
        setMemoryManagementCharacterId(nextCharacterId);
        memoryManagementCharacterIdRef.current = nextCharacterId;
        await Promise.all([
          callbacks.loadMemoryDiagnostics(),
          callbacks.loadMemoryProfile(nextCharacterId),
          callbacks.loadMemoryArchiveMemories(nextCharacterId),
          callbacks.loadMemoryArchiveBatches(nextCharacterId),
        ]);
      }
    } catch (err) {
      setMemoryManagementError(getErrorMessage(err));
    } finally {
      setMemoryManagementLoading(false);
    }
  }, []);

  const handleMemoryManagementCharacterChange = (characterId: string, callbacks: MemoryManagementCharacterChangeCallbacks) => {
    setMemoryManagementCharacterId(characterId);
    memoryManagementCharacterIdRef.current = characterId;
    callbacks.resetProfile();
    callbacks.resetArchiveForCharacterChange();

    if (characterId) {
      void callbacks.loadMemoryProfile(characterId);
      void callbacks.loadMemoryArchiveMemories(characterId);
      void callbacks.loadMemoryArchiveBatches(characterId);
    }
    void callbacks.loadMemoryDiagnostics();
  };

  return {
    memoryManagementCharacters,
    memoryManagementCharacterId,
    memoryManagementLoading,
    memoryManagementError,
    memoryManagementCharacterIdRef,
    loadMemoryManagementCharacters,
    handleMemoryManagementCharacterChange,
  };
}

export type UseMemoryManagementCharactersResult = ReturnType<typeof useMemoryManagementCharacters>;
