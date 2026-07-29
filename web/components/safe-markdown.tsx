import { Component, type ReactNode } from "react";
import { MarkdownRenderer } from "./markdown-renderer";

interface SafeMarkdownProps {
  content: string;
  className?: string;
  onFilePathLinkClick?: (href: string) => boolean;
}

interface SafeMarkdownState {
  failed: boolean;
}

/**
 * Renders translated text as markdown, but falls back to raw pre-wrapped
 * text when the markdown pipeline cannot render it properly (translation
 * may mangle markdown structure).
 */
export class SafeMarkdown extends Component<
  SafeMarkdownProps,
  SafeMarkdownState
> {
  state: SafeMarkdownState = { failed: false };

  static getDerivedStateFromError(): SafeMarkdownState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn("Translated markdown failed to render; showing raw text", error);
  }

  componentDidUpdate(prevProps: SafeMarkdownProps): void {
    if (prevProps.content !== this.props.content && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    const { content, className = "", onFilePathLinkClick } = this.props;
    if (this.state.failed) {
      return (
        <pre
          className={`whitespace-pre-wrap break-words font-sans text-sm ${className}`}
        >
          {content}
        </pre>
      );
    }
    return (
      <MarkdownRenderer
        content={content}
        className={className}
        onFilePathLinkClick={onFilePathLinkClick}
      />
    );
  }
}
