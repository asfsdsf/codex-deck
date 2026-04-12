import { CheckCircle2, ImageIcon, Terminal } from "lucide-react";
import { BashResultRenderer } from "./bash-renderer";
import { SearchResultRenderer } from "./search-renderer";
import { FileContentRenderer } from "./read-renderer";
import { CopyButton } from "./copy-button";
import { MarkdownRenderer, getFencedCodeBlock } from "../markdown-renderer";
import hljs from "highlight.js/lib/core";
import bashLanguage from "highlight.js/lib/languages/bash";
import cssLanguage from "highlight.js/lib/languages/css";
import goLanguage from "highlight.js/lib/languages/go";
import javaLanguage from "highlight.js/lib/languages/java";
import javascriptLanguage from "highlight.js/lib/languages/javascript";
import jsonLanguage from "highlight.js/lib/languages/json";
import kotlinLanguage from "highlight.js/lib/languages/kotlin";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import phpLanguage from "highlight.js/lib/languages/php";
import pythonLanguage from "highlight.js/lib/languages/python";
import rubyLanguage from "highlight.js/lib/languages/ruby";
import rustLanguage from "highlight.js/lib/languages/rust";
import scssLanguage from "highlight.js/lib/languages/scss";
import swiftLanguage from "highlight.js/lib/languages/swift";
import typescriptLanguage from "highlight.js/lib/languages/typescript";
import xmlLanguage from "highlight.js/lib/languages/xml";
import yamlLanguage from "highlight.js/lib/languages/yaml";
import { getPathBaseName } from "../../path-utils";
import { parseRgOutputLine } from "./rg-parser";

interface FunctionToolResultRendererProps {
  toolName: string;
  content: string;
  isError?: boolean;
  command?: string;
  embedded?: boolean;
  hideHeader?: boolean;
  onFilePathLinkClick?: (href: string) => boolean;
}

interface ExecResultMeta {
  chunkId?: string;
  wallTime?: string;
  exitCode?: number;
  originalTokenCount?: string;
  totalOutputLines?: string;
  body: string;
}

