# Interop matrix

Codec used per browser pair, plus notes. `DB1` = minimal descriptor (PRD
8.2.1), `DB0` = full-SDP fallback.

## Automated (CI / local)

| Pair                              | Route                                | Codec | Result              | Date       |
| --------------------------------- | ------------------------------------ | ----- | ------------------- | ---------- |
| Real DB1 pipeline ↔ same pipeline | same process, WebRTC transport faked | DB1   | pass (`npm run ci`) | 2026-10-10 |
| Chromium ↔ Chromium (same tab)    | loopback transport, in-app self-test | —     | pass (FR-62)        | 2026-10-10 |

The first row runs the real `DB1` encode/decode and the full session
pipeline in one process (only the WebRTC transport is faked — see
`tests/integration/session-pairing.test.ts`). The second row proves the
transport itself in a real browser: the "Test my connection" self-test
(`src/core/peer/self-test.ts`) opens two `RTCPeerConnection`s in one tab
and completes a data-channel round trip.

> **Manual matrix status (2026-10-10): not yet run.** It needs physical
> devices on real networks; it is the remaining gate before `v1.0` (PRD
> M8). Fill the Result/Notes cells as each pair is tested.

## Manual (fill during M8)

| Pair                             | Network                           | Route     | Codec | Result                 | Notes |
| -------------------------------- | --------------------------------- | --------- | ----- | ---------------------- | ----- |
| Windows Chrome ↔ Android Chrome  | same Wi-Fi                        | QR        |       |                        |       |
| Windows Chrome ↔ iPhone Safari   | same Wi-Fi                        | QR + link |       |                        |       |
| Chrome ↔ Firefox                 | same Wi-Fi                        | paste     |       |                        |       |
| Chrome ↔ Safari (macOS)          | same Wi-Fi                        | paste     |       |                        |       |
| Android Chrome ↔ Android Samsung | same hotspot                      | QR        |       |                        |       |
| Any ↔ any                        | guest Wi-Fi with client isolation | —         |       | expect helpful failure |

## Known limits

- Safari/iOS: large files limited by memory unless OPFS is available (see PRD 8.5).
- mDNS-only candidates: if `.local` names do not resolve on the network, use the
  hotspot trick or enable "Across networks" (STUN).
