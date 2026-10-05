# Decision log

Format: date · problem · choice · reason. Every deviation from the PRD or a
library's docs gets an entry here (PRD section 0.3).

---

## 2026-10-03 · Dev vs production CSP

- **Problem:** The PRD CSP (`style-src 'self'`) blocks Vite's dev-mode `<style>` injection and its HMR websocket.
- **Choice:** `index.html` ships the PRD CSP verbatim. During `vite dev` a `transformIndexHtml` plugin prepends a dev-only variant adding `'unsafe-inline'` to `style-src` and `ws: wss:` to `connect-src`. Production build output never contains the relaxed CSP.
- **Reason:** Keeps the shipped policy exactly as specified while keeping local development usable.

## 2026-10-03 · Impeccable install and command mapping

- **Problem:** PRD 10.7 requires `npx impeccable install`, `/impeccable init`, and a
  zero-findings detector gate; it also says to record a mapping if command names
  differ from the PRD.
- **Choice:** `npx impeccable install` ran successfully and installed the skill pack
  into the available harness directories. `npx impeccable help` shows the PRD's
  command names all exist unchanged: `/init`, `/shape`, `/craft`, `/critique`,
  `/layout`, `/colorize`, `/animate`, `/harden`, `/audit`, `/polish`. The
  detector gate is the CLI: `npx impeccable detect <paths>` (exit 0 = clean);
  ignore rules are managed with `npx impeccable ignores add-value|add-rule`.
- **Reason:** `/init` runs an interactive multi-round interview that cannot be run
  non-interactively here; per PRD M0 the context file was copied to `PRODUCT.md`
  first, which is exactly what `/init` reads. Everything else is used as named.

## 2026-10-03 · Detector flags the mandated display font

- **Problem:** `npx impeccable detect` reports `overused-font` for Fraunces, but
  PRD Appendix D/10.2 mandates Fraunces as the display face.
- **Choice:** Added a scoped detector ignore with a reason:
  `ignores add-value overused-font Fraunces --reason "PRD Appendix D …"` in
  `.impeccable/config.json` (committed).
- **Reason:** The PRD is the source of truth for the design system; the detector
  finding is a style heuristic, not an accessibility or anti-pattern issue.

## 2026-10-03 · Font sourcing

- **Problem:** Fonts must be self-hosted WOFF2, OFL/open licensed, no third-party font requests (10.2, 9.1).
- **Choice:** `scripts/fetch-fonts.mjs` runs at development time only; it downloads Fraunces, Instrument Sans, JetBrains Mono and Noto Sans Devanagari (latin subsets) from Google Fonts into `src/ui/fonts/` and generates `src/ui/fonts.css`. Content-hash filenames dedupe identical variable files.
- **Reason:** Runtime has zero third-party requests; the fetch script is never imported by app code.

## 2026-10-05 · Transfer-engine protocol choices (M1)

- **Problem:** The PRD specifies phases and integrity rules (7.2, 8.4, FR-14..FR-20)
  but not the wire details: frame layout, fid uniqueness, flow control, and how
  `ok`/`err`/`cancel` reference files.
- **Choice:** 16 KiB chunks; data frame `[1B type=0x01][4B fid BE][4B seq BE][payload]`;
  fids allocated with direction parity (offerer uses odd, answerer even) so
  `{fid}` control messages are unambiguous; backpressure pauses above 1 MiB
  buffered and resumes at ≤256 KiB; offers are serialized (one batch in flight);
  the receiver opens every sink _before_ replying `accept` (so no data frame can
  arrive for an unknown fid); the sender keeps a `pendingErrors` map so an `err`
  arriving before `done` still rejects the right file.
- **Reason:** Each rule closes a concrete race or ambiguity observed while
  writing the integration tests (early `err`, unknown-fid frames, buffer bloat).

## 2026-10-05 · Hashing: Worker with synchronous fallback (M1)

- **Problem:** SHA-256 over multi-hundred-MB files must not block the UI thread,
  but Worker module loading fails under some test/jsdom setups.
- **Choice:** `hash.ts` tries a module Worker (`hash.worker.ts`) first and falls
  back to an inline `hash-wasm` hasher when `Worker` is unavailable or fails to
  load. Both implement the same `Hasher` interface; tests exercise the fallback
  path automatically.
