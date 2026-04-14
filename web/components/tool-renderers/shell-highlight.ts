import { useEffect, useState } from "react";
import { getSingletonHighlighter } from "shiki";
import { useResolvedTheme } from "../../hooks/use-resolved-theme";
import type { ResolvedTheme } from "../../theme";

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

const SHIKI_THEME_DARK = "vitesse-dark";
const SHIKI_THEME_LIGHT = "github-light-high-contrast";
const SHIKI_LANGS = ["bash", "json"] as const;
type SupportedShikiLanguage = (typeof SHIKI_LANGS)[number];
type SupportedShikiTheme = typeof SHIKI_THEME_DARK | typeof SHIKI_THEME_LIGHT;

const SHIKI_THEME_BY_RESOLVED_THEME: Record<
  ResolvedTheme,
  SupportedShikiTheme
> = {
  dark: SHIKI_THEME_DARK,
  light: SHIKI_THEME_LIGHT,
};

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
  theme: SupportedShikiTheme,
): Promise<string> {
  if (!code) {
    return "";
  }

  const cacheKey = `${theme}\u0000${language}\u0000${code}`;
  let cached = highlightedCodeCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      try {
        if (!highlighterPromise) {
          highlighterPromise = getSingletonHighlighter({
            themes: [SHIKI_THEME_DARK, SHIKI_THEME_LIGHT],
            langs: [...SHIKI_LANGS],
          });
        }
        const instance = await highlighterPromise;
        const html = instance.codeToHtml(code, {
          lang: language,
          theme,
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
  const resolvedTheme = useResolvedTheme();
  const shikiTheme = SHIKI_THEME_BY_RESOLVED_THEME[resolvedTheme];
  const [highlightedHtml, setHighlightedHtml] = useState(() =>
    escapeHtml(code),
  );

  useEffect(() => {
    let cancelled = false;
    setHighlightedHtml(escapeHtml(code));

    void highlightCodeHtml(code, language, shikiTheme).then((html) => {
      if (!cancelled) {
        setHighlightedHtml(html);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, language, shikiTheme]);

  return highlightedHtml;
}

export function useHighlightedShellCommand(command: string): string {
  return useHighlightedCode(command, "bash");
}

export function useHighlightedJsonCode(code: string): string {
  return useHighlightedCode(code, "json");
}
