import type { NativeScope } from "./codex-native";
import { CodexAccountManager } from "./codex-account";
import { CodexImportManager } from "./codex-import";
import {
  readPresets,
  writePreset,
  type CodexPresetInput,
  type CodexPresetsSnapshot,
} from "./codex-presets";

/**
 * App-server bridge used by the account/extension features. `threadId`
 * resumes the thread on shared sockets; `timeoutMs` overrides the default
 * request timeout for long-running flows.
 */
export type ExtensionRpc = (
  method: string,
  params: Record<string, unknown> | undefined,
  options?: { threadId?: string | null; timeoutMs?: number },
) => Promise<unknown>;

/**
 * Native Codex account and extension administration (presets, account,
 * migration, apps, and plugins). Shared state changes are broadcast through
 * `native_state_changed` so every connected browser refreshes.
 */
export class CodexExtensions {
  constructor(
    private readonly rpc: ExtensionRpc,
    private readonly notify: (
      scope: NativeScope,
      threadId?: string | null,
    ) => void,
  ) {}

  private plain = (method: string, params: Record<string, unknown>) =>
    this.rpc(method, params);

  /** Codex account onboarding (distinct from Deck's remote-server login). */
  readonly account = new CodexAccountManager(
    (method, params, options) => this.rpc(method, params, options),
    () => this.notify("account"),
  );

  /** External-agent setup migration (`/import`). */
  readonly imports = new CodexImportManager(
    (method, params, options) => this.rpc(method, params, options),
    () => this.notify("import"),
  );

  /** Returns true when the notification was fully consumed. */
  handleNotification(method: string, params: unknown): boolean {
    if (this.imports.observe(method, params)) return true;
    // Account notifications are observed but left for the existing auth
    // fingerprint/usage handlers.
    if (this.account.observe(method, params))
      return method === "account/gatewayOAuth/changed";
    return false;
  }

  readPresets(cwd?: string | null): Promise<CodexPresetsSnapshot> {
    return readPresets(this.plain, cwd);
  }
  async writePreset(
    slot: string,
    preset: CodexPresetInput | null,
    options: { expectedVersion?: string | null; cwd?: string | null } = {},
  ): Promise<CodexPresetsSnapshot> {
    const snapshot = await writePreset(this.plain, slot, preset, options);
    this.notify("presets");
    return snapshot;
  }
}
