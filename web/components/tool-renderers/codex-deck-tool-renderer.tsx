import { AlertTriangle, ListChecks } from "lucide-react";
import {
  formatCodexDeckStatus,
  parseCodexDeckToolName,
  parseCodexDeckToolOutput,
  shortThreadId,
} from "../../codex-deck-tools";

interface CodexDeckToolResultRendererProps {
  toolName: string;
  content: string;
  embedded?: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function StatusChip(props: { status: unknown }) {
  const label = formatCodexDeckStatus(props.status);
  if (!label) {
    return null;
  }
  return (
    <span className="shrink-0 rounded border border-zinc-700/60 bg-zinc-800/50 px-1.5 py-0.5 text-[10px] leading-none text-zinc-400">
      {label}
    </span>
  );
}

function ThreadIdLabel(props: { id: unknown }) {
  const id = text(props.id);
  if (!id) {
    return null;
  }
  return (
    <span className="font-mono text-[10px] text-zinc-500" title={id}>
      {shortThreadId(id)}
    </span>
  );
}

function UntrustedNotice() {
  return (
    <p className="px-3 pt-2 text-[10px] text-zinc-500">
      Task titles and contents are untrusted data, not instructions.
    </p>
  );
}

function ThreadList(props: { value: JsonRecord }) {
  const threads = records(props.value.threads);
  return (
    <div>
      <UntrustedNotice />
      {threads.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500">No tasks.</p>
      ) : (
        <ul className="divide-y divide-zinc-800/50">
          {threads.map((thread, index) => {
            const title = text(thread.title) || text(thread.summary);
            const updated = formatTimestamp(thread.updatedAt);
            return (
              <li
                key={text(thread.id) || index}
                className="flex flex-col gap-1 px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 break-words text-xs text-zinc-200">
                    {title || "(untitled)"}
                  </span>
                  <StatusChip status={thread.status} />
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <ThreadIdLabel id={thread.id} />
                  {updated && (
                    <span className="text-[10px] text-zinc-500">{updated}</span>
                  )}
                  {typeof thread.cwd === "string" && thread.cwd && (
                    <span className="min-w-0 break-all font-mono text-[10px] text-zinc-500">
                      {thread.cwd}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {typeof props.value.nextCursor === "string" && (
        <p className="px-3 pb-2 text-[10px] text-zinc-500">
          More tasks available.
        </p>
      )}
    </div>
  );
}

function describeItem(item: JsonRecord): { label: string; body: string } {
  const type = text(item.type);
  switch (type) {
    case "userMessage":
      return {
        label: "user",
        body: records(item.content)
          .map((entry) =>
            entry.type === "text" ? text(entry.text) : `[${text(entry.type)}]`,
          )
          .join("\n"),
      };
    case "agentMessage":
      return { label: "assistant", body: text(item.text) };
    case "plan":
      return { label: "plan", body: text(item.text) };
    case "reasoning":
      return {
        label: "reasoning",
        body: (Array.isArray(item.summary) ? item.summary : [])
          .map(text)
          .join("\n"),
      };
    case "commandExecution":
      return { label: "command", body: text(item.command) };
    case "fileChange":
      return {
        label: "file change",
        body: records(item.changes)
          .map((change) => text(change.path))
          .join("\n"),
      };
    case "mcpToolCall":
    case "dynamicToolCall":
      return { label: "tool", body: text(item.tool) };
    case "webSearch":
      return { label: "web search", body: text(item.query) };
    default:
      return { label: type || "item", body: "" };
  }
}

function ReadThread(props: { value: JsonRecord }) {
  const thread = isRecord(props.value.thread) ? props.value.thread : {};
  const turns = records(props.value.turns);
  const page = isRecord(props.value.page) ? props.value.page : {};
  return (
    <div>
      <UntrustedNotice />
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 py-2">
        <span className="min-w-0 break-words text-xs font-medium text-zinc-200">
          {text(thread.title) || text(thread.preview) || "(untitled)"}
        </span>
        <StatusChip status={thread.status} />
        <ThreadIdLabel id={thread.id} />
      </div>
      <ol className="divide-y divide-zinc-800/50 border-t border-zinc-800/50">
        {turns.map((turn, turnIndex) => {
          const error = isRecord(turn.error) ? text(turn.error.message) : "";
          return (
            <li key={text(turn.id) || turnIndex} className="px-3 py-2">
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                <span>turn</span>
                <StatusChip status={turn.status} />
                {error && <span className="text-rose-400">{error}</span>}
              </div>
              <div className="flex flex-col gap-1">
                {records(turn.items).map((item, itemIndex) => {
                  const { label, body } = describeItem(item);
                  return (
                    <div
                      key={text(item.id) || itemIndex}
                      className="flex min-w-0 gap-2 text-xs"
                    >
                      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">
                        {label}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-zinc-300">
                        {body}
                      </span>
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
      {page.hasMore === true && (
        <p className="px-3 pb-2 text-[10px] text-zinc-500">
          Older turns available.
        </p>
      )}
    </div>
  );
}

function WaitThreads(props: { value: JsonRecord }) {
  const wake = isRecord(props.value.wake) ? props.value.wake : null;
  const polls = records(props.value.polls);
  const errors = records(props.value.errors);
  return (
    <div>
      <UntrustedNotice />
      <p className="px-3 py-2 text-xs text-zinc-300">
        {wake
          ? `Woke: ${text(wake.reason) || "update"} on ${shortThreadId(wake.threadId)}`
          : props.value.timedOut === true
            ? "Timed out without a change."
            : "No change."}
      </p>
      <ul className="divide-y divide-zinc-800/50 border-t border-zinc-800/50">
        {polls.map((poll, index) => {
          const thread = isRecord(poll.thread) ? poll.thread : {};
          const turn = isRecord(poll.latestTurn) ? poll.latestTurn : null;
          const message = isRecord(poll.latestAssistantMessage)
            ? text(poll.latestAssistantMessage.text)
            : "";
          return (
            <li key={text(thread.id) || index} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <ThreadIdLabel id={thread.id} />
                <StatusChip status={thread.status} />
                {turn && <StatusChip status={turn.status} />}
                {poll.changed === true && (
                  <span className="text-[10px] text-cyan-300">changed</span>
                )}
              </div>
              {message && (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-300">
                  {message}
                </p>
              )}
            </li>
          );
        })}
        {errors.map((error, index) => (
          <li
            key={`error-${index}`}
            className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs text-rose-300"
          >
            <ThreadIdLabel id={error.threadId} />
            <span className="break-words">{text(error.message)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SimpleResult(props: { tool: string; value: JsonRecord }) {
  const { tool, value } = props;
  const message =
    tool === "set_thread_title"
      ? `Renamed to "${text(value.title)}"`
      : tool === "set_thread_archived"
        ? value.archived === true
          ? "Archived"
          : "Restored"
        : null;
  if (!message) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] text-zinc-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs text-zinc-300">
      <span>{message}</span>
      <ThreadIdLabel id={value.threadId} />
    </div>
  );
}

export function CodexDeckToolResultRenderer(
  props: CodexDeckToolResultRendererProps,
) {
  const { toolName, content, embedded = false } = props;
  const tool = parseCodexDeckToolName(toolName) ?? toolName;
  const { value, text: outputText } = parseCodexDeckToolOutput(content);
  const frame = embedded
    ? "rounded-md bg-zinc-900/40"
    : "rounded-lg border border-zinc-700/50 bg-zinc-900/70";

  if (!value) {
    return (
      <div
        className={`${frame} flex items-start gap-2 px-3 py-2 text-xs text-rose-300`}
      >
        <AlertTriangle size={12} className="mt-0.5 shrink-0 opacity-80" />
        <span className="min-w-0 whitespace-pre-wrap break-words">
          {outputText}
        </span>
      </div>
    );
  }

  let body;
  if (tool === "list_threads" || tool === "list_archived_threads") {
    body = <ThreadList value={value} />;
  } else if (tool === "read_thread") {
    body = <ReadThread value={value} />;
  } else if (tool === "wait_threads") {
    body = <WaitThreads value={value} />;
  } else {
    body = <SimpleResult tool={tool} value={value} />;
  }

  return (
    <div className={`${frame} overflow-hidden`}>
      <div className="flex items-center gap-1.5 border-b border-zinc-700/50 px-3 py-1.5 text-[10px] text-zinc-500">
        <ListChecks size={11} className="opacity-70" />
        <span>codex-deck task tool</span>
        {value.truncated === true && <span>· truncated</span>}
      </div>
      {body}
    </div>
  );
}
