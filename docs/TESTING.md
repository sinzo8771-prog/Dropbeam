# Testing

Commands:

| Command             | What it runs                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `npm run typecheck` | `tsc --noEmit` (strict)                                          |
| `npm run lint`      | ESLint flat config                                               |
| `npm test`          | Vitest: `tests/unit` + `tests/integration`                       |
| `npm run test:e2e`  | Playwright against the production build (Chromium)               |
| `npm run ci`        | typecheck → lint → test → build → size budget → pwa:health → e2e |

## Unit (`tests/unit`)

Codecs (round trip, size budget, invalid input), SDP template, compact candidate
parsing, multi-frame QR assemble/shuffle/duplicates, pairing-link build/parse
(including the in-tab `hashchange` route), single-QR budget vs multi-frame
fallback, QR pixel round trip (uqr → jsQR), filename sanitizer (table-driven
with hostile inputs), protocol encode/decode, backpressure controller
(simulated `bufferedAmount`), state machine transitions and timeouts,
verification phrase determinism, settings store allowlist and hostile payloads
(FR-40), the settings sheet UI (FR-41), wake-lock acquire/release/support
detection, the code-expiry countdown, the font contract (subset per family,
family names the stacks actually declare), PWA manifest/service worker, and
the contrast gate computed from the shipped tokens (PRD 13.1).

## Integration (`tests/integration`)

Two `RTCPeerConnection`s in one page (loopback) transferring: 0-byte file,
1 byte, 16 KiB A→1, 5 MB; cancel mid-way; decline; hash mismatch injection;
peer drop. The pairing integration drives two `SessionController`s with real
DB1 codes and covers expiry, cleanup and the snapshot's `codeExpiresAt`
(PRD 13.2). The resume integration (`resume.test.ts`) drops a transfer after
two chunks — a channel that stops forwarding mid-file, control frames
included — re-pairs, and proves the receiver's parked offset continues with
exactly the missing chunk re-crossing the wire and the file verifying
byte-identical; it also pins that memory sinks start over (with a fresh
prompt), that a clean transfer leaves nothing parked, and that `chunks` past
the end of a file are rejected on the wire (PRD 9.4). The per-chunk repair
suite in `transfer.test.ts` corrupts chunks in flight and covers: one bad
chunk repaired with the file saved byte-identical and exactly one `repair`
request sent; every chunk corrupted in the same pass (only the re-sent
chunks arrive clean, or the handshake cannot succeed); the re-sent chunks
still corrupt, which is terminal after the single re-verify; and a sink
that cannot read its staged bytes back, never even asking for a plan. The
heartbeat suite in `transfer.test.ts` pins `PEER_LOST` at the plain pong
timeout and the recoverable-drop grace: while the wired `pcState` reads
`disconnected` the deadline doubles, and `failed` / `closed` still fail at
the plain one.

## End-to-end (`tests/e2e`)

Real Chromium against the production build, with the service worker and its
stamped build id in place:

- **Pairing and transfer** — two separate browser contexts (two "devices")
  pair over loopback WebRTC through the link and paste routes, match
  verification words, pass the host approval gate, move a file and a note in
  both directions, and check that neither page logged an error; a second spec
  covers the peer-drop reason code (PRD 13.3, 12).
- **Settings sheet** — theme tokens, Hindi + the Devanagari face actually
  loading, reduce-motion token override, persistence across reload with the
  FR-40 key list, and modal semantics (Escape) (FR-41).
- **Debug panel** — the 8-tap reveal gesture against real timers and the real
  service-worker health rows (FR-50).

## Manual device matrix

Recorded in `docs/INTEROP.md` (PRD 13.4). The rows that need only
different engines are automated locally (`scripts/interop-matrix.mjs`:
Chromium ↔ Chromium and Chromium ↔ Firefox, both directions). What is
left needs physical devices: the camera QR route, Wi-Fi / hotspot /
guest-network behaviour, real Safari, and mobile power/screen review.

## Release audit (one-off)

`node scripts/audit-release.mjs` (against `vite preview` on :4198) runs
Lighthouse's mobile profile against a Playwright-managed Chromium and a
network audit of a full two-context pairing + transfer, asserting every
request is same-origin (PRD 9.1, DoD 5, DoD 8). Lighthouse is installed
on demand (`npm i --no-save lighthouse`), so it stays out of
`package.json`.
