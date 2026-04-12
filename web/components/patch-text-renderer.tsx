import { useEffect, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/core";
import bashLanguage from "highlight.js/lib/languages/bash";
import cppLanguage from "highlight.js/lib/languages/cpp";
import cssLanguage from "highlight.js/lib/languages/css";
import goLanguage from "highlight.js/lib/languages/go";
import javaLanguage from "highlight.js/lib/languages/java";
import javascriptLanguage from "highlight.js/lib/languages/javascript";
import jsonLanguage from "highlight.js/lib/languages/json";
import kotlinLanguage from "highlight.js/lib/languages/kotlin";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import phpLanguage from "highlight.js/lib/languages/php";
import plaintextLanguage from "highlight.js/lib/languages/plaintext";
import pythonLanguage from "highlight.js/lib/languages/python";
import rubyLanguage from "highlight.js/lib/languages/ruby";
import rustLanguage from "highlight.js/lib/languages/rust";
import scssLanguage from "highlight.js/lib/languages/scss";
import swiftLanguage from "highlight.js/lib/languages/swift";
import typescriptLanguage from "highlight.js/lib/languages/typescript";
import xmlLanguage from "highlight.js/lib/languages/xml";
import yamlLanguage from "highlight.js/lib/languages/yaml";

const PATCH_FILE_HEADER_REGEX = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_TO_HEADER_REGEX = /^\*\*\* Move to: (.+)$/;
const PATCH_UNIFIED_HUNK_HEADER_REGEX =
  /^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/;

type PatchFileOperation = "add" | "update" | "delete";
type PatchLineNumberState = {
  oldLineNumber: number | null;
  newLineNumber: number | null;
};

type PatchLanguageInfo = {
  label: string;
  highlight: string | null;
};

const PATCH_EXTENSION_LANGUAGE_MAP: Record<string, PatchLanguageInfo> = {
  ts: { label: "TypeScript", highlight: "typescript" },
  tsx: { label: "TypeScript React", highlight: "typescript" },
  js: { label: "JavaScript", highlight: "javascript" },
  jsx: { label: "JavaScript React", highlight: "javascript" },
  mjs: { label: "JavaScript", highlight: "javascript" },
  cjs: { label: "JavaScript", highlight: "javascript" },
  json: { label: "JSON", highlight: "json" },
  css: { label: "CSS", highlight: "css" },
  scss: { label: "SCSS", highlight: "scss" },
  html: { label: "HTML", highlight: "html" },
  md: { label: "Markdown", highlight: "markdown" },
  markdown: { label: "Markdown", highlight: "markdown" },
  mdx: { label: "Markdown", highlight: "markdown" },
  mkd: { label: "Markdown", highlight: "markdown" },
  mkdn: { label: "Markdown", highlight: "markdown" },
  mdown: { label: "Markdown", highlight: "markdown" },
  yml: { label: "YAML", highlight: "yaml" },
  yaml: { label: "YAML", highlight: "yaml" },
  sh: { label: "Shell", highlight: "bash" },
  py: { label: "Python", highlight: "python" },
  go: { label: "Go", highlight: "go" },
  rs: { label: "Rust", highlight: "rust" },
  java: { label: "Java", highlight: "java" },
  kt: { label: "Kotlin", highlight: "kotlin" },
  swift: { label: "Swift", highlight: "swift" },
  rb: { label: "Ruby", highlight: "ruby" },
  php: { label: "PHP", highlight: "php" },
  c: { label: "C", highlight: "cpp" },
  cc: { label: "C++", highlight: "cpp" },
  cpp: { label: "C++", highlight: "cpp" },
  h: { label: "C/C++ Header", highlight: "cpp" },
  hpp: { label: "C++ Header", highlight: "cpp" },
  vue: { label: "Vue", highlight: "html" },
  svelte: { label: "Svelte", highlight: "html" },
};

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

function registerPatchLanguage(
  languageName: string,
  languageDefinition: Parameters<typeof hljs.registerLanguage>[1],
) {
  if (!hljs.getLanguage(languageName)) {
    hljs.registerLanguage(languageName, languageDefinition);
  }
}

registerPatchLanguage("bash", bashLanguage);
registerPatchLanguage("cpp", cppLanguage);
registerPatchLanguage("css", cssLanguage);
registerPatchLanguage("go", goLanguage);
registerPatchLanguage("java", javaLanguage);
registerPatchLanguage("javascript", javascriptLanguage);
registerPatchLanguage("json", jsonLanguage);
registerPatchLanguage("kotlin", kotlinLanguage);
registerPatchLanguage("markdown", markdownLanguage);
registerPatchLanguage("php", phpLanguage);
registerPatchLanguage("plaintext", plaintextLanguage);
registerPatchLanguage("python", pythonLanguage);
registerPatchLanguage("ruby", rubyLanguage);
registerPatchLanguage("rust", rustLanguage);
registerPatchLanguage("scss", scssLanguage);
registerPatchLanguage("swift", swiftLanguage);
registerPatchLanguage("typescript", typescriptLanguage);
registerPatchLanguage("xml", xmlLanguage);
registerPatchLanguage("yaml", yamlLanguage);
registerPatchLanguage("html", xmlLanguage);

export function detectPatchLanguageFromPath(
  filePath: string,
): PatchLanguageInfo {
  const ext = filePath.toLowerCase().split(".").pop() || "";
  const knownLanguage = PATCH_EXTENSION_LANGUAGE_MAP[ext];
  if (knownLanguage) {
    return knownLanguage;
  }
  if (ext) {
    return { label: ext.toUpperCase(), highlight: null };
  }
  return { label: "Text", highlight: null };
}

export function getPatchFileTypes(raw: string): string[] {
  const lines = raw.split("\n");
  const types = new Set<string>();

  for (const line of lines) {
    const match = line.match(PATCH_FILE_HEADER_REGEX);
    if (!match) {
      continue;
    }
    types.add(detectPatchLanguageFromPath(match[2].trim()).label);
  }

  return [...types];
}

function getPatchFileOperation(line: string): PatchFileOperation | null {
  const fileHeaderMatch = line.match(PATCH_FILE_HEADER_REGEX);
  if (!fileHeaderMatch) {
    return null;
  }

  const operation = fileHeaderMatch[1].toLowerCase();
  if (operation === "add" || operation === "update" || operation === "delete") {
    return operation;
  }
  return null;
}

function getPatchHunkStartLineNumbers(
  line: string,
): PatchLineNumberState | null {
  const hunkMatch = line.match(PATCH_UNIFIED_HUNK_HEADER_REGEX);
  if (!hunkMatch) {
    return null;
  }

  return {
    oldLineNumber: Number.parseInt(hunkMatch[1], 10),
    newLineNumber: Number.parseInt(hunkMatch[2], 10),
  };
}

function getPatchLineNumbersForCodeLine(
  prefix: string,
  state: PatchLineNumberState,
): { oldLine: number | null; newLine: number | null } {
  if (prefix === "+") {
    const newLine = state.newLineNumber;
    if (state.newLineNumber !== null) {
      state.newLineNumber += 1;
    }
    return { oldLine: null, newLine };
  }

  if (prefix === "-") {
    const oldLine = state.oldLineNumber;
    if (state.oldLineNumber !== null) {
      state.oldLineNumber += 1;
    }
    return { oldLine, newLine: null };
  }

  const oldLine = state.oldLineNumber;
  const newLine = state.newLineNumber;
  if (state.oldLineNumber !== null) {
    state.oldLineNumber += 1;
  }
  if (state.newLineNumber !== null) {
    state.newLineNumber += 1;
  }

  return { oldLine, newLine };
}

function getPatchLineNumberDisplay(value: number | null): string {
  return value === null ? " " : String(value);
}

function getPatchPreferredLineNumber(lineNumbers: {
  oldLine: number | null;
  newLine: number | null;
}): number | null {
  if (lineNumbers.newLine !== null) {
    return lineNumbers.newLine;
  }
  if (lineNumbers.oldLine !== null) {
    return lineNumbers.oldLine;
  }
  return null;
}

function getPatchLineClass(line: string): string {
  if (line.startsWith("diff --git")) {
    return "bg-indigo-500/12 text-indigo-200";
  }
  if (line.startsWith("index ")) {
    return "text-zinc-400";
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "bg-emerald-500/14";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "bg-rose-500/14";
  }
  if (line.startsWith("@@")) {
    return "bg-amber-500/12 text-amber-200";
  }
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return "bg-sky-500/12 text-sky-200";
  }
  if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
    return "bg-sky-500/12 text-sky-200";
  }
  if (line.match(PATCH_FILE_HEADER_REGEX)) {
    return "bg-indigo-500/14 text-indigo-200";
  }
  if (line.startsWith("***")) {
    return "bg-zinc-700/40 text-zinc-200";
  }
  return "text-zinc-300";
}

