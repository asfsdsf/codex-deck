import type { CodexThreadAttachment } from "@codex-deck/api";

export const PULL_REQUEST_ATTACHMENT_TYPE = "pull_request";

export interface ThreadAttachmentDraft {
  attachmentType: string;
  identityKey: string;
  payload: unknown;
}

/**
 * Builds the canonical pull-request identity documented by app-server:
 * `JSON.stringify([canonicalHostname, lowercaseOwner, lowercaseRepository,
 * pullRequestNumber])`, so every surface adds and removes the same entry.
 */
export function pullRequestAttachmentFromUrl(
  value: string,
): ThreadAttachmentDraft | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const owner = decodeURIComponent(match[1]);
  const repository = decodeURIComponent(match[2]).replace(/\.git$/i, "");
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return {
    attachmentType: PULL_REQUEST_ATTACHMENT_TYPE,
    identityKey: JSON.stringify([
      host,
      owner.toLowerCase(),
      repository.toLowerCase(),
      number,
    ]),
    payload: {
      url: `${url.protocol}//${url.host}/${owner}/${repository}/pull/${number}`,
    },
  };
}

/** Parses the advanced form; the payload must be JSON. */
export function customAttachmentDraft(input: {
  attachmentType: string;
  identityKey: string;
  payload: string;
}): ThreadAttachmentDraft | string {
  const attachmentType = input.attachmentType.trim();
  if (!attachmentType) return "Enter an attachment type.";
  if (!input.identityKey) return "Enter an identity key.";
  let payload: unknown = null;
  if (input.payload.trim()) {
    try {
      payload = JSON.parse(input.payload);
    } catch {
      return "Payload must be valid JSON.";
    }
  }
  return { attachmentType, identityKey: input.identityKey, payload };
}

const TYPE_LABELS: Record<string, string> = {
  pull_request: "Pull request",
  worktree: "Worktree",
  archived_worktree: "Archived worktree",
};

export interface ThreadAttachmentSummary {
  typeLabel: string;
  title: string;
  /** Only http(s) links are offered as clickable. */
  href: string | null;
  detail: string | null;
}

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function describeThreadAttachment(
  attachment: CodexThreadAttachment,
): ThreadAttachmentSummary {
  const url = payloadString(attachment.payload, "url");
  let href: string | null = null;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        href = parsed.href;
    } catch {
      href = null;
    }
  }
  const root =
    payloadString(attachment.payload, "workspaceRoot") ??
    payloadString(attachment.payload, "root");
  return {
    typeLabel:
      TYPE_LABELS[attachment.attachmentType] ?? attachment.attachmentType,
    title: url ?? root ?? attachment.identityKey,
    href,
    detail: url || root ? attachment.identityKey : null,
  };
}
