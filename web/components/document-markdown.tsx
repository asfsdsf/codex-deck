import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Check } from "lucide-react";
import { RightPaneIcon } from "./deepseek/right-pane-icons";

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textOf(child.props.children)
        : String(child),
    )
    .join("");
}

function DocumentCodeBlock({ children }: { children?: ReactNode }) {
  const [wrapped, setWrapped] = useState(true);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const code = textOf(children).replace(/\n$/, "");
  const child = Children.toArray(children)[0];
  const language = isValidElement<{ className?: string }>(child)
    ? child.props.className?.replace("language-", "")
    : undefined;
  return (
    <div className="right-pane-document__code-block">
      <div className="right-pane-document__code-toolbar">
        <span>
          {!language || /^(?:text|txt|plaintext|plain)$/i.test(language)
            ? "Code block"
            : language}
        </span>
        <span className="right-pane__fill" />
        <button
          type="button"
          aria-label="Wrap lines"
          title={wrapped ? "Unwrap lines" : "Wrap lines"}
          aria-pressed={wrapped}
          onClick={() => setWrapped(!wrapped)}
        >
          <RightPaneIcon name="wrap-lines" />
        </button>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy"}
          title={copied ? "Copied" : "Copy"}
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => {
                setCopied(true);
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), 1600);
              })
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <Check /> : <RightPaneIcon name="copy" />}
        </button>
      </div>
      <pre data-wrap={wrapped}>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: DocumentCodeBlock,
  table: ({ children }) => (
    <div className="right-pane-document__table">
      <table>{children}</table>
    </div>
  ),
};

// Workspace Markdown can contain HTML (README badges, pictures, tables). Strip
// executable elements/attributes before KaTeX adds its own trusted markup.
const documentSchema: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "picture", "source"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "align"],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-./, "math-inline", "math-display"],
    ],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
    source: ["srcSet", "media", "type"],
  },
};

/** Document typography follows ui-sidebar-documentpreview and ui-primitives, not chat bubbles. */
export default function DocumentMarkdown({
  content,
  onOpenPath,
  resolveImage,
}: {
  content: string;
  onOpenPath?: (href: string) => boolean;
  resolveImage?: (src: string) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showContents, setShowContents] = useState(false);
  const frontmatter =
    /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(
      content,
    );
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  // Resolve workspace images through the same transport as file previews (also works remotely).
  useEffect(() => {
    let cancelled = false;
    if (resolveImage)
      for (const image of ref.current?.querySelectorAll<HTMLImageElement>(
        "img",
      ) ?? []) {
        const src = image.getAttribute("src");
        if (!src || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src)) continue;
        void resolveImage(src)
          .then((url) => {
            if (!cancelled && url) image.src = url;
          })
          .catch(() => {});
      }
    if (resolveImage)
      for (const source of ref.current?.querySelectorAll<HTMLSourceElement>(
        "source[srcset]",
      ) ?? []) {
        const src = source.getAttribute("srcset");
        if (!src || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) continue;
        void Promise.all(
          src.split(",").map(async (candidate) => {
            const [path, descriptor] = candidate.trim().split(/\s+/);
            const url = await resolveImage(path);
            return url ? `${url}${descriptor ? ` ${descriptor}` : ""}` : "";
          }),
        )
          .then((values) => {
            if (!cancelled) source.srcset = values.filter(Boolean).join(", ");
          })
          .catch(() => {});
      }
    return () => {
      cancelled = true;
    };
  }, [body, resolveImage]);
  const [headings, setHeadings] = useState<string[]>([]);
  useEffect(() => {
    setHeadings(
      Array.from(ref.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? []).map(
        (element) => element.textContent ?? "",
      ),
    );
  }, [body]);
  return (
    <div className="right-pane-document" ref={ref} data-document-markdown>
      {headings.length ? (
        <div className="right-pane-document__contents">
          <button
            type="button"
            className="right-pane__icon-button"
            aria-label="Table of contents"
            title="Table of contents"
            aria-expanded={showContents}
            onClick={() => setShowContents(!showContents)}
          >
            <RightPaneIcon name="table-of-contents" />
          </button>
          {showContents ? (
            <nav aria-label="Table of contents">
              {headings.map((heading, index) => (
                <button
                  type="button"
                  key={index}
                  onClick={() => {
                    ref.current
                      ?.querySelectorAll("h1,h2,h3,h4,h5,h6")
                      [index]?.scrollIntoView({ block: "start" });
                    setShowContents(false);
                  }}
                >
                  {heading.replace(/^#+ /, "")}
                </button>
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}
      {frontmatter ? (
        <pre className="right-pane-document__frontmatter">{frontmatter[1]}</pre>
      ) : null}
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, documentSchema],
          rehypeKatex,
        ]}
        components={{
          ...components,
          a: ({ href, children }) => (
            <a
              href={href}
              target={href?.startsWith("#") ? undefined : "_blank"}
              rel="noreferrer"
              onClick={(event) => {
                if (href?.startsWith("#")) {
                  const target = Array.from(
                    ref.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? [],
                  ).find(
                    (el) =>
                      el.textContent
                        ?.toLowerCase()
                        .replace(/[^\p{L}\p{N}\s-]/gu, "")
                        .replace(/\s+/g, "-") === decodeFragment(href.slice(1)),
                  );
                  if (target) {
                    event.preventDefault();
                    target.scrollIntoView({ block: "start" });
                  }
                } else if (href && onOpenPath?.(href)) event.preventDefault();
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}
