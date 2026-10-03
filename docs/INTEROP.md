# Interop matrix

Codec used per browser pair, plus notes. `DB1` = minimal descriptor (PRD
8.2.1), `DB0` = full-SDP fallback.

## Automated (CI / local)

| Pair                | Route                | Codec | Result  | Date |
| ------------------- | -------------------- | ----- | ------- | ---- |
| Chromium ↔ Chromium | loopback (same page) | DB1   | pending |      |

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