function getPatchLineCode(
  line: string,
): { prefix: string; code: string } | null {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return null;
  }

  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return { prefix: line[0], code: line.slice(1) };
  }

  return null;
}

function getPatchPrefixClass(prefix: string): string {
  if (prefix === "+") {
    return "text-emerald-300";
  }
  if (prefix === "-") {
    return "text-rose-300";
  }
  return "text-zinc-500";
}

function getPatchSyntaxClassName(language: string | null): string {
  return language === "markdown"
    ? "patch-syntax patch-syntax-markdown"
    : "patch-syntax";
}

function highlightPatchCode(code: string, language: string | null): string {
  if (!code.length) {
    return "&nbsp;";
  }

  if (!language || !hljs.getLanguage(language)) {
    return escapeHtml(code);
  }

  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

export interface PatchTextRendererProps {
  raw: string;
  filePathHint?: string | null;
  maxHeightClassName?: string;
  onFilePathLinkClick?: (href: string) => boolean;
}

function handlePatchFilePathClick(
  filePath: string,
  onFilePathLinkClick?: (href: string) => boolean,
): boolean {
  if (onFilePathLinkClick && onFilePathLinkClick(filePath)) {
    return true;
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("codex-deck:file-path-link-click", {
        detail: { href: filePath },
      }),
    );
    return true;
  }

  return false;
}

