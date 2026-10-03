# PRD (FINAL): Dropbeam — direct device-to-device file transfer in the browser

Version 1.1 FINAL · Owner: Qweq · Audience: AI coding agent (build the whole product from this document)

This version adds: the design system, component decisions, the Impeccable design workflow, and a ready-to-use `PRODUCT.md` (Appendix C) and design tokens (Appendix D).

---

## 0. How the agent should use this document

1. Read the whole PRD before writing code.
2. Build in the milestone order in section 17. Do not skip ahead. Each milestone ends with a demo-able, tested state.
3. When this document and a library's behavior disagree, test it, pick the working option, and record the decision in `docs/DECISIONS.md` (date, problem, choice, reason).
4. Never add a backend, analytics, accounts, or any network call not listed in section 9 (Privacy). If something seems to need a server, use the fallback listed here or ask.
5. Every requirement has an ID (FR-x, NFR-x). Reference IDs in commit messages and tests.
6. Definition of done for the whole project is section 18.

---

## 1. Summary

Dropbeam is a website that sends files and text directly between two devices (phone ↔ laptop, laptop ↔ laptop, phone ↔ phone) **without uploading anything to a server, without accounts, and without installing an app**.

Two devices connect over WebRTC using a **serverless handshake**: the connection details are exchanged by scanning QR codes (or copy-pasting a short code or opening a link). After that, files move peer-to-peer over an encrypted WebRTC data channel.

**One-line pitch:** "AirDrop for any device, in your browser. No upload, no account, no server."

---

## 2. Problem and opportunity

- Moving a file from phone to laptop usually means WhatsApp-to-self, email-to-self, a cable, or a cloud upload. These are slow, lossy (compression), or require accounts.
- Cross-platform (Android ↔ Windows ↔ iPhone) direct transfer is poor. AirDrop is Apple-only. Nearby Share/Quick Share support varies.
- Existing web tools (e.g. relay-based share sites) route data through a server or need a signaling server. A fully serverless handshake is rare and a strong privacy and cost story (hosting is free static files).

### Goals

- G1: Transfer a file between any two modern browsers in under 30 seconds of setup.
- G2: Zero data touches any server. Hosting is static files only.
- G3: Works for large files (target 2 GB+ on Chromium; clear limits elsewhere).
- G4: Great as a portfolio project: clean code, tests, documented architecture.

### Non-goals (v1)

- No cloud storage, no links that work later, no "send to someone offline".
- No accounts, history sync, or contacts.
- No transfers through a relay (TURN). If a direct connection is impossible, show a helpful message.
- No native apps. (PWA install is in scope.)
- No group rooms or one-to-many in v1 (see section 19, roadmap).

---

## 3. Target users and use cases

| Persona                | Need                                                  | Example                                                  |
| ---------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Student                | Move notes, PDFs, photos between phone and college PC | Send a phone photo of a notice to a lab PC with no login |
| Developer              | Move build files, logs, screenshots between machines  | Laptop → phone APK                                       |
| Family / non-technical | Send videos from phone to laptop                      | Parent with a PC and an Android phone                    |
| Privacy-conscious      | No cloud, no tracking                                 | Send an ID scan without uploading it                     |

Primary scenarios:

- S1: Same Wi-Fi, laptop shows QR, phone scans, phone picks files, laptop receives.
- S2: Both devices on mobile hotspot from one phone (no router).
- S3: Different networks (home vs office) using the STUN-assisted mode (section 8.3).
- S4: Send a text snippet / link / clipboard instead of a file.

---

## 4. Product principles

1. **Obvious in 5 seconds.** One screen, two big buttons: "Send" and "Receive".
2. **Nothing leaves your devices.** Say it in the UI and make it verifiable (open-source, no third-party calls except those listed).
3. **Fail helpfully.** Every failure has a plain-language cause and a next step.
4. **Phone-first, desktop-good.** Large touch targets, works one-handed.
5. **Small and fast.** Initial load under 150 KB gzipped JS (excluding lazy-loaded scanner/QR libs).

---

## 5. User flows

### 5.1 Core flow (QR both ways), "Pair"

Roles are about the handshake only; after connecting, both can send.

1. Device A opens the site, taps **Start**. App creates a WebRTC offer, waits for ICE gathering to finish, builds a compact handshake code, and shows it as a **QR + link + copyable text**.
2. Device B opens the site and taps **Join**, then scans A's QR (camera). Alternatively B's phone camera app opens the link (the offer travels in the URL fragment `#`) which opens the site directly in Join mode with the offer preloaded.
3. B creates the answer, gathers ICE, and shows its own **QR + copyable text**.
4. A taps **Scan reply** and scans B's QR (laptop webcam or phone camera). Alternatively B copies the reply code and A pastes it.
5. The data channel opens. Both screens show **Connected** with a short verification phrase (section 9.3).
6. Either side drags/drops or picks files, or types text. The other side sees an incoming-transfer prompt with Accept/Decline (or auto-accept if the user enabled it for this session).
7. Progress, speed, ETA shown. On completion, a Save/Open button appears (or the file is already saved on Chromium via File System Access API).

### 5.2 Fallback flows

- **No camera / camera denied:** copy-paste the code (text field + "Paste" button using clipboard API where allowed).
- **Cross-device by chat:** user sends the link through any messenger; the other side opens it (offer in fragment). Reply code is sent back the same way and pasted.
- **Laptop has no webcam:** the laptop **starts** and shows its QR; the phone scans it. The phone's reply reaches the laptop by copy/paste, or by sharing the reply link through any messenger and opening it on the laptop. The UI must say this plainly on the Reply screen.

### 5.3 After connect

- Send more files any time while the channel is open.
- "New connection" resets cleanly.
- If the channel drops, show Reconnect (requires a new handshake in v1; auto-resume is roadmap).

---

## 6. Functional requirements

### 6.1 Handshake and pairing

