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
  fids allocated with direction parity (the host, which creates the WebRTC
  offer, gets even fids via parity 1; the guest odd via parity 0) so
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

## 2026-10-05 · Security gates live in core, not in the screen (M6)

- **Problem:** PRD 9.3/9.5 add two checks at the exact moment the channel is
  open: both devices must show the same verification phrase, and the host must
  approve the peer before anything may move. Wiring these into the Connected
  screen left three defects visible only under test: the guest never reached
  `CONNECTED` because `PeerSession` was constructed with no events, so
  `onChannel` never fired; "Paste reply" on the scan screen set the code into
  state but never answered the offer, so pasting silently did nothing; and
  `ConnectionApproval.request()` re-fired its prompt on every call.
- **Choice:** The approval gate is a `ConnectionApproval` object in
  `src/core/peer/approval.ts` with `requireAllowed()` throwing the PRD 12 reason
  code, so transfers are blocked by the core and not by a rendered button. The
  connected section carries `data-approval="pending|allowed|granted"` as the
  contract the transfer UI mounts behind. `request()` is one-shot via a
  `prompted` flag, since the UI may re-render or re-signal.
- **Reason:** A security control that only exists in a component can be
  rendered away; one that lives in core cannot. The phrase is derived by
  `SessionController.verificationPhrase()` from the two DTLS fingerprints it
  already collected — no new plumbing, and it is `null` until both are known,
  so an unpaired session can never show a reassuring phrase.

## 2026-10-05 · One state machine for the app's lifetime, side chosen per attempt (M6)

- **Problem:** The UI rebuilt `ConnectionStateMachine` whenever the side
  flipped. Because `setSide()` triggers a render, the click handler that set the
  side went on to drive the _old_ machine, which the effect cleanup then
  disposed — a use-after-dispose race on the Join path.
- **Choice:** `ConnectionStateMachine.setSide()` mutates the side and is only
  legal from `IDLE`; the UI builds exactly one machine and picks the side on it
  per attempt. `SessionController` for an attempt is kept in a ref rather than
  rebuilt per step, so the fingerprints it collected survive into
  `applyReplyCode`.
- **Reason:** One machine for the app's lifetime is the only way "the UI never
  flips connection state directly" (ARCHITECTURE rule 2) actually holds, and it
  removes a class of teardown races instead of papering over them.

## 2026-10-05 · A deliberate close is not peer loss (M6)

- **Problem:** `PeerSession.close()` raises the same `connectionstatechange` and
  channel `close` events a dropped peer does, so "Try again" tore the session
  down and then immediately reported `PEER_LOST`, stranding the user on an error
  they had just dismissed.
- **Choice:** `close()` sets a `closed` flag first and both listeners return
  early when it is set.
- **Reason:** Local teardown and remote loss are different events that happen to
  share a signal. `tests/unit/peer-session.test.ts` pins both directions: a
  local close reports nothing, a real `failed` transition still does.

## 2026-10-05 · `Prompt` falls back to the `open` attribute (M6)

- **Problem:** `dialog.showModal?.()` silently did nothing in jsdom, which does
  not implement `showModal`. Every prompt test therefore asserted against a
  dialog that was rendered but permanently closed and inaccessible to
  `getByRole` — the approval and incoming-transfer gates were effectively
  untestable, and the optional call hid it.
- **Choice:** Use `showModal`/`close` when the method exists (real browsers keep
  the top layer, focus trap and Escape) and otherwise set the `open` attribute
  directly.
- **Reason:** Tests must be able to click the real buttons, and an optional call
  that can turn a security prompt into a no-op is worse than an explicit
  fallback. Browser behaviour is unchanged.

## 2026-10-05 · `frame-ancestors` belongs in an HTTP header, not the CSP meta tag (M4, confirmed in M6)

- **Problem:** The shipped CSP included `frame-ancestors 'none'`. Browsers ignore
  that directive inside a `<meta>` tag and log a console error on every load.
- **Choice:** Removed from both the production and development policies in
  [`index.html`](../index.html) and [`vite.config.ts`](../vite.config.ts).
- **Reason:** Clickjacking protection has to be served as a header by the host.
  Keeping a directive that is provably ignored only produces false assurance.

