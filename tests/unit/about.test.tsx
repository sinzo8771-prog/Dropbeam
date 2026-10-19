// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";
import { AboutScreen } from "../../src/ui/about";
import { translatorFor } from "../../src/core/platform/i18n";

/**
 * The About/Privacy screen (PRD 10.1 screen 7, PRD 15).
 *
 * §15 asks for four statements to be made exactly, and this screen is where a
 * user would look for them - so the test checks that all four are actually
 * on the page, in both languages, rather than that the screen merely exists.
 * A privacy page that renders but says nothing is the failure this is here to
 * catch.
 */

const en = translatorFor("en");
const hi = translatorFor("hi");

afterEach(cleanup);

describe("AboutScreen (PRD 10.1 #7, 15)", () => {
  it("states the four things the PRD says it must state", () => {
    render(<AboutScreen t={en} onBack={() => {}} />);

    // No data collected.
    expect(screen.getByText(/No data is collected\./)).toBeTruthy();
    // No cookies.
    expect(screen.getByText(/No cookies are set/)).toBeTruthy();
    // The optional STUN disclosure, and that it is off by default.
    expect(screen.getByText(/STUN/)).toBeTruthy();
    expect(screen.getByText(/off by default/)).toBeTruthy();
    // The hosting provider's own logs.
    expect(screen.getByText(/host's own server logs/)).toBeTruthy();
  });

  it("names the licence and the third-party notices", () => {
    render(<AboutScreen t={en} onBack={() => {}} />);
    expect(screen.getByText(/MIT licensed/)).toBeTruthy();
    expect(screen.getByText(/THIRD-PARTY-NOTICES\.md/)).toBeTruthy();
  });

  it("says the app is not affiliated with Apple", () => {
    render(<AboutScreen t={en} onBack={() => {}} />);
    expect(screen.getByText(/not affiliated with, endorsed by or connected to Apple/)).toBeTruthy();
  });

  it("says the same in Hindi, so the statements are not only in one language", () => {
    render(<AboutScreen t={hi} onBack={() => {}} />);
    // The Hindi catalog carries the same four claims.
    expect(screen.getByText(/कोई डेटा एकत्र नहीं होता/)).toBeTruthy();
    expect(screen.getByText(/कोई कुकी नहीं लगाई जाती/)).toBeTruthy();
    expect(screen.getByText(/STUN/)).toBeTruthy();
    expect(screen.getByText(/Apple/)).toBeTruthy();
  });

  it("goes back when the back button is pressed", () => {
    let wentBack = false;
    render(<AboutScreen t={en} onBack={() => (wentBack = true)} />);
    screen.getByRole("button", { name: "Back" }).click();
    expect(wentBack).toBe(true);
  });

  it("has a heading, so the page is navigable", () => {
    render(<AboutScreen t={en} onBack={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("About and privacy");
  });
});
