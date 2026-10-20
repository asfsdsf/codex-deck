import type { Page } from "@playwright/test";

/** Send a real SSE partial, then hold the final snapshot until the test releases it. */
export async function mockStreamingTranslations(page: Page) {
  const sources: string[] = [];
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/translate", async (route) => {
    const { text, stream } = route.request().postDataJSON();
    if (!stream) throw new Error("Expected a streaming translation request");
    const translationId = String(sources.push(text) - 1);
    await route.fulfill({
      json: { translationId, translatedText: "", done: false },
    });
  });
  await page.route("**/api/translations/**", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3];
    const text = sources[Number(id)];
    if (url.pathname.endsWith("/stream")) {
      await route.fulfill({
        contentType: "text/event-stream",
        body: `event: translation\ndata: ${JSON.stringify({ translationId: id, translatedText: `部分：${text}`, done: false })}\n\n`,
      });
    } else {
      await completed;
      await route.fulfill({
        json: {
          translationId: id,
          translatedText: `完整：${text}`,
          done: true,
        },
      });
    }
  });
  return { sources, release };
}
