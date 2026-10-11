# Dropbeam

Send files straight between your devices, over a direct connection. Nothing is
uploaded — no account, no server, no third-party request.

![Two browsers pairing and transferring a file](docs/demo.gif)

Both devices open the same static page and pair with a QR code, a link, or a
pasted code. Files and notes then travel directly over a WebRTC data channel on
your local network, verified with SHA-256 on arrival.

## What it does

- **Pair three ways:** QR (with a multi-frame fallback for long codes), link,
  or paste. Every session shows three verification words and waits for the host
  to approve the connection before a single byte moves.
- **Send files and notes:** folders included; per-file progress, speed and ETA;
  cancel any time. Large files are staged through FSA/OPFS so memory stays
  flat.
- **Settings sheet:** theme (system/light/dark), English or Hindi, auto-accept,
  "Across networks" (STUN, off by default), keep-screen-awake, reduce motion and
  an optional device label — nothing but those keys is ever stored.
- **Installs as a PWA:** offline shell, safe update flow, and a share target on
  Android (shared files wait on a Send screen until a device is paired).
- **Help built in:** a "How it works" page, a troubleshooting page, and a
  one-tap connection self-test that runs two peers inside the same tab to prove
  WebRTC works in your browser.
- **Nothing leaves the device.** STUN ("Across networks") is off by default;
  even then only your public IP is disclosed to a public STUN server. See
  [docs/PRIVACY.md](docs/PRIVACY.md).

## Quick start

```sh
npm install
npm run dev        # http://localhost:5173 — two tabs pair with each other
```

To try a real transfer, open the app on two devices on the same Wi-Fi (or run
it on one machine and join from a second browser profile).

## Checks

```sh
npm run ci         # typecheck, lint, unit + integration tests, build,
                   # size budget, PWA health, Playwright e2e
```

Individual scripts: `npm run test` (Vitest), `npm run test:e2e` (Playwright),
`npm run size` (gzip budget), `npm run pwa:health` (installability probe).

Current gate: 275 tests green (265 unit/integration + 10 e2e), initial JS
~147.0 KB gz against a 153.6 KB budget, Lighthouse mobile **99 / 100 / 100 /
100** (Performance / Accessibility / Best practices / SEO), and a network audit
over a real pairing + transfer showing only same-origin requests. Both checks
are reproducible with `node scripts/audit-release.mjs` against `vite preview`.

## Using it

1. Open Dropbeam on both devices on the same network.
2. On one device press **Start**; on the other press **Join** and scan the code.
3. Check that both screens show the same three words, then allow the
   connection.
4. Drop files or type a note. They move directly, device to device.

Can't connect? The in-app **Troubleshooting** page covers guest networks, VPNs,
the hotspot trick and the browser support table.

## Documentation

- [docs/PRD.md](docs/PRD.md) — product requirements and milestones
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit
- [docs/PRIVACY.md](docs/PRIVACY.md) — threat model with linked tests
- [docs/INTEROP.md](docs/INTEROP.md) — browser interop matrix
- [docs/TESTING.md](docs/TESTING.md) — what each test layer covers
- [docs/DECISIONS.md](docs/DECISIONS.md) — every notable build decision

## Status

`v1.0`. Milestones M0–M8 are complete and gated by `npm run ci`: pairing,
verification, approval, two-way transfers, the settings sheet, the PWA
shell, and the release audit are all covered by 266 unit/integration and
10 e2e tests, plus the documented manual matrix.

The automated half of the [interop matrix](docs/INTEROP.md) runs **real
engines** — Chromium ↔ Chromium, Chromium ↔ Firefox in both directions,
with real WebRTC over the paste route. What is deliberately _not_
automated, and is listed there as field QA: the camera QR route, real
Wi-Fi / hotspot / guest-network behaviour, real Safari (Playwright's
Windows WebKit build has no WebRTC), and mobile power/screen behaviour.

The demo animation above is recorded by `node scripts/record-demo.mjs`;
`node scripts/interop-matrix.mjs` re-runs the cross-engine rows and
`node scripts/audit-release.mjs` re-runs the Lighthouse and network
audits. A hidden diagnostic panel ships for field debugging: tap eight
times on the right edge of the screen.
