import { Circle, CircleCheck, Loader2, ListTodo } from "lucide-react";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TodoRendererProps {
  todos: TodoItem[];
  embedded?: boolean;
  hideHeader?: boolean;
}

function getStatusIcon(status: string) {
  if (status === "completed") {
    return <CircleCheck size={14} className="text-emerald-400" />;
  }
  if (status === "in_progress") {
    return <Loader2 size={14} className="text-amber-400 animate-spin" />;
  }
  return <Circle size={14} className="text-zinc-500" />;
}

function getStatusClass(status: string) {
  if (status === "completed") {
    return "text-zinc-400 line-through";
  }
  if (status === "in_progress") {
    return "text-amber-200";
  }
  return "text-zinc-300";
}

export function TodoRenderer(props: TodoRendererProps) {
  const { todos, embedded = false, hideHeader = false } = props;

  if (!todos || todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const totalCount = todos.length;

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"}`}>
      <div
        className={`${embedded ? "bg-transparent border-0 rounded-none" : "bg-zinc-900/70 border border-zinc-700/50 rounded-lg"} overflow-hidden`}
      >
        {!hideHeader && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700/50 bg-zinc-800/30">
            <ListTodo size={14} className="text-violet-400" />
            <span className="text-xs font-medium text-zinc-300">Tasks</span>
            <span className="text-xs text-zinc-500 ml-auto">
              {completedCount}/{totalCount}
            </span>
            <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all duration-300"
                style={{ width: `${(completedCount / totalCount) * 100}%` }}
              />
            </div>
          </div>
        )}
        <ul className="divide-y divide-zinc-800/50">
          {todos.map((todo, index) => (
            <li
              key={index}
              className="flex items-start gap-2.5 px-3 py-2 hover:bg-zinc-800/20 transition-colors"
            >
              <span className="mt-0.5 flex-shrink-0">
                {getStatusIcon(todo.status)}
              </span>
              <span
                className={`text-xs leading-relaxed ${getStatusClass(todo.status)}`}
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
