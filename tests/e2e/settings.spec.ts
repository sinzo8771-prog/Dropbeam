import { expect, test } from "@playwright/test";

/**
 * FR-41 settings in a real browser: the sheet reaches the document
 * (theme attribute, language attribute, Devanagari font face, the
 * reduce-motion token override) and survives a reload through the
 * allowlisted `localStorage` keys (FR-40).
 */

async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

/**
 * A segmented control's radios are visually hidden and non-interactive by
 * design (base.css) — the label is the hit target, exactly as for a user.
 * So the click targets the label; the role query stays for assertions.
 */
async function pickSegment(page: import("@playwright/test").Page, label: string): Promise<void> {
  await page.locator(".segments label", { hasText: label }).click();
}

test.describe("settings sheet (FR-41)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("applies the dark theme to the document tokens", async ({ page }) => {
    await openSettings(page);
    await pickSegment(page, "Dark");

    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // The paper token actually flips: the dark palette is in effect, not
    // just an attribute sitting there.
    const paper = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--paper").trim(),
    );
    expect(paper).toBe("#151412");
  });

  test("switches the UI to Hindi and loads the Devanagari face (DoD 12)", async ({ page }) => {
    await openSettings(page);
    await pickSegment(page, "हिन्दी");

    await expect(page.getByRole("radio", { name: "हिन्दी" })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    // The shell re-renders in Hindi, not just the attribute.
    await expect(page.getByRole("button", { name: "शुरू करें" })).toBeVisible();

    // The regression this guards: the @font-face declares the family as
    // "noto-sans-devanagari", but the stack once referenced
    // "Noto Sans Devanagari" — a different family (spaces are significant),
    // so Hindi rendered in a system fallback and this face never loaded.
    // The woff2 also used to ship the family's *latin* subset.
    await page.waitForFunction(() => {
      for (const face of document.fonts) {
        if (face.family === "noto-sans-devanagari" && face.status === "loaded") return true;
      }
      return false;
    });
  });

  test("keeps the chosen settings across a reload (FR-40)", async ({ page }) => {
    await openSettings(page);
    // STUN first: every label below it re-renders in Hindi once the language
    // flips, so the English names stop being findable.
    await page.getByRole("switch", { name: "Across networks" }).click();
    await pickSegment(page, "Dark");
    await pickSegment(page, "हिन्दी");
    // Close via Escape: by now the sheet itself is in Hindi.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");

    // The app itself is in Hindi now, so the entry point is too — and so
    // is every label inside the sheet.
    await page.getByRole("button", { name: "सेटिंग" }).click();
    await expect(page.getByRole("radio", { name: "गहरा" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "हिन्दी" })).toBeChecked();
    await expect(page.getByRole("switch", { name: "अलग नेटवर्क के बीच" })).toBeChecked();

    // FR-40: only the allowlisted keys are persisted — the device label is
    // not among them, so the field comes back empty after a reload.
    const persisted = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("dropbeam.settings.v1") ?? "{}"),
    );
    expect(Object.keys(persisted).sort()).toEqual([
      "autoAccept",
      "ice",
      "language",
      "reduceMotion",
      "theme",
      "wakeLock",
    ]);
    await expect(page.getByLabel("उपकरण का नाम")).toHaveValue("");
  });

  test("reduce motion overrides the motion tokens like the media query does", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("switch", { name: "Reduce motion" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
    const base = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--t-base").trim(),
    );
    // Chromium serializes the zero-length declaration as "0s".
    expect(base).toMatch(/^0m?s$/);
  });

  test("is a real modal: Escape closes it without touching the session", async ({ page }) => {
    await openSettings(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveJSProperty("open", true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Dismissing settings must not disturb the home screen behind it.
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  });
});
