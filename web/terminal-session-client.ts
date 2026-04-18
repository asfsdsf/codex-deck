import type { TerminalStreamEvent } from "@codex-deck/api";
import { sendTerminalInput, subscribeTerminalStream } from "./api";

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
  let sendQueue = Promise.resolve();

  const flush = async () => {
    return sendQueue;
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

      sendQueue = sendQueue
        .catch(() => undefined)
        .then(async () => {
          if (input.isDisposed()) {
            return;
          }
          try {
            await sendInput(input.terminalId, { input: chunk }, input.clientId);
          } catch (error) {
            input.setError(getErrorMessage(error));
          }
        });
    },
    flush,
    reset() {
      sendQueue = Promise.resolve();
    },
  };
}

interface ConnectTerminalSessionInput {
  terminalId: string;
  clientId: string;
  isDisposed: () => boolean;
  onBootstrap: (event: Extract<TerminalStreamEvent, { type: "bootstrap" }>) => void;
  onEvent: (event: TerminalStreamEvent) => void;
  onConnectedChange: (connected: boolean) => void;
  onError: (message: string | null) => void;
  subscribe?: typeof subscribeTerminalStream;
}

export async function connectTerminalSession(
  input: ConnectTerminalSessionInput,
): Promise<() => void> {
  const subscribe = input.subscribe ?? subscribeTerminalStream;

  try {
    const unsubscribe = subscribe(
      {
        onEvent: (event) => {
          if (input.isDisposed()) {
            return;
          }
          input.onConnectedChange(true);
          input.onError(null);
          if (event.type === "bootstrap") {
            input.onBootstrap(event);
            return;
          }
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
        clientId: input.clientId,
        bootstrap: true,
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
