import { expect, test } from "@playwright/test";

/**
 * PWA shortcuts (roadmap "send to this device"): the manifest's shortcut
 * URLs open the app with `?screen=…`, which selects the same page state
 * the home screen's quiet links do. The query string must be cleared so a
 * reload does not replay it.
 */

test.describe("app shortcuts", () => {
  test("?screen=send opens the Send screen and clears the query", async ({ page }) => {
    await page.goto("/?screen=send");
    await expect(page.getByRole("heading", { name: "Ready to send" })).toBeVisible();
    expect(new URL(page.url()).search).toBe("");
    // The shortcut is a pairing entry point, so Start/Join must be there.
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Join" })).toBeVisible();
  });

  test("?screen=selftest opens the connection self-test", async ({ page }) => {
    await page.goto("/?screen=selftest");
    await expect(page.getByRole("heading", { name: "Connection test" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run test" })).toBeVisible();
    expect(new URL(page.url()).search).toBe("");
  });

  test("an unknown screen value leaves the home screen alone", async ({ page }) => {
    await page.goto("/?screen=nonsense");
    await expect(page.getByRole("heading", { name: "Dropbeam" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  });

  test("?screen=about opens the About and privacy page", async ({ page }) => {
    await page.goto("/?screen=about");
    await expect(page.getByRole("heading", { name: "About and privacy" })).toBeVisible();
    // The four statements §15 asks for are on the page, not in a document
    // somewhere else: this is where a user would look for them.
    await expect(page.getByText("No data is collected.")).toBeVisible();
    await expect(page.getByText(/No cookies are set/)).toBeVisible();
    expect(new URL(page.url()).search).toBe("");
  });

  test("the home screen's quiet links reach it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "About and privacy" }).click();
    await expect(page.getByRole("heading", { name: "About and privacy" })).toBeVisible();
  });
});
