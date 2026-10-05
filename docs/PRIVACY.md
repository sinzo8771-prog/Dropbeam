# Privacy

**No data is collected.** Dropbeam has no accounts, no analytics, no cookies,
no tracking, and no server of its own beyond static file hosting.

## Network calls the app may make

1. Loading its own static files (the site you are visiting).
2. Nothing else by default.
3. Optional, off by default: a public STUN server (`stun:stun.l.google.com:19302`)
   when the user enables "Across networks". This discloses your public IP to
   that third party. STUN only returns your public address; no file data ever
   touches it.

File bytes and text travel only over the DTLS-encrypted WebRTC channel, directly
between the two devices. There is no TURN relay: if a direct path cannot be
formed, no transfer happens.

## Threat model (PRD 9.4)

Every row names the test that proves the mitigation, so the table cannot drift
away from the code. Paths are relative to the repository root.

| Threat                           | Mitigation                                                                                                    | Proven by                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eavesdropper on Wi-Fi            | DTLS encryption; fingerprint pinned from the handshake                                                        | [`tests/unit/handshake.test.ts`](../tests/unit/handshake.test.ts) — `fingerprints survive the hex ↔ base64url round trip`, `rejects ICE credential and fingerprint injection attempts`                                                                         |
| Someone sees the QR and connects | Offer is single-use; first valid answer wins; host approval prompt before transfers; verification phrase      | [`tests/integration/verification.test.ts`](../tests/integration/verification.test.ts) (phrase + approval), [`tests/integration/session-pairing.test.ts`](../tests/integration/session-pairing.test.ts) — `pairs two devices through the real code pipeline`    |
| Malicious file from peer         | Accept/Decline prompt; filename sanitization; executable warnings; never auto-open                            | [`tests/unit/approval.test.ts`](../tests/unit/approval.test.ts) — `blocks transfers until the host allows the peer`; filename sanitization in `src/core/storage/filename.ts`                                                                                   |
| Malicious link in text           | Raw URL shown, tap required, `rel="noopener noreferrer"`, no auto-open                                        | [`tests/unit/handshake.test.ts`](../tests/unit/handshake.test.ts) — link and frame parsing accept codes only, never auto-navigate                                                                                                                              |
| XSS                              | No `innerHTML` with peer data; text rendered as text nodes; strict CSP                                        | [`tests/unit/i18n.test.ts`](../tests/unit/i18n.test.ts) plus the ESLint `no-restricted-globals` rule banning `localStorage` and direct DOM sinks in `src/core`; peer labels are rendered as Preact text nodes (`tests/unit/ui.test.tsx` — App host-flow tests) |
| Memory exhaustion                | Cap in-memory sink; clear message when the sink cannot hold the file                                          | [`tests/unit/sinks.test.ts`](../tests/unit/sinks.test.ts) — cap and `SINK_UNAVAILABLE` mapping                                                                                                                                                                 |
| Stale/replayed handshake         | `ts` expiry (10 min); ICE credentials random per session                                                      | [`tests/unit/handshake.test.ts`](../tests/unit/handshake.test.ts) — expiry tests; [`tests/integration/session-pairing.test.ts`](../tests/integration/session-pairing.test.ts)                                                                                  |
| Tracking by host                 | Static hosting, no logs under our control                                                                     | No third-party requests; `scripts/size-budget.mjs` and the CSP in `index.html` allow only same-origin assets                                                                                                                                                   |
| Man in the middle (PRD 9.3)      | Both devices show words + 6 digits derived from the sorted DTLS fingerprint pair; a mismatch means disconnect | [`tests/integration/verification.test.ts`](../tests/integration/verification.test.ts) — `gives both devices the same phrase`, `changes the phrase when one fingerprint is substituted`                                                                         |

## Verification phrase (PRD 9.3)

Once the channel is open, both devices show three words and six digits derived
from the pair of DTLS fingerprints they exchanged (sorted, SHA-256, mapped onto
a fixed word list). The derivation is deterministic and needs no network call.

If the words differ, the two devices are not talking directly to each other —
disconnect and re-pair.

The phrase is a _check_, not an identity: anyone who can read your screen can
read the words. It catches interception, not a device you wrongly trusted.

## Connection approval (PRD 9.5)

The host (the device that created the offer) sees "Allow connection from
&lt;device label&gt;?" even though the channel is already open, and no file can
move until it is allowed. The gate lives in
[`src/core/peer/approval.ts`](../src/core/peer/approval.ts), not in the screen,
so a mis-wired UI cannot enable transfers by accident. Declining is permanent
for that session and surfaces `PEER_DECLINED`.

The peer label shown in the prompt is text supplied by the other device. It is
rendered as a text node only — never as markup — and is not interpreted.

## Storage

Nothing about a transfer is persisted. `localStorage` holds only: theme,
language, and the auto-accept default (PRD FR-40). Files are never written
anywhere except to a destination the user picks (File System Access API) or to
browser-managed staging (OPFS) until the user downloads them.

## Hosting-provider logs

Dropbeam is hosted as static files. Any request logs kept by the hosting
provider are outside our control and contain only static asset requests.

## Content Security Policy

`index.html` ships a strict policy: no inline scripts, no `eval`, no remote
origins. `frame-ancestors` is **not** in the policy — browsers ignore it in a
`<meta>` tag, so it must be sent as an HTTP header by the host. See
[`docs/DECISIONS.md`](DECISIONS.md).