## 2026-10-05 · The transfer engine lives in a hook, not in the screen (M5 follow-up)

- **Problem:** `TransferSession` was complete and tested but nothing ever
  constructed it: the app could pair and then had no way to send a byte. The
  natural place — building it inside the Connected screen — would tie its
  lifetime to a component that renders conditionally on approval, so switching
  sides mid-session could leave two sessions bound to one channel.
- **Choice:** `useTransfer` in [`src/ui/use-transfer.ts`](../src/ui/use-transfer.ts) owns
  one `TransferSession` per open channel, creating it in an effect and disposing
  it in the effect's cleanup. `TransferPanel` is presentational: it renders what
  the hook returns and calls back for actions, never touching the channel.
- **Reason:** Ownership in one place means the session dies exactly when the
  channel does, and the component stays testable with plain props. The App test
  asserts the wire really carries `hello` after connecting, so "mounted" means
  the protocol is live, not just that a component painted.

## 2026-10-05 · The host's approval gates the host; the guest is granted on arrival (M6, applied in the transfer screen)

- **Problem:** PRD 9.5 says transfers are blocked until the host allows the peer
  and that "both sides see state", but the protocol has no message telling the
  guest that approval was granted. A literal reading leaves the guest blocked
  forever with no way to learn it may proceed.
- **Choice:** The host's transfer controls stay hidden until it presses Allow.
  The guest is granted on arrival, because it scanned one specific QR code and
  that scan was the consent. Both sides still see the approval state on screen.
- **Reason:** The threat PRD 9.4 describes is a stranger who saw the QR and
  connected _to the host_; the host is the one who needs a second look. Making
  the guest wait on an absent signal would strand it in a dead UI. If a future
  milestone wants true two-sided approval, it should add an explicit control
  frame rather than infer consent from silence.

## 2026-10-05 · A shared offer link must answer the offer, not park it (found by two browser tabs)

- **Problem:** Verified in a real browser with two tabs: opening a `#j=` link
  landed the guest on `SCANNING_OFFER` forever. The link effect did `setOfferCode`
  and `machine.send("join")` and nothing else, so the offer was stored in state
  that no screen rendered and no code consumed — the single most likely way to
  use the app was a dead end. This is the same shape as the `pasteOffer` defect
  fixed in M6, in a second copy of the same code.
- **Choice:** Both routes now go through one `joinWithOffer(code)` that decodes
  and answers, called from a one-shot mount effect (guarded by a ref) and from
  the paste button.
- **Reason:** Two copies of "take an offer" is one too many. Collapsing them means
  the next change to one cannot silently skip the other, and the regression test
  asserts the link route reaches a real `DB1.` answer code.

## 2026-10-05 · The answer screen shows a preparing state too

- **Problem:** The machine reaches `SHOWING_ANSWER` one tick before the answer
  code finishes encoding, and the reply screen was gated on `answerPlan`, so
  `<main>` rendered empty for that tick — the same blank-screen class already
  fixed for `SHOWING_OFFER`.
- **Choice:** Render the existing "Preparing a code…" status whenever the screen
  is `SHOWING_ANSWER` and no plan exists yet.
- **Reason:** A state in the PRD state machine must always have a screen. The
  empty `<main>` was only visible as a flash, which is exactly the kind of defect
  a screenshot review misses and a DOM assertion catches.

---

## 2026-10-05 · PWA assets: hand-rolled PNGs and a stamped worker (M7, FR-50)

- **Problem:** FR-50 needs an installable PWA: manifest, icons (192, 512,
  maskable), and a service worker giving an offline shell plus a "New version,
  reload" flow. No image toolchain is permitted in this dependency-light
  (NFR-1) project, and Vite cannot version a static `sw.js` so its cache name
  must be stamped at build time.
- **Choice:** Generate the icons with a tiny self-contained Node script
  (`scripts/generate-icons.mjs`) that writes PNGs by hand from zlib — no sharp/
  ImageMagick/SVG dependency. Ship the worker as plain JS in `public/` (Vite
  copies it verbatim to `dist/`) and let `scripts/postbuild.mjs` overwrite a
  `__BUILD_ID__` placeholder so each build rolls the cache name `dropbeam-<id>`.
  The worker is cache-first for static assets, network-first+offline-fallback for
  navigations, and announces a takeover to clients that were controlled by the
  _previous_ build only (first-install tabs receive no reload prompt).
