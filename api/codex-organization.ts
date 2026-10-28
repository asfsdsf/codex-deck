import type { NativeRpc } from "./codex-native";
import { ThreadReadStateService } from "./codex-read-state";
import { RemoteControlService } from "./codex-remote-control";
import { EnvironmentService } from "./codex-environments";
export type {
  EnvironmentConnectionEvent,
  EnvironmentEntry,
  EnvironmentRegistration,
  EnvironmentStatusKind,
  EnvironmentsSnapshot,
  ThreadEnvironmentSnapshot,
  TurnEnvironmentSelection,
} from "./codex-environments";
export type {
  RemoteControlClientInfo,
  RemoteControlConnectionStatus,
  RemoteControlPairing,
  RemoteControlSnapshot,
  RemoteControlStatus,
} from "./codex-remote-control";
export type {
  ThreadReadState,
  ThreadReadStateOperation,
  ThreadReadStatesSnapshot,
  ThreadReadStateUpdateResult,
  ThreadUnreadPosition,
} from "./codex-read-state";

/** `native_state_changed` scopes owned by the organization/remote services. */
export type OrganizationScope = "readState" | "remoteControl" | "environments";

export interface CodexOrganizationDeps {
  rpc: NativeRpc;
  notify: (scope: OrganizationScope, threadId: string | null) => void;
}

/**
 * Upstream organization and remote APIs (read receipts, named projects,
 * Codex remote control, execution environments). Kept out of the main
 * app-server bridge; the bridge forwards requests and notifications here.
 */
export class CodexOrganizationService {
  public readonly readState: ThreadReadStateService;
  public readonly remoteControl: RemoteControlService;
  public readonly environments: EnvironmentService;

  public constructor(deps: CodexOrganizationDeps) {
    this.readState = new ThreadReadStateService(deps.rpc, (threadId) =>
      deps.notify("readState", threadId),
    );
    this.remoteControl = new RemoteControlService(deps.rpc, () =>
      deps.notify("remoteControl", null),
    );
    this.environments = new EnvironmentService(deps.rpc, (threadId) =>
      deps.notify("environments", threadId),
    );
  }

  /** Returns true when the notification was consumed. */
  public handleNotification(method: string, params: unknown): boolean {
    return (
      this.readState.handleNotification(method, params) ||
      this.remoteControl.handleNotification(method) ||
      this.environments.handleNotification(method, params)
    );
  }
}
