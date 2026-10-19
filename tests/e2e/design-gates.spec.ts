import { expect, test, type Page } from "@playwright/test";

/**
 * DoD 11, the part that can be checked instead of asserted: "no gradients,
 * nested cards, or banned copy words exist in the shipped UI".
 *
 * This runs against real computed styles rather than a grep over the source,
 * which is the stronger claim: a gradient reaches a user whether it was typed in
 * `base.css`, inlined on an element, or pulled in by a third-party style, and
 * only the rendered value distinguishes those. The same goes for nesting — the
 * PRD's own rule is "two surface levels only (page, panel)", so what has to hold
 * is that no `.panel` sits inside another `.panel`, whatever markup produced it.
 *
 * Banned words are the one clause that is about copy rather than pixels, so they
 * are gated at the source in `tests/unit/design-gates.test.ts` instead.
 *
 * Every screen reachable without a peer is walked, because a rule that only
 * holds on the home screen holds nowhere that matters.
 */

/** Screens a user can reach with no paired device. */
const SCREENS: { name: string; open: (page: Page) => Promise<void> }[] = [
  { name: "home", open: async (page) => void (await page.goto("/")) },
  {
    name: "settings",
    open: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "help",
    open: async (page) => {
      await page.goto("/");
      await page.getByRole("button", { name: "How it works" }).click();
    },
  },
  { name: "self-test", open: async (page) => void (await page.goto("/?screen=selftest")) },
  { name: "about", open: async (page) => void (await page.goto("/?screen=about")) },
];

/** The single elevated surface class. `page` is the other level. */
const SURFACE = "panel";

test.describe("shipped-UI design gates (DoD 11)", () => {
  for (const screen of SCREENS) {
    test(`${screen.name} has no gradient and no card inside a card`, async ({ page }) => {
      await screen.open(page);

      const findings = await page.evaluate((surfaceClass) => {
        const gradients: string[] = [];
        const nested: string[] = [];
        for (const element of Array.from(document.querySelectorAll("*"))) {
          const style = getComputedStyle(element);
          // `background-image` is what a gradient lands in; `background` is
          // checked too because the shorthand is where it usually gets typed.
          if (
            style.backgroundImage.includes("gradient(") ||
            style.background.includes("gradient(")
          ) {
            gradients.push(element.className || element.tagName);
          }
          // `closest` from the parent, so an element never matches itself.
          if (
            element.classList.contains(surfaceClass) &&
            element.parentElement?.closest(`.${surfaceClass}`)
          ) {
            nested.push(element.className);
          }
        }
        return { gradients, nested };
      }, SURFACE);

      expect(
        findings.gradients,
        `a gradient survived into the ${screen.name} screen (PRD 10.2, PRODUCT.md)`,
      ).toEqual([]);
      expect(
        findings.nested,
        `a ${SURFACE} inside another ${SURFACE} on the ${screen.name} screen — ` +
          "PRD 10.2 allows two surface levels, page and panel",
      ).toEqual([]);
    });
  }

  test("the hidden debug panel is a surface too, and is not nested", async ({ page }) => {
    // It is hidden behind a gesture, so walking the screens above never sees it,
    // and a design rule that only holds where nobody looks is not a rule.
    await page.goto("/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    const box = page.viewportSize();
    if (!box) throw new Error("no viewport set - configure one in playwright.config.ts");
    for (let i = 0; i < 8; i++) await page.mouse.click(box.width - 10, box.height / 2);
    await expect(page.locator(".debug-panel")).toBeVisible();

    const nested = await page.evaluate(
      (surfaceClass) =>
        Array.from(document.querySelectorAll(`.${surfaceClass}`))
          .filter((element) => element.parentElement?.closest(`.${surfaceClass}`))
          .map((element) => element.className),
      SURFACE,
    );
    expect(nested).toEqual([]);
  });
});