- **FR-1** Generate a WebRTC offer with one reliable ordered data channel (`label: "dropbeam"`).
- **FR-2** Use **non-trickle ICE**: wait for gathering complete (or 3 s timeout with at least one candidate), then encode. No signaling server.
- **FR-3** Encode the handshake as a compact payload (section 8.2) rendered as QR, as a shareable link (`https://<site>/#j=<code>`), and as plain text.
- **FR-4** If the payload does not fit one QR (size > ~1,800 bytes after compression), fall back to a **multi-frame animated QR** (section 8.2.4) and always offer the text/link route.
- **FR-5** Join accepts: camera scan, pasted text, or link with `#j=` fragment. Fragment is removed from the URL bar (`history.replaceState`) after reading.
- **FR-6** The answer is produced and shown the same ways (QR/text/link `#a=`).
- **FR-7** Handshake codes expire client-side after 10 minutes (stale offers are rejected with a clear message).
- **FR-8** Connection state machine exactly as in section 7.

### 6.2 Transfers

- **FR-10** Send multiple files in one action; queue shown with per-file status.
- **FR-11** Drag-and-drop on desktop; file picker everywhere; paste image from clipboard (desktop) as a file.
- **FR-12** Send **text** (plain text / URL / clipboard). Receiver gets a card with Copy and Open-link (if URL) buttons. Max 1 MB text.
- **FR-13** Receiver gets an **incoming prompt** showing file name, size, type, count. Accept / Decline. Setting: "Auto-accept for this session".
- **FR-14** Chunked transfer with backpressure (section 8.4). Max single file size: unlimited by protocol; practical limits shown in UI per browser (section 8.5).
- **FR-15** Progress per file and total: bytes, %, speed (rolling 2 s average), ETA.
- **FR-16** Cancel any file (either side). Cancel all.
- **FR-17** Integrity: per-file SHA-256 computed incrementally on both ends and compared at the end; mismatch = "File corrupted, retry" and the partial file is discarded. (Use incremental hashing; see 8.6.)
- **FR-18** Folder send (desktop Chromium/Firefox via `webkitdirectory`): sent as multiple files preserving relative paths; receiver saves into a chosen directory (Chromium) or as a ZIP (others, v1.1).
- **FR-19** Transfers continue while the tab is in the foreground; request a **Screen Wake Lock** during active transfers where supported. Show a warning on mobile that locking the screen may pause the transfer.
- **FR-20** After completion show: Save, Open (images/PDF/video preview where cheap), Copy path (n/a), and "Send back".

### 6.3 Receiving and saving

- **FR-30** Chromium desktop and Android Chrome: use File System Access API `showSaveFilePicker` (desktop) and stream chunks straight to disk. On Android/iOS or if unsupported, use the fallback below.
- **FR-31** Fallback sink: Origin Private File System (OPFS) staging where available, then offer download via `Blob` URL from the OPFS file. If neither works, in-memory chunks to `Blob` with a hard cap and a visible warning (default cap 1 GB, configurable constant).
- **FR-32** Filename sanitization: strip path separators, control characters, reserved Windows names; clamp to 200 chars; preserve extension. Duplicate names get `(1)` suffix.
- **FR-33** Never auto-open or execute received files. Show a type warning for executables (`.exe`, `.msi`, `.apk`, `.bat`, `.sh`, `.js`, `.jar`, `.scr`, `.cmd`).

### 6.4 Sessions and settings

- **FR-40** Session-only state. No persistence of files or codes. Only these may use `localStorage`: theme, language, "auto-accept" default, "hide verification phrase" never (always shown).
- **FR-41** Settings sheet: theme (system/light/dark), language (English, Hindi), auto-accept, STUN mode (section 8.3), wake lock on/off, reduce motion.
- **FR-42** Device label: optional friendly name ("Qweq's phone") shown to the peer (sent over the channel only).

### 6.5 PWA

- **FR-50** Installable PWA with manifest, icons, offline shell (app works with no internet once loaded, since transfer is local-network only). Service worker with cache-first for static assets, versioned cache, safe update flow ("New version, reload").
- **FR-51** Web Share Target (Android Chrome): the PWA appears in the system share sheet; shared files are staged into a "Send" screen. (Best-effort; feature-detect.)

### 6.6 Help and education

- **FR-60** "How it works" page in 4 steps with a diagram.
- **FR-61** Troubleshooting page: same Wi-Fi tips, guest network / AP isolation, VPN, hotspot trick, STUN mode explanation, browser support table.
- **FR-62** In-app **self-test**: "Test my connection" opens two peers inside the same tab (loopback) to verify WebRTC works in this browser and reports pass/fail.

---

## 7. State machines

### 7.1 Connection (per side)

```
IDLE
 ├─ Start ─▶ CREATING_OFFER ─▶ GATHERING ─▶ SHOWING_OFFER ─▶ WAITING_FOR_REPLY
 │                                                   │ reply provided
 │                                                   ▼
 └─ Join ─▶ SCANNING_OFFER ─▶ CREATING_ANSWER ─▶ GATHERING ─▶ SHOWING_ANSWER ─▶ CONNECTING
                                                                                  │
 WAITING_FOR_REPLY ───────────── reply applied ─────────────────────────────────▶ CONNECTING
 CONNECTING ─▶ CONNECTED ─▶ (DISCONNECTED | FAILED) ─▶ IDLE
```

Timeouts: GATHERING 10 s hard cap; CONNECTING 20 s; WAITING_FOR_REPLY 10 min (code expiry).
Failures always show a reason code (section 12) and a "Try again" that returns to IDLE with cleanup (close peer connection, stop camera, release wake lock).

### 7.2 Transfer (per file)

`QUEUED → OFFERED → ACCEPTED | DECLINED → TRANSFERRING → VERIFYING → DONE | FAILED | CANCELED`

---

## 8. Technical design

### 8.1 Stack

- **Language:** TypeScript (strict).
- **Build:** Vite. Output: static files only.
- **UI:** Preact + plain CSS with custom properties (tokens in Appendix D). No CSS framework, no component kit with a default look. Component approach is in section 10.6 (native-first, headless fallback).
- **Design tooling:** Impeccable (design skill for AI agents), installed with `npx impeccable install` and used per section 10.7.
- **Libraries (all MIT/Apache, pinned versions):**
  - QR generation: `qrcode` (or `uqr`).
  - QR scanning: native `BarcodeDetector` when available, else `jsQR` (lazy-loaded). Camera via `getUserMedia({ video: { facingMode: "environment" } })`.
  - Compression: native `CompressionStream("deflate-raw")` with `fflate` fallback.
  - Hashing: `hash-wasm` (incremental SHA-256).
  - Testing: Vitest (unit), Playwright (e2e, two browser contexts), `@testing-library/preact` as needed.
