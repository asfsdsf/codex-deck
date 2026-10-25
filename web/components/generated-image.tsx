import { useEffect, useState } from "react";
import type { ContentBlock } from "@codex-deck/api";
import { generatedImageDataUrl } from "../../api/generated-images";
import { getGeneratedImage } from "../api";

export function GeneratedImage({
  block,
  sessionId,
}: {
  block: ContentBlock;
  sessionId?: string;
}) {
  const image = block.generatedImage!;
  const inline = generatedImageDataUrl(image.result);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    setError(null);
    if (inline || !sessionId || !block.id || !image.savedPath) return;
    let cancelled = false;
    getGeneratedImage(sessionId, block.id).then(
      (result) => {
        if (!cancelled) setPreview(result.dataUrl);
      },
      (reason) => {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : "Image unavailable",
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [inline, sessionId, block.id, image.savedPath]);
  const source = inline ?? preview;
  const [imageLink, setImageLink] = useState<{
    source: string;
    url: string;
  } | null>(null);
  useEffect(() => {
    setImageLink(null);
    if (!source) return;
    let cancelled = false;
    let url: string | undefined;
    // Browsers block top-level data: navigation. A local blob URL supports
    // opening the preview, including context-menu and mobile interactions.
    void fetch(source)
      .then((response) => response.blob())
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImageLink({ source, url });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source]);
  const href = imageLink?.source === source ? imageLink.url : undefined;
  return (
    <figure className="min-w-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
      <figcaption className="space-y-1 p-3 text-sm text-zinc-200">
        <div className="font-medium">
          Generated image · {image.status.replace(/_/g, " ")}
        </div>
        {image.prompt && (
          <p className="whitespace-pre-wrap break-words">{image.prompt}</p>
        )}
        {image.failure && (
          <p role="alert" className="break-words text-red-400">
            {image.failure}
          </p>
        )}
      </figcaption>
      {source ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label="Open generated image"
          aria-disabled={!href}
        >
          <img
            src={source}
            alt={image.prompt || "Generated image"}
            loading="lazy"
            className="max-h-[640px] max-w-full object-contain"
          />
        </a>
      ) : (
        <p className="px-3 pb-3 text-xs text-zinc-400">
          {error ??
            (image.savedPath && sessionId
              ? "Loading image…"
              : image.fileId
                ? "Preview unavailable for this stored attachment."
                : "Waiting for image result…")}
        </p>
      )}
    </figure>
  );
}
