import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Match the syntax supported by MarkdownRenderer, including table cells.
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

interface TextSpan {
  start: number;
  end: number;
  text: string;
}

function getTextSpans(source: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    // Autolink labels are also their destinations; keep URLs unchanged.
    if (node.type === "link" && source[start] !== "[") return;
    if (node.type === "text" && node.value?.trim()) {
      spans.push({ start, end, text: node.value });
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(source));
  return spans;
}

function escapeMarkdownText(text: string): string {
  // Translated punctuation and line breaks must stay inside the original text
  // node, rather than becoming table delimiters, links, or new block syntax.
  return text.replace(/[!-/:-@[-`{-~]/g, "\\$&").replace(/\r\n?|\n/g, "&#10;");
}

/** Translate text leaves while retaining the source Markdown verbatim elsewhere. */
export async function translateMarkdown(
  source: string,
  translate: (
    text: string,
    onProgress?: (text: string) => void,
  ) => Promise<string>,
  onProgress?: (text: string) => void,
): Promise<string> {
  let translated = "";
  let position = 0;
  const completed = new Map<string, string>();
  for (const { start, end, text } of getTextSpans(source)) {
    translated += source.slice(position, start);
    const prefix = translated;
    const original = source.slice(start, end);
    const format = (value: string) =>
      value === text
        ? original
        : (text.match(/^\s*/)?.[0] ?? "") +
          escapeMarkdownText(value.trim()) +
          (text.match(/\s*$/)?.[0] ?? "");
    let result = completed.get(text);
    if (result === undefined) {
      result = await translate(
        text,
        onProgress
          ? (partial) =>
              onProgress(prefix + format(partial) + source.slice(end))
          : undefined,
      );
      if (!result.trim()) throw new Error("Translation is empty.");
      completed.set(text, result);
    }
    translated += format(result);
    position = end;
    // Retain untranslated cells and closing syntax during streaming, too.
    onProgress?.(translated + source.slice(position));
  }
  return translated + source.slice(position);
}
