import {
  Terminal,
  Play,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
} from "lucide-react";
import { useState } from "react";
import { AnsiText } from "./ansi-text";
import { useHighlightedShellCommand } from "./shell-highlight";

interface BashInput {
  command: string;
  description?: string;
  timeout?: number;
}

interface BashRendererProps {
  input: BashInput;
  embedded?: boolean;
  hideHeader?: boolean;
}

interface BashResultRendererProps {
  content: string;
  isError?: boolean;
  embedded?: boolean;
}

export function BashRenderer(props: BashRendererProps) {
  const { input, embedded = false, hideHeader = false } = props;
  const [copied, setCopied] = useState(false);

  if (!input || !input.command) {
    return null;
  }

  const command = input.command;
  const description = input.description;
  const highlightedCommand = useHighlightedShellCommand(command);

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"}`}>
      <div
        className={`${embedded ? "bg-transparent border-0 rounded-none" : "bg-zinc-900/70 border border-zinc-700/50 rounded-lg"} overflow-hidden`}
      >
        {!hideHeader && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700/50 bg-zinc-800/30">
            <Terminal size={14} className="text-green-400" />
            <span className="text-xs font-medium text-zinc-300">Command</span>
            {description && (
              <span className="text-xs text-zinc-500 truncate ml-1">
                — {description}
              </span>
            )}
            <button
              onClick={handleCopy}
              className="ml-auto p-1 hover:bg-zinc-700/50 rounded transition-colors"
              title="Copy command"
            >
              {copied ? (
                <Check size={12} className="text-green-400" />
              ) : (
                <Copy size={12} className="text-zinc-500" />
              )}
            </button>
          </div>
        )}
        <div className="p-3 overflow-x-auto">
          <div
            className="command-syntax command-syntax-block block text-xs font-mono leading-tight whitespace-pre-wrap break-all"
            dangerouslySetInnerHTML={{ __html: highlightedCommand }}
          />
        </div>
      </div>
    </div>
  );
}

export function BashResultRenderer(props: BashResultRendererProps) {
  const { content, isError, embedded = false } = props;

  if (!content || content.trim().length === 0) {
    return (
      <div className={`w-full ${embedded ? "" : "mt-2"}`}>
        <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/30 border border-zinc-700/50 rounded-lg">
          <CheckCircle2 size={14} className="text-teal-400" />
          <span className="text-xs text-zinc-400">
            Command completed successfully (no output)
          </span>
        </div>
      </div>
    );
  }

  const lines = content.split("\n");
  const maxLines = 30;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;
  const displayContent = displayLines.join("\n");

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"}`}>
      <div
        className={`border rounded-lg overflow-hidden ${
          isError
            ? "bg-rose-950/20 border-rose-900/30"
            : "bg-zinc-900/70 border-zinc-700/50"
        }`}
      >
        <div
          className={`flex items-center gap-2 px-3 py-2 border-b ${
            isError
              ? "border-rose-900/30 bg-rose-900/20"
              : "border-zinc-700/50 bg-zinc-800/30"
          }`}
        >
          {isError ? (
            <>
              <AlertTriangle size={14} className="text-rose-400" />
              <span className="text-xs font-medium text-rose-300">
                Error Output
              </span>
            </>
          ) : (
            <>
              <Play size={14} className="text-teal-400" />
              <span className="text-xs font-medium text-zinc-300">Output</span>
            </>
          )}
          <span className="text-xs text-zinc-500 ml-auto">
            {lines.length} lines
          </span>
        </div>
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <pre
            className={`text-xs font-mono p-3 whitespace-pre-wrap break-all ${
              isError ? "text-rose-200/80" : "text-zinc-300"
            }`}
          >
            <AnsiText text={displayContent} />
            {truncated && (
              <span className="block text-zinc-500 mt-2 pt-2 border-t border-zinc-700/50">
                ... {lines.length - maxLines} more lines
              </span>
            )}
          </pre>
        </div>
      </div>
    </div>
  );
}