- **Hosting:** GitHub Pages or Cloudflare Pages. HTTPS is required (camera + secure context). No server code in the repo.

### 8.2 Handshake encoding

**Goal:** fit an offer or answer into one QR with comfortable error correction.

#### 8.2.1 Minimal descriptor (preferred)

Instead of sending a full SDP, extract only what a data-channel-only connection needs, and rebuild a standards-valid SDP on the other side.

```ts
type Handshake = {
  v: 1; // format version
  t: "o" | "a"; // offer | answer
  ts: number; // created at (unix seconds) for expiry
  u: string; // ice-ufrag
  p: string; // ice-pwd
  f: string; // DTLS fingerprint, sha-256, base64url of 32 bytes
  s: "actpass" | "active"; // DTLS setup role
  c: string[]; // candidates, compact: "<foundation>|<prio>|<proto>|<addr>|<port>|<type>"
  m?: { sp: number; mms: number }; // sctp port (default 5000), max message size
  n?: string; // optional device label
};
```

Pipeline: `Handshake → JSON (short keys) → deflate-raw → base64url → prefix "DB1."`.

Rebuild SDP from a fixed template (BUNDLE group, `m=application ... UDP/DTLS/SCTP webrtc-datachannel`, `a=mid:0`, `a=sctp-port`, ice-ufrag/pwd, fingerprint, setup, candidates, `a=end-of-candidates`).

**Risk and required fallback:** SDP reconstruction can behave differently across Chrome/Firefox/Safari. The agent must:

1. Implement the minimal codec and an interop test matrix (Chrome↔Chrome, Chrome↔Firefox, Chrome↔Safari, Android Chrome↔Desktop Chrome, iOS Safari↔Chrome).
2. Keep a **fallback codec** `DB0.` = full SDP, deflate-raw, base64url. Both codecs must decode on receive. The sender chooses `DB1` by default and `DB0` if a "compat mode" setting is on or if `DB1` interop failed in a self-test.
3. Record which codec each browser pair needs in `docs/INTEROP.md`.

#### 8.2.2 Candidates

- Include only UDP host + srflx candidates. Drop TCP, relay (no TURN), and IPv6 link-local. Cap at 6 candidates. Keep IPv6 global if present.
- Browsers may hide local IPs behind **mDNS hostnames** (`xxxx.local`). Support hostname addresses in the compact format and test resolution on the same LAN. If mDNS resolution fails on a network, the connection fails; show the troubleshooting hint (use hotspot, or enable STUN mode).

#### 8.2.3 Delivery formats

- QR content: the code string itself, or the link `https://<site>/#j=<code>` (QR of the link is preferred so any camera app opens it).
- Text: the raw code, grouped in blocks of 5 characters for manual reading, with a one-tap Copy.
- Link: the same URL as the QR.

#### 8.2.4 Multi-frame QR fallback

If the code exceeds a single QR budget (target: version ≤ 25, error correction M, around 1,000 bytes):

- Split into frames of ≤ 400 bytes: header `DBF|<id>|<index>|<total>|<payload>`.
- Animate at 4 frames/s on the sender; the scanner collects frames in any order until complete; show progress.
- Also always offer text/link.

#### 8.2.5 Security of the handshake

The handshake carries the DTLS fingerprint. Because the QR/link travels out-of-band (camera or user-chosen channel), a network attacker cannot substitute a fingerprint without access to that channel. The verification phrase (9.3) gives a second check.

### 8.3 ICE configuration

- **Default mode: "Local"** `iceServers: []`. Works on the same LAN / same hotspot. Zero third-party contact.
- **Optional mode: "Across networks (uses public STUN)"** adds a public STUN server (default `stun:stun.l.google.com:19302`, configurable constant). This contacts a third party and discloses the device's public IP to it. Off by default, with a plain explanation in the toggle.
- No TURN in v1. If both peers are behind symmetric NAT, show the cannot-connect message with options (same Wi-Fi/hotspot).

### 8.4 Transfer protocol

Single ordered, reliable `RTCDataChannel` named `dropbeam`, `binaryType = "arraybuffer"`.

**Control messages** (JSON text frames):

```
{ "k":"hello", "v":1, "name":"...", "caps":{ "fsa":true, "opfs":true } }
{ "k":"offer",  "id":"<uuid>", "files":[{ "fid":1, "name":"a.pdf", "size":123, "type":"application/pdf", "path":"dir/a.pdf" }], "totalSize":123 }
{ "k":"accept", "id":"<uuid>", "fids":[1] }      // or decline
{ "k":"decline","id":"<uuid>" }
{ "k":"done",   "fid":1, "sha256":"<hex>" }
{ "k":"ok",     "fid":1 }                        // receiver verified hash
{ "k":"err",    "fid":1, "code":"HASH_MISMATCH" }
{ "k":"cancel", "fid":1 }
{ "k":"text",   "id":"<uuid>", "body":"..." }
{ "k":"ping" } / { "k":"pong" }                  // every 5 s, detect dead peer after 15 s
```

**Data frames** (binary): `[1 byte type=0x01][4 bytes fid big-endian][4 bytes seq big-endian][payload]`.

**Chunking and backpressure:**

- Chunk payload size: **16 KiB** (cross-browser safe). Do not rely on larger message sizes.
- `channel.bufferedAmountLowThreshold = 256 KiB`. Pause reading when `bufferedAmount > 1 MiB`; resume on `bufferedamountlow`.
- Read files via `Blob.stream()` or `slice().arrayBuffer()` in 1 MiB read-ahead blocks, then split into chunks.
- One file in flight at a time by default (sequential queue) for predictable progress; configurable concurrency constant (default 1).

**Receiver ordering:** channel is ordered/reliable so `seq` is used for sanity checks only (detect gaps = abort with `SEQ_GAP`).

