import { processImage } from "./processImage";
import { describe, expect, it } from "vitest";

describe("processImage", () => {
  it("should resize image", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2fQAAAAASUVORK5CYII=";
    const img = Buffer.from(pngBase64, "base64");
    const result = await processImage(img);

    expect(result.format).toBe("png");
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.pixels.length).toBeGreaterThan(0);
    expect(result.thumbhash.length).toBeGreaterThan(0);
  });
});
