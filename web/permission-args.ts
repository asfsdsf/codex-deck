import type {
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexPermissionSelection,
} from "@codex-deck/api";

export const PERMISSIONS_USAGE =
  "Usage: /permissions <profile-id> [--approval-policy=<policy>] [--reviewer=user|auto_review]";

function parseApproval(value: string): CodexApprovalPolicy {
  if (value === "untrusted" || value === "on-request" || value === "never")
    return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && "granular" in parsed)
      return parsed as CodexApprovalPolicy;
  } catch {
    // Fall through to the upstream error.
  }
  throw new Error(
    `Unknown approval policy \`${value}\`. Expected \`untrusted\`, \`on-request\`, \`never\`, or a granular policy.`,
  );
}

function parseReviewer(value: string): CodexApprovalsReviewer {
  if (value === "user" || value === "auto_review") return value;
  throw new Error(
    `Unknown permission reviewer \`${value}\`. Expected \`user\` or \`auto_review\`.`,
  );
}

/** Mirrors upstream `/permissions <profile-id> [--approval-policy] [--reviewer]`. */
export function parsePermissionArgs(args: string): CodexPermissionSelection {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const match = /^(--approval-policy|--reviewer)(?:=(.*))?$/.exec(token);
    if (!match) {
      if (token.startsWith("--"))
        throw new Error(`Unknown permission option \`${token}\`.`);
      positionals.push(token);
      continue;
    }
    const value = match[2] ?? tokens[++index];
    if (!value) throw new Error(`Missing value for \`${match[1]}\`.`);
    if (match[1] in flags) throw new Error(`Duplicate option \`${match[1]}\`.`);
    flags[match[1]] = value;
  }
  if (!positionals[0]) throw new Error(PERMISSIONS_USAGE);
  if (positionals[1])
    throw new Error(`Unexpected permission argument \`${positionals[1]}\`.`);
  return {
    profileId: positionals[0],
    approvalPolicy: flags["--approval-policy"]
      ? parseApproval(flags["--approval-policy"])
      : null,
    approvalsReviewer: flags["--reviewer"]
      ? parseReviewer(flags["--reviewer"])
      : null,
  };
}

export function describeApprovalPolicy(
  policy: CodexApprovalPolicy | null,
): string {
  if (!policy) return "Unavailable";
  if (typeof policy === "string") return policy;
  const enabled = Object.entries(policy.granular)
    .filter(([, value]) => value)
    .map(([key]) => key.replaceAll("_", " "));
  return `granular (${enabled.join(", ") || "none"})`;
}

export function describeReviewer(
  reviewer: CodexApprovalsReviewer | null,
): string {
  if (reviewer === "auto_review" || reviewer === "guardian_subagent")
    return "Auto-review";
  return "You";
}

export function describeSandbox(
  sandbox: { type: string; [key: string]: unknown } | null,
): string {
  if (!sandbox) return "Unavailable";
  const network =
    sandbox.networkAccess === true || sandbox.networkAccess === "enabled"
      ? ", network enabled"
      : sandbox.type === "dangerFullAccess"
        ? ""
        : ", network restricted";
  switch (sandbox.type) {
    case "readOnly":
      return `read-only${network}`;
    case "workspaceWrite": {
      const roots = Array.isArray(sandbox.writableRoots)
        ? sandbox.writableRoots.length
        : 0;
      return `workspace-write${network}${roots ? `, ${roots} extra writable root${roots === 1 ? "" : "s"}` : ""}`;
    }
    case "dangerFullAccess":
      return "danger-full-access";
    case "externalSandbox":
      return `external sandbox${network}`;
    default:
      return sandbox.type;
  }
}
