import { useCallback, useRef, useState, type FormEvent } from "react";
import {
  addCodexThreadAttachment,
  getCodexThreadAttachments,
  removeCodexThreadAttachment,
} from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import {
  customAttachmentDraft,
  describeThreadAttachment,
  pullRequestAttachmentFromUrl,
  type ThreadAttachmentDraft,
} from "../thread-attachments";

const inputClass =
  "h-10 w-full min-w-0 rounded border border-zinc-700 bg-zinc-950/60 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none";
const buttonClass =
  "h-10 shrink-0 rounded border border-zinc-700 px-3 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50";

/** Durable resource references (`thread/attachment/*`) for one conversation. */
export default function ThreadAttachments({ threadId }: { threadId: string }) {
  const load = useCallback(
    () => getCodexThreadAttachments(threadId),
    [threadId],
  );
  const { data, loading, error, refresh } = useNativeSnapshot(
    "attachments",
    threadId,
    load,
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [pullRequestUrl, setPullRequestUrl] = useState("");
  const [custom, setCustom] = useState({
    attachmentType: "",
    identityKey: "",
    payload: "",
  });

  const act = async (work: () => Promise<string>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      setNotice(await work());
      refresh();
      return true;
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const add = async (draft: ThreadAttachmentDraft) => {
    const result = await addCodexThreadAttachment(threadId, draft);
    return result.outcome === "existing"
      ? "That resource is already attached."
      : "Attachment added.";
  };

  const submitPullRequest = async (event: FormEvent) => {
    event.preventDefault();
    const draft = pullRequestAttachmentFromUrl(pullRequestUrl);
    if (!draft) {
      setActionError(
        "Enter a pull request URL such as https://github.com/owner/repo/pull/123.",
      );
      return;
    }
    if (await act(() => add(draft))) setPullRequestUrl("");
  };
  const submitCustom = async (event: FormEvent) => {
    event.preventDefault();
    const draft = customAttachmentDraft(custom);
    if (typeof draft === "string") {
      setActionError(draft);
      return;
    }
    if (await act(() => add(draft)))
      setCustom({ attachmentType: "", identityKey: "", payload: "" });
  };

  const attachments = data?.attachments ?? [];
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Resources associated with this conversation, stored separately from its
        history. Forks copy the attachments present when they are created; later
        changes apply to each conversation independently. Removing an attachment
        only forgets the reference — the resource itself is not changed.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || loading}
          className={buttonClass}
          onClick={refresh}
        >
          Refresh
        </button>
      </div>
      {(error || actionError) && (
        <p role="alert" className="break-words text-red-400">
          {actionError || error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-emerald-300">
          {notice}
        </p>
      )}
      {loading && !data && <p role="status">Loading attachments…</p>}
      {data && !attachments.length && (
        <p className="text-zinc-400">No attachments.</p>
      )}
      {attachments.length > 0 && (
        <ul className="space-y-2" aria-label="Attachments">
          {attachments.map((attachment) => {
            const summary = describeThreadAttachment(attachment);
            return (
              <li
                key={attachment.id}
                className="flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    {summary.typeLabel}
                  </p>
                  {summary.href ? (
                    <a
                      href={summary.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block break-all text-cyan-300 underline"
                    >
                      {summary.title}
                    </a>
                  ) : (
                    <p className="break-all font-mono text-xs text-zinc-200">
                      {summary.title}
                    </p>
                  )}
                  {summary.detail && (
                    <p className="break-all font-mono text-[11px] text-zinc-500">
                      {summary.detail}
                    </p>
                  )}
                  <p className="text-[11px] text-zinc-500">
                    Added{" "}
                    {new Date(attachment.createdAt * 1000).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass}
                  onClick={() =>
                    void act(async () => {
                      await removeCodexThreadAttachment(threadId, {
                        attachmentType: attachment.attachmentType,
                        identityKey: attachment.identityKey,
                      });
                      return "Attachment removed.";
                    })
                  }
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        onSubmit={(event) => void submitPullRequest(event)}
        className="space-y-2 rounded-lg border border-zinc-700 p-3"
      >
        <label
          htmlFor="thread-attachment-pr"
          className="block font-medium text-zinc-200"
        >
          Attach a pull request
        </label>
        <div className="flex flex-wrap gap-2 sm:flex-nowrap">
          <input
            id="thread-attachment-pr"
            type="url"
            inputMode="url"
            value={pullRequestUrl}
            onChange={(event) => setPullRequestUrl(event.target.value)}
            placeholder="https://github.com/owner/repo/pull/123"
            className={inputClass}
          />
          <button
            type="submit"
            disabled={busy || !pullRequestUrl.trim()}
            className={buttonClass}
          >
            Attach
          </button>
        </div>
      </form>
      <details className="rounded-lg border border-zinc-700 p-3">
        <summary className="cursor-pointer text-zinc-200">
          Custom resource reference
        </summary>
        <form
          onSubmit={(event) => void submitCustom(event)}
          className="mt-2 space-y-2"
        >
          <p className="text-xs text-zinc-400">
            An attachment is identified by its type and identity key; adding the
            same pair again returns the existing attachment.
          </p>
          <input
            aria-label="Attachment type"
            value={custom.attachmentType}
            onChange={(event) =>
              setCustom({ ...custom, attachmentType: event.target.value })
            }
            placeholder="Type, e.g. issue"
            className={inputClass}
          />
          <input
            aria-label="Identity key"
            value={custom.identityKey}
            onChange={(event) =>
              setCustom({ ...custom, identityKey: event.target.value })
            }
            placeholder="Stable identity key"
            className={inputClass}
          />
          <textarea
            aria-label="Payload JSON"
            value={custom.payload}
            onChange={(event) =>
              setCustom({ ...custom, payload: event.target.value })
            }
            placeholder='Payload JSON, e.g. {"url": "https://…"}'
            rows={3}
            className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-950/60 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
          />
          <button type="submit" disabled={busy} className={buttonClass}>
            Add attachment
          </button>
        </form>
      </details>
    </div>
  );
}
