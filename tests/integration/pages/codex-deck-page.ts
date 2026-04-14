import { expect, type Locator, type Page } from "@playwright/test";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class CodexDeckPage {
  readonly page: Page;
  readonly rightPane: Locator;
  readonly paneModeSelect: Locator;

  constructor(page: Page) {
    this.page = page;
    this.rightPane = page.locator("aside").last();
    this.paneModeSelect = this.rightPane.locator("select").first();
  }

  async goto(baseURL: string): Promise<void> {
    await this.page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await expect(this.page.getByPlaceholder("Search...")).toBeVisible();
  }

  async selectProject(projectName: string): Promise<void> {
    await this.page.locator("#select-project").click();
    const listbox = this.page.getByRole("listbox", { name: "Projects" });
    await expect(listbox).toBeVisible();
    await listbox
      .getByRole("option", {
        name: new RegExp(`^${escapeRegExp(projectName)}(?:\\s|$)`),
      })
      .click();
  }

  async filterSessions(query: string): Promise<void> {
    await this.page.getByPlaceholder("Search...").fill(query);
  }

  async selectSession(promptSnippet: string): Promise<void> {
    await this.page
      .getByRole("button", {
        name: new RegExp(escapeRegExp(promptSnippet), "i"),
      })
      .click();
  }

  async requestDeleteSession(sessionId: string): Promise<void> {
    await this.page
      .getByRole("button", {
        name: new RegExp(`^Delete session ${escapeRegExp(sessionId)}$`),
      })
      .click();
  }

  async expectDeleteSessionConfirmVisible(): Promise<void> {
    await expect(this.page.getByText("Delete this session?")).toBeVisible();
  }

  async cancelDeleteSession(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
  }

  async confirmDeleteSession(): Promise<void> {
    const prompt = this.page
      .locator("div.fixed")
      .filter({ hasText: "Delete this session?" });
    await prompt.getByRole("button", { name: "Delete" }).click();
  }

  async expectDeleteSessionPrompt(displaySnippet: string): Promise<void> {
    const prompt = this.page
      .locator("div.fixed")
      .filter({ hasText: "Delete this session?" });
    await expect(prompt).toBeVisible();
    await expect(
      prompt.getByText(new RegExp(escapeRegExp(displaySnippet), "i")).first(),
    ).toBeVisible();
  }

  async expectSessionVisible(promptSnippet: string): Promise<void> {
    await expect(
      this.page.getByRole("button", {
        name: new RegExp(escapeRegExp(promptSnippet), "i"),
      }),
    ).toBeVisible();
  }

  async expectSessionHidden(promptSnippet: string): Promise<void> {
    await expect(
      this.page.getByRole("button", {
        name: new RegExp(escapeRegExp(promptSnippet), "i"),
      }),
    ).toBeHidden();
  }

  async openConversationSearch(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Search this conversation" })
      .click();
    await expect(
      this.page.getByRole("searchbox", { name: "Search conversation" }),
    ).toBeVisible();
  }

  async searchConversation(query: string): Promise<void> {
    await this.page
      .getByRole("searchbox", { name: "Search conversation" })
      .fill(query);
  }

  async chooseRightPaneMode(label: string): Promise<void> {
    const expandRightPaneButton = this.page.getByRole("button", {
      name: "Expand right pane",
    });
    if (await expandRightPaneButton.isVisible().catch(() => false)) {
      await expandRightPaneButton.click();
    }

    await expect(this.paneModeSelect).toBeVisible();
    await this.paneModeSelect.selectOption({ label });
  }

  async openProjectDirectory(name: string): Promise<void> {
    await this.rightPane
      .getByRole("button", {
        name: new RegExp(`^${escapeRegExp(name)}$`),
      })
      .click();
  }

  async openProjectFile(name: string): Promise<void> {
    await this.rightPane
      .getByRole("button", {
        name: new RegExp(`^${escapeRegExp(name)}(?:\\s|$)`),
      })
      .click();
  }
}
