// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { HelpScreen, TroubleshootScreen } from "../../src/ui/help";
import { translatorFor } from "../../src/core/platform/i18n";

const t = translatorFor("en");

afterEach(cleanup);

describe("Help screen (FR-60: how it works, 4 steps + diagram)", () => {
  it("shows exactly four steps with a labelled inline diagram", () => {
    const { container } = render(<HelpScreen t={t} onBack={() => {}} onTroubleshoot={() => {}} />);
    expect(container.querySelectorAll(".help-steps > li")).toHaveLength(4);
    const diagram = container.querySelector("svg.help-diagram");
    expect(diagram).not.toBeNull();
    // Accessible name on the SVG itself; no <img> or emoji stand-ins
    // (PRD 10.2 rule 5: no emoji as icons, no stock illustrations).
    expect(diagram?.getAttribute("role")).toBe("img");
    expect(diagram?.getAttribute("aria-label")).toBe(t("help.diagram"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("navigates to troubleshooting and back", () => {
    const onBack = vi.fn();
    const onTroubleshoot = vi.fn();
    render(<HelpScreen t={t} onBack={onBack} onTroubleshoot={onTroubleshoot} />);
    fireEvent.click(screen.getByText("Troubleshooting"));
    expect(onTroubleshoot).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders the same structure in Hindi", () => {
    const th = translatorFor("hi");
    const { container } = render(<HelpScreen t={th} onBack={() => {}} onTroubleshoot={() => {}} />);
    expect(screen.getByText("कैसे काम करता है")).toBeTruthy();
    expect(container.querySelectorAll(".help-steps > li")).toHaveLength(4);
  });
});

describe("Troubleshooting screen (FR-61)", () => {
  it("covers every required topic as its own section", () => {
    const { container } = render(<TroubleshootScreen t={t} onBack={() => {}} />);
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    for (const key of [
      "ts.sameWifi.title",
      "ts.isolation.title",
      "ts.vpn.title",
      "ts.hotspot.title",
      "ts.stun.title",
      "ts.browsers.title",
    ] as const) {
      expect(headings).toContain(t(key));
    }
  });

  it("renders a real table with five browsers", () => {
    const { container } = render(<TroubleshootScreen t={t} onBack={() => {}} />);
    const table = container.querySelector("table.support-table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("thead th")).toHaveLength(4);
    const rows = table?.querySelectorAll("tbody tr") ?? [];
    expect(rows).toHaveLength(5);
    expect(table?.textContent).toContain("Chrome (Android)");
    expect(table?.textContent).toContain(t("ts.v.yes"));
    expect(table?.textContent).toContain(t("ts.v.no"));
    // Column headers are real headers, not bold text.
    for (const th of table?.querySelectorAll("thead th") ?? []) {
      expect(th.getAttribute("scope")).toBe("col");
    }
  });

  it("goes back", () => {
    const onBack = vi.fn();
    render(<TroubleshootScreen t={t} onBack={onBack} />);
    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