- **Reason:** A 4 KB PNG encoder costs nothing and keeps the dep tree unchanged;
  a plain JS worker at a stable URL is required by the spec (module workers are
  not yet widely supported as the SW entry); the versioned cache + `caches.delete`
  on activate is the smallest correct pattern; gating the reload prompt on clients
  controlled before `claim()` avoids showing "New version available" on a first
  visit. The `pwa.test.ts` unit test asserts the manifest/icon wiring and the
  staged stamp before any browser runs.

---

## 2026-10-05 · Update flow lives in the app shell, not the connection screen (M7)

- **Problem:** The PRD safe-update flow ("New version, reload") must be visible
  on every screen, but the connection state machine has no concept of it and
  threading a new state through `App`'s screen logic would conflate build lifecycle
  with connection lifecycle.
- **Choice:** The worker posts `{type: "dropbeam.updated"}` to previously-controlled
  clients; `main.tsx` re-broadcasts it as a `"dropbeam:update"` window event; `App`
  listens and renders a fixed bottom bar (`update.available` / `update.reload`,
  en+hi) that calls `location.reload()`.
- **Reason:** Keeps FR-50 lifecycle out of the connection state machine (rule 2 of
  the data-flow rules) and makes the banner reachable from any screen without
  touching the machine. Reloading is the correct action because `skipWaiting()` on
  install means the fresh SW is already in control.

---

## 2026-10-10 · Help, self-test and share target as pages layered over the shell (M7, FR-51, FR-60, FR-61, FR-62)

- **Problem:** M7 still owed four PRD items: a "How it works" page with a
  diagram (FR-60), a troubleshooting page (FR-61), an in-app connection
  self-test (FR-62), and the Web Share Target with a staged Send screen
  (FR-51). The connection state machine only models connection states, so
  informational screens cannot become machine states, and the share-target
  POST can only be answered by the service worker, not the page.
- **Choice:**
  - **Pages, not states.** `App` carries a small `page` state
    (main / help / trouble / selftest / send) rendered in place of the
    connection screens; any real screen change drops back to main so the
    transfer UI can never hide behind an informational page. Home gains two
    quiet links (How it works, Test my connection) per PRD 10.2.1.
  - **Share staging in a cache.** The manifest posts `./share` to the worker;
    `sw.js` stores each file in a `dropbeam-share` cache (the activate sweep
    now exempts it, so a deploy cannot eat a share) and 303-redirects to
    `#shared`. The page reads and clears the staging once (session-only per
    FR-40) into a Send screen; staged files auto-send exactly once when the
    normal approval gate opens, and a failure re-stages them with a toast.
  - **Self-test as a loopback pair.** `runSelfTest()` wires two
    RTCPeerConnections in memory (no STUN, no signalling server), proves the
    path with a ping/pong data-channel round trip, and reports the failed
    stage in PRD 7.1 vocabulary (gathering / connecting / unsupported). Both
    the PC factory and the screen's runner are injectable, so the pass,
    timeout and unsupported paths are unit-tested without a real network.
  - **Troubleshooting table.** Browser names stay literal brand strings
    (identical in every locale); all cell values and headings are catalog
    keys, en + hi.
- **Reason:** The page layer keeps the state machine's meaning intact
  (ARCHITECTURE rule 2) and makes each new screen a pure component with unit
  tests; the cache-staged share flow is the smallest correct shape for a
  serverless PWA and keeps every byte on-device (FR-40, PRD 9.1).
- **Also:** DoD 11's "every color token pair passes the 10.2 contrast
  thresholds" is now enforced by `tests/unit/contrast.test.ts`, computed from
  the shipped `tokens.css` for both themes (text ≥ 4.5:1, interactive
  borders/focus ≥ 3:1) — no token needed adjusting.

---

## 2026-10-10 · Design-gate record: audit + polish + detector (M7, 10.7, DoD 11)

