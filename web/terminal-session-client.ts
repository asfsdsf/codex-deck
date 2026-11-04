import type { TerminalStreamEvent } from "@codex-deck/api";
import { sendTerminalInput, subscribeTerminalStream } from "./api";

export type TerminalIncrementalStreamEvent = Exclude<
  TerminalStreamEvent,
  { type: "bootstrap" }
>;

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
  // `userInitiated` defaults to true. Data that is not user initiated (mouse
  // and focus reports, automatic query replies) is only sent while this
  // client owns terminal write, and never triggers the read-only warning.
  queueInput: (chunk: string, options?: { userInitiated?: boolean }) => void;
  flush: () => Promise<void>;
  reset: () => void;
}

export function createBufferedTerminalInputController(
  input: BufferedTerminalInputControllerInput,
): BufferedTerminalInputController {
  const sendInput = input.sendInput ?? sendTerminalInput;
  // Input typed while a request is in flight is batched into the next request,
  // so typing speed is not limited by one round trip per key (which matters a
  // lot over the remote relay).
  let pendingInput = "";
  let pumping = false;
  let pumpPromise: Promise<void> = Promise.resolve();

  const pump = async () => {
    pumping = true;
    try {
      while (pendingInput.length > 0) {
        if (input.isDisposed()) {
          pendingInput = "";
          break;
        }
        const chunk = pendingInput;
        pendingInput = "";
        try {
          await sendInput(input.terminalId, { input: chunk }, input.clientId);
        } catch (error) {
          input.setError(getErrorMessage(error));
        }
      }
    } finally {
      pumping = false;
    }
  };

  return {
    queueInput(chunk, options) {
      if (!chunk || input.isDisposed()) {
        return;
      }

      const userInitiated = options?.userInitiated ?? true;
      const writeOwnerId = input.getWriteOwnerId();
      if (userInitiated) {
        if (writeOwnerId !== null && writeOwnerId !== input.clientId) {
          input.onReadOnlyAttempt?.();
          return;
        }
      } else if (writeOwnerId !== input.clientId) {
        return;
      }

      pendingInput += chunk;
      if (!pumping) {
        pumpPromise = pump();
      }
    },
    flush() {
      return pumpPromise;
    },
    reset() {
      pendingInput = "";
    },
  };
}

interface ConnectTerminalSessionInput {
  terminalId: string;
  clientId: string;
  isDisposed: () => boolean;
  onBootstrap: (
    event: Extract<TerminalStreamEvent, { type: "bootstrap" }>,
  ) => void;
  onEvent: (event: TerminalIncrementalStreamEvent) => void;
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
