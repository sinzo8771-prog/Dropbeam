# Interop matrix

Codec used per browser pair, plus notes. `DB1` = minimal descriptor (PRD
8.2.1), `DB0` = full-SDP fallback.

## Automated (CI / local)

| Pair                                                                                              | Route                                                       | Codec | Result                                              | Date       |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----- | --------------------------------------------------- | ---------- |
| Real DB1 pipeline ↔ same pipeline                                                                 | same process, WebRTC transport faked                        | DB1   | pass (`npm run ci`)                                 | 2026-10-10 |
| Chromium ↔ Chromium (same tab)                                                                    | loopback transport, in-app self-test                        | —     | pass (FR-62)                                        | 2026-10-10 |
| Chromium ↔ Chromium (two browser contexts)                                                        | real WebRTC over loopback, DB1 codes exchanged as text/link | DB1   | pass (`tests/e2e/pairing-transfer.spec.ts`)         | 2026-10-10 |
| Chromium ↔ Chromium (peer disconnect)                                                             | same pair, host device removed                              | —     | guest reaches `PEER_LOST` with no console errors    | 2026-10-10 |
| Chromium ↔ Chromium (OPFS save path)                                                              | guest without File System Access                            | —     | file staged and saved (PRD 8.5 Firefox/Safari sink) | 2026-10-10 |
| Chromium ↔ Firefox (two engines)                                                                  | real WebRTC, DB1 code pasted                                | DB1   | pass (`scripts/interop-matrix.mjs`)                 | 2026-10-10 |
| Firefox ↔ Chromium (two engines)                                                                  | real WebRTC, DB1 code pasted                                | DB1   | pass (`scripts/interop-matrix.mjs`)                 | 2026-10-10 |
| Chromium settings sheet (theme, hi, reduce motion, wake lock, STUN, persistence, Devanagari face) | —                                                           | —     | pass (`tests/e2e/settings.spec.ts`)                 | 2026-10-10 |

The first row runs the real `DB1` encode/decode and the full session
pipeline in one process (only the WebRTC transport is faked — see
`tests/integration/session-pairing.test.ts`). The second row proves the
transport itself in a real browser: the "Test my connection" self-test
(`src/core/peer/self-test.ts`) opens two `RTCPeerConnection`s in one tab
and completes a data-channel round trip.

The third row is the automated half of the manual matrix below: two
**separate browser contexts** — the closest CI gets to two devices — run
the shipped production build, pair through real ICE/DTLS/data channels
using DB1 codes over the link and paste routes, verify that both sides
derive the same three verification words (PRD 9.3), pass the host
approval gate (9.5), move a file host → guest, a note guest → host, and
assert neither page logged a single console or page error. The peer-drop
row covers PRD 12's reason-code path. The guest in the transfer row saves
with `showSaveFilePicker` removed, which is exactly the OPFS path Firefox
and Safari take (PRD 8.5).

The two cross-engine rows answer the "Chrome ↔ Firefox" manual row with
**real engines** (Chromium 153 and Firefox 155 on one machine, pair over
the paste route, DB1, matching verification words, guest saving through
OPFS). They are loopback-on-one-machine, so they prove interop between
engines — not LAN behaviour or camera QR.

The WebKit rows of the manual matrix **cannot** be run here: Playwright's
WebKit build for Windows ships without `RTCPeerConnection`, so no pairing
is possible. That gap produced one useful finding, now fixed and covered
by a unit test: the app used to answer "Join" in such a browser with a
_network_ failure instead of "This browser can't do direct transfers".
Both entry points now run the support check. Real Safari (macOS/iOS)
still needs hardware.

> **Manual matrix status (2026-10-10): partially covered.** The browser
> pairs that do not need a phone are done above (Chromium ↔ Chromium and
> Chromium ↔ Firefox, real engines, real WebRTC). What remains needs
> physical devices on real networks: the QR route (camera), the Wi-Fi /
> hotspot / guest-network behaviour, real Safari, and mobile power/screen
> behaviour — the last gate before `v1.0` (PRD M8). Fill the cells as each
> pair is tested.

## Manual (fill during M8)

| Pair                             | Network                           | Route     | Codec | Result                 | Notes                                                 |
| -------------------------------- | --------------------------------- | --------- | ----- | ---------------------- | ----------------------------------------------------- |
| Windows Chrome ↔ Android Chrome  | same Wi-Fi                        | QR        |       |                        |                                                       |
| Windows Chrome ↔ iPhone Safari   | same Wi-Fi                        | QR + link |       |                        |                                                       |
| Chrome ↔ Firefox                 | same Wi-Fi                        | paste     | DB1   | **engine row done**    | loopback pair pass above; still run over real Wi-Fi   |
| Chrome ↔ Safari (macOS)          | same Wi-Fi                        | paste     |       |                        | no WebRTC in the Windows WebKit build; needs hardware |
| Android Chrome ↔ Android Samsung | same hotspot                      | QR        |       |                        |                                                       |
| Any ↔ any                        | guest Wi-Fi with client isolation | —         |       | expect helpful failure |                                                       |

## Known limits

- Safari/iOS: large files limited by memory unless OPFS is available (see PRD 8.5).
- mDNS-only candidates: if `.local` names do not resolve on the network, use the
  hotspot trick or enable "Across networks" (STUN). The toggle lives in the
  settings sheet (gear icon on the home screen, FR-41).