- **Detector (`npx impeccable detect src public index.html`):** exit 0, zero
  findings (the Fraunces ignore from 2026-10-03 is the only rule ever
  suppressed). Re-run after the help/self-test/send screens landed.
- **`/impeccable audit` scorecard** (per the installed skill's rubric):

  | #         | Dimension                | Score     | Key finding                                                                                                                                                                                                                                    |
  | --------- | ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 1         | Accessibility            | 4         | Contrast is test-enforced (DoD 11); new screens walked in Chromium's accessibility tree: landmarks, h1→h2 order, real `table`/`list` semantics, `role="img"` label on the diagram, `role="status"` on the test result, global `:focus-visible` |
  | 2         | Performance              | 4         | No new dependencies; 134 KB gz budget with ~19 KB headroom; self-test runs once per screen open and closes both peers on every exit path                                                                                                       |
  | 3         | Responsive               | 4         | Single-column flow, 44 px targets (`.btn` min-height), support table scrolls inside `.table-wrap`, diagram capped at 320 px                                                                                                                    |
  | 4         | Theming                  | 4         | New CSS uses tokens only; the QR tile's black-on-white is the PRD-mandated exception; both themes pinned by the contrast test                                                                                                                  |
  | 5         | Implementation Integrity | 4         | Detector clean; no new shortcuts or system drift                                                                                                                                                                                               |
  | **Total** |                          | **20/20** | **Excellent**                                                                                                                                                                                                                                  |

- **`/impeccable polish` pass:** triaged the new surfaces against the
  playbook (flow → states → hierarchy → consistency → cleanup). No P0–P2
  changes needed; one known P3 stands: Vite's dev-only inline HMR styles
  trip the strict `style-src 'self'` CSP in the console (dev-only, documented
  above, production CSP unaffected). One pre-existing gap flagged, not
  introduced here: FR-41's settings sheet has no UI surface yet (the store,
  keys and i18n exist), so the troubleshooting page describes Across
  networks without a toggle to reach it.
- **Lighthouse (mobile profile, v11, against `vite preview`):** Performance
  99, Accessibility 100, PWA 100 — M7's "≥ 90 each" gate met. The first run
  scored PWA 75 because the manifest declared `theme_color` as a
  media-scoped array, which is not valid manifest syntax: browsers and
  Lighthouse both ignored it (the per-scheme tinting that actually works is
  the pair of `<meta name="theme-color">` tags in `index.html`, kept as-is).
  The manifest now carries a single fallback string and the PWA category is
  pinned to 100 by the run above; `tests/unit/pwa.test.ts` asserts the
  string form so the array cannot come back.

---

## 2026-10-10 — FR-41 settings sheet closed, plus two latent font bugs

- **Problem:** The M7 polish pass flagged one pre-existing gap: FR-41's
  settings sheet had no UI — the `SettingsStore`, the allowlisted keys
  (FR-40) and both catalogs' strings existed, but nothing emitted or
  applied them. While building the sheet, two silent font defects surfaced:
  (1) `scripts/fetch-fonts.mjs` kept the _latin_ subset for every family, so
  the shipped "Devanagari" woff2 held Latin glyphs and its
  `unicode-range` never matched Hindi text; (2) `base.css` referenced that
  face as `"Noto Sans Devanagari"` while fonts.css declares
  `"noto-sans-devanagari"` — CSS family names are case-insensitive but not
  space/hyphen-insensitive, so the face never loaded and Hindi rendered in
  a system fallback. The same mismatch made `"Instrument Sans"` /
  `"JetBrains Mono"` miss their declared names, i.e. the whole UI was
  rendering body text in `system-ui`.