interface RichContentPart {
  type?: string;
  text?: string;
  image_url?: string;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

function registerExecLanguage(
  languageName: string,
  languageDefinition: Parameters<typeof hljs.registerLanguage>[1],
) {
  if (!hljs.getLanguage(languageName)) {
    hljs.registerLanguage(languageName, languageDefinition);
  }
}

registerExecLanguage("bash", bashLanguage);
registerExecLanguage("css", cssLanguage);
registerExecLanguage("go", goLanguage);
registerExecLanguage("java", javaLanguage);
registerExecLanguage("javascript", javascriptLanguage);
registerExecLanguage("json", jsonLanguage);
registerExecLanguage("kotlin", kotlinLanguage);
registerExecLanguage("markdown", markdownLanguage);
registerExecLanguage("php", phpLanguage);
registerExecLanguage("python", pythonLanguage);
registerExecLanguage("ruby", rubyLanguage);
registerExecLanguage("rust", rustLanguage);
registerExecLanguage("scss", scssLanguage);
registerExecLanguage("swift", swiftLanguage);
registerExecLanguage("typescript", typescriptLanguage);
registerExecLanguage("xml", xmlLanguage);
registerExecLanguage("yaml", yamlLanguage);
registerExecLanguage("html", xmlLanguage);

function highlightCode(code: string, language: string): string {
  if (!hljs.getLanguage(language)) {
    return escapeHtml(code);
  }

  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const firstChar = trimmed[0];
  const looksLikeJson =
    firstChar === "{" ||
    firstChar === "[" ||
    firstChar === '"' ||
    trimmed === "null" ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d/.test(trimmed);

  if (!looksLikeJson) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function JsonResultRenderer(props: {
  value: unknown;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  return (
    <MarkdownRenderer
      content={getFencedCodeBlock(stringifyJson(props.value), "json")}
      onFilePathLinkClick={props.onFilePathLinkClick}
    />
  );
}

function formatInlineMarkdown(value: unknown): string {
  if (value === null) {
    return "`null`";
  }

  if (value === undefined) {
    return "`undefined`";
  }

  if (typeof value === "string") {
    if (!value.trim()) {
      return "_(empty)_";
    }

    const normalized = value.replace(/`/g, "\\`");
    return /^[\w./:@-]+$/.test(normalized) ? `\`${normalized}\`` : normalized;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `\`${String(value)}\``;
  }

  return `\`${JSON.stringify(value)}\``;
}

function isMarkdownFriendly(value: unknown, depth: number = 0): boolean {
  if (depth > 4) {
    return false;
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return true;
  }

  if (typeof value === "string") {
    return !value.includes("\n") && value.length <= 240;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isMarkdownFriendly(item, depth + 1));
  }

  if (isRecord(value)) {
    return Object.values(value).every((item) =>
      isMarkdownFriendly(item, depth + 1),
    );
  }

  return false;
}

function toMarkdownList(value: unknown, depth: number = 0): string {
  const indent = "  ".repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indent}- _(empty)_`;
    }

    return value
      .map((item) => {
        if (isRecord(item) || Array.isArray(item)) {
          return `${indent}-\n${toMarkdownList(item, depth + 1)}`;
        }
        return `${indent}- ${formatInlineMarkdown(item)}`;
      })
      .join("\n");
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return `${indent}- _(empty)_`;
    }

    return entries
      .map(([key, item]) => {
        if (isRecord(item) || Array.isArray(item)) {
          return `${indent}- **${key}**:\n${toMarkdownList(item, depth + 1)}`;
        }
        return `${indent}- **${key}**: ${formatInlineMarkdown(item)}`;
      })
      .join("\n");
  }

  return `${indent}- ${formatInlineMarkdown(value)}`;
}

function parseExecOutput(content: string): ExecResultMeta {
  const lines = content.split("\n");
  const meta: ExecResultMeta = { body: content.trimEnd() };

  let bodyStartIndex = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line === "Output:" || line === "") {
      if (line === "Output:") {
        bodyStartIndex = index + 1;
      }
      continue;
    }

    if (line.startsWith("Chunk ID:")) {
      meta.chunkId = line.slice("Chunk ID:".length).trim();
      continue;
    }

    if (line.startsWith("Wall time:")) {
      meta.wallTime = line.slice("Wall time:".length).trim();
      continue;
    }

    const exitCodeMatch = line.match(/^Process exited with code\s+(\d+)/);
    if (exitCodeMatch) {
      meta.exitCode = Number(exitCodeMatch[1]);
      continue;
    }

    if (line.startsWith("Original token count:")) {
      meta.originalTokenCount = line
        .slice("Original token count:".length)
        .trim();
      continue;
    }

    if (line.startsWith("Total output lines:")) {
      meta.totalOutputLines = line.slice("Total output lines:".length).trim();
      continue;
    }

    bodyStartIndex = index;
    break;
  }

  meta.body = lines.slice(bodyStartIndex).join("\n").trimEnd();
  return meta;
}

function MetadataBadge(props: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "error";
}) {
  const { label, value, tone = "neutral" } = props;

  const className =
    tone === "success"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
      : tone === "error"
        ? "border-rose-500/20 bg-rose-500/10 text-rose-200"
        : "border-zinc-700/60 bg-zinc-800/70 text-zinc-400";

  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[10px] ${className}`}
    >
      {label}: {value}
    </span>
  );
}