### 8.5 Storage sinks and per-browser limits

| Environment             | Sink                                                             | Notes                               |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| Chromium desktop        | File System Access (`showSaveFilePicker`) streamed               | No memory limit; best path          |
| Chrome Android          | OPFS staging then download                                       | Limited by device storage           |
| Firefox desktop/Android | OPFS staging then download (feature detect), else Blob in memory | Warn above 1 GB                     |
| Safari iOS/macOS        | OPFS where supported, else Blob in memory                        | Warn above ~500 MB; document limits |

The sink interface is `interface Sink { open(meta); write(chunk); close(): Promise<SaveResult>; abort() }` with implementations `FsaSink`, `OpfsSink`, `MemorySink`. Choose at runtime via feature detection; log the choice in debug panel.

### 8.6 Hashing

Use incremental SHA-256 (`hash-wasm`) on both ends, updated per chunk. Sender sends `done` with the hash; receiver compares after the last chunk. Hash computation must not block the UI thread: run in a Web Worker.

### 8.7 Architecture and file layout

```
/src
  /core
    handshake/  codec-db1.ts  codec-db0.ts  sdp-template.ts  qr-frames.ts
    peer/       peer-session.ts  ice-config.ts  state-machine.ts
    transfer/   protocol.ts  sender.ts  receiver.ts  backpressure.ts  hash.worker.ts
    storage/    sink.ts  fsa-sink.ts  opfs-sink.ts  memory-sink.ts  filename.ts
    platform/   features.ts  wakelock.ts  clipboard.ts  camera.ts
  /ui
    screens/    Home  Start  Join  Scan  Connected  Transfers  Settings  Help
    components/ QrView  CodeBox  FileList  ProgressRow  Toast  Prompt
    i18n/       en.json  hi.json
  /pwa          service-worker.ts  manifest.webmanifest  icons/
  main.tsx
/tests
  unit/  e2e/  fixtures/
/docs
  PRD.md  ARCHITECTURE.md  DECISIONS.md  INTEROP.md  PRIVACY.md  TESTING.md
```

Rules: `core` has no DOM dependency except where listed under `platform`; UI imports core, never the reverse. All state transitions go through the state machine module.

---

## 9. Security and privacy

### 9.1 Data flow

- File bytes and text travel only over the DTLS-encrypted WebRTC channel, directly between peers.
- No analytics, tracking, ads, cookies, or fingerprinting. No third-party scripts or fonts (self-host everything).
- Network calls the app may make: (a) loading its own static files, (b) optional STUN (opt-in), (c) none else. Enforce with CSP.

### 9.2 Content Security Policy (via `<meta>` or headers)

`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
(Adjust only with a DECISIONS.md entry. If STUN is enabled, STUN traffic is UDP via WebRTC and is not governed by `connect-src`.)

### 9.3 Verification phrase (man-in-the-middle check)

Derive a short phrase from both DTLS fingerprints (sorted, hashed with SHA-256, mapped to 3 words from a 2048-word list, or 6 digits). Show on both screens: "Check that both devices show the same words." Always displayed after connect. Mismatch instruction: disconnect.

### 9.4 Threat model (document in PRIVACY.md)

| Threat                           | Mitigation                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Eavesdropper on Wi-Fi            | DTLS encryption; fingerprint pinned from handshake                                                                                    |
| Someone sees the QR and connects | Offer is single-use; first valid answer wins; show "Device X wants to connect, Allow?" before enabling transfers; verification phrase |
| Malicious file from peer         | Accept/Decline prompt; filename sanitization; executable warnings; never auto-open                                                    |
| Malicious link in text           | Show raw URL, require tap, `rel="noopener noreferrer"`, no auto-open                                                                  |
| XSS                              | No `innerHTML` with peer data; text rendered as text nodes; strict CSP                                                                |
| Memory exhaustion                | Cap in-memory sink; reject offers above sink capability with clear message                                                            |
| Stale/replayed handshake         | `ts` expiry; ICE credentials are random per session                                                                                   |
| Tracking by host                 | Static hosting, no logs under our control (state this in docs)                                                                        |

### 9.5 Connection approval

Even after the channel opens, the **host (offer creator)** sees "Allow connection from <device label>?" Transfers are blocked until allowed (both sides see state).

---

## 10. UX and UI specification

### 10.1 Screens

1. **Home:** logo, tagline, two large buttons: **Start** (create code) and **Join** (scan code). Use these handshake words, not Send/Receive, because both sides can send once connected. Under them: "How it works", "Test my connection", settings icon.
2. **Start:** big QR, link, Copy code, "Waiting for the other device…", then **Scan reply** and **Paste reply**. Timer showing code expiry.
3. **Join:** camera view with frame guide, "Paste code instead".
4. **Reply:** shows answer QR/link/copy, "Waiting for connection…".
5. **Connected:** peer label, verification words, drop zone, "Send files", "Send text", received list.
6. **Transfers:** per-file rows (icon, name, size, progress bar, speed, ETA, cancel), totals.
7. **Settings, Help, Troubleshooting, About/Privacy.**

### 10.2 Design system

**Concept: "a well-made physical tool."** Warm paper surfaces, ink-dark text, one vermilion accent, and a monospace face for anything the user must read or compare (codes, verification words, file sizes). The **QR tile is the hero** of the product; the **beam** between two device glyphs is the single signature animation. Nothing else decorates.

**Anti-slop rules (hard rules; Impeccable's detector must report zero findings):**

1. No gradients on backgrounds, text, or buttons. No glassmorphism or blur panels. No glow shadows.
2. No purple/indigo/blue-violet palettes. No default Inter/Roboto/Arial/system-only typography as the visible brand voice.
3. No cards nested in cards. Two surfaces total: page and panel. Hierarchy comes from spacing, type size, and hairline dividers.
4. No gray text on colored backgrounds. Text colors are chosen per surface from the tokens.
5. No centered hero + three feature cards layout. No emoji as icons. No stock illustrations.
6. One border radius scale (4 / 8 / 14 px) and one shadow level (or none). Do not round everything fully.
7. Copy is concrete and short. Banned words: seamless, effortless, revolutionary, supercharge, unlock, elevate, powerful, blazing.
8. Motion only for: connect success, transfer progress, sheet/dialog enter/exit. 120-220 ms, ease-out. Respect `prefers-reduced-motion` (replace with instant state change).

**Color (tokens; verify every text/background pair is at least 4.5:1, and interactive-control borders at least 3:1 using `--border-strong`; `--hairline` is for decorative dividers only. Adjust values if a check fails):**

- Light: paper `#F6F2EA`, panel `#FFFFFF`, ink `#1B1A17`, muted ink `#5C574E`, hairline `#DDD6C8`, strong border `#857D6F`, accent `#C8381A` (white text on it), success `#2A7048`, warning `#8A5A00`, danger `#B3261E`.
- Dark: paper `#151412`, panel `#1E1C19`, ink `#EFEAE0`, muted ink `#A8A196`, hairline `#34312B`, strong border `#7A7468`, accent `#F0603F` (dark text on it), success `#6CC38F`, warning `#E3A94B`, danger `#FF8A80`.
- The QR tile is always black on white with a 4-module quiet zone in both themes.