- **Choice:**
  - `src/ui/settings.tsx`: a native `<dialog>` bottom sheet with radio
    segment groups (theme, language — real `<input type="radio">`) and
    `role="switch"` checkboxes with visible "On/Off" state text
    (PRD 10.6), the FR-42 device label (capped at 64 chars, never
    persisted), and the wake-lock row feature-detected so no dead switch
    appears where the API is missing.
  - The sheet is a **dynamic import** (like the scanner and QR renderer):
    it is not part of the first paint, and NFR-1 budgets only what is.
  - The app shell applies `data-theme` / `lang` / `data-reduce-motion` to
    the document from the store, so tokens.css and the Devanagari stack
    react to it; `use-wake-lock.ts` holds a screen lock only while files
    are moving (re-taking it on visibility, best-effort, never fatal).
  - FR-7's TTL is now visible: `SessionSnapshot` carries `codeExpiresAt`,
    and the pairing screens count it down instead of letting the _other_
    device discover the expiry first.
  - `fonts.css` keeps each family's own subset (Devanagari keeps
    `U+0900-097F`), and every stack in base/tokens references the declared
    family names verbatim. `tests/unit/fonts.test.ts` pins both.
  - The offered answer link that arrives as an in-tab fragment change
    (`hashchange`, not a load) is now answered too — the same one-shot
    bootstrap path, so a link pasted into the address bar of an open tab
    no longer leaves the home screen sitting there.
  - `fflate` (the DEFLATE fallback for browsers without
    `CompressionStream`) became a dynamic import and a named
    `fflate-fallback` chunk. Native streams cover every browser at launch
    (PRD 8.1 prefers them), so the fallback no longer costs first paint.
- **Reason:** These were stored-but-dead features and silent-wrong fonts —
  the exact "clipped/blank UI" class DoD 12 guards against. Lazy-loading
  the sheet and the fallback compressor also moved initial JS from
  152.7 KB to 147.0 KB gz against the 153.6 KB budget, so the feature
  landed with more headroom than it found.
- **Also:** the M7 polish note is now closed by
  `tests/e2e/settings.spec.ts` + `tests/e2e/pairing-transfer.spec.ts` (two
  real browser contexts pair over loopback WebRTC, exchange a file and a
  note, and assert zero console errors), and the settings flow is covered
  end-to-end including persistence across reload (FR-40 key list asserted
  from `localStorage`).

---

## 2026-10-10 — Linux CI failure, release audit, robots.txt

- **Problem:** CI had been red since the previous M8 commit — the share
  staging test failed only on Linux (`expected '[object Blob]'`): Node 22
  exposes jsdom's `File` while the cached `Response` is Node's own, so
  jsdom's `Blob` stringified the foreign-realm blob part instead of
  unwrapping it. Locally (Node 24) both come from one realm, hiding it.
- **Choice:** `readStagedShare` reads the entry as bytes and builds the
  `File` from the `ArrayBuffer` — a `BufferSource` part is copied as bytes
  by any spec-compliant `Blob`/`File`, whatever realm produced it.
- **Reason:** The pattern was fragile by construction; fixing the
  implementation is safer than loosening the fake, and it removes an
  intermediate object.
- **Release audit** (`scripts/audit-release.mjs`, run against the
  production build): Lighthouse mobile **99 performance / 100
  accessibility / 100 best practices / 100 SEO**. Lighthouse 12 removed
  the PWA category, so installability is proven directly: Chromium's
  `Page.getInstallabilityErrors` returns an empty list (valid manifest,
  active fetch-handling service worker, 192/512 icons), `npm run
pwa:health` is green, and the FR-50 e2e asserts the worker controls the
  page with a primed cache. The promotional `beforeinstallprompt` event
  does not fire in automation regardless of engagement — Chromium
  withholds it from low-engagement profiles — which is why the audit
  checks the criteria instead.
- **Also:** a network audit of a full pairing + transfer (two browser
  contexts, real loopback WebRTC, file and note in both directions) shows
  14 requests, **all same-origin** — DoD 5 with STUN off. `public/robots.txt`
  was added as the conventional `Allow: /` after the first attempt
  (`Disallow: /`) _lowered_ the Lighthouse SEO score: Lighthouse treats a
  page blocked from indexing as a failure, not a pass.

---

## 2026-10-10 — Cross-engine interop rows; guest-side UNSUPPORTED fix

