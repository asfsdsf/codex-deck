import { nativeRecord } from "./codex-native";
import { CodexWorkspaceError } from "./codex-working-directory";

/** Mirrors upstream `AskForApproval`; granular policies stay opaque objects. */
export type CodexApprovalPolicy =
  | "untrusted"
  | "on-request"
  | "never"
  | { granular: Record<string, boolean> };
export type CodexApprovalsReviewer =
  | "user"
  | "auto_review"
  | "guardian_subagent";

export interface CodexPermissionSettings {
  threadId: string;
  cwd: string | null;
  approvalPolicy: CodexApprovalPolicy | null;
  approvalsReviewer: CodexApprovalsReviewer | null;
  sandboxPolicy: { type: string; [key: string]: unknown } | null;
  activePermissionProfile: { id: string; extends: string | null } | null;
}

export interface CodexPermissionProfileSummary {
  id: string;
  description: string | null;
  allowed: boolean;
}

export interface CodexPermissionRequirements {
  allowedApprovalPolicies: CodexApprovalPolicy[] | null;
  allowedApprovalsReviewers: CodexApprovalsReviewer[] | null;
  allowedSandboxModes: string[] | null;
  allowedPermissionProfiles: Record<string, boolean> | null;
}

export interface CodexPermissionOption {
  key: string;
  label: string;
  description: string;
  profileId: string;
  approvalPolicy: CodexApprovalPolicy | null;
  approvalsReviewer: CodexApprovalsReviewer | null;
  isCurrent: boolean;
  disabledReason: string | null;
  requiresConfirmation: boolean;
}

export interface CodexPermissionSnapshot {
  settings: CodexPermissionSettings;
  profiles: CodexPermissionProfileSummary[];
  requirements: CodexPermissionRequirements | null;
  autoReviewAvailable: boolean;
  options: CodexPermissionOption[];
  subtitle: string | null;
}

export interface CodexPermissionSelection {
  profileId: string;
  approvalPolicy?: CodexApprovalPolicy | null;
  approvalsReviewer?: CodexApprovalsReviewer | null;
}

export type ThreadRpc = (
  method: string,
  params: Record<string, unknown>,
  threadId?: string | null,
) => Promise<unknown>;

// Upstream TUI wording (chatwidget.rs, permissions_menu.rs, approval presets).
export const ASK_FOR_APPROVAL_LABEL = "Ask for approval";
export const APPROVE_FOR_ME_LABEL = "Approve for me";
const AUTO_REVIEW_DESCRIPTION =
  "Only ask for actions detected as potentially unsafe";
const BUILT_IN_PRESETS = [
  {
    id: "auto",
    profileId: ":workspace",
    label: "Default",
    approval: "on-request" as const,
    description:
      "Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace",
  },
  {
    id: "full-access",
    profileId: ":danger-full-access",
    label: "Full Access",
    approval: "never" as const,
    description:
      "Use with caution: Codex can edit files outside this workspace and access the internet without approval",
  },
  {
    id: "read-only",
    profileId: ":read-only",
    label: "Read Only",
    approval: "on-request" as const,
    description:
      "Read workspace files, with approval required for edits or internet access",
  },
];

const APPROVAL_VALUES = ["untrusted", "on-request", "never"];
const REVIEWER_VALUES = ["user", "auto_review", "guardian_subagent"];

export function parseApprovalPolicy(
  value: unknown,
): CodexApprovalPolicy | null {
  if (typeof value === "string" && APPROVAL_VALUES.includes(value))
    return value as CodexApprovalPolicy;
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const granular = record?.granular;
  if (
    record &&
    Object.keys(record).length === 1 &&
    granular &&
    typeof granular === "object" &&
    !Array.isArray(granular) &&
    Object.values(granular).every((entry) => typeof entry === "boolean")
  )
    return { granular: granular as Record<string, boolean> };
  return null;
}

export function parseApprovalsReviewer(
  value: unknown,
): CodexApprovalsReviewer | null {
  return typeof value === "string" && REVIEWER_VALUES.includes(value)
    ? (value as CodexApprovalsReviewer)
    : null;
}

