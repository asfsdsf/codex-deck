import { Bot, Play, Pause, ArrowRight, RefreshCw } from "lucide-react";

interface TaskInput {
  description: string;
  prompt: string;
  subagent_type: string;
  model?: string;
  run_in_background?: boolean;
  resume?: string;
}

interface TaskRendererProps {
  input: TaskInput;
  embedded?: boolean;
  hideHeader?: boolean;
}

function getAgentColor(agentType: string): string {
  const type = agentType.toLowerCase();
  if (type === "explore") {
    return "text-cyan-400";
  }
  if (type === "plan") {
    return "text-violet-400";
  }
  if (type === "claude-code-guide") {
    return "text-amber-400";
  }
  if (type === "general-purpose") {
    return "text-emerald-400";
  }
  return "text-blue-400";
}

function getAgentBgColor(agentType: string): string {
  const type = agentType.toLowerCase();
  if (type === "explore") {
    return "bg-cyan-500/10 border-cyan-500/20";
  }
  if (type === "plan") {
    return "bg-violet-500/10 border-violet-500/20";
  }
  if (type === "claude-code-guide") {
    return "bg-amber-500/10 border-amber-500/20";
  }
  if (type === "general-purpose") {
    return "bg-emerald-500/10 border-emerald-500/20";
  }
  return "bg-blue-500/10 border-blue-500/20";
}

export function TaskRenderer(props: TaskRendererProps) {
  const { input, embedded = false, hideHeader = false } = props;

  if (!input) {
    return null;
  }

  const agentColor = getAgentColor(input.subagent_type);
  const agentBgColor = getAgentBgColor(input.subagent_type);

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"}`}>
      <div
        className={`${embedded ? "bg-transparent border-0 rounded-none" : "bg-zinc-900/70 border border-zinc-700/50 rounded-lg"} overflow-hidden`}
      >
        {!hideHeader && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700/50 bg-zinc-800/30">
            <Bot size={14} className={agentColor} />
            <span className={`text-xs font-medium ${agentColor}`}>
              {input.subagent_type}
            </span>
            {input.description && (
              <>
                <ArrowRight size={10} className="text-zinc-600" />
                <span className="text-xs text-zinc-400">
                  {input.description}
                </span>
              </>
            )}
            <div className="flex items-center gap-1.5 ml-auto">
              {input.resume && (
                <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">
                  <RefreshCw size={10} />
                  resume
                </span>
              )}
              {input.run_in_background && (
                <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">
                  <Pause size={10} />
                  background
                </span>
              )}
              {input.model && (
                <span className="text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">
                  {input.model}
                </span>
              )}
            </div>
          </div>
        )}
        <div className="p-3">
          <div
            className={`flex items-start gap-2 px-3 py-2 rounded-lg border ${agentBgColor}`}
          >
            <Play size={12} className={`${agentColor} mt-0.5 flex-shrink-0`} />
            <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {input.prompt}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
