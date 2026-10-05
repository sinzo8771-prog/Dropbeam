# Architecture

Dropbeam is a static site: no server code, no backend. Two browsers pair by
moving a WebRTC offer/answer out-of-band (QR camera scan, link, or paste) and
then transfer bytes over a single reliable, ordered `RTCDataChannel`.

## Layers

```
src/ui        Preact screens/components. Imports core. Never the reverse.
src/core      Pure logic. No DOM except the modules listed under platform/.
public/        Static PWA assets: service worker, manifest, icons.
```

### core/handshake

- `codec-db1.ts` — minimal descriptor (PRD 8.2.1): Handshake → JSON short keys →
  deflate-raw → base64url → `DB1.` prefix.
- `codec-db0.ts` — full-SDP fallback (`DB0.` prefix). Both codecs decode on receive.
- `sdp-template.ts` — rebuilds a data-channel-only SDP from a Handshake.
- `qr-frames.ts` — multi-frame QR split/assemble (`DBF|id|index|total|payload`).
- `qr-render.ts` — single-QR size budget (uqr version ≤ 25, ECC M) + SVG render.
- `link.ts` — share links (`#j=` offer / `#a=` answer) and scan-text → code.

### core/peer

- `peer-session.ts` — owns `RTCPeerConnection` + `RTCDataChannel`, non-trickle ICE
  (PRD FR-2), offer/answer lifecycle.
- `state-machine.ts` — the connection state machine of PRD 7.1 (single source of truth).
- `ice-config.ts` — Local mode (`iceServers: []`) vs opt-in STUN mode.
- `session-controller.ts` — drives one side of a pairing end to end
  (`startHosting` / `joinWithCode` / `applyReplyCode`) over an injected
  `PeerTransport`, sharing the caller's state machine so the UI never runs a
  second one.

### core/transfer

- `protocol.ts` — control JSON frames + binary data frame layout.
- `sender.ts` / `receiver.ts` — queue, chunking (16 KiB), accept/decline, cancel, verify.
- `backpressure.ts` — bufferedAmount gate (pause > 1 MiB, resume at 256 KiB).
- `hash.worker.ts` — incremental SHA-256 off the UI thread.
- `transfer-session.ts` — binds an open channel to Sender + Receiver, negotiates
  `hello`, and selects a storage sink per incoming file.

### core/storage

- `sink.ts` — `interface Sink { open(meta); write(chunk); close(): SaveResult; abort() }`.
- `fsa-sink.ts` / `opfs-sink.ts` / `memory-sink.ts` — runtime-selected by feature detection.
- `select-sink.ts` — `chooseSink()` reports the path and its size limits;
  `createSinkFor()` honours an explicit user destination first (PRD 8.5).
- `filename.ts` — sanitization (FR-32).

### core/platform

Feature detection, wake lock, clipboard, camera. Only modules allowed to touch
these DOM APIs from core.

- `scanner.ts` — camera QR scanning: native `BarcodeDetector` when available,
  else a polling canvas loop with lazily-imported jsQR.
- `i18n.ts` — en/hi catalogs, `{placeholder}` interpolation, PRD 12 error text.
- `storage.ts` — the **only** module allowed to touch `localStorage` (FR-40);
  persists theme/language/auto-accept/ICE/wake-lock/reduce-motion only.

## UI

```
src/ui/App.tsx          screen switch driven by ConnectionStateMachine.snapshot()
src/ui/components/      QrTile, Beam, CodeBox, Prompt, ProgressRow
src/ui/i18n/            en.json, hi.json (key parity enforced by a unit test)
```

Screens map to machine states: IDLE → Home, SHOWING_OFFER/WAITING_FOR_REPLY →
Pairing, SCANNING_OFFER → Join, SHOWING_ANSWER → Reply, CONNECTING/CONNECTED →
Connected.

## Data flow

```
UI action → state machine → peer-session (SDP/ICE) → handshake code → QR/link/text
peer-session open → transfer/protocol → sender → data channel → receiver → Sink
```

Rules:

1. UI imports core; core never imports UI.
2. All connection state transitions go through `state-machine.ts`.
3. Peer-supplied data is rendered as text only (never `innerHTML`).
