import type { ContentBlock } from "./storage";

/** Normalize hosted, extension, and legacy image-generation lifecycle items. */
export function parseGeneratedImage(value: unknown): ContentBlock | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const item = raw;
  const type = String(item.type ?? "")
    .replace(/_/g, "")
    .toLowerCase();
  if (
    item.kind !== "image_gen.generation" &&
    ![
      "imagegeneration",
      "imagegenerationcall",
      "imagegenerationbegin",
      "imagegenerationend",
    ].includes(type)
  )
    return null;
  const string = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    type: "image_generation",
    id: string(item.id ?? item.call_id),
    generatedImage: {
      status: string(item.status) ?? "in_progress",
      prompt: string(item.revisedPrompt ?? item.revised_prompt),
      result: string(item.result),
      fileId: string(item.fileId ?? item.file_id),
      savedPath: string(item.savedPath ?? item.saved_path),
      failure: item.failure ? JSON.stringify(item.failure) : undefined,
    },
  };
}

/** Generated results are inline raster images, never arbitrary navigation URLs. */
export function generatedImageDataUrl(result?: string): string | null {
  if (!result?.trim()) return null;
  const value = result.trim();
  if (
    /^data:image\/(png|jpeg|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(value)
  )
    return value;
  if (/^[a-z0-9+/=\s]+$/i.test(value))
    return `data:image/png;base64,${value.replace(/\s/g, "")}`;
  return null;
}
