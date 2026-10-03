# Decision log

Format: date · problem · choice · reason. Every deviation from the PRD or a
library's docs gets an entry here (PRD section 0.3).

---

## 2026-10-03 · Dev vs production CSP

- **Problem:** The PRD CSP (`style-src 'self'`) blocks Vite's dev-mode `<style>` injection and its HMR websocket.
- **Choice:** `index.html` ships the PRD CSP verbatim. During `vite dev` a `transformIndexHtml` plugin prepends a dev-only variant adding `'unsafe-inline'` to `style-src` and `ws: wss:` to `connect-src`. Production build output never contains the relaxed CSP.
- **Reason:** Keeps the shipped policy exactly as specified while keeping local development usable.

## 2026-10-03 · Impeccable install and command mapping

- **Problem:** PRD 10.7 requires `npx impeccable install`, `/impeccable init`, and a
  zero-findings detector gate; it also says to record a mapping if command names
  differ from the PRD.
- **Choice:** `npx impeccable install` ran successfully and installed the skill pack
  into the available harness directories. `npx impeccable help` shows the PRD's
  command names all exist unchanged: `/init`, `/shape`, `/craft`, `/critique`,
  `/layout`, `/colorize`, `/animate`, `/harden`, `/audit`, `/polish`. The
  detector gate is the CLI: `npx impeccable detect <paths>` (exit 0 = clean);
  ignore rules are managed with `npx impeccable ignores add-value|add-rule`.
- **Reason:** `/init` runs an interactive multi-round interview that cannot be run
  non-interactively here; per PRD M0 the context file was copied to `PRODUCT.md`
  first, which is exactly what `/init` reads. Everything else is used as named.

## 2026-10-03 · Detector flags the mandated display font

- **Problem:** `npx impeccable detect` reports `overused-font` for Fraunces, but
  PRD Appendix D/10.2 mandates Fraunces as the display face.
- **Choice:** Added a scoped detector ignore with a reason:
  `ignores add-value overused-font Fraunces --reason "PRD Appendix D …"` in
  `.impeccable/config.json` (committed).
- **Reason:** The PRD is the source of truth for the design system; the detector
  finding is a style heuristic, not an accessibility or anti-pattern issue.

## 2026-10-03 · Font sourcing

- **Problem:** Fonts must be self-hosted WOFF2, OFL/open licensed, no third-party font requests (10.2, 9.1).
- **Choice:** `scripts/fetch-fonts.mjs` runs at development time only; it downloads Fraunces, Instrument Sans, JetBrains Mono and Noto Sans Devanagari (latin subsets) from Google Fonts into `src/ui/fonts/` and generates `src/ui/fonts.css`. Content-hash filenames dedupe identical variable files.
- **Reason:** Runtime has zero third-party requests; the fetch script is never imported by app code.