- **Reason:** Same code path in prod and tests, no test-only branches, and the
  fallback also covers browsers where workers are blocked (e.g. some CSPs).

## 2026-10-05 · Handshake codecs: DB1 with SDP fallback (M2)

- **Problem:** The QR/link/paste handshake (8.2) must carry full WebRTC
  credentials in a short, manually-typable code while still interoperating with
  browsers that reject rebuilt SDP, and every code is untrusted input.
- **Choice:** `DB1.` = short-key JSON (`{v,t,ts,u,p,f,s,c,m?,n?}`) → `deflate-raw`
  → base64url, validated field-by-field with a 10-minute TTL ±60s clock skew
  (FR-7); `DB0.` = full rebuilt SDP (BUNDLE, `m=application`, SCTP 5000,
  sha-256 fingerprint, non-trickle candidates + `end-of-candidates`) as the
  fallback — `decodeHandshake` dispatches on prefix. Candidates use the compact
  `<foundation>|<prio>|<proto>|<addr>|<port>|<type>` form, UDP host/srflx only
  (component 1, no TCP/relay/prflx/link-local/mDNS-exempted `.local` kept as
  host), capped at 6 (8.2.2). Compression is native `CompressionStream` with
  `fflate` fallback (8.1); every inflate/decode failure is normalized to
  `DropbeamError("CODE_INVALID")`, with a 1 MiB inflation cap against bombs.
- **Reason:** One dispatcher covers both browsers (strict SDP) and QR-friendly
  payloads; treating parsing and policy separately (malformed = fatal,
  unusable-candidate = dropped) keeps peer input from ever throwing mid-SDP;
  expiry is enforced at decode time so stale pasted codes die client-side with
  no backend.

## 2026-10-05 · QR delivery: link-first, encoder-decided budget (M3)

- **Problem:** FR-4 requires a multi-frame fallback when a code does not fit one
  QR, and PRD 8.2.3 prefers QRing the _link_ so any camera app opens the app.
  Neither decision can be made from a byte-count constant: the QR capacity
  depends on error-correction level, character mode and the URL length.
- **Choice:** `fitsSingleQr` asks uqr itself whether the content fits
  version ≤ 25 at ECC M (PRD 8.2.4 target) and reports false instead of
  throwing; `planQrContent` then chooses link QR → raw-code QR → multi-frame.
  Frames are `DBF|<id>|<index>|<total>|<payload>`, sized by fixed-point
  iteration against the final digit width so no frame exceeds 400 bytes;
  `FrameAssembler` accepts frames in any order, ignores duplicates, restarts on
  a new id, and drops same-id frames with a contradictory total. Scanning
  prefers native `BarcodeDetector` and lazily loads jsQR only as fallback, with
  duplicate text suppressed (re-emitted after 3 s) so a static QR fires once.
- **Reason:** The encoder is the only authority on capacity, so the budget stays
  correct if ECC or charset changes; link-first keeps camera apps working as
  fallback; tolerant assembly matches how animated QRs actually scan (dropped
  and repeated frames are the norm, not the exception).

## 2026-10-05 · UI: state-driven screens, CSP without frame-ancestors (M4)

- **Problem:** The screens of PRD 10.1 have to stay in step with the connection
  state machine, and the shipped CSP was producing a console error in every
  browser.
- **Choice:** `App` renders the screen that `ConnectionStateMachine` reports and
  never mutates connection state; the machine is rebuilt when the side flips
  (Start → host, Join → guest) because `SHOWING` resolves per side. Two defects
  this surfaced: a guest could never leave `GATHERING` because the transition
  was hardcoded to `SHOWING_OFFER`, and "Try again" reset the machine but left
  the reason code on screen — both fixed at the cause, not in the UI. The CSP
  now omits `frame-ancestors`.
- **Reason:** Browsers _ignore_ `frame-ancestors` when the policy arrives in a
  `<meta>` tag and log an error for it, so it bought no clickjacking protection
  while polluting the console. The deploy target (GitHub Pages / Cloudflare
  Pages) must send it as a real HTTP header; that is noted in the deploy docs.
  Keeping the console clean is a release-quality signal, not cosmetics.

