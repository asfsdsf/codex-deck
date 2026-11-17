import { test, expect } from "./helpers/codex-deck-fixture";

for (const theme of ["light", "dark"] as const) {
  test(`remote admin login, token creation, password rotation, and logout in ${theme} mode`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    let authenticated = false;
    let password = "admin-secret";
    const tokens: Array<{
      id: string;
      label: string;
      enabled: boolean;
      createdAt: number;
      updatedAt: number;
      lastUsedAt: number | null;
    }> = [];

    await page.route("**/v1/admin/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/admin/auth/login") {
        authenticated = request.postDataJSON().password === password;
        await route.fulfill({
          status: authenticated ? 200 : 401,
          json: authenticated
            ? { success: true }
            : {
                code: "remote_admin_password_invalid",
                error: "Invalid admin password.",
              },
        });
        return;
      }
      if (!authenticated) {
        await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
        return;
      }
      if (path === "/v1/admin/auth/logout") {
        authenticated = false;
        await route.fulfill({ json: { success: true } });
        return;
      }
      if (path === "/v1/admin/password") {
        expect(request.postDataJSON().oldPassword).toBe(password);
        password = request.postDataJSON().newPassword;
        await route.fulfill({ json: { success: true } });
        return;
      }
      expect(path).toBe("/v1/admin/setup-tokens");
      if (request.method() === "POST") {
        const token = {
          id: "token-1",
          label: request.postDataJSON().label,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastUsedAt: null,
        };
        tokens.push(token);
        await route.fulfill({ json: { token, rawToken: "test-setup-token" } });
        return;
      }
      await route.fulfill({ json: { tokens } });
    });

    await page.goto(`${app.baseURL}/admin`);
    await expect(
      page.getByRole("heading", { name: "Server Admin" }),
    ).toBeVisible();
    const passwordInput = page.getByPlaceholder("Enter admin password");
    await passwordInput.fill("wrong-password");
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await expect(
      page.getByText("Admin password is incorrect.", { exact: true }),
    ).toBeVisible();
    await passwordInput.fill(password);
    await page.getByRole("button", { name: "Show Admin Password" }).click();
    await expect(passwordInput).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide Admin Password" }).click();
    await expect(passwordInput).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await page.getByPlaceholder("Optional token label").fill("Development CLI");
    await page
      .getByRole("button", { name: "Create Token", exact: true })
      .click();
    await expect(
      page.getByText("test-setup-token", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Disable", exact: true }),
    ).toBeVisible();

    await page
      .getByPlaceholder("Enter the current admin password")
      .fill(password);
    await page
      .getByPlaceholder("Enter a new admin password")
      .fill("new-admin-secret");
    await page
      .getByPlaceholder("Enter the new password again")
      .fill("new-admin-secret");
    await page
      .getByRole("button", { name: "Rotate Password", exact: true })
      .click();
    await expect(
      page.getByPlaceholder("Enter the current admin password"),
    ).toHaveValue("");
    expect(password).toBe("new-admin-secret");
    await page.getByRole("button", { name: "Logout", exact: true }).click();
    await expect(passwordInput).toBeVisible();
    await passwordInput.fill(password);
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Disable", exact: true }),
    ).toBeVisible();
  });
}
