import type {
  TerminalSnapshotResponse,
  TerminalStreamEvent,
} from "@codex-deck/api";
import {
  getTerminalSnapshot,
  sendTerminalInput,
  subscribeTerminalStream,
} from "./api";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomHexBytes(size: number): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    const bytes = new Uint8Array(size);
    cryptoObject.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  return Array.from({ length: size }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
}

export function createTerminalClientId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    try {
      return cryptoObject.randomUUID();
    } catch {
      // Fall back to a locally generated UUID-like value.
    }
  }

  const hex = randomHexBytes(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

interface BufferedTerminalInputControllerInput {
  terminalId: string;
  clientId: string;
  isDisposed: () => boolean;
  getWriteOwnerId: () => string | null;
  setError: (message: string) => void;
  onReadOnlyAttempt?: () => void;
  claimWriteIfUnowned?: () => Promise<void>;
  sendInput?: typeof sendTerminalInput;
}

export interface BufferedTerminalInputController {
  queueInput: (chunk: string) => void;
  flush: () => Promise<void>;
  reset: () => void;
}

export function createBufferedTerminalInputController(
  input: BufferedTerminalInputControllerInput,
): BufferedTerminalInputController {
  const sendInput = input.sendInput ?? sendTerminalInput;
  let bufferedInput = "";
  let flushPromise: Promise<void> | null = null;

  const flush = async () => {
    if (flushPromise) {
      return flushPromise;
    }

    flushPromise = (async () => {
      while (bufferedInput.length > 0 && !input.isDisposed()) {
        const writeOwnerId = input.getWriteOwnerId();
        if (writeOwnerId !== input.clientId) {
          if (writeOwnerId === null && input.claimWriteIfUnowned) {
            await input.claimWriteIfUnowned();
          } else {
            break;
          }
        }

        if (input.getWriteOwnerId() !== input.clientId) {
          break;
        }

        const chunk = bufferedInput;
        bufferedInput = "";
        try {
          await sendInput(input.terminalId, { input: chunk }, input.clientId);
        } catch (error) {
          input.setError(getErrorMessage(error));
          bufferedInput = `${chunk}${bufferedInput}`;
          break;
        }
      }
    })().finally(() => {
      flushPromise = null;
    });

    return flushPromise;
  };

  return {
    queueInput(chunk: string) {
      if (!chunk || input.isDisposed()) {
        return;
      }

      const writeOwnerId = input.getWriteOwnerId();
      if (writeOwnerId !== null && writeOwnerId !== input.clientId) {
        input.onReadOnlyAttempt?.();
        return;
      }

      bufferedInput += chunk;
      void flush();
    },
    flush,
    reset() {
      bufferedInput = "";
      flushPromise = null;
    },
  };
}

interface ConnectTerminalSessionInput {
  terminalId: string;
  clientId: string;
  isDisposed: () => boolean;
  onSnapshot: (snapshot: TerminalSnapshotResponse) => void;
  onEvent: (event: TerminalStreamEvent) => void;
  onConnectedChange: (connected: boolean) => void;
  onError: (message: string | null) => void;
  getSnapshot?: typeof getTerminalSnapshot;
  subscribe?: typeof subscribeTerminalStream;
}

export async function connectTerminalSession(
  input: ConnectTerminalSessionInput,
): Promise<() => void> {
  const loadSnapshot = input.getSnapshot ?? getTerminalSnapshot;
  const subscribe = input.subscribe ?? subscribeTerminalStream;

  try {
    const snapshot = await loadSnapshot(input.terminalId);
    if (input.isDisposed()) {
      return () => undefined;
    }

    input.onSnapshot(snapshot);

    const unsubscribe = subscribe(
      {
        onEvent: (event) => {
          if (input.isDisposed()) {
            return;
          }
          input.onConnectedChange(true);
          input.onError(null);
          input.onEvent(event);
        },
        onError: () => {
          if (input.isDisposed()) {
            return;
          }
          input.onConnectedChange(false);
        },
      },
      {
        terminalId: input.terminalId,
        fromSeq: snapshot.seq,
        clientId: input.clientId,
      },
    );

    input.onConnectedChange(true);
    return () => {
      unsubscribe();
    };
  } catch (error) {
    if (!input.isDisposed()) {
      input.onConnectedChange(false);
      input.onError(getErrorMessage(error));
    }
    return () => undefined;
  }
}