**Typography (self-hosted WOFF2, subset; OFL/open licenses; no third-party font requests):**

- Display (wordmark, screen titles only): **Fraunces** (variable serif) at weights 600-700.
- UI text: **Instrument Sans** at 400/500/600.
- Mono (codes, verification words, sizes, speeds): **JetBrains Mono** or **Commit Mono**.
- Hindi: **Noto Sans Devanagari** (subset) as the fallback for the `hi` locale.
- Scale (rem): 0.8125, 0.9375, 1, 1.25, 1.625, 2.25. Body line-height 1.5; titles 1.15. Max text measure 62ch.

**Spacing and layout:** 4 px base; steps 4/8/12/16/24/32/48. Mobile single column with 16 px gutters; desktop max content width 880 px, two-column only on the Connected screen (drop zone + activity list). Touch targets at least 44x44 px. Bottom-anchored primary actions on mobile (thumb reach).

**Iconography:** Phosphor or Tabler icons, only the ones used (about 20), inlined as SVG, 1.5 px stroke, `currentColor`. No icon fonts.

**The signature elements:**

- **QR tile:** large, centered, on a white tile with a thin ink border and a small mono caption showing the code length and expiry countdown.
- **Beam:** two device glyphs joined by a line. States: idle (dashed), connecting (dash animates), connected (solid accent), transferring (small pulses travel along the line at a rate tied to throughput), failed (broken, danger color). Honors reduced motion.
- **Verification words:** shown as three words in mono on a hairline-bordered strip with a copy-free, read-aloud-friendly layout.

### 10.2.1 Screen-level notes

- **Home:** wordmark, one sentence ("Send files straight between your devices. Nothing is uploaded."), two buttons (Start, Join), quiet links (How it works, Test my connection, Settings). No hero art.
- **Start:** QR tile first, link/copy below, expiry timer, then the Scan reply / Paste reply actions.
- **Join:** full-width camera view with a corner-bracket scan frame (no glow), Paste instead as a secondary button.
- **Connected:** beam at top with the verification words, then the drop zone (large, dashed hairline, plain label "Drop files here or choose"), then the activity list.
- **Activity rows:** file glyph by type, name (middle-ellipsis for long names, extension kept), size in mono, thin progress bar (no animated stripes), speed and ETA in mono, one clear cancel icon button.
- **Prompts:** native dialog; plain title ("Alex's phone wants to send 3 files"), file list, total size, two buttons (Accept primary, Decline secondary). Executable warning is inline text with the warning color, not a red banner.

### 10.3 Copy tone

Plain, friendly, short. Examples: "Waiting for your other device…", "Keep this screen open while sending.", "Can't connect. Make sure both devices are on the same Wi-Fi, or turn on Across networks."

### 10.4 Accessibility

WCAG 2.1 AA: keyboard operable (desktop), focus-visible, ARIA live region for progress and state, contrast ≥ 4.5:1, labels for all controls, QR has a text alternative (the code), no color-only status.

### 10.5 i18n

All strings in JSON; English and Hindi at launch; formatting via `Intl` (numbers, bytes).

### 10.6 Component decisions (native-first, headless fallback)

Use native browser features before any library, to keep the bundle small and the look fully ours. Style everything with the tokens in Appendix D.

| Need                                                                  | Implementation                                                                         | Notes                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Accept/Decline prompt, confirm dialogs                                | Native `<dialog>` with `showModal()`                                                   | Focus trap and Esc are built in; style `::backdrop` flat (no blur)             |
| Settings sheet / bottom sheet                                         | Native `<dialog>` styled as a sheet                                                    | Slide up 180 ms; respects reduced motion                                       |
| Switch (auto-accept, STUN, wake lock)                                 | `<input type="checkbox" role="switch">`                                                | Visible label, state text ("On"/"Off"), not color-only                         |
| Segmented control (theme, language)                                   | Radio group styled as segments                                                         | Real `<input type="radio">` for keyboard support                               |
| Progress                                                              | `<progress>` or `role="progressbar"` element                                           | ARIA live summary every 5 s, not every chunk                                   |
| Tooltip / small hints                                                 | Popover API (`popover="hint"`) or inline help text                                     | Prefer inline text on mobile                                                   |
| Toast                                                                 | Small custom component using an `aria-live="polite"` region                            | Auto-dismiss 4 s, errors persist until dismissed                               |
| Tabs (Help page)                                                      | Plain links/anchors or radio-based tabs                                                | Use real headings for structure                                                |
| Menu (overflow)                                                       | Popover API                                                                            | Only if needed                                                                 |
| Complex cases (if native support is insufficient on a target browser) | Radix Primitives (`@radix-ui/react-*`) through `preact/compat`, imported per component | Must stay within the JS budget (NFR-1); otherwise write a small custom version |

Rules: every interactive component has a visible focus ring (2 px accent outline with 2 px offset), a keyboard path, and correct ARIA. Do not install a component kit (shadcn/ui, Material, Chakra, DaisyUI) or its default theme. No UI library may add third-party network requests.

### 10.7 Impeccable workflow (design quality gate)