function shellLikeTokenize(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return tokens.map((token) => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function findLikelyFilePath(command: string): string | null {
  const firstSegment = command.split("|")[0] ?? command;
  const tokens = shellLikeTokenize(firstSegment);
  const candidate = [...tokens]
    .reverse()
    .find(
      (token) =>
        token.length > 0 &&
        token !== "&&" &&
        token !== ";" &&
        !token.startsWith("-") &&
        !token.startsWith("$") &&
        (token.includes("/") || token.includes("\\") || token.includes(".")),
    );
  return candidate ?? null;
}

function languageFromFilePath(filePath: string): string | null {
  const baseName = getPathBaseName(filePath);
  const ext = baseName.split(".").pop()?.toLowerCase() ?? "";
  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    php: "php",
    css: "css",
    scss: "scss",
    html: "html",
    json: "json",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    sh: "bash",
    bash: "bash",
    sql: "sql",
    xml: "xml",
    c: "cpp",
    cc: "cpp",
    cpp: "cpp",
    h: "cpp",
    hpp: "cpp",
  };
  return languageMap[ext] ?? null;
}

function detectCommandRenderMode(command?: string): {
  mode:
    | "plain"
    | "git_diff"
    | "git_status"
    | "git_show"
    | "sed"
    | "cat"
    | "nl"
    | "rg"
    | "ls"
    | "find";
  language?: string | null;
} {
  if (!command) {
    return { mode: "plain" };
  }

  const normalized = command.trim().toLowerCase();

  if (/^git\s+diff(?:\s|$)/.test(normalized)) {
    return { mode: "git_diff" };
  }

  if (/^git\s+status(?:\s|$)/.test(normalized)) {
    return { mode: "git_status" };
  }

  if (/^git\s+show(?:\s|$)/.test(normalized)) {
    return { mode: "git_show" };
  }

  if (/^sed\s+-n(?:\s|$)/.test(normalized)) {
    const filePathCandidate = findLikelyFilePath(command);
    return {
      mode: "sed",
      language: filePathCandidate
        ? languageFromFilePath(filePathCandidate)
        : null,
    };
  }

  if (/^cat(?:\s|$)/.test(normalized)) {
    const filePathCandidate = findLikelyFilePath(command);
    return {
      mode: "cat",
      language: filePathCandidate
        ? languageFromFilePath(filePathCandidate)
        : null,
    };
  }

  if (/^nl(?:\s|$)/.test(normalized)) {
    const filePathCandidate = findLikelyFilePath(command);
    return {
      mode: "nl",
      language: filePathCandidate
        ? languageFromFilePath(filePathCandidate)
        : null,
    };
  }

  if (/^rg(?:\s|$)/.test(normalized)) {
    return { mode: "rg" };
  }

  if (/^find(?:\s|$)/.test(normalized)) {
    return { mode: "find" };
  }

  if (
    /^ls(?:\s|$)/.test(normalized) ||
    /(?:^|\s&&\s)ls(?:\s|$)/.test(normalized)
  ) {
    return { mode: "ls" };
  }

  return { mode: "plain" };
}

function getGitDiffLineClass(line: string): string {
  if (line.startsWith("diff --git")) {
    return "bg-indigo-500/12 text-indigo-200";
  }
  if (line.startsWith("index ")) {
    return "text-zinc-400";
  }
  if (line.startsWith("@@")) {
    return "bg-amber-500/12 text-amber-200";
  }
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return "bg-sky-500/12 text-sky-200";
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "bg-emerald-500/14 text-emerald-200";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "bg-rose-500/14 text-rose-200";
  }
  return "text-zinc-300";
}