- **Problem:** The interop matrix needed "different engines", not just
  different contexts, so `scripts/interop-matrix.mjs` runs Chromium
  ↔ Firefox in both directions with real WebRTC over the paste route.
  Playwright's WebKit build for Windows ships **without
  `RTCPeerConnection`**, so the Safari rows stay hardware-gated — but
  running into that wall exposed a real defect: the host path checked
  `isWebRtcSupported()` before starting, and the guest paths did not, so
  a browser with no WebRTC that tapped **Join** (or opened a shared link)
  was told "Couldn't find a network path. Check Wi-Fi." — a network
  diagnosis for a browser that cannot transfer at all.
- **Choice:** `join()` and `joinWithOffer()` now run the same support
  check `start()` always did, so both entry points answer UNSUPPORTED.
  The interop runner records the blocked engines instead of failing
  silently, and its rows say so.
- **Reason:** A missing capability must be reported as a missing
  capability (PRD 12 reason codes); the interop run is the first time a
  browser without WebRTC actually reached that code path.
- **Result:** Chromium ↔ Firefox and Firefox ↔ Chromium both pass with
  real engines — DB1, matching verification words, guest saving through
  OPFS, no console errors. WebKit: blocked, both directions, with the app
  now correctly reporting UNSUPPORTED instead of a network error.

---

## 2026-10-11 — Post-v1 roadmap slice: self-hosting guide, shortcuts, text share

Three roadmap items from PRD §19 that need no new infrastructure and no
product decisions were shipped; the rest are blocked on scoping (see the
end of this entry).

- **Self-hosting + TURN guidance** (`docs/SELF-HOSTING.md`, linked from
  the README): what a static host must provide (HTTPS, MIME types,
  sub-path caveat, the two headers a `<meta>` CSP cannot carry), how to
  keep the privacy invariants (`pwa:health` fails on an external URL; the
  FR-40 key allowlist), and the STUN/TURN table with the exact seam for a
  TURN build (`src/core/peer/ice-config.ts`). The app keeps shipping STUN
  only: a TURN relay forwards file bytes, which contradicts the
  "nothing is uploaded" promise, so it is documented as a deliberate
  self-hoster change with coturn guidance rather than a default.
- **App shortcuts** (roadmap "send to this device"): the manifest's
  `shortcuts` open `./?screen=send` and `./?screen=selftest`, which the
  app consumes into the same page state the home screen's quiet links use
  — and then clears the query so a reload cannot replay it. `pwa:health`
  now validates every shortcut URL and icon, and `tests/unit/pwa.test.ts`
  - `tests/e2e/shortcuts.spec.ts` pin the routes (including an unknown
    value falling through to the home screen).
- **Text share target** (roadmap "clipboard sync", first slice): the
  manifest now accepts `text`/`title`, the worker stages them under a
  sentinel entry in the existing FR-51 staging cache, and `readStagedShare`
  returns `{ files, text }`. The Send screen shows the shared text as it
  will be sent, and the connected screen's note field starts pre-filled —
  the user still presses Send, because text is never auto-sent.