Impeccable is a design skill pack for AI coding agents (commands include `init`, `shape`, `craft`, `critique`, `audit`, `polish`, `layout`, `colorize`, `animate`, `harden`, `live`). If a command name differs in the installed version, run `/impeccable` help and use the closest equivalent; record the mapping in `docs/DECISIONS.md`.

1. **Install (M0):** run `npx impeccable install` in the repo root (Claude Code alternative: `/plugin marketplace add pbakaus/impeccable`). Copy Appendix C into `PRODUCT.md` at the repo root, then run `/impeccable init` and confirm it picks up that context.
2. **Plan (start of M4):** `/impeccable shape` for each screen in 10.1 before writing UI code. Save outputs under `docs/design/`.
3. **Build (M4):** `/impeccable craft` per screen, constrained by section 10.2 and the tokens in Appendix D.
4. **Review (end of M4, M7):** `/impeccable critique` on Home, Start, Join, Connected, Transfers. Fix every high-severity point or record a reason in DECISIONS.md.
5. **Targeted passes:** `/impeccable layout` (spacing/rhythm), `/impeccable colorize` only to apply tokens (never to add new hues), `/impeccable animate` only for the motion list in rule 8, `/impeccable harden` for error and empty states in section 12.
6. **Ship gate (M7, M8):** `/impeccable audit` and `/impeccable polish`. Release is blocked while the detector reports any finding (zero findings required) or while audit lists unresolved accessibility issues.

---

## 11. Non-functional requirements