function GitDiffOutputRenderer(props: { body: string }) {
  const lines = props.body.replace(/\r\n/g, "\n").split("\n");

  return (
    <pre className="max-h-96 overflow-auto rounded-none border-0 bg-transparent p-0 text-xs whitespace-pre">
      {lines.map((line, index) => (
        <div
          key={`${index}:${line}`}
          className={`px-3 py-0.5 font-mono ${getGitDiffLineClass(line)}`}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function getGitStatusLineClass(line: string): string {
  const trimmed = line.trimStart();

  if (
    line.startsWith("On branch ") ||
    line.startsWith("HEAD detached at ") ||
    line.startsWith("Your branch is ")
  ) {
    return "text-sky-300";
  }
  if (
    line.startsWith("Changes to be committed:") ||
    line.startsWith("Changes not staged for commit:") ||
    line.startsWith("Untracked files:")
  ) {
    return "text-amber-300";
  }
  if (trimmed.startsWith("new file:")) {
    return "text-emerald-300";
  }
  if (trimmed.startsWith("modified:")) {
    return "text-amber-200";
  }
  if (trimmed.startsWith("deleted:")) {
    return "text-rose-300";
  }
  if (
    line.includes("nothing to commit") ||
    line.includes("working tree clean")
  ) {
    return "text-emerald-300";
  }
  return "text-zinc-300";
}

function GitStatusOutputRenderer(props: { body: string }) {
  const lines = props.body.replace(/\r\n/g, "\n").split("\n");

  return (
    <pre className="max-h-96 overflow-auto rounded-none border-0 bg-transparent p-0 text-xs whitespace-pre-wrap break-all">
      {lines.map((line, index) => (
        <div
          key={`${index}:${line}`}
          className={`px-3 py-0.5 font-mono ${getGitStatusLineClass(line)}`}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function isLikelyDiffBody(body: string): boolean {
  return /(^|\n)diff --git /.test(body) || /(^|\n)@@ /.test(body);
}

function getGitShowLineClass(line: string): string {
  if (/^[0-9a-f]{7,40}\s/.test(line) || line.startsWith("commit ")) {
    return "text-sky-300";
  }
  if (/files? changed/.test(line)) {
    return "text-zinc-200";
  }
  if (/insertion/.test(line)) {
    return "text-emerald-300";
  }
  if (/deletion/.test(line)) {
    return "text-rose-300";
  }
  return "text-zinc-300";
}

function GitShowOutputRenderer(props: { body: string }) {
  if (isLikelyDiffBody(props.body)) {
    return <GitDiffOutputRenderer body={props.body} />;
  }

  const lines = props.body.replace(/\r\n/g, "\n").split("\n");
  return (
    <pre className="max-h-96 overflow-auto rounded-none border-0 bg-transparent p-0 text-xs whitespace-pre-wrap break-all">
      {lines.map((line, index) => (
        <div
          key={`${index}:${line}`}
          className={`px-3 py-0.5 font-mono ${getGitShowLineClass(line)}`}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function CodeOutputRenderer(props: { body: string; language: string }) {
  const { body, language } = props;
  return (
    <pre className="max-h-96 overflow-auto rounded-none border-0 p-3 text-xs whitespace-pre-wrap break-all text-zinc-200">
      <code
        className="patch-syntax block"
        dangerouslySetInnerHTML={{
          __html: highlightCode(body, language),
        }}
      />
    </pre>
  );
}

function NlOutputRenderer(props: { body: string; language?: string | null }) {
  const lines = props.body.replace(/\r\n/g, "\n").split("\n");

  return (
    <pre className="max-h-96 overflow-auto rounded-none border-0 bg-transparent p-0 text-xs whitespace-pre">
      {lines.map((line, index) => {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!match) {
          return (
            <div
              key={`${index}:${line}`}
              className="px-3 py-0.5 font-mono text-zinc-300"
            >
              {line || " "}
            </div>
          );
        }

        const code = match[2] ?? "";
        return (
          <div key={`${index}:${line}`} className="flex px-3 py-0.5 font-mono">
            <span className="w-14 shrink-0 pr-3 text-right text-zinc-500">
              {match[1]}
            </span>
            {props.language ? (
              <span
                className="patch-syntax grow text-zinc-200"
                dangerouslySetInnerHTML={{
                  __html: highlightCode(code, props.language),
                }}
              />
            ) : (
              <span className="grow text-zinc-300">{code || " "}</span>
            )}
          </div>
        );
      })}
    </pre>
  );
}

function RgOutputRenderer(props: { body: string }) {
  const lines = props.body.replace(/\r\n/g, "\n").split("\n");

  return (
    <pre className="max-h-96 overflow-auto rounded-none border-0 bg-transparent p-0 text-xs whitespace-pre-wrap break-all">
      {lines.map((line, index) => {
        const parsedLine = parseRgOutputLine(line);

        if (parsedLine.kind === "match_with_column") {
          return (
            <div key={`${index}:${line}`} className="px-3 py-0.5 font-mono">
              <span className="text-cyan-300">{parsedLine.filePath}</span>
              <span className="text-zinc-500">:</span>
              <span className="text-amber-300">{parsedLine.lineNumber}</span>
              <span className="text-zinc-500">:</span>
              <span className="text-fuchsia-300">
                {parsedLine.columnNumber}
              </span>
              <span className="text-zinc-500">:</span>
              <span className="text-zinc-200">{parsedLine.text}</span>
            </div>
          );
        }

        if (parsedLine.kind === "match_with_line") {
          return (
            <div key={`${index}:${line}`} className="px-3 py-0.5 font-mono">
              <span className="text-cyan-300">{parsedLine.filePath}</span>
              <span className="text-zinc-500">:</span>
              <span className="text-amber-300">{parsedLine.lineNumber}</span>
              <span className="text-zinc-500">:</span>
              <span className="text-zinc-200">{parsedLine.text}</span>
            </div>
          );
        }

        if (parsedLine.kind === "path_only") {
          return (
            <div
              key={`${index}:${line}`}
              className="px-3 py-0.5 font-mono text-cyan-300"
            >
              {parsedLine.text}
            </div>
          );
        }

        return (
          <div
            key={`${index}:${line}`}
            className="px-3 py-0.5 font-mono text-zinc-300"
          >
            {parsedLine.text || " "}
          </div>
        );
      })}
    </pre>
  );
}

function getLsLineClass(line: string): string {
  if (line.startsWith("total ")) {
    return "text-zinc-500";
  }
  if (/^d[rwx-]{9}/.test(line)) {
    return "text-sky-300";
  }
  if (/^l[rwx-]{9}/.test(line)) {
    return "text-cyan-300";
  }
  if (/^-[rwx-]{3}[rwx-]{3}[rwx]x/.test(line)) {
    return "text-emerald-300";
  }
  return "text-zinc-300";
}

function LsOutputRenderer(props: { body: string }) {
  const lines = props.body.replace(/\r\n/g, "\n").split("\n");

  return (
    <pre className="max-h-96 overflow-auto rounded-none border-0 bg-transparent p-0 text-xs whitespace-pre-wrap break-all">
      {lines.map((line, index) => (
        <div
          key={`${index}:${line}`}
          className={`px-3 py-0.5 font-mono ${getLsLineClass(line)}`}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function FindOutputRenderer(props: { body: string }) {
  const lines = props.body.replace(/\r\n/g, "\n").split("\n");

  return (
    <pre className="max-h-96 overflow-auto rounded-none border-0 bg-transparent p-0 text-xs whitespace-pre-wrap break-all">
      {lines.map((line, index) => (
        <div
          key={`${index}:${line}`}
          className="px-3 py-0.5 font-mono text-cyan-300"
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function PlainExecOutputRenderer(props: { body: string; isFailure: boolean }) {
  const { body, isFailure } = props;

  return (
    <pre
      className={`max-h-96 overflow-auto rounded-none border-0 p-3 text-xs whitespace-pre-wrap break-all ${
        isFailure ? "text-rose-100/90" : "text-zinc-200"
      }`}
    >
      {body}
    </pre>
  );
}

function ExecResultRenderer(props: {
  content: string;
  isError?: boolean;
  command?: string;
  embedded?: boolean;
  hideHeader?: boolean;
}) {
  const {
    content,
    isError,
    command,
    embedded = false,
    hideHeader = false,
  } = props;
  const parsed = parseExecOutput(content);
  const body = parsed.body || "";
  const isFailure =
    isError || (parsed.exitCode !== undefined && parsed.exitCode !== 0);
  const renderMode = detectCommandRenderMode(command);

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"}`}>
      <div
        className={`overflow-hidden ${
          embedded
            ? "rounded-none border-0 bg-transparent"
            : `rounded-lg border ${
                isFailure
                  ? "border-rose-900/40 bg-rose-950/20"
                  : "border-zinc-700/50 bg-zinc-900/70"
              }`
        }`}
      >
        {!hideHeader && (
          <div
            className={`flex flex-wrap items-center gap-2 border-b px-3 py-2 ${
              isFailure
                ? "border-rose-900/30 bg-rose-900/20"
                : "border-zinc-700/50 bg-zinc-800/30"
            }`}
          >
            <Terminal
              size={14}
              className={isFailure ? "text-rose-300" : "text-green-400"}
            />
            <span className="text-xs font-medium text-zinc-200">
              Terminal output
            </span>
            {parsed.exitCode !== undefined && (
              <MetadataBadge
                label="exit"
                value={String(parsed.exitCode)}
                tone={parsed.exitCode === 0 ? "success" : "error"}
              />
            )}
            {parsed.wallTime && (
              <MetadataBadge label="time" value={parsed.wallTime} />
            )}
            {parsed.originalTokenCount && (
              <MetadataBadge label="tokens" value={parsed.originalTokenCount} />
            )}
            {parsed.totalOutputLines && (
              <MetadataBadge label="lines" value={parsed.totalOutputLines} />
            )}
            {body && <CopyButton text={body} className="ml-auto" />}
          </div>
        )}
        {body ? (
          renderMode.mode === "git_diff" ? (
            <GitDiffOutputRenderer body={body} />
          ) : renderMode.mode === "git_status" ? (
            <GitStatusOutputRenderer body={body} />
          ) : renderMode.mode === "git_show" ? (
            <GitShowOutputRenderer body={body} />
          ) : renderMode.mode === "rg" ? (
            <RgOutputRenderer body={body} />
          ) : renderMode.mode === "ls" ? (
            <LsOutputRenderer body={body} />
          ) : renderMode.mode === "find" ? (
            <FindOutputRenderer body={body} />
          ) : renderMode.mode === "nl" ? (
            <NlOutputRenderer body={body} language={renderMode.language} />
          ) : (renderMode.mode === "sed" || renderMode.mode === "cat") &&
            renderMode.language ? (
            <CodeOutputRenderer body={body} language={renderMode.language} />
          ) : (
            <PlainExecOutputRenderer body={body} isFailure={isFailure} />
          )
        ) : (
          <div className="px-3 py-2 text-xs text-zinc-500">No output</div>
        )}
      </div>
    </div>
  );
}

function RichContentRenderer(props: {
  parts: RichContentPart[];
  embedded?: boolean;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const { parts, embedded = false, onFilePathLinkClick } = props;

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"} space-y-3`}>
      {parts.map((part, index) => {
        if (
          (part.type === "input_text" || part.type === "output_text") &&
          typeof part.text === "string"
        ) {
          return (
            <div
              key={index}
              className="rounded-lg border border-zinc-700/50 bg-zinc-900/70 px-3 py-2.5"
            >
              <MarkdownRenderer
                content={part.text}
                onFilePathLinkClick={onFilePathLinkClick}
              />
            </div>
          );
        }

        if (part.type === "input_image" && typeof part.image_url === "string") {
          return (
            <div
              key={index}
              className="overflow-hidden rounded-lg border border-zinc-700/50 bg-zinc-900/70"
            >
              <div className="flex items-center gap-2 border-b border-zinc-700/50 bg-zinc-800/30 px-3 py-2">
                <ImageIcon size={14} className="text-cyan-400" />
                <span className="text-xs font-medium text-zinc-300">Image</span>
              </div>
              <div className="flex items-center justify-center bg-zinc-950 p-3">
                <img
                  src={part.image_url}
                  alt={`Tool result ${index + 1}`}
                  className="max-h-[420px] w-auto max-w-full rounded-md"
                />
              </div>
            </div>
          );
        }

        return (
          <JsonResultRenderer
            key={index}
            value={part}
            onFilePathLinkClick={onFilePathLinkClick}
          />
        );
      })}
    </div>
  );
}

function StatusResultRenderer(props: {
  label: string;
  detail?: string;
  isError?: boolean;
  embedded?: boolean;
}) {
  const { label, detail, isError, embedded = false } = props;

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"}`}>
      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
          isError
            ? "border-rose-500/20 bg-rose-500/10 text-rose-200"
            : "border-teal-500/20 bg-teal-500/10 text-teal-200"
        }`}
      >
        <CheckCircle2 size={14} className="opacity-80" />
        <span className="text-xs font-medium">{label}</span>
        {detail && <span className="text-xs opacity-75">{detail}</span>}
      </div>
    </div>
  );
}

function ApplyPatchResultRenderer(props: {
  value: Record<string, unknown>;
  isError?: boolean;
  embedded?: boolean;
}) {
  const { value, isError, embedded = false } = props;
  const output = typeof value.output === "string" ? value.output.trim() : "";
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  const lines = output ? output.split("\n").filter(Boolean) : [];
  const summary = lines[0] ?? (isError ? "Patch failed" : "Patch applied");
  const fileLines = lines
    .slice(1)
    .filter((line) => /^([A-Z?]{1,2})\s+/.test(line));

  return (
    <div className={`w-full ${embedded ? "" : "mt-2"}`}>
      <div
        className={`overflow-hidden ${
          embedded
            ? "rounded-none border-0 bg-transparent"
            : `rounded-lg border ${
                isError
                  ? "border-rose-900/40 bg-rose-950/20"
                  : "border-emerald-900/40 bg-emerald-950/20"
              }`
        }`}
      >
        <div
          className={`flex flex-wrap items-center gap-2 border-b px-3 py-2 ${
            isError
              ? "border-rose-900/30 bg-rose-900/20"
              : "border-emerald-900/30 bg-emerald-900/20"
          }`}
        >
          <CheckCircle2
            size={14}
            className={isError ? "text-rose-300" : "text-emerald-300"}
          />
          <span className="text-xs font-medium text-zinc-100">{summary}</span>
          {metadata && typeof metadata.exit_code === "number" && (
            <MetadataBadge
              label="exit"
              value={String(metadata.exit_code)}
              tone={metadata.exit_code === 0 ? "success" : "error"}
            />
          )}
          {metadata && typeof metadata.duration_seconds === "number" && (
            <MetadataBadge
              label="duration"
              value={`${metadata.duration_seconds}s`}
            />
          )}
        </div>
        {fileLines.length > 0 && (
          <div className="divide-y divide-zinc-800/50">
            {fileLines.map((line) => {
              const match = line.match(/^([A-Z?]{1,2})\s+(.+)$/);
              const status = match?.[1] ?? "?";
              const filePath = match?.[2] ?? line;

              return (
                <div
                  key={line}
                  className="flex items-center gap-2 px-3 py-2 text-xs"
                >
                  <span className="w-5 text-center font-medium text-emerald-300">
                    {status}
                  </span>
                  <span className="font-mono text-zinc-300">{filePath}</span>
                  <CopyButton text={filePath} className="ml-auto" />
                </div>
              );
            })}
          </div>
        )}
        {!fileLines.length && output && (
          <div className="px-3 py-2.5">
            <MarkdownRenderer
              content={output}
              onFilePathLinkClick={props.onFilePathLinkClick}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PlainTextResultRenderer(props: FunctionToolResultRendererProps) {
  const { content, isError, embedded = false } = props;

  if (!content || content.trim().length === 0) {
    return (
      <StatusResultRenderer label="Completed successfully" isError={isError} />
    );
  }

  const maxLength = 2000;
  const truncated = content.length > maxLength;
  const displayContent = truncated ? content.slice(0, maxLength) : content;

  return (
    <pre
      className={`${embedded ? "" : "mt-2"} max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border p-3 text-xs ${
        isError
          ? "border-rose-900/30 bg-rose-950/30 text-rose-200/80"
          : "border-teal-900/30 bg-teal-950/30 text-teal-200/80"
      }`}
    >
      {displayContent}
      {truncated && (
        <span className="text-zinc-500">
          ... ({content.length - maxLength} more chars)
        </span>
      )}
    </pre>
  );
}

export function FunctionToolResultRenderer(
  props: FunctionToolResultRendererProps,
) {
  const {
    toolName,
    content,
    isError,
    command,
    embedded = false,
    hideHeader = false,
    onFilePathLinkClick,
  } = props;
  const name = toolName.toLowerCase();
  const parsed = tryParseJson(content);

  if (name === "bash") {
    return (
      <BashResultRenderer
        content={content}
        isError={isError}
        embedded={embedded}
      />
    );
  }

  if (name === "glob") {
    return (
      <SearchResultRenderer content={content} isFileList embedded={embedded} />
    );
  }

  if (name === "grep") {
    return <SearchResultRenderer content={content} embedded={embedded} />;
  }

  if (name === "read") {
    return <FileContentRenderer content={content} embedded={embedded} />;
  }

  if (name === "exec_command" || name === "write_stdin") {
    return (
      <ExecResultRenderer
        content={content}
        isError={isError}
        command={command}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (name === "apply_patch" && isRecord(parsed)) {
    return (
      <ApplyPatchResultRenderer
        value={parsed}
        isError={isError}
        embedded={embedded}
      />
    );
  }

  if (name === "js_repl" || name === "view_image") {
    if (Array.isArray(parsed)) {
      return (
        <RichContentRenderer
          parts={parsed as RichContentPart[]}
          embedded={embedded}
          onFilePathLinkClick={onFilePathLinkClick}
        />
      );
    }
    return <PlainTextResultRenderer {...props} />;
  }

  if (name === "update_plan") {
    return (
      <StatusResultRenderer
        label={content.trim() || "Plan updated"}
        isError={isError}
        embedded={embedded}
      />
    );
  }

  if (name === "js_repl_reset") {
    return (
      <StatusResultRenderer
        label={content.trim() || "Kernel reset"}
        isError={isError}
        embedded={embedded}
      />
    );
  }

  if (name === "web_search") {
    return (
      <StatusResultRenderer
        label="Web search"
        detail={content.trim() || undefined}
        isError={isError}
        embedded={embedded}
      />
    );
  }

  if (
    parsed &&
    isMarkdownFriendly(parsed) &&
    ["spawn_agent", "request_user_input", "wait", "close_agent"].includes(name)
  ) {
    return (
      <div
        className={`${embedded ? "" : "mt-2"} rounded-lg border border-zinc-700/50 bg-zinc-900/70 px-3 py-2.5`}
      >
        <MarkdownRenderer
          content={toMarkdownList(parsed)}
          onFilePathLinkClick={onFilePathLinkClick}
        />
      </div>
    );
  }

  if (parsed !== null) {
    return (
      <JsonResultRenderer
        value={parsed}
        onFilePathLinkClick={onFilePathLinkClick}
      />
    );
  }

  return <PlainTextResultRenderer {...props} />;
}