export function PatchTextRenderer(props: PatchTextRendererProps) {
  const {
    raw,
    filePathHint = null,
    maxHeightClassName = "max-h-[420px]",
    onFilePathLinkClick,
  } = props;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  return (
    <pre
      className={`m-0 ${maxHeightClassName} overflow-auto rounded-none border-0 bg-transparent p-0 text-xs leading-relaxed`}
    >
      {(() => {
        let activeLanguage = filePathHint
          ? detectPatchLanguageFromPath(filePathHint).highlight
          : null;
        let currentFileOperation: PatchFileOperation | null = null;
        const lineNumberState: PatchLineNumberState = {
          oldLineNumber: null,
          newLineNumber: null,
        };

        return lines.map((line, index) => {
          const fileHeaderMatch = line.match(PATCH_FILE_HEADER_REGEX);
          if (fileHeaderMatch) {
            const operation = getPatchFileOperation(line);
            currentFileOperation = operation;
            const filePath = fileHeaderMatch[2].trim();
            activeLanguage = detectPatchLanguageFromPath(filePath).highlight;

            if (operation === "add") {
              lineNumberState.oldLineNumber = null;
              lineNumberState.newLineNumber = 1;
            } else if (operation === "delete") {
              lineNumberState.oldLineNumber = 1;
              lineNumberState.newLineNumber = null;
            } else {
              lineNumberState.oldLineNumber = 1;
              lineNumberState.newLineNumber = 1;
            }
          }

          const moveToMatch = line.match(PATCH_MOVE_TO_HEADER_REGEX);
          if (moveToMatch) {
            activeLanguage = detectPatchLanguageFromPath(
              moveToMatch[1].trim(),
            ).highlight;
          }

          const hunkStart = getPatchHunkStartLineNumbers(line);
          if (hunkStart) {
            lineNumberState.oldLineNumber = hunkStart.oldLineNumber;
            lineNumberState.newLineNumber = hunkStart.newLineNumber;
          } else if (line.startsWith("@@")) {
            if (currentFileOperation === "add") {
              lineNumberState.oldLineNumber = null;
              if (lineNumberState.newLineNumber === null) {
                lineNumberState.newLineNumber = 1;
              }
            } else if (currentFileOperation === "delete") {
              if (lineNumberState.oldLineNumber === null) {
                lineNumberState.oldLineNumber = 1;
              }
              lineNumberState.newLineNumber = null;
            } else if (currentFileOperation === "update") {
              if (lineNumberState.oldLineNumber === null) {
                lineNumberState.oldLineNumber = 1;
              }
              if (lineNumberState.newLineNumber === null) {
                lineNumberState.newLineNumber = 1;
              }
            }
          }

          const codeLine = getPatchLineCode(line);
          const isMarkdownCodeLine =
            activeLanguage === "markdown" && codeLine !== null;
          const lineClass = `${isMarkdownCodeLine ? "min-w-full w-full whitespace-pre-wrap break-words" : "min-w-full w-max whitespace-pre"} px-3 py-0.5 font-mono ${getPatchLineClass(
            line,
          )}`;

          if (!codeLine) {
            const fileHeaderMatch = line.match(PATCH_FILE_HEADER_REGEX);
            if (fileHeaderMatch) {
              const prefix = `*** ${fileHeaderMatch[1]} File: `;
              const filePath = fileHeaderMatch[2].trim();
              return (
                <div key={`${index}:${line}`} className={lineClass}>
                  {prefix}
                  <button
                    type="button"
                    className="cursor-pointer rounded-sm border-0 bg-transparent p-0 font-mono text-current underline decoration-zinc-500/70 underline-offset-2 hover:text-cyan-200 hover:decoration-cyan-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
                    onClick={(event) => {
                      const handled = handlePatchFilePathClick(
                        filePath,
                        onFilePathLinkClick,
                      );
                      if (handled) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                    title={`Open ${filePath}`}
                  >
                    {filePath}
                  </button>
                </div>
              );
            }

            const moveToMatch = line.match(PATCH_MOVE_TO_HEADER_REGEX);
            if (moveToMatch) {
              const filePath = moveToMatch[1].trim();
              return (
                <div key={`${index}:${line}`} className={lineClass}>
                  {"*** Move to: "}
                  <button
                    type="button"
                    className="cursor-pointer rounded-sm border-0 bg-transparent p-0 font-mono text-current underline decoration-zinc-500/70 underline-offset-2 hover:text-cyan-200 hover:decoration-cyan-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
                    onClick={(event) => {
                      const handled = handlePatchFilePathClick(
                        filePath,
                        onFilePathLinkClick,
                      );
                      if (handled) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                    title={`Open ${filePath}`}
                  >
                    {filePath}
                  </button>
                </div>
              );
            }

            return (
              <div key={`${index}:${line}`} className={lineClass}>
                {line || " "}
              </div>
            );
          }

          const lineNumbers = getPatchLineNumbersForCodeLine(
            codeLine.prefix,
            lineNumberState,
          );

          return (
            <div key={`${index}:${line}`} className={lineClass}>
              <span className="inline-block w-[5ch] select-none pr-2 text-right tabular-nums text-zinc-400">
                {getPatchLineNumberDisplay(
                  getPatchPreferredLineNumber(lineNumbers),
                )}
              </span>
              <span
                className={`inline-block w-[1ch] select-none ${getPatchPrefixClass(
                  codeLine.prefix,
                )}`}
              >
                {codeLine.prefix}
              </span>
              <span
                className={getPatchSyntaxClassName(activeLanguage)}
                dangerouslySetInnerHTML={{
                  __html: highlightPatchCode(codeLine.code, activeLanguage),
                }}
              />
            </div>
          );
        });
      })()}
    </pre>
  );
}

export interface SourceCodeRendererProps {
  content: string;
  filePathHint?: string | null;
  firstLineNumber?: number | null;
  focusLineNumber?: number | null;
  maxHeightClassName?: string;
}

export function SourceCodeRenderer(props: SourceCodeRendererProps) {
  const {
    content,
    filePathHint = null,
    firstLineNumber = null,
    focusLineNumber = null,
    maxHeightClassName = "max-h-none",
  } = props;
  const activeLanguage = filePathHint
    ? detectPatchLanguageFromPath(filePathHint).highlight
    : null;
  const syntaxClassName = getPatchSyntaxClassName(activeLanguage);
  const preWhitespaceClassName =
    activeLanguage === "markdown"
      ? "whitespace-pre-wrap break-words"
      : "whitespace-pre";
  const focusedLineRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(
    () => content.replace(/\r\n/g, "\n").split("\n"),
    [content],
  );

  useEffect(() => {
    if (!focusedLineRef.current) {
      return;
    }
    focusedLineRef.current.scrollIntoView({
      block: "center",
      behavior: "auto",
    });
  }, [focusLineNumber, content, firstLineNumber]);

  if (typeof firstLineNumber === "number" && firstLineNumber > 0) {
    return (
      <pre
        className={`m-0 ${maxHeightClassName} overflow-auto rounded-none border-0 bg-transparent p-0 text-xs leading-relaxed ${preWhitespaceClassName}`}
      >
        {lines.map((line, index) => {
          const lineNumber = firstLineNumber + index;
          const isFocused = focusLineNumber === lineNumber;
          return (
            <div
              key={`${lineNumber}:${line}`}
              ref={isFocused ? focusedLineRef : null}
              className={`px-3 py-0.5 font-mono ${isFocused ? "bg-amber-500/14 ring-1 ring-amber-400/35 ring-inset" : ""}`}
            >
              <span className="inline-block w-[6ch] select-none pr-2 text-right tabular-nums text-zinc-500">
                {lineNumber}
              </span>
              <span
                className={syntaxClassName}
                dangerouslySetInnerHTML={{
                  __html: highlightPatchCode(line, activeLanguage),
                }}
              />
            </div>
          );
        })}
      </pre>
    );
  }

  return (
    <pre
      className={`m-0 ${maxHeightClassName} overflow-auto rounded-none border-0 bg-transparent p-3 text-xs leading-relaxed ${preWhitespaceClassName}`}
    >
      <code
        className={`${syntaxClassName} block`}
        dangerouslySetInnerHTML={{
          __html: highlightPatchCode(content, activeLanguage),
        }}
      />
    </pre>
  );
}