- **NFR-1 Performance:** First load (cold) interactive < 2 s on mid-range phone over 4G. JS < 150 KB gz initial; scanner/hash libs lazy-loaded.
- **NFR-2 Throughput:** On same Wi-Fi (5 GHz), sustain ≥ 20 MB/s between two laptops; ≥ 8 MB/s phone ↔ laptop (hardware dependent; measure, don't promise in UI).
- **NFR-3 Reliability:** 100 MB transfer completes without error in 95% of lab runs on same LAN across the browser matrix.
- **NFR-4 Memory:** Streaming sinks keep heap under 150 MB regardless of file size.
- **NFR-5 Compatibility:** Latest two versions of Chrome, Edge, Firefox, Safari (macOS/iOS), Chrome Android, Samsung Internet. Show a clear "unsupported browser" page otherwise.
- **NFR-6 Offline:** App shell loads offline after first visit.
- **NFR-7 Code quality:** TypeScript strict, ESLint + Prettier, no `any` without comment, ≥ 80% unit coverage on `core/`.
- **NFR-8 Size of repo/deps:** Keep dependencies ≤ 8 runtime packages.

---

## 12. Error handling

| Code                 | Meaning                | User message                                                          | Action                 |
| -------------------- | ---------------------- | --------------------------------------------------------------------- | ---------------------- |
| `CAMERA_DENIED`      | Permission denied      | "Camera blocked. Paste the code instead or allow camera in settings." | Show paste UI          |
| `CODE_INVALID`       | Not a Dropbeam code    | "That doesn't look like a Dropbeam code."                             | Rescan                 |
| `CODE_EXPIRED`       | `ts` older than 10 min | "This code expired. Start again."                                     | Back to IDLE           |
| `ICE_GATHER_TIMEOUT` | No candidates          | "Couldn't find a network path. Check Wi-Fi."                          | Retry                  |
| `CONNECT_TIMEOUT`    | No channel in 20 s     | "Couldn't connect. Same Wi-Fi? Try hotspot or Across networks."       | Troubleshoot link      |
| `PEER_LOST`          | Heartbeat missed 15 s  | "Connection lost."                                                    | Offer reconnect        |
| `HASH_MISMATCH`      | Integrity failure      | "File arrived damaged. Try sending again."                            | Retry file             |
| `SEQ_GAP`            | Missing chunk          | "Transfer interrupted."                                               | Retry file             |
| `SINK_UNAVAILABLE`   | No safe place to store | "Your browser can't save files this big."                             | Suggest Chrome desktop |
| `DISK_FULL`          | Write failed           | "Not enough storage."                                                 | Cancel file            |
| `UNSUPPORTED`        | Missing WebRTC/Streams | "This browser can't do direct transfers."                             | Show supported list    |

---

## 13. Testing strategy

### 13.1 Unit (Vitest)

Codecs (round trip, size budget, invalid input), SDP template, compact candidate parsing, multi-frame QR assemble/shuffle/duplicates, filename sanitizer (table-driven with hostile inputs), protocol encode/decode, backpressure controller (simulated `bufferedAmount`), state machine transitions and timeouts, verification phrase determinism.

### 13.2 Integration

Two `RTCPeerConnection`s in one page (loopback) transferring: 0-byte file, 1 byte, 16 KiB ± 1, 5 MB, 200 MB; cancel mid-way; decline; hash mismatch injection; peer drop.

### 13.3 End-to-end (Playwright)

Two browser contexts, manual handshake by passing the code string between them (simulates paste route). Run on Chromium, Firefox, WebKit. Camera/QR scanning tested with a fake video stream feeding a generated QR image.

### 13.4 Manual device matrix (record results in `docs/INTEROP.md`)

Windows Chrome/Edge/Firefox, macOS Safari/Chrome, Android Chrome/Samsung Internet/Firefox, iPhone Safari/Chrome (WebKit). Networks: same Wi-Fi, mobile hotspot, guest Wi-Fi with client isolation (expected to fail with helpful message), VPN on.

### 13.5 Acceptance checklist

See section 18.

---

## 14. Observability (without telemetry)

- Optional **local debug panel** (toggle by tapping logo 5 times): shows connection state, selected ICE pair types, codec used, sink used, throughput graph. Never sent anywhere.
- "Copy diagnostics" button builds a text block (no file names, no IPs) that users can paste into a GitHub issue.

---

## 15. Legal, content, and policy

- License: MIT. Include third-party license notices.
- Privacy page states exactly: no data collected, no cookies, optional STUN disclosure, hosting provider logs outside our control.
- Terms: tool is provided as-is; users are responsible for what they send; prohibited-use notice for illegal content.
- No claim of Apple/AirDrop affiliation: the product name is **Dropbeam**; "AirDrop-like" appears only descriptively in docs if at all, never in the logo or domain.

---

## 16. Risks and mitigations

| Risk                               | Impact              | Mitigation                                                            |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------- |
| Handshake too big for QR           | Poor UX             | Minimal descriptor, compression, multi-frame QR, link/paste           |
| SDP rebuild incompatibilities      | Fails on some pairs | `DB0` full-SDP fallback; interop matrix; self-test                    |
| mDNS candidates unresolved         | LAN connect fails   | Hotspot guidance; STUN mode; srflx candidates                         |
| Client isolation / corporate Wi-Fi | Cannot connect      | Detect timeout; explain; hotspot suggestion                           |
| iOS background throttling          | Transfer pauses     | Wake lock where possible; "keep screen on" warning                    |
| Large files on Safari/Firefox      | Memory failure      | OPFS staging, caps, clear limits in UI                                |
| Camera unavailable on laptops      | Reply step blocked  | Paste/link routes; phone shows QR to laptop webcam when available     |
| User scans malicious code          | Phishing-like       | Codes are inert data; app never navigates to arbitrary URLs from them |

---

## 17. Milestones and tasks

**M0 Project setup (0.5 day)**
Vite + TS strict, lint/format, CI (build + unit tests), folder layout, `docs/` stubs, deploy pipeline to static host. Install Impeccable, add `PRODUCT.md` (Appendix C), add `tokens.css` (Appendix D), self-host fonts, run `/impeccable init`.
Done when: empty app deploys over HTTPS and CI is green.

**M1 Loopback transfer (1–2 days)**
`peer-session`, protocol, sender/receiver, backpressure, `MemorySink`; two peers in one page; progress UI minimal.
Done when: integration tests pass for all sizes in 13.2.

**M2 Handshake codec (1–2 days)**
`DB1` and `DB0` codecs, SDP template, expiry, candidate filtering; copy/paste pairing between two real devices on the same LAN.
Done when: Chrome↔Chrome on two machines connects via pasted codes; codec round-trip tests pass.

**M3 QR + scanning (1–2 days)**
QR render, link route (`#j=`/`#a=`), camera scanner (BarcodeDetector + jsQR), multi-frame fallback.
Done when: phone ↔ laptop pair using only QR works; size-budget tests pass.

**M4 Real UI (2–3 days)**
All screens in 10.1, state machine wiring, error messages (section 12), settings, i18n (en/hi), a11y pass. Follow 10.7 steps 2-5 for each screen (shape, craft, critique, targeted passes). Build the beam and QR tile as the two signature components.
Done when: a new user completes a transfer unaided in under 60 s (test with 3 people) and `/impeccable critique` has no unresolved high-severity findings.

**M5 Storage and big files (1–2 days)**
`FsaSink`, `OpfsSink`, filename sanitizer, hash worker, folder send, wake lock, executable warnings.
Done when: 2 GB file transfers on Chromium desktop with heap < 150 MB.

**M6 Security hardening (1 day)**
Verification phrase, connection approval, CSP, XSS review, text-only rendering of peer data, dependency audit.
Done when: threat-model table in PRIVACY.md is all green with linked tests.

**M7 PWA + polish (1–2 days)**
Service worker, manifest, share target, update flow, self-test page, help pages, debug panel, perf budget check. Run `/impeccable audit` and `/impeccable polish`; fix all findings.
Done when: Lighthouse PWA/Perf/Accessibility ≥ 90 on mobile profile.

**M8 Interop and release (2 days)**
Full manual device matrix, fix bugs, write `INTEROP.md`, README with GIF demo, tag v1.0.

---

## 18. Definition of done (v1.0 acceptance)

1. Laptop (Chrome) ↔ Android (Chrome) transfer a 500 MB video over the same Wi-Fi using QR only, with matching verification words.
2. Laptop ↔ iPhone (Safari) transfer a 50 MB file using QR + link; limits for large files documented.
3. Text snippet send/receive works both directions.
4. Cancel, decline, drop, and hash-mismatch paths all behave per section 12.
5. No network requests other than own static files (verified in DevTools Network tab with STUN off).
6. Works offline after first load (airplane mode + hotspot still pairs).
7. All tests in section 13 pass in CI; manual matrix recorded.
8. Lighthouse mobile: Performance ≥ 90, Accessibility ≥ 95, PWA installable.
9. README, ARCHITECTURE, PRIVACY, INTEROP, DECISIONS docs complete.
10. Demo GIF/video recorded for the portfolio.
11. Impeccable detector reports zero findings; `audit` has no unresolved accessibility issues; all color token pairs pass the contrast thresholds in 10.2; no gradients, nested cards, or banned copy words exist in the shipped UI.
12. Both themes and both languages (en, hi) reviewed on a real phone; Hindi text renders in Noto Sans Devanagari with no clipped glyphs.

---

## 19. Roadmap (post v1, do not build now)

- Auto-reconnect and resumable transfers (chunk bitmap, hash tree).
- Multi-peer rooms (mesh) and one-to-many broadcast.
- Optional tiny signaling relay (e.g. a free Worker) for **short numeric pairing codes**, still no file relay; strictly opt-in.
- Optional TURN guidance for self-hosters.
- ZIP-on-the-fly for folders on browsers without directory pickers.
- Clipboard sync mode, "send to this device" quick shortcuts, QR for Wi-Fi hotspot setup.
- Encrypted-at-rest receive vault (OPFS + passphrase).
- Browser extension for right-click "Send via Dropbeam".

---

## 20. Prompt to give the coding agent

> You are building **Dropbeam** from `PRD-Dropbeam-FINAL.md`. Follow section 0 and build milestone by milestone (section 17). Work in a git repo. After each milestone: run the full test suite, update `docs/DECISIONS.md`, commit with message `M<n>: <summary> (FR-…)`, and write a short status note listing what is done, what is tested, and open risks. Do not add servers, analytics, accounts, or third-party network calls (including CDN fonts or icon packs). Follow section 10 for all UI: use the tokens in Appendix D, the component decisions in 10.6, and the Impeccable workflow in 10.7; never introduce gradients, glass effects, nested cards, purple palettes, or emoji icons. If a requirement is impossible or ambiguous, choose the simplest safe option, record it in DECISIONS.md, and continue. Stop and ask only for: (1) a domain/hosting choice, (2) legal text approval, (3) a conflict between two requirements.

---

## 21. Appendix A: sample UI strings (English)

- Start: "Show this code to your other device."
- Join: "Point your camera at the code."
- Waiting: "Waiting for the other device…"
- Connected: "Connected. Check both screens show: {words}"
- Prompt: "{name} wants to send {count} file(s), {size}. Accept?"
- Warning (exe): "This file can run programs. Only open it if you trust the sender."
- Wake lock: "Keep this screen on while sending."

## 22. Appendix B: glossary

- **WebRTC data channel:** browser API for peer-to-peer messaging and binary transfer.
- **SDP:** text describing a WebRTC session (network paths, encryption fingerprint).
- **ICE / candidate:** a possible network path between peers.
- **STUN:** a server that tells a device its public address; does not carry data.
- **TURN:** a relay that carries data when a direct path fails (not used in v1).
- **mDNS candidate:** a hidden local address (`xxxx.local`) browsers use to avoid exposing local IPs.
- **DTLS fingerprint:** hash of a peer's certificate, used to verify who you're talking to.
- **OPFS:** Origin Private File System, browser-managed storage usable for large files.

## 23. Appendix C: `PRODUCT.md` (copy to repo root, then run `/impeccable init`)

```markdown
# Dropbeam: product context

## What it is

A website that sends files and text directly between two devices (phone, laptop) over an encrypted peer-to-peer connection. No upload, no account, no server. Pairing is done by scanning a QR code or pasting a short code.

## Who uses it

Students, developers, and non-technical family members who need to move a photo, PDF, video, or build file from one device to another quickly, often on a phone, often in a hurry, sometimes on slow or shared networks.

## Brand personality

Calm, precise, trustworthy, tactile. Like a well-made physical tool, not a startup dashboard. Quietly confident. Never playful to the point of unserious, never corporate.

## Signature ideas

1. The QR code is the hero object of the interface.
2. The "beam": two device glyphs joined by a line whose state shows idle, connecting, connected, transferring, failed.
3. Monospace for anything a person must read or compare (codes, verification words, sizes, speeds).

## Visual direction

Warm paper background, ink-dark text, a single vermilion accent, hairline dividers. Serif display type for the wordmark and screen titles only, humanist sans for UI, mono for data. Flat surfaces. Two surface levels only (page, panel).

## Anti-references (do not look like)

Purple or blue-violet gradients, glassmorphism, glow shadows, centered hero with three feature cards, emoji or stock-illustration decoration, nested cards, Inter-everywhere SaaS templates, "AI product" aesthetics, generic cloud-storage landing pages.

## Voice and copy

Plain, short, concrete. Say what is happening and what to do next. Examples: "Waiting for your other device.", "Keep this screen open while sending.", "Can't connect. Check both devices are on the same Wi-Fi." Banned: seamless, effortless, revolutionary, supercharge, unlock, elevate, powerful, blazing.

## Constraints

Mobile first, one-handed use, 44 px minimum touch targets. WCAG 2.1 AA. Light and dark themes. English and Hindi. Reduced-motion support. All fonts, icons, and assets self-hosted. No third-party network requests. JS budget under 150 KB gzipped for the initial load.

## Success looks like

A first-time user pairs two devices and sends a file in under 60 seconds without reading help text, and trusts it because the interface explains what stays private.
```

## 24. Appendix D: design tokens (`src/ui/tokens.css`)

```css
:root {
  color-scheme: light dark;

  /* color: light */
  --paper: #f6f2ea;
  --panel: #ffffff;
  --ink: #1b1a17;
  --ink-muted: #5c574e;
  --hairline: #ddd6c8; /* decorative dividers only */
  --border-strong: #857d6f; /* inputs, buttons, drop zone: 3:1 vs surfaces */
  --accent: #c8381a;
  --on-accent: #ffffff;
  --success: #2a7048;
  --warning: #8a5a00;
  --danger: #b3261e;

  /* type */
  --font-display: "Fraunces", Georgia, serif;
  --font-ui: "Instrument Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --fs-xs: 0.8125rem;
  --fs-sm: 0.9375rem;
  --fs-md: 1rem;
  --fs-lg: 1.25rem;
  --fs-xl: 1.625rem;
  --fs-2xl: 2.25rem;

  /* space (4px base) */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-6: 24px;
  --s-8: 32px;
  --s-12: 48px;

  /* shape */
  --r-sm: 4px;
  --r-md: 8px;
  --r-lg: 14px;
  --shadow-1: 0 1px 0 rgba(27, 26, 23, 0.06);

  /* motion */
  --t-fast: 120ms;
  --t-base: 180ms;
  --t-slow: 220ms;
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);

  /* focus */
  --focus: 2px solid var(--accent);
  --focus-offset: 2px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #151412;
    --panel: #1e1c19;
    --ink: #efeae0;
    --ink-muted: #a8a196;
    --hairline: #34312b;
    --border-strong: #7a7468;
    --accent: #f0603f;
    --on-accent: #1b1a17;
    --success: #6cc38f;
    --warning: #e3a94b;
    --danger: #ff8a80;
    --shadow-1: none;
  }
}
:root[data-theme="dark"] {
  --paper: #151412;
  --panel: #1e1c19;
  --ink: #efeae0;
  --ink-muted: #a8a196;
  --hairline: #34312b;
  --border-strong: #7a7468;
  --accent: #f0603f;
  --on-accent: #1b1a17;
  --success: #6cc38f;
  --warning: #e3a94b;
  --danger: #ff8a80;
  --shadow-1: none;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --t-fast: 0ms;
    --t-base: 0ms;
    --t-slow: 0ms;
  }
}

/* QR tile is always black on white, in both themes */
.qr-tile {
  background: #fff;
  color: #000;
  padding: 16px;
  border-radius: var(--r-md);
  border: 1px solid var(--hairline);
}
```

Token rule: components may only use these variables for color, type, space, radius, and motion. Adding a new color requires a DECISIONS.md entry and a contrast check.