- **Deferred, needs a decision from you:** resumable transfers (protocol
  change — chunk bitmap + per-chunk hashes, and a reconnect story the
  codec's 10-minute expiry does not currently cover), multi-peer mesh
  rooms (topology and approval changes), the numeric-code relay Worker
  (needs a deploy target and a privacy decision), the encrypted receive
  vault (key-derivation design), and the browser extension (packaging and
  distribution).
- **Reason:** these three are additive, reversible, and test-covered;
  the rest change the protocol, the threat model or the deployment story
  and should not be guessed at. Initial JS went 147.0 → 148.3 KB of the
  153.6 KB budget; 272 unit/integration + 13 e2e tests green.

## 2026-10-11 · Resumable transfers: re-pairing continues a dropped file (§19)

The previous entry deferred resumable transfers pending a decision. The
decision is now made (below); the reconnect-within-a-session half stays
roadmap.

- **Problem:** §19 asked for "auto-reconnect and resumable transfers
  (chunk bitmap, hash tree)". A dropped `RTCPeerConnection` ends the
  session — a re-connect needs a new handshake (PRD 5.1) — so the real
  gap was what happens _after_ the user pairs again: both sides still
  hold what they had, and the file should continue, not restart.
- **Choice:**
  - `ResumeStore` (in-memory, one per tab) parks what a dropped session
    left behind: the receiver its staged prefix (`parkInbound`), the
    sender its Blob (`parkOutbound`). Both are keyed by (name, size) —
    never by fid, because fids are allocated per session
    (`parity + 1 + index * 2`, cumulative) and cannot identify a file
    across sessions. Only disk-backed sinks are parked (`memory` bytes
    die with the page); those files start over and re-prompt.
  - Wire: a new control message `{k:"resume", files:[{fid, name, size,
chunks}]}`, announced by the receiver right after `hello`. The sender
    re-offers a matching parked file with `chunks` on the offer and
    streams from `chunks × 16 KiB`; the receiver re-opens its sink at that
    offset. Offsets travel positionally (`sendFiles(files, resumeChunks)`),
    not by fid.
  - Integrity: **no** chunk bitmap / hash tree yet. Both sides still hash
    the whole file — the receiver re-hashes its staged prefix, the sender
    seeds its hasher with the same prefix and hashes only the tail — so
    the existing SHA-256 `done`/`ok` exchange proves the reassembled file
    end to end with zero new wire messages. A bitmap would buy per-chunk
    repair of a completed-but-corrupt file; the protocol fails fast on
    mismatch today, so that cost is not warranted yet.
  - Prompt rule (FR-13): a resumed file is auto-accepted only when every
    offered file has a parked partial (`fresh.length === 0`); anything new
    still prompts. The UI surfaces parked files (resume hint on
    `PEER_LOST`, discard rows) so a half-received file can be cleared.
  - Security (PRD 9.4): `chunks` is bounded by the offered size on both
    the announcement and the offer, so a peer cannot claim an offset past
    EOF and make us zero-fill staged bytes.
- **Reason:** additive, no new infrastructure, no threat-model change,
  and fully testable without a network: `MemoryChannel` gained
  `stallDataFramesAfter`, modelling a link that dies after the Nth data
  frame — control frames after it are blocked too, which is what a real
  drop looks like (the peer never sees the `done`). The resume integration
  test drives two sessions, each with its own store (sender and receiver
  are separate tabs) over one staging disk: drop after two chunks, re-pair,
  and the file completes from the parked offset with exactly one chunk
  re-crossing the wire, byte-identical. Still roadmap: the bitmap/hash
  tree for partial repair of a completed-but-corrupt file.

---

## 2026-10-11 · Recoverable-drop grace: heartbeat waits out a self-healing ICE blip (§19)

First slice of the roadmap's "auto-reconnect _within_ a session". A full
re-pair still needs a new handshake (PRD 5.1) and is unchanged; this
guards the narrower case where the link was never really gone.

- **Problem:** the receiver's heartbeat fires `PEER_LOST` after one pong
  timeout (15 s in production). `RTCPeerConnection.connectionState` can
  read `disconnected` for a few seconds while the browser re-establishes
  ICE on its own — a transient blip. During that window the sender is
  simply quiet (it has no ping/pong handler), so the receiver counted
  silence as loss and forced a re-pair the link was about to undo.
- **Choice:** the heartbeat consults a live `pcState` callback
  (`() => peerSessionRef.current?.connectionState`, read at call time
  through the stable ref). When it reads `disconnected`, the pong
  deadline doubles (15 s + 15 s = 30 s in production); every other state
  (`connected` but silent, `failed`, `closed`, or no callback wired) is
  a real loss at the plain deadline. The grace is derived from
  `pongTimeoutMs`, not a new knob, so tests tighten the real constant
  and a separate `recoveryGraceMs` cannot drift from it.
- **Reason:** `readyState === "open"` on the `DataChannel` is the
  normal state, so deriving recovery from the channel alone would grant
  grace always; ICE recovery is only observable from the
  `RTCPeerConnection`. `failed`/`closed` get no grace because the
  browser has already given up and `peer-session` tears the PC down on
  either. Grace is deliberately bounded at 2× so a genuinely dead peer
  is still reported in ≤30 s (PRD 12's PEER_LOST contract holds, only
  the recovering case stretches).
- **Cost:** three integration tests pin the behaviour — grace holds
  `PEER_LOST` while `disconnected`, `failed` and `closed` still fail at
  the plain deadline. Plumbing (`pcState` through `TransferSession` and
  `useTransfer`) cost 179 B gz against a ~105 B effective budget, so it
  was paid for by dropping the separate grace knob and inlining the
  App-side getter (a `PeerSession.connectionState` getter measured
  12 B worse than reading the existing ref, and was removed).

---

## 2026-10-12 - Per-chunk repair: single-pass rewrite of a corrupt completed file (§19, FR-17)

First slice of the roadmap's `chunk bitmap / hash tree for per-chunk
repair`. FR-17 said a whole-file mismatch discards the partial file; it
now asks the peer for per-chunk digests, rewrites only the bad chunks, and
re-verifies once. The bitmap and the hash tree stay roadmap.

- **Problem:** a corrupted transfer (bad link, bit rot on a stalled chunk)
  always threw away the whole file. Every byte that landed correctly was
  re-sent, and a 50 MB transfer paid for one flipped byte.
- **Choice:** one new handshake, single pass, no retry:

  | step     | message                      | who      |
  | -------- | ---------------------------- | -------- |
  | mismatch | `{k:"mismatch",fid}`         | RX -> TX |
  | digests  | `{k:"plan",fid,hashes[]}`    | TX -> RX |
  | request  | `{k:"repair",fid,indices[]}` | RX -> TX |

  The sender re-sends exactly the named indices as DATA frames at their
  original sequence numbers; the receiver rewrites them with
  `writeAt(seq x 16 KiB, chunk)`, then hashes the whole staged file one
  final time against the original digest. A second mismatch is terminal.
  Chunks that never arrived stay `SEQ_GAP` - a digest cannot recreate a
  chunk that was never sent, so nothing is gained by asking.

- **Reason:** repair is lazily loaded, so the corrupted-transfer path costs
  the first paint nothing (the two new chunks are 1.2 KB gz combined). The
  budget is paid for by keeping the handshake out of the bundle and by the
  re-verified digest, which proves the whole file end to end without a
  Merkle structure. A single pass bounds the protocol: a peer that keeps
  corrupting cannot loop, and the timeout on both waits keeps a silent peer
  from hanging the transfer.
- **Cost:** three lifecycle bugs were found while making the tests green,
  all in code the feature shares: calling `sink.readRange` unbound
  (`this` is undefined inside `MemorySink`), waiting on a promise array
  that is still empty when the re-sent chunks have not arrived yet, and
  reading `opts.pongTimeoutMs` for a timeout that is only normalised onto
  `this.pongTimeoutMs`. The sinks gained optional `writeAt` /
  `readRange`; a memory-staged file has nothing durable to diff against,
  so that path stays terminal by design.

---

## 2026-10-12 - Size budget: initial JS means what the document loads

NFR-1's gate now derives "initial" from `index.html` instead of matching
filenames.

- **Problem:** `scripts/size-budget.mjs` split chunks with a filename
  regex. It listed `hash` among the lazy patterns, so the hash-wasm
  inline fallback was _meant_ to be excluded - but Vite names that chunk
  after the package entry (`index.esm-*.js`), not its contents, so
  17.9 KB gz of dynamically-imported fallback had always been counted as
  initial JS. The gate passed only because the app sat just under the
  number by accident, and any filename-based rule rots the same way.
- **Choice:** initial JS is the entry module referenced by the document's
  `<script src>`. Vite bundles every static import into that entry, so
  anything else in `dist/` is a dynamic `import()` chunk (scanner/QR
  render, hash worker, the hash-wasm fallback, the settings sheet, the
  fflate fallback, per-chunk repair) or the hand-written service worker -
  none of it is parsed before first paint. Those still print as `lazy`
  so total shipped weight stays visible.
- **Reason:** the rule now tracks how a chunk is loaded rather than what
  it happens to be called, so a new dynamic chunk is lazy the moment it is
  added and a new document entry is counted the moment it appears. The
  budget itself is unchanged (150 KB gz).
- **Cost:** the reported initial total drops by the chunks that were never
  initial, which is why the gate reports more headroom than before. This
  is a measurement fix, not extra licence: the entry module is still
  counted whole, and it still grew 4.1 KB gz for per-chunk repair.