## 2026-10-05 · Progress bars animate with transform, not width (M4)

- **Problem:** The obvious `transition: width` on a transfer progress bar is
  flagged by Impeccable's `layout-transition` rule and genuinely forces layout
  on every progress tick — dozens per second for a fast transfer.
- **Choice:** The fill is a full-width element scaled with
  `transform: scaleX(ratio)` (compositor-only), with `aria-valuenow` carrying the
  same value for assistive tech and a unit test asserting the fill never sets
  `width`.
- **Reason:** Progress ticks are the hottest UI path in the app; keeping them
  off the layout path preserves the 60fps budget while remaining accessible, and
  it satisfies the detector rule that DoD 11 requires to report zero findings.

## 2026-10-05 · SessionController: one machine, injected transport (M4)

- **Problem:** The UI had grown its own copy of the pairing flow (create offer,
  encode, apply answer) alongside `ConnectionStateMachine`, so the screen and
  the session could drift — they already had: two machines disagreed and the
  pairing screen never appeared. Testing the flow was also impossible without a
  browser, because it was baked into a Preact component.
- **Choice:** `SessionController` owns the whole host↔guest flow and takes an
  injected `PeerTransport` (the only thing that touches WebRTC) plus an
  _optional shared_ `ConnectionStateMachine`. The UI passes its own machine in,
  so there is exactly one source of truth for connection state. Replies are run
  through `extractCode`, so a bare code and a `#a=`/`#j=` link are the same
  input (FR-3/FR-6), and both sides accept either.
- **Reason:** Pairing is now covered by an integration test that runs two real
  sessions against real DB1 codes with only the transport faked, so encode,
  decode, expiry, the link route and every transition are exercised without a
  browser. Three defects surfaced immediately: the host sent `connected`
  without first applying the reply, replies arriving as links were rejected as
  `CODE_INVALID`, and a guest could not reach `CONNECTED` in one hop — all fixed
  in the controller rather than worked around in the UI.

## 2026-10-05 · Sinks and TransferSession: destination beats detection (M5)

- **Problem:** PRD 8.5 requires FSA → OPFS → memory selection, and the receiver
  has to stream to _somewhere_ while both halves of the engine run on one
  channel. Two bugs made the obvious wiring wrong: `createSinkFor` ignored an
  explicitly supplied destination whenever FSA was unavailable (so the user's
  chosen destination was silently discarded), and `TransferSession` forwarded
  `onSaved(fid, result)` as a single argument, handing the UI a fid number
  instead of the `SaveResult`.
- **Choice:** An explicit `pickDestination` always wins and only falls through
  on non-cancel failures; feature detection only decides the fallback.
  `TransferSession` owns Sender + Receiver, mirrors Sender's deterministic fid
  allocation (`parity + 1 + index * 2`) so progress rows can show names before
  the peer responds, and sanitizes outgoing filenames as well as incoming ones.
- **Reason:** The destination is a user decision made in a gesture; feature
  detection is only a capability guess and must never override it. Sink tests
  exercise the chunk stream and `DISK_FULL`/`CANCELED` mapping with fake browser
  APIs, and `transfer-session.test.ts` moves real bytes between two sessions and
  asserts they arrive intact — which is what caught both bugs above.

## 2026-10-05 · Pairing links are fragment-carried, never percent-encoded (M3)

- **Problem:** The offer/answer link (`#j=`, `#a=`) is typed, copied through
  messengers and scanned by third-party camera apps, so it must survive
  whitespace, re-encoding and truncation noise.
- **Choice:** `buildPairLink` emits the code verbatim after
  `#<kind>=` — every code character is base64url plus a dotted prefix, so it is
  already fragment-safe — and `parsePairLink`/`extractCode` accept a full URL, a
  bare fragment, or a fragment with or without `#`, stripping whitespace and
  tolerating (but not requiring) percent-encoding.
- **Reason:** Round-tripping text that users and apps mangle means pairing
  succeeds on the paste/link route even when the copy is imperfect; rejecting
  non-codec fragments keeps unrelated in-page anchors (e.g. `#help`) from being
  read as pairing attempts.
