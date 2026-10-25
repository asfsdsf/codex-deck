import { useEffect, useState } from "react";
import { getConversation } from "../api";
import {
  downloadMarkdown,
  transcriptFilename,
  transcriptMarkdown,
} from "../transcript-export";

export default function TranscriptExport({
  threadId,
  filename = "",
}: {
  threadId: string;
  filename?: string;
}) {
  const [name, setName] = useState(filename || `conversation-${threadId}.md`);
  const [text, setText] = useState("");
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void getConversation(threadId)
      .then(
        (messages) => {
          if (active) {
            setText(transcriptMarkdown(messages, threadId));
            setCount(messages.length);
          }
        },
        (reason) => {
          if (active)
            setError(reason instanceof Error ? reason.message : String(reason));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [threadId, version]);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Export the complete available transcript, including tool calls and
        results, as Markdown. Running turns are captured at export time.
      </p>
      {loading && <p role="status">Preparing transcript…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      <label className="block space-y-1">
        <span>File name</span>
        <input
          aria-label="Export file name"
          className="w-full rounded border border-zinc-700 bg-zinc-950 p-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p>
        {count} messages · {new Blob([text]).size.toLocaleString()} bytes
      </p>
      <label className="block space-y-1">
        <span>Markdown preview</span>
        <textarea
          aria-label="Markdown preview"
          readOnly
          value={text}
          rows={14}
          className="w-full rounded border border-zinc-700 bg-zinc-950/40 p-2 font-mono text-xs"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={loading || !!error || !text}
          className="rounded bg-cyan-600 px-3 py-2 text-white disabled:opacity-50"
          onClick={() =>
            downloadMarkdown(text, transcriptFilename(name, threadId))
          }
        >
          Download Markdown
        </button>
        <button
          disabled={loading}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
          onClick={() => setVersion((current) => current + 1)}
        >
          Refresh transcript
        </button>
      </div>
    </div>
  );
}
