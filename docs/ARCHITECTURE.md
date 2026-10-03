# Architecture

Dropbeam is a static site: no server code, no backend. Two browsers pair by
moving a WebRTC offer/answer out-of-band (QR camera scan, link, or paste) and
then transfer bytes over a single reliable, ordered `RTCDataChannel`.

## Layers

```
src/ui        Preact screens/components. Imports core. Never the reverse.
src/core      Pure logic. No DOM except the modules listed under platform/.
src/pwa       Service worker, manifest, icons.
```

### core/handshake

- `codec-db1.ts` — minimal descriptor (PRD 8.2.1): Handshake → JSON short keys →
  deflate-raw → base64url → `DB1.` prefix.
- `codec-db0.ts` — full-SDP fallback (`DB0.` prefix). Both codecs decode on receive.
- `sdp-template.ts` — rebuilds a data-channel-only SDP from a Handshake.
- `qr-frames.ts` — multi-frame QR split/assemble (`DBF|id|index|total|payload`).

### core/peer

- `peer-session.ts` — owns `RTCPeerConnection` + `RTCDataChannel`, non-trickle ICE
  (PRD FR-2), offer/answer lifecycle.
- `state-machine.ts` — the connection state machine of PRD 7.1 (single source of truth).
- `ice-config.ts` — Local mode (`iceServers: []`) vs opt-in STUN mode.

### core/transfer

- `protocol.ts` — control JSON frames + binary data frame layout.
- `sender.ts` / `receiver.ts` — queue, chunking (16 KiB), accept/decline, cancel, verify.
- `backpressure.ts` — bufferedAmount gate (pause > 1 MiB, resume at 256 KiB).
- `hash.worker.ts` — incremental SHA-256 off the UI thread.

### core/storage

- `sink.ts` — `interface Sink { open(meta); write(chunk); close(): SaveResult; abort() }`.
- `fsa-sink.ts` / `opfs-sink.ts` / `memory-sink.ts` — runtime-selected by feature detection.
- `filename.ts` — sanitization (FR-32).

### core/platform

Feature detection, wake lock, clipboard, camera. Only modules allowed to touch
these DOM APIs from core.

## Data flow

```
UI action → state machine → peer-session (SDP/ICE) → handshake code → QR/link/text
peer-session open → transfer/protocol → sender → data channel → receiver → Sink
```

Rules:

1. UI imports core; core never imports UI.
2. All connection state transitions go through `state-machine.ts`.
3. Peer-supplied data is rendered as text only (never `innerHTML`).
