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

| Threat                           | Mitigation                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Eavesdropper on Wi-Fi            | DTLS encryption; fingerprint pinned from the handshake                                                   |
| Someone sees the QR and connects | Offer is single-use; first valid answer wins; host approval prompt before transfers; verification phrase |
| Malicious file from peer         | Accept/Decline prompt; filename sanitization; executable warnings; never auto-open                       |
| Malicious link in text           | Raw URL shown, tap required, `rel="noopener noreferrer"`, no auto-open                                   |
| XSS                              | No `innerHTML` with peer data; text rendered as text nodes; strict CSP                                   |
| Memory exhaustion                | Cap in-memory sink; clear message when the sink cannot hold the file                                     |
| Stale/replayed handshake         | `ts` expiry (10 min); ICE credentials random per session                                                 |
| Tracking by host                 | Static hosting, no logs under our control                                                                |

## Storage

Nothing about a transfer is persisted. `localStorage` holds only: theme,
language, and the auto-accept default (PRD FR-40). Files are never written
anywhere except to a destination the user picks (File System Access API) or to
browser-managed staging (OPFS) until the user downloads them.

## Hosting-provider logs

Dropbeam is hosted as static files. Any request logs kept by the hosting
provider are outside our control and contain only static asset requests.