function sameApproval(
  left: CodexApprovalPolicy | null | undefined,
  right: CodexApprovalPolicy | null | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameReviewer(
  left: CodexApprovalsReviewer | null | undefined,
  right: CodexApprovalsReviewer | null | undefined,
): boolean {
  const normalize = (value: CodexApprovalsReviewer | null | undefined) =>
    value === "guardian_subagent" ? "auto_review" : (value ?? "user");
  return normalize(left) === normalize(right);
}

export function parsePermissionSettings(
  threadId: string,
  value: unknown,
): CodexPermissionSettings {
  const record = nativeRecord(value);
  const sandbox = record.sandboxPolicy ?? record.sandbox;
  const sandboxRecord =
    sandbox && typeof sandbox === "object" && !Array.isArray(sandbox)
      ? (sandbox as { type?: unknown })
      : null;
  const profile =
    record.activePermissionProfile &&
    typeof record.activePermissionProfile === "object"
      ? (record.activePermissionProfile as Record<string, unknown>)
      : null;
  return {
    threadId,
    cwd: typeof record.cwd === "string" ? record.cwd : null,
    approvalPolicy: parseApprovalPolicy(record.approvalPolicy),
    approvalsReviewer: parseApprovalsReviewer(record.approvalsReviewer),
    sandboxPolicy:
      sandboxRecord && typeof sandboxRecord.type === "string"
        ? (sandboxRecord as CodexPermissionSettings["sandboxPolicy"])
        : null,
    activePermissionProfile:
      profile && typeof profile.id === "string"
        ? {
            id: profile.id,
            extends:
              typeof profile.extends === "string" ? profile.extends : null,
          }
        : null,
  };
}

function parseRequirements(value: unknown): CodexPermissionRequirements | null {
  const outer =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const record =
    outer.requirements && typeof outer.requirements === "object"
      ? (outer.requirements as Record<string, unknown>)
      : null;
  if (!record) return null;
  const list = <T>(raw: unknown, parse: (entry: unknown) => T | null) =>
    Array.isArray(raw)
      ? raw.map(parse).filter((entry): entry is T => entry !== null)
      : null;
  const profiles =
    record.allowedPermissionProfiles &&
    typeof record.allowedPermissionProfiles === "object" &&
    !Array.isArray(record.allowedPermissionProfiles)
      ? Object.fromEntries(
          Object.entries(record.allowedPermissionProfiles).filter(
            (entry): entry is [string, boolean] =>
              typeof entry[1] === "boolean",
          ),
        )
      : null;
  return {
    allowedApprovalPolicies: list(
      record.allowedApprovalPolicies,
      parseApprovalPolicy,
    ),
    allowedApprovalsReviewers: list(
      record.allowedApprovalsReviewers,
      parseApprovalsReviewer,
    ),
    allowedSandboxModes: list(record.allowedSandboxModes, (entry) =>
      typeof entry === "string" ? entry : null,
    ),
    allowedPermissionProfiles: profiles,
  };
}

/** Upstream `PermissionDiscovery::disabled_reason`. */
export function permissionDisabledReason(
  profiles: CodexPermissionProfileSummary[],
  requirements: CodexPermissionRequirements | null,
  id: string,
  approval: CodexApprovalPolicy | null,
  reviewer: CodexApprovalsReviewer | null,
): string | null {
  const profile = profiles.find((entry) => entry.id === id);
  if (!profile) return "Not available on this server";
  if (
    !profile.allowed ||
    (requirements?.allowedPermissionProfiles &&
      requirements.allowedPermissionProfiles[id] !== true) ||
    (requirements?.allowedApprovalPolicies &&
      approval &&
      !requirements.allowedApprovalPolicies.some((entry) =>
        sameApproval(entry, approval),
      )) ||
    (requirements?.allowedApprovalsReviewers &&
      reviewer &&
      !requirements.allowedApprovalsReviewers.includes(reviewer))
  )
    return "Disabled by requirements";
  return null;
}

function presetMatchesSandbox(
  profileId: string,
  sandbox: CodexPermissionSettings["sandboxPolicy"],
): boolean {
  const type = sandbox?.type;
  return (
    (profileId === ":read-only" && type === "readOnly") ||
    (profileId === ":workspace" && type === "workspaceWrite") ||
    (profileId === ":danger-full-access" && type === "dangerFullAccess")
  );
}

/** Builds the upstream "Update Model Permissions" picker entries. */
export function buildPermissionOptions(
  settings: CodexPermissionSettings,
  profiles: CodexPermissionProfileSummary[],
  requirements: CodexPermissionRequirements | null,
  autoReviewAvailable: boolean,
): CodexPermissionOption[] {
  if (profiles.length === 0) return [];
  const activeId = settings.activePermissionProfile?.id ?? null;
  const builtin = (
    preset: (typeof BUILT_IN_PRESETS)[number],
    reviewer: CodexApprovalsReviewer,
  ): CodexPermissionOption => {
    const approval: CodexApprovalPolicy =
      reviewer === "auto_review" ? "on-request" : preset.approval;
    const label =
      preset.id === "auto"
        ? reviewer === "auto_review"
          ? APPROVE_FOR_ME_LABEL
          : ASK_FOR_APPROVAL_LABEL
        : preset.label;
    const profileMatches = activeId
      ? activeId === preset.profileId
      : presetMatchesSandbox(preset.profileId, settings.sandboxPolicy);
    return {
      key: `${preset.profileId}:${reviewer}`,
      label,
      description:
        reviewer === "auto_review"
          ? AUTO_REVIEW_DESCRIPTION
          : preset.description,
      profileId: preset.profileId,
      approvalPolicy: approval,
      approvalsReviewer: reviewer,
      isCurrent:
        profileMatches &&
        sameApproval(settings.approvalPolicy, approval) &&
        sameReviewer(settings.approvalsReviewer, reviewer),
      disabledReason: permissionDisabledReason(
        profiles,
        requirements,
        preset.profileId,
        approval,
        reviewer,
      ),
      requiresConfirmation: preset.id === "full-access",
    };
  };
  const [workspace, fullAccess, readOnly] = BUILT_IN_PRESETS;
  const options = [builtin(workspace, "user")];
  if (autoReviewAvailable) options.push(builtin(workspace, "auto_review"));
  options.push(builtin(fullAccess, "user"), builtin(readOnly, "user"));
  for (const profile of profiles) {
    if (profile.id.startsWith(":")) continue;
    options.push({
      key: profile.id,
      label: profile.id,
      description: profile.description || "Configured permission profile",
      profileId: profile.id,
      approvalPolicy: null,
      approvalsReviewer: null,
      isCurrent: activeId === profile.id,
      disabledReason: permissionDisabledReason(
        profiles,
        requirements,
        profile.id,
        null,
        null,
      ),
      requiresConfirmation: false,
    });
  }
  if (
    activeId &&
    !profiles.some((profile) => profile.id === activeId) &&
    !options.some((option) => option.isCurrent)
  )
    options.push({
      key: activeId,
      label: activeId,
      description: "Current permission profile",
      profileId: activeId,
      approvalPolicy: null,
      approvalsReviewer: null,
      isCurrent: true,
      disabledReason: "Not available on this server",
      requiresConfirmation: false,
    });
  return options;
}

function rpcCode(error: unknown): number | null {
  return error && typeof error === "object" && "code" in error
    ? Number((error as { code: unknown }).code)
    : null;
}

function discoveryError(error: unknown): Error {
  const code = rpcCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (
    code === -32601 ||
    (code === -32600 &&
      /permissionProfile\/list|configRequirements\/read|config\/read/.test(
        message,
      ))
  )
    return new Error(
      "This server does not support permission discovery. Upgrade the Codex server to use this menu.",
    );
  return new Error(`Failed to load permissions: ${message}`);
}

/**
 * Reads the effective conversation permissions with the server catalog, and
 * applies selections through `thread/settings/update` for subsequent turns.
 */
export class PermissionManager {
  private settings = new Map<string, CodexPermissionSettings>();

  public constructor(
    private readonly rpc: ThreadRpc,
    private readonly notify: (threadId: string) => void,
  ) {}

  /** Observes `thread/settings/updated`; never consumes the notification. */
  public handleNotification(method: string, params: unknown): void {
    if (method !== "thread/settings/updated") return;
    const record =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : null;
    if (typeof record?.threadId !== "string" || !record.threadSettings) return;
    try {
      const next = parsePermissionSettings(
        record.threadId,
        record.threadSettings,
      );
      const previous = this.settings.get(record.threadId);
      this.settings.set(record.threadId, next);
      if (JSON.stringify(previous) !== JSON.stringify(next))
        this.notify(record.threadId);
    } catch {
      // Ignore malformed settings payloads.
    }
  }

  private async readSettings(
    threadId: string,
  ): Promise<CodexPermissionSettings> {
    const result = await this.rpc("thread/resume", {
      threadId,
      excludeTurns: true,
      persistExtendedHistory: true,
    });
    const settings = parsePermissionSettings(threadId, result);
    this.settings.set(threadId, settings);
    return settings;
  }

  public async read(threadId: string): Promise<CodexPermissionSnapshot> {
    const settings = await this.readSettings(threadId);
    let profiles: CodexPermissionProfileSummary[] = [];
    let requirements: CodexPermissionRequirements | null = null;
    let guardianEnabled = true;
    try {
      const [requirementResult, config] = await Promise.all([
        this.rpc("configRequirements/read", {}),
        this.rpc("config/read", {
          includeLayers: false,
          ...(settings.cwd ? { cwd: settings.cwd } : {}),
        }).catch(() => null),
      ]);
      requirements = parseRequirements(requirementResult);
      const features = (
        (config as { config?: { features?: Record<string, unknown> } } | null)
          ?.config?.features ?? {}
      ).guardian_approval;
      guardianEnabled = features !== false;
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const response = nativeRecord(
          await this.rpc("permissionProfile/list", {
            cursor,
            limit: 100,
            ...(settings.cwd ? { cwd: settings.cwd } : {}),
          }),
        );
        if (!Array.isArray(response.data))
          throw new Error("Invalid permission profile catalog");
        for (const entry of response.data) {
          const value = nativeRecord(entry);
          if (typeof value.id !== "string") continue;
          if (profiles.some((profile) => profile.id === value.id))
            throw new Error(
              "The server returned duplicate permission profiles.",
            );
          profiles.push({
            id: value.id,
            description:
              typeof value.description === "string" ? value.description : null,
            allowed: value.allowed !== false,
          });
        }
        if (response.nextCursor == null) {
          cursor = null;
          break;
        }
        if (
          typeof response.nextCursor !== "string" ||
          seen.has(response.nextCursor)
        )
          throw new Error(
            "Permission discovery exceeded its pagination limit. Try /permissions again.",
          );
        cursor = response.nextCursor;
        seen.add(cursor);
      }
      if (cursor)
        throw new Error(
          "Permission discovery exceeded its pagination limit. Try /permissions again.",
        );
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate permission profiles|pagination limit/.test(error.message)
      )
        throw error;
      throw discoveryError(error);
    }
    // Upstream `cyber_model_approval_reviewer`: auto-review requires the
    // feature plus requirements that allow both on-request and auto_review.
    const autoReviewAvailable =
      guardianEnabled &&
      (!requirements?.allowedApprovalPolicies ||
        requirements.allowedApprovalPolicies.includes("on-request")) &&
      (!requirements?.allowedApprovalsReviewers ||
        requirements.allowedApprovalsReviewers.includes("auto_review"));
    return {
      settings,
      profiles,
      requirements,
      autoReviewAvailable,
      options: buildPermissionOptions(
        settings,
        profiles,
        requirements,
        autoReviewAvailable,
      ),
      subtitle:
        profiles.length === 0
          ? "No permission profiles returned by the server."
          : null,
    };
  }

  public async apply(
    threadId: string,
    selection: CodexPermissionSelection,
  ): Promise<CodexPermissionSnapshot> {
    const snapshot = await this.read(threadId);
    let reviewer = selection.approvalsReviewer ?? null;
    let profileId = selection.profileId.trim();
    // Upstream accepts the menu aliases as inline profile ids.
    if (profileId === ":approve-for-me" || profileId === ":ask-for-approval") {
      reviewer ??= profileId === ":approve-for-me" ? "auto_review" : "user";
      profileId = ":workspace";
    }
    const preset = BUILT_IN_PRESETS.find(
      (entry) => entry.profileId === profileId,
    );
    const approval =
      selection.approvalPolicy ??
      (preset
        ? reviewer === "auto_review"
          ? "on-request"
          : preset.approval
        : null);
    if (preset && !reviewer) reviewer = "user";
    if (reviewer === "auto_review" && !snapshot.autoReviewAvailable)
      throw new CodexWorkspaceError(
        "Approve for me is unavailable. Run `/permissions` to see available profiles.",
      );
    if (!snapshot.profiles.some((profile) => profile.id === profileId))
      throw new CodexWorkspaceError(
        `Unknown permission profile \`${profileId}\`. Run \`/permissions\` to see available profiles.`,
      );
    const reason = permissionDisabledReason(
      snapshot.profiles,
      snapshot.requirements,
      profileId,
      approval,
      reviewer,
    );
    if (reason)
      throw new CodexWorkspaceError(
        `Permission profile \`${profileId}\` is unavailable: ${reason}.`,
      );
    try {
      await this.rpc(
        "thread/settings/update",
        {
          threadId,
          permissions: profileId,
          ...(approval ? { approvalPolicy: approval } : {}),
          ...(reviewer ? { approvalsReviewer: reviewer } : {}),
        },
        threadId,
      );
    } catch (error) {
      if (rpcCode(error) === -32601)
        throw new Error("Permission selection requires a newer app server.");
      throw error;
    }
    this.notify(threadId);
    return this.read(threadId);
  }
}
