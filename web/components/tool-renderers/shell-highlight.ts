import { useEffect, useState } from "react";
import { getSingletonHighlighter } from "shiki";

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

const SHIKI_THEME = "vitesse-dark";
const SHIKI_LANGS = ["bash", "json"] as const;
type SupportedShikiLanguage = (typeof SHIKI_LANGS)[number];

let highlighterPromise: ReturnType<typeof getSingletonHighlighter> | null =
  null;
const highlightedCodeCache = new Map<string, Promise<string>>();

function extractCodeInnerHtml(html: string): string {
  const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/i);
  return match?.[1] ?? html;
}

async function highlightCodeHtml(
  code: string,
  language: SupportedShikiLanguage,
): Promise<string> {
  if (!code) {
    return "";
  }

  const cacheKey = `${language}\u0000${code}`;
  let cached = highlightedCodeCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      try {
        const highlighter =
          highlighterPromise ??
          getSingletonHighlighter({
            themes: [SHIKI_THEME],
            langs: [...SHIKI_LANGS],
          });
        highlighterPromise = highlighter;
        const instance = await highlighter;
        const html = instance.codeToHtml(code, {
          lang: language,
          theme: SHIKI_THEME,
        });
        return extractCodeInnerHtml(html);
      } catch {
        return escapeHtml(code);
      }
    })();
    highlightedCodeCache.set(cacheKey, cached);
  }

  return cached;
}

export function useHighlightedCode(
  code: string,
  language: SupportedShikiLanguage,
): string {
  const [highlightedHtml, setHighlightedHtml] = useState(() =>
    escapeHtml(code),
  );

  useEffect(() => {
    let cancelled = false;
    setHighlightedHtml(escapeHtml(code));

    void highlightCodeHtml(code, language).then((html) => {
      if (!cancelled) {
        setHighlightedHtml(html);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return highlightedHtml;
}

export function useHighlightedShellCommand(command: string): string {
  return useHighlightedCode(command, "bash");
}

export function useHighlightedJsonCode(code: string): string {
  return useHighlightedCode(code, "json");
}
