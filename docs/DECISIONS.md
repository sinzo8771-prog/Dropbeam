# Decision log

Format: date · problem · choice · reason. Every deviation from the PRD or a
library's docs gets an entry here (PRD section 0.3).

---

## 2026-10-03 · Dev vs production CSP

- **Problem:** The PRD CSP (`style-src 'self'`) blocks Vite's dev-mode `<style>` injection and its HMR websocket.
- **Choice:** `index.html` ships the PRD CSP verbatim. During `vite dev` a `transformIndexHtml` plugin prepends a dev-only variant adding `'unsafe-inline'` to `style-src` and `ws: wss:` to `connect-src`. Production build output never contains the relaxed CSP.
- **Reason:** Keeps the shipped policy exactly as specified while keeping local development usable.

> **Superseded in part (2026-10-20):** prepending the dev variant did not work,
> and the reason is in the CSP spec rather than in Vite: a document may carry
> several policies, but a resource then has to satisfy *all* of them, so the
> effective restriction is their intersection. The strict shipped policy stayed
> in charge, Vite's injected `<style>` elements were blocked, and the dev page
> rendered with no styles at all — the very thing the relaxation existed to
> prevent. The plugin now *replaces* the policy instead of adding a second one,
> so the dev page carries exactly one policy and it is the relaxed one. The
> shipped page is untouched. The 2026-10-20 entry has the measurement.

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
  changes needed; one known P3 stood: Vite's dev-only inline HMR styles
  trip the strict `style-src 'self'` CSP in the console (dev-only, documented
  above, production CSP unaffected). One pre-existing gap flagged, not
  introduced here: FR-41's settings sheet has no UI surface yet (the store,
  keys and i18n exist), so the troubleshooting page describes Across
  networks without a toggle to reach it.
  > **Closed (2026-10-20):** the P3 was the dev page's console errors, and
  > they were the symptom of the policy being in force twice rather than once.
  > The dev server now replaces the policy instead of prepending a second
  > one, so the dev page loads its styles and logs no CSP error. The gate
  > says zero console errors on the shipped page; this is the same claim for
  > the page a developer actually looks at.
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
  `readRange`, and the gate checks those two methods rather than the
  sink's kind: `MemorySink` implements both, so a memory-staged file is
  repaired too, and only a sink that omits them stays terminal.

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

## 2026-10-13 - The release audit is a gate, not a printout

`npm run ci` now ends with the release audit, and the audit decides with an
exit code (DoD 5, DoD 8).

- **Problem:** `scripts/audit-release.mjs` computed both DoD verdicts and
  then threw them away. Lighthouse's scores were only `console.log`'d, and the
  network audit ended in a ternary that printed `PASS` or `FAIL` with no
  `process.exitCode`. A run in which every request left the origin still
  exited 0, so nothing automated could notice a regression in the two
  requirements the file exists to check. It also required a human to start
  `vite preview` on :4198 first - exactly the kind of setup step that quietly
  stops happening.

- **Choice:** the thresholds are numbers in one place (`CATEGORY_GATES`,
  `OFF_ORIGIN_GATE`), every verdict goes through a single `check()` that
  records failures, and the script sets `process.exitCode = 1` when that list
  is non-empty. It now starts its own `vite preview` server programmatically
  (`preview()` from Vite) and closes it in a `finally`, so the command is
  self-contained and the port is released even when a gate fails.
  `npm run ci` gained a final `npm run audit:release`, and
  `.github/workflows/ci.yml` gained the same step after the Playwright browser
  install.

- **Reason:** DoD 5 and DoD 8 are release blockers, and a blocker that exists
  only as a line of console output is not a blocker. Putting the thresholds in
  one object also means the gate can be read in one place instead of inferred
  from the log.

- **Gates chosen:** performance >= 90 and accessibility >= 95 - DoD 8
  verbatim - plus zero off-origin requests. Best practices and SEO are printed
  but deliberately not gated: neither is a DoD threshold, and gating them would
  turn an unrelated Lighthouse scoring change into a red build. For the same
  reason the `agentic-browsing` category (50) and the sub-0.9 insight audits
  are labelled informational.

- **Bound to IPv4 on purpose:** the preview server is pinned to `127.0.0.1`.
  A bare `localhost` follows whatever the host resolves first - the IPv6
  loopback on some Windows machines, which is the trap `playwright.config.ts`
  already documents for :4199 - and a Node `fetch` to `localhost` can resolve
  to IPv4 and get ECONNREFUSED against a server that is in fact up.

- **Cost:** the stage adds ~12 s to `npm run ci` on a warm machine (measured;
  Lighthouse is run with `throttlingMethod: "simulate"`, so it models slow
  hardware instead of waiting on it). The gate also needs a Chromium that
  Lighthouse can drive, so a local `npm run ci` needs
  `npx playwright install chromium` if the e2e stage has not run in that
  checkout yet.

- **Verified:** with the real gates the stage exits 0 (Lighthouse 99 / 100 /
  100 / 100, 14 requests, 0 off-origin). With `performance` temporarily raised
  to 101 and the off-origin gate set to -1, both branches recorded a failure
  and the process exited 1; the file was then restored byte-identical.

## 2026-10-13 - CI runs the gate, not a copy of it

`.github/workflows/ci.yml` no longer spells the gate out stage by stage; it
runs `npm run ci`.

- **Problem:** the workflow listed the stages itself - lint, typecheck, test,
  build, size, install Chromium, e2e. That list had already fallen behind: it
  had never run `pwa:health`, so CI could be green on a gate that fails
  locally, and nothing could notice, because the list lived in two places. The
  release audit was about to become the second divergence.

- **Choice:** one `run: npm run ci` step, with
  `npx playwright install --with-deps chromium` kept as a named prerequisite
  ahead of it, since the e2e specs and the release audit both need a real
  browser. The order of the stages now comes from `package.json` alone.

- **Reason:** drift between "what CI checks" and "what the gate checks" is
  silent by construction, and its failure mode is a green build that does not
  reproduce locally. A single command makes that impossible rather than merely
  unlikely.

- **Cost:** the Actions UI shows one step instead of eight, so a failure names
  the stage in the log rather than in the step title - the same granularity a
  local `npm run ci` gives, which is the point.

- **Enforced, not just agreed:** `tests/unit/ci-parity.test.ts` now fails if
  the workflow ever lists a stage itself, and it reads the workflow with a line
  regex rather than a YAML library (the project ships no YAML dependency). That
  reader cannot see a `run: |` block scalar, so the suite rejects that form
  outright instead of risking a vacuous pass. The guard was exercised in both
  directions: re-adding `- run: npm run pwa:health` failed it by naming that
  exact stage, and a `run: |` rewrite failed it too.

- **Verified:** the workflow parses with a real YAML loader and invokes the gate
  while duplicating none of its stages; `npm run ci` is green with the parity
  suite included. GitHub Actions cannot be executed locally, so the job has not
  actually run on a runner; that remains the one unproven link.

## 2026-10-13 - The README's gate figures are generated, not typed

`npm run docs:figures` re-runs the gate and rewrites the test counts and the
gzip figure in `README.md`; `npm run docs:figures:check` fails if they are
stale.

- **Problem:** the same three numbers were hand-maintained in two paragraphs,
  and they went stale three times in one day - twice before this session, then
  again the moment five tests were added. Each copy is a claim nobody
  re-measured, and the two paragraphs had even drifted from each other (265
  unit/integration in one, 266 in the other).

- **Choice:** `scripts/update-gate-figures.mjs` runs `npm run ci` itself rather
  than any list of stages, so there is still exactly one definition of the gate,
  and rewrites each site where a figure appears. Every replacement is a strict
  single-match pattern over the text (never anchored to a line break, so a
  Prettier re-wrap cannot break it) and the run aborts when a pattern misses - a
  silent no-op would quietly restore the hand-maintained problem. Edits change
  digits only, and a rewrite that would alter the file's line endings is
  refused.

- **Reason:** those numbers are measurements, so a machine should take them.
  The one thing that must not be automated is guessing them, which is why the
  abort paths matter more than the write path.

- **Cost and limits:** it runs the whole gate, so it costs about what `npm run
ci` costs, release audit included. It reads the figures out of the gate's
  console summary, which is the fragile part: Vitest emits ANSI escapes even
  into a pipe, so the codes are stripped, and any change to the summary shape of
  either tool fails the run loudly instead of writing a wrong number.
  `docs:figures:check` is deliberately not in `npm run ci`, which would run the
  entire gate a second time to re-derive numbers it had just produced.

- **Verified:** with all three numbers deliberately corrupted, `--check` exited
  1 and named the true figures; the generator then restored the file
  byte-identically (`cmp` clean, zero CR bytes against a pre-corruption copy)
  and `prettier --check .` stayed green.

## 2026-10-13 - The gate takes its own figures

The entry above left the figures to a separate script, which could only keep
`README.md` current by running the whole gate a second time. The gate itself now
takes them, in the run that measures them.

- **Problem:** measurement and publication were two runs of the same thing. The
  gate measured the counts and printed them; `docs:figures` then ran the entire
  gate again to re-derive them from its own console output. Between the two,
  nothing kept the document honest - the check was a command somebody had to
  remember, it was deliberately not in `npm run ci`, and a stale `README.md`
  could be committed with every gate green.

- **Choice:** `npm run ci` is now `scripts/gate.mjs`. It runs each stage of
  `package.json`'s new `gate` list in order, streams each stage's output, and
  then rewrites the test counts and the gzip figure in `README.md` from that same
  run. Under CI it checks instead of writing. `scripts/gate-figures.mjs` holds
  the reading and the rewriting as pure functions, so the abort paths can be
  tested without a gate run.

- **Reason:** a figure is a measurement, and the only way to publish the number
  the run actually produced is to be the run. The stage list stays data in
  `package.json` rather than an array inside the runner because
  `tests/unit/ci-parity.test.ts` then reads exactly the list the runner reads -
  without importing an executable module - and can check that every stage is a
  real script, that none of them runs the gate again, and that the workflow still
  does not spell the stages out itself.

- **Cost:** the stages are now spawned one process at a time instead of being
  chained by the shell, so the runner owns the sequencing; it stops at the first
  red stage and writes nothing, so a broken tree cannot have its figures
  recorded. A stale `README.md` now fails CI, which is the point, but it is a new
  way for the build to be red, and the figures are checked against what the Linux
  runner measures when it eventually runs. Prose that quotes these numbers
  elsewhere in the documentation is still prose.

- **Verified:** the gate's own run rewrote `README.md` in place; with the numbers
  deliberately corrupted, a check-mode run exited 1 naming the true figures while
  a default run restored the file byte-identically (`cmp` clean, line endings
  unchanged, `prettier --check .` green). The new unit suite drives both halves
  directly and caught a real defect while being written: the wrapped sentence's
  separator was read from the replacer's first argument - the whole match - rather
  than from the capture group, so it wrote the old number where the line break
  belonged. The fixed-point check in the rewrite is what noticed.

## 2026-10-14 - The gate runs nightly

`.github/workflows/ci.yml` gains a `schedule` trigger: the same job, the same one
command, at 03:17 UTC.

- **Problem:** the gate only ever ran when something in this repository changed.
  The environment it runs in - the Ubuntu runner image, the Chromium build
  Playwright installs, what npm resolves - changes without any commit here, and a
  push or a PR trigger cannot see that by construction. And the workflow has still
  never executed on a runner at all: the local runs prove the commands and the
  sequence, not the machine.

- **Choice:** add `schedule: - cron: "17 3 * * *"` to the existing workflow rather
  than a second workflow file. A nightly that restated the setup steps would be a
  second definition of how the gate runs, which is exactly the drift that this
  workflow was fixed to stop.

- **Reason:** the scheduled run is also where the Linux half of the README's
  figures gets checked. Locally the gate measures the counts and writes them; with
  `CI` set it verifies them instead, so a count that differed per platform would
  fail the nightly rather than pass unnoticed on a laptop. The minute is 17 rather
  than 0 because GitHub's scheduled runs queue behind the rest of the world on the
  hour, where they can be delayed or dropped.

- **Cost and limits:** a scheduled run spends runner minutes (free on a public
  repository) and arrives a day late by nature. GitHub disables scheduled
  workflows after 60 days without repository activity and emails the owner, so
  "nightly" can silently stop being nightly. Nothing announces a failure except
  the Actions tab, and a failing nightly nobody opens is not a check. Most of all:
  the trigger could not be executed here - GitHub runs a schedule on the default
  branch, on its own clock - so this is verified as configuration and unverified
  as a run.

- **Enforced, not just agreed:** `tests/unit/ci-parity.test.ts` fails if the
  schedule trigger is dropped, reading the workflow with the same line regex the
  rest of that suite uses. It was exercised in both directions: the assertion
  fails once the trigger is removed, and the workflow was restored
  byte-identically afterwards.

- **Verified:** the workflow parses with a real YAML loader (PyYAML) to push on
  `main`, `pull_request`, and `schedule: [{cron: "17 3 * * *"}]`, with the job's
  three run commands and five steps unchanged - so the nightly and the PR path
  are one job rather than two that can drift apart. The parity suite is green at
  8 tests including the new one, and `npm run ci` is green with the figures
  re-synced to 318 unit/integration + 13 e2e.

## 2026-10-14 - The nightly widens the matrix: a second Node line, and Firefox

The nightly job is now a matrix over Node (`22`, `24`) and engine (`chromium`,
`firefox`); a push or a PR still runs the single leg it always did.

- **Problem:** the gate ran one configuration. Node 22 was pinned in CI while the
  machine this is developed on runs 24, so the version the developer uses was
  never the version CI checked, and a toolchain break on either side would have
  been found late or not at all. The engine was worse: this app's whole point is
  moving files between browsers, `docs/INTEROP.md` records Firefox rows as done
  and passing, and the _gate_ never opened Firefox once - so a Firefox
  regression would surface only when somebody ran the by-hand interop script or
  picked up a real device.

- **Choice:** widen the same job rather than add a second one. The matrix axes
  are the Node version and the engine, both widened by an expression only when
  `github.event_name == 'schedule'`, so a pull request runs exactly the one leg it
  ran before. The engine comes from `E2E_BROWSERS`, read by `playwright.config.ts`
  (default Chromium), and each leg installs and drives exactly one browser - which
  is also why the axes are separate legs rather than one leg with a comma-separated
  engine list: a comma inside a matrix value is not something to bet a workflow on,
  and a failure now names the leg it came from.

- **Reason:** a pull request gets the fast answer its diff deserves, and the
  combinations that are about drift - a second runtime, a second engine - are
  paid for once a night instead of on every push. It is the same trade the nightly
  itself was built on.

- **Cost and limits:** the nightly is four full gate runs (free minutes on a
  public repository, and they run in parallel). WebKit cannot be one of them at
  all: Playwright's WebKit build has WebRTC disabled, because WebKitGTK's
  `enable-webrtc` setting defaults to false, and the Windows build ships without
  `RTCPeerConnection` - so `playwright.config.ts` refuses `webkit` by name and
  prints that reason instead of starting a run that fails for a cause nobody here
  can fix. The engine axis therefore has two values, and a third engine means
  adding the project and the browser install, not a config line. The matrix
  expressions themselves cannot be executed here - GitHub evaluates them - so the
  axis widening is verified as configuration: parsed with a real YAML loader,
  asserted on the exact expressions, and unrunnable locally by construction.
  > **Superseded in part (2026-10-19):** the claim that WebKit's Linux build has
  > WebRTC disabled is wrong. Measured on the hosted Linux runner, that build
  > *does* report `RTCPeerConnection` - the debug panel reads `WebRTC yes` there -
  > so the exclusion below rests on the Windows build having no API and on the
  > Linux build never having paired, not on the setting quoted above. The engine
  > axis has gone too: the nightly's Firefox leg is a job of its own now, because
  > the runner's Firefox cannot gather a local candidate and so collects fewer
  > tests than the figures state. The 2026-10-19 entry has the measurement and
  > what the legs look like now.

- **Not weakened to make it pass:** two Firefox problems were found by running
  the suite there, and both fixes are at the harness, not the assertion. The
  clipboard is seeded differently on Firefox, because Playwright answers
  `Unknown permission: clipboard-read`; the app still calls `navigator.clipboard`
  and the same paste route runs. And the peer-drop test now waits 45 s instead of
  30 s, because that 30 s was the app's _exact_ worst case (15 s of silence,
  doubled to 30 s while the browser reports only `disconnected`) and Firefox sits
  in `disconnected` longer than Chromium, so the doubled deadline landed outside
  the window. The assertion is unchanged; the bound now sits above the contract
  instead of exactly on it. Both are recorded in docs/INTEROP.md, which is where
  the engine rows live.

- **Verified:** the whole suite passes on both engines locally (Chromium 13/13 in
  24 s, Firefox 13/13 in 47 s), and the full gate is green twice over - once on
  the default Chromium configuration, which re-synced the README figures to 326
  unit/integration + 13 e2e, and once with `E2E_BROWSERS=firefox`, which reported
  `README.md is current` against the same figures. That second run is why there is
  no "skip the figures" mode: every leg measures the same numbers, so every leg
  can check them. `E2E_BROWSERS=chrome` and `E2E_BROWSERS=webkit` both stop the run
  at config load, naming the offending engine and, for WebKit, the reason. New
  guards: `tests/unit/e2e-browsers.test.ts` (5 tests) pins the default and both
  refusals, and `tests/unit/gate-figures.test.ts` covers the mode decision
  (`--check`, `--write`, the CI default, a typo, and two contradictory flags).

## 2026-10-15 - The WebKit leg: scoped to what the engine can run, and off the gate

The third engine is driven now, but only over the specs it can actually run:
`npm run test:webkit` runs every spec except pairing on WebKit, on its own
scheduled job. This supersedes the "WebKit cannot be one of them at all" limit in
the entry above.

- **Problem:** refusing WebKit by name meant the engine whose behaviour differs
  most from the others had no automated coverage at all - and it is the engine the
  PRD's degradation story is about. A browser with no WebRTC has to say so clearly,
  and only WebKit has that property for real; the app's guest-side support check
  exists _because_ of a WebKit-only finding, and nothing in CI exercised it in a
  real browser. The limitation is also one spec wide: pairing needs
  `RTCPeerConnection` and the build has none, but the settings sheet, the debug
  panel, the shortcuts and every degradation path need nothing of the sort.

- **Choice:** scope the engine instead of refusing or skipping. `playwright.config.ts`
  gives WebKit a project whose `testIgnore` excludes exactly
  `pairing-transfer.spec.ts`, and adds `tests/e2e/degradation.spec.ts` for the rest.
  That spec is deliberately one code path on all three engines: an init script sets
  `RTCPeerConnection` to `undefined` - a no-op on WebKit, a real removal on Chromium
  and Firefox - so the PR legs cover the degradation messaging too, and WebKit is
  where the absence is genuine rather than injected. The WebKit project also reads
  its engine from the npm script name (`engineList`), because `npm run test:webkit`
  has to mean WebKit on any platform and this project has no cross-platform way to
  set the variable inside the script.

- **Reason:** the engine's limitation is one spec wide, and refusing the whole
  engine threw away seventeen runnable specs to avoid two unrunnable ones. What the
  leg buys is the only thing no other engine can give: the app meeting a real
  absence of the API it is built on, with nothing stubbed. The suite already had a
  documented case of getting that wrong - the guest paths answered a missing
  WebRTC with a _network_ failure - so a real browser exercising the message is
  worth more than the two specs the engine cannot take.

- **Cost and limits - why it is not a leg of the gate:** excluding the pairing spec
  makes WebKit collect a smaller suite than `README.md` describes. As a matrix
  engine it would fail the figure check for a difference that is structural, not a
  regression; and in a local `write` run it would record the smaller count as the
  published figure, which is the wrong number the whole figure arrangement exists
  to prevent. So it is a separate job, scheduled only like the widened matrix legs,
  and `figureMode()` refuses `E2E_BROWSERS=webkit` before any stage runs, naming
  the command meant for it. The scheduled job is the only place this runs, so the
  leg's Linux behaviour is still unproven here; and Playwright's WebKit is not
  Safari, which docs/INTEROP.md says in as many words.

- **Findings, and what the spec therefore does not assert:** measured on the
  served origin, WebKit has no `showSaveFilePicker`, no `RTCPeerConnection`, but
  does have `navigator.storage.getDirectory` - so `chooseSink()` (PRD 8.5) resolves
  to the OPFS sink, the Safari path the design assumes, and the degradation spec
  pins that detection input on every engine. But the OPFS write round trip
  **fails** on this build: `createWritable()` throws `UnknownError` while Firefox
  and Chromium complete it. So no test claims the OPFS save path works on WebKit -
  asserting the browser's own bug would turn a future WebKit fix into a red build -
  and the gap is recorded in docs/INTEROP.md instead. The gap has a product face
  too: `isOpfsSupported()` checks only that `getDirectory` exists, so on this build
  the app would choose OPFS and fail mid-transfer rather than fall back to memory.
  Not changed here, because there is no evidence real Safari shares the limitation.

- **Verified:** the WebKit leg passes 17/17 locally (19 specs minus the 2 pairing
  tests), with the degradation file running against the genuine absence of the API;
  Chromium 19/19 and Firefox 19/19, so both gate engines still collect the same
  suite. `E2E_BROWSERS=webkit npm run ci` stops before a stage runs and leaves
  `README.md` untouched, which was checked by diffing the file across the attempt.
  The gate is green end to end and re-synced the README figures to 331
  unit/integration + 19 e2e. New guards: `e2e-browsers.test.ts` (7 tests) pins the
  scoping against the specs actually on disk, so a widened ignore list or a new
  spec silently outside the run fails there; `ci-parity.test.ts` checks the WebKit
  job is separate, scheduled, installs its own browser first, names its engine, and
  never enters the `gate` list; `gate-figures.test.ts` covers the refusal.

## 2026-10-15 - The debug panel reports what the browser can do, from the app's own detection

The panel gained five rows: WebRTC, File System Access, OPFS, whether OPFS can
actually be written to, and the sink `chooseSink()` would take.

- **Problem:** the panel showed the build, the service worker, the cache and the
  session, but nothing about what the _browser_ can do - which is what most often
  explains a field report. A device that cannot pair, or that stages onto a path
  it cannot write, looked exactly like one that had simply not tried yet. The
  storage layer had already anticipated this: `chooseSink()`'s doc comment says
  the chosen kind "is surfaced so the debug panel can log it", and nothing used
  it.

- **Choice:** every value comes from the function the real path runs on -
  `isWebRtcSupported`, `isFsaSupported`, `isOpfsSupported`, `chooseSink().kind`
  - so the panel reports the decision this device makes rather than a second
    opinion about it. One question those functions do not answer is added as a new
    probe, `probeOpfsWrite`: a scratch write into the staging directory that
    cleans up after itself and answers `false` instead of throwing on every failure
    mode. Reachability and writability are separate rows because on real builds
    they are separate facts.

- **Reason:** the panel's job is to make a field report answerable without a
  debugger, and "which path did this device take" is the first question that
  makes a report actionable. The WebKit build is the proof: measured through the
  panel, it reads `OPFS yes / OPFS write fails / Save sink opfs` - it would stage
  onto a sink it cannot write to, which a reachability check alone reports as
  perfectly healthy. The contradiction is now visible on the device, not just in
  this repository's notes.

- **Cost and limits:** opening the panel writes one small file into the app's own
  OPFS staging directory, removes it, and probes once per mount rather than on
  the panel's 2 s health poll. The panel is part of the initial bundle, so the
  rows, the probe and the five label pairs in both catalogs cost 1.6 KB gz
  (135.1 -> 136.7, budget 153.6) - paid up front on the home screen route. That
  is the price of a field report that answers the capability question without a
  debugger; nothing here is on the transfer path itself. The rows make `debug-panel.spec.ts` the one
  engine-keyed e2e spec - the right answer depends on which browser is running,
  so it carries a per-engine table like the interop matrix. The write row pins
  only that the probe _answered_ on WebKit, never which verdict: the current
  answer is `fails`, and pinning that would turn a future WebKit fix into a red
  nightly. On the engines whose transfers stage through OPFS it does pin `ok`,
  because the suite's own guest save depends on that path working.

- **Verified:** unit - 4 new panel tests (stubbed detections and probe: the
  healthy path, the memory-only browser, the reachable-but-unwritable split, and
  the row staying `—` until the probe answers) and 5 new probe tests (write and
  cleanup, unwritable, failed write, no namespace, unopenable directory);
  `sinks.test.ts` 25, `debug.test.tsx` 20, `i18n.test.ts` 7 on the new keys in
  both catalogs. E2E - the same spec run on all three engines in one pass (9/9),
  then read back out of real WebKit through the panel with the documented
  gesture: `WebRTC no / File System Access no / OPFS yes / OPFS write fails / Save
sink opfs`, `page errors: []`.

## 2026-10-15 - A sink that refuses the file costs the file no more

The receiver now falls back to memory for a file whose chosen sink refuses it
before a byte has landed, instead of failing the transfer.

- **Problem:** the sink is chosen by feature detection and then opened, and on a
  build where those two answers disagree - the measured WebKit shape, where
  `getDirectory` exists and every `createWritable` throws - the file simply
  failed. The reported reason was worse than uninformative: `toErrorCode` did not
  know `SinkError`, so the storage layer's own mapping (a refused write is
  `DISK_FULL` there) collapsed into `SINK_UNAVAILABLE` on the wire, telling the
  user their browser lacked an API that it had just advertised. And the failure
  arrived at the one moment a fallback is free: nothing staged, nothing lost.

- **Choice:** building the sink and opening it are now one guarded step, and a
  refusal falls back to memory for that file alone (PRD 8.5's fallback order ends
  there anyway). Two exclusions, both about not losing data or agency: a resumed
  transfer is never restarted into memory, because its prefix lives in the sink
  that just refused and the tail alone would be a file with a hole in it; and a
  cancellation is reported rather than absorbed, because a dismissed save picker
  is the user's decision, not the storage layer failing. The refused sink is
  aborted on the way past, so an empty `.part` does not linger in the staging
  directory. `toErrorCode` now honours `SinkError.code`, which is what carries
  the sink's real reason to the wire.

- **Reason:** the alternative was to probe writability when _selecting_ a sink -
  the debug panel's probe already does exactly that for its own report - and it
  was rejected as the fix: it costs a file creation per incoming file, it can
  still race (the probe succeeds and the real open fails), and the failure it
  guards against is only reachable at the point the fallback now sits. Detection
  is left shallow for the same reason, and because there is still no evidence
  real Safari shares the limitation. What the transfer _cannot_ absorb is a sink
  that fails after bytes have landed; that stays a failure, and the per-chunk
  repair path (FR-17) is the tool for the case where the bytes arrived wrong.

- **Cost and limits:** the fallback is silent at the protocol level - the file
  arrives, the sender sees a normal completion, and only the saved row's
  `sink: "memory"` says where it went (the UI already renders a memory save as a
  download). There is no per-file "this one went to RAM" notice; that would need
  a new event through receiver -> session -> UI, and it is the obvious follow-up
  rather than something to invent here. A file past the 1 GiB memory cap
  (FR-31) still fails, reporting the sink's own reason. The change also makes two
  previously _silent_ failures visible: a sink that cannot be built and a resume
  that cannot open now send their `err` frame, which is what
  `accept()`'s comment always claimed happened.

- **Verified:** 6 new tests. `tests/integration/transfer.test.ts` (32 tests) falls
  back with a double, drives the **real** `OpfsSink` against the exact
  `UnknownError` Playwright's WebKit build throws - file byte-identical, saved as
  `memory`, nothing reported - reports the sink's own `DISK_FULL` when memory
  cannot take the file either, refuses to restart a resumed transfer, and reports
  a dismissed picker instead of staging it in RAM. `tests/unit/sinks.test.ts`
  pins that `toErrorCode` carries each `SinkError` code. Full gate green:
  346 unit/integration + 19 e2e tests, 136.8 KB gz of 153.6 KB (the fallback cost
  0.1 KB), Lighthouse 99/100/100/100, network and release audits pass.

## 2026-10-18 - DoD 6 was not true: the precache held only the shell

- **Problem:** DoD 6 says the app works offline after first load, and the worker's
  precache listed only `./` (the shell). The app code-splits, so the settings
  sheet, the two repair paths and the hashing worker are separate chunks that are
  only requested the first time a user reaches them. On a first visit those
  requests are made _before_ the worker has claimed the page, so they never pass
  through its fetch handler and never reach the cache. A device that had never
  opened Settings could not open Settings offline: the dynamic import failed, the
  button did nothing, and the app said nothing about it.

  Nothing caught it because every offline check so far was "does the app boot",
  and the app booted — it was the code-split routes that were broken.

- **Choice:** `scripts/postbuild.mjs` now walks `dist/` after every build and
  rewrites the worker's precache list with every emitted file — entry script, CSS,
  each code-split chunk, the worker script and the self-hosted fonts (~446 KB).
  `public/sw.js` carries a `__PRECACHE__` marker for it to replace, and the
  stamping fails the build loudly if that marker is missing, because a silent
  no-op here would ship the broken worker behind a green build. The shell is
  added first and on its own (`addAll(["./"])`), then the rest one at a time with
  a caught rejection and a `console.warn`, because `addAll` rejects as a unit and
  one 404 would otherwise cost the app every offline asset rather than one.

- **Reason:** The alternative was to warm the cache by driving the app through
  every screen before going offline, which is what the test would have done
  naturally, and it is the wrong fix twice over: it only helps the test that does
  it, and it leaves a real user who has not pressed the button yet without the
  chunk. Precaching is what "works offline" actually means.

- **Cost and limits:** ~446 KB is fetched at install rather than on demand, so a
  first visit on a slow connection now pays for the repair paths it may never
  reach. That is the standard trade for an offline-first PWA and the size is
  dominated by fonts that are needed anyway. `sw.js` itself is deliberately not
  precached: the browser fetches the worker through its own update path, where a
  cached copy would be the wrong copy.

- **Verified:** 3 new tests in `tests/e2e/offline.spec.ts` (home screen, deep
  `?screen=` route, and recovery when the network returns), 2 in
  `tests/unit/pwa.test.ts` pinning the marker and the precache shape, and the
  settings-sheet step in the e2e test is the one that actually reproduces the
  bug — a dead button, not a failed assertion.

## 2026-10-18 - Cache lookups ignore `Vary`, or precached chunks never match

- **Problem:** Even with the chunk in the cache, the settings sheet still failed
  offline with `net::ERR_FAILED`. The cause was `Vary: Origin`, which
  `vite preview` sends on static files. The Cache API honours `Vary` by default,
  so the lookup compared it: the worker's own `cache.add` requests carry no
  `Origin` header, while a module script fetched by `import()` does, so the
  request that needed the copy was told it wanted a different representation than
  the one stored. The response was sitting in the cache the whole time and the
  lookup simply declined it.

- **Choice:** Every cache lookup in the worker goes through one `lookup()` helper
  that passes `{ ignoreVary: true }`.

- **Reason:** `Vary` is a statement about how a _server_ varies its answer on
  request headers. It is not a statement about whether two requests want the same
  static file, and a same-origin hashed asset is one file whatever headers the
  browser attached. Honouring it here made offline depend on a response header
  that several common static servers and dev servers set for reasons unrelated to
  this app.

- **Cost and limits:** None for this app — the precache is written by this worker
  for itself, and every entry is a same-origin immutable hashed file, so there is
  no representation to vary. It would be wrong in a worker serving
  user-generated or negotiated content, which is not what this one does.
  `tests/unit/pwa.test.ts` asserts there is no bare `caches.match(` left in the
  worker, since one unguarded lookup reintroduces the whole failure.

- **Verified:** the settings-sheet step in `tests/e2e/offline.spec.ts` fails
  without the fix and passes with it, and a direct `caches.match` probe showed
  the entry present, status 200, `content-type: text/javascript` — present and
  unmatched, which is what identified `Vary` as the cause rather than a guess.

## 2026-10-18 - What DoD 6 can and cannot be tested against here

- **Problem:** DoD 6 is "works offline after first load (airplane mode + hotspot
  still pairs)". The pairing half cannot be automated on this machine.
  Playwright's `setOffline` cuts the whole network stack, WebRTC included, so with
  both contexts offline the pairing reaches `WAITING_FOR_REPLY` and then `FAILED`
  — which is the emulated network refusing ICE, not the app refusing anything. But
  DoD 6's case is the opposite one: the internet is gone and the _local link to
  the other device is not_. Reproducing that needs a second network the peer can
  still reach, which two browser contexts on one machine do not have.

- **Choice:** Automate the half that is about the app and mark the rest honestly.
  `tests/e2e/pairing-transfer.spec.ts` pairs two offline devices as far as the
  codes go — both produce an offer and a reply from cached pages with the origin
  unreachable, through the shared-link route, with no console errors. The data
  channel itself stays a row in the manual matrix in `docs/INTEROP.md`, needing a
  phone on the other end of a real hotspot.

- **Reason:** The tempting alternative is a test that goes offline and asserts the
  transfer completes, which would either fail for a reason that is the harness's
  or need a skip that hides it. Either way the matrix would show a covered row
  that nothing covered.

- **Cost and limits:** A reader of the pairing spec should know the codes-offline
  test stops before the connection, so the comment above it says so plainly. The
  offline _app_ half is fully automated, and it is the half that was actually
  broken.

## 2026-10-18 - Playwright's WebKit cannot navigate offline, so DoD 6 is unverified there

- **Problem:** The DoD 6 offline spec was written and run against Chromium, where
  it passed. The scheduled WebKit job runs "every spec but pairing", so the new
  spec was picked up there too - and failed all three of its tests with `WebKit
encountered an internal error` on `page.reload()` and `page.goto()` while the
  network was emulated down. The job would have gone red on its first run.

  The failure is narrower than "WebKit has no service workers". Service workers
  work there: the app installs, `claim()`s, and populates its cache on this
  engine, so the offline spec's setup completed every time. What this build
  cannot do is _navigate_ with the network down.

- **Choice:** The offline spec joins the pairing spec in WebKit's project-level
  `testIgnore`, with both reasons written out in `playwright.config.ts`.
  `e2e-browsers.test.ts` is updated to name both excluded specs explicitly
  rather than counting them, so the next exclusion has to be written down.

- **Reason:** The alternative - an in-file `test.skip()` on WebKit - is what this
  project already rejects for the pairing spec, and for the same reason: a skip
  hides the fact that the engine collects a smaller suite, and that difference is
  what keeps the WebKit leg off the gate. Leaving the spec in and letting it fail
  was the third option and the worst one, because it turns a known harness limit
  into a red nightly that trains people to ignore red nightlies.

  Project-level exclusion was also the honest reading of the result. The
  alternative mechanism, blocking requests with `page.route` instead of
  `setOffline`, was rejected on inspection: Playwright does not route service
  worker requests, so the worker's network-first `fetch()` would still succeed and
  the test would quietly become a check that an _online_ page renders - passing
  while proving nothing about offline.

- **Cost and limits:** This is a real gap, not a formality. DoD 6 is a claim
  about Safari, and after this change no automated run covers it on the engine
  that most resembles Safari. It stays a hardware row in `docs/INTEROP.md` with
  the same phone and real hotspot it needed anyway for DoD 1 and DoD 2, and both
  docs now say so where a reader of the spec will find it.

- **Verified:** `npm run test:webkit` green at 22 (17 before this work, plus the
  5 design-gate tests, minus the 3 offline ones), and the Firefox leg green at 28
  - which is why the exclusion is WebKit's alone rather than a blanket one.

## 2026-10-18 - the guest had no timeout at all, which is why the isolation row said "expect"

- **Problem:** The manual matrix row for "guest Wi-Fi with client isolation" had
  been sitting there reading "expect helpful failure" since it was written. It
  was an expectation, not a result, and checking it turned up a real bug on the
  one network in the matrix where failure is the correct outcome.

  On a client-isolated network the codes cross fine - they are typed, scanned or
  pasted, not routed - so both devices complete the handshake and then stop,
  because the peer connection can never be established. The host handles that:
  `PeerSession.applyAnswer` awaits `waitForChannel`, which gives up after
  `CONNECT_TIMEOUT_MS` and fails with `CONNECT_TIMEOUT`. The guest had no
  equivalent. `joinWithCode` publishes the answer and returns, the guest's state
  only moves when the channel opens, and it passes through `CONNECTING` at that
  same instant - so the connecting timeout never armed for it. `TIMEOUT_STATE`
  listed `GATHERING`, `CONNECTING` and `WAITING_FOR_REPLY`, and not
  `SHOWING_ANSWER`. The guest waited on a channel that would never arrive, with
  no bound at all.

  Worse, the failure would have been silent even once bounded. The machine's
  timeout goes straight to `FAILED`, but `SessionController.error` was only ever
  set by the controller's own `fail()`, so a machine-initiated failure left the
  snapshot's reason null; and the UI subscribed to the machine for `state` alone,
  while its alert is gated on `error`. So the guest would have moved to a FAILED
  screen that said nothing and offered no Try again, while the host explained
  itself. One side of a pair telling the user what went wrong while the other
  says nothing is the worst version of this failure.

- **Choice:** Three changes, smallest first.
  1. `SHOWING_ANSWER` arms the `connecting` timeout, so the guest gets the same
     20 s bound and the same `CONNECT_TIMEOUT` code as the host.
  2. `SessionController.snapshot()` falls back to the machine's own failure, so
     a failure the machine reached by itself carries its reason.
  3. The machine subscription in `App.tsx` projects that reason onto the alert,
     via an exported `errorFromMachine` so the rule is testable on its own.

- **Reason:** Symmetry is the point. The two sides reach the same dead end by
  different routes - the host has a seam to time out in, the guest has an event
  that simply never fires - and the fix has to land on both, or the matrix row
  still describes two devices behaving differently. Bounding the wait and
  carrying the reason are separate changes because either alone still leaves a
  silent failure.

- **Cost and limits:** The bound is the same 20 s PRD 7.1 already promises for
  connecting, which is generous for a channel that normally opens in well under a
  second, so the risk is a slow-but-failing connection being cut off rather than
  a real connection being harmed. `snapshot()` falling back to the machine's
  failure also changes what a _host_ sees on its own gathering or code-expiry
  timeouts, which previously reported a FAILED screen with no reason; that is the
  same defect and is now reported the same way as everything else.

  What is still not covered is the one thing only hardware can show: that a real
  router with client isolation produces this shape rather than some other
  failure. The tests prove the app responds correctly once the transport never
  delivers a channel, not that the router behaves this way.

- **Verified:** 4 new tests. `session-pairing.test.ts` drives both sides of the
  scenario - the host through a transport whose `applyAnswer` rejects exactly as
  `waitForChannel` does, the guest by simply never receiving the channel event -
  and asserts each ends `FAILED` with `CONNECT_TIMEOUT` within the bound. The
  guest test was written first and failed against the shipped code, still in
  `SHOWING_ANSWER` after 21 s; the state alone passing and the reason still null
  is what surfaced the second and third changes. `i18n.test.ts` pins that the
  message names the hotspot remedy PRD 553 promises, and `ui.test.tsx` pins the
  projection. Full gate green.

## 2026-10-18 - §19 work landed under M8 labels, and why that was legitimate

- **Problem:** PRD §17 builds milestone by milestone, and §19 is headed "Roadmap
  (post v1, do not build now)" - it lists "Auto-reconnect and resumable
  transfers (chunk bitmap, hash tree)". Six commits implemented §19 items while
  M8's own remaining task, the manual device matrix, was still open:

  `52b6c47` resumable transfers, `8a6fa15` recoverable-drop grace, `764cd78`
  per-chunk repair, `3532918`/`2ce26c5`/`bf52138` its tests and shared path.

  Read on its own that is §17 ordering broken: two milestones' worth of work
  landing before the earlier milestone was done.

- **Choice:** Keep the work, record the ordering, and stop labelling new §19
  work as `M8:`.

- **Reason:** `v1.0` was already tagged, at `3439704`, before any of those six
  commits. §19 is gated on _after_ v1.0, not on the matrix being finished, so
  every one of them was legitimate post-v1 work. The mistake was not the work
  and not the timing - it was the commit prefix, which files post-v1 work under
  the milestone that owns the unfinished matrix. That matters more than it
  sounds: `git log` is how a reader reconstructs what happened, and a reader
  seeing six `M8:` commits would conclude M8 had advanced when in fact the
  matrix had not moved at all.

  The distinction also decides what "M8 complete" means. It is still gated on
  the hardware rows in `docs/INTEROP.md`, not on anything in a commit message.

- **Cost and limits:** Nothing to undo, and the six commits stay as they are -
  rewriting published history to relabel them would cost more than it is worth.
  From here, §19 work takes its own prefix so the two are never confused again.

- **Verified:** nothing to run; this records why the log reads the way it does.
  `docs/INTEROP.md` remains the authority on what is still open.

## 2026-10-18 - The nightly legs can be run by hand

- **Context:** The WebKit leg was added tonight and gated on
  `github.event_name == 'schedule'`, with no other way to reach it. Checking the
  repository afterwards showed the honest consequence: no scheduled run had ever
  fired, because the job and the `schedule` trigger both landed after that day's
  03:17 UTC window. The first automatic execution was therefore the following
  morning - and until then nothing could tell whether the job was wired to the
  right engine, installed the right browser, or ran at all.

  A job that can only be started at one fixed hour is a job nobody can check.
  The same applies to the widened matrix legs: changing the WebKit browser
  version means either waiting a day to see the effect or editing the cron to
  make the nightly run early, which is a worse way to ask the question.

- **Alternatives considered:**
  - Add `workflow_dispatch` alone. Rejected, and quietly wrong: the job's
    condition tests the event name, so a manual dispatch would skip the very job
    it was dispatched to run, and the run would report `skipped` - which reads
    as health.
  - Fold the leg into the nightly's own run so a hand-trigger and a nightly are
    literally the same job. Rejected: they are not the same question. The nightly
    exists to catch runner drift on a schedule nobody is watching; a dispatch is
    someone asking a question now, and a red manual run should be read as an
    answer rather than as the nightly failing.
  - Give the WebKit job its own workflow file. Rejected for the reason the
    original decision records: one workflow, one setup path.

- **Choice:** add `workflow_dispatch:` to the existing workflow's triggers, and
  extend the WebKit job's condition to
  `github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'`.
  Both halves, together, or neither: either alone reproduces the original
  problem in a new form.

- **Reason:** a manual dispatch is an escape hatch, and an escape hatch that
  reports `skipped` is not one. Pinning both halves in `ci-parity.test.ts` means
  neither can rot unnoticed - the trigger is asserted against the workflow, the
  condition against the job, so removing either one fails the suite rather than
  quietly narrowing what CI runs.

- **Cost and limits:** anyone can now start a run on demand, which consumes
  Actions minutes; the schedule remains the primary path and the manual trigger
  is for questions, not for routine runs. The manual run still takes the
  default branch and still verifies rather than writes the README figures,
  because `CI` is set either way.

- **Verified:** `npm run ci` green. The job's condition, the trigger, and the
  WebKit job's absence from the `gate` list are all pinned by `ci-parity.test.ts`;
  the WebKit leg itself was then dispatched by hand against this commit, which is
  the first time that job has ever run in CI — and it went red, for a reason of
  its own: the capability table still carried the Windows answer. Corrected
  under the entry below, which is what the dispatch was actually for.

## 2026-10-19 · WebKit's capability rows are keyed by platform, not by engine

- **Problem:** the debug panel's four capability rows (FR-50) were one row per
  engine, so `webkit` had a single set of expected values. Those were read on a
  Windows machine. When the WebKit leg ran in CI for the first time, on Ubuntu,
  the WebRTC row failed: the app reported `yes` where the table said `no`. The
  same row failed the scheduled leg too, which fired on 2026-10-19 at 09:01 UTC.
  Nothing in the repository had ever run WebKit on Linux, so the table was not
  wrong by accident — it was a measurement of one platform wearing another's
  name.

- **Alternatives considered:**
  - Change the WebKit row to the Linux values. Rejected: the Windows leg runs
    locally on every `npm run test:webkit`, so that would have broken the one
    place these values can be checked, and silently swapped which platform the
    published numbers describe.
  - Split the row per platform but keep hard assertions and let CI report one
    drifted row per run. Rejected as a way of finding out: four runs to read
    four values, each of them a red main branch.
  - Guess the remaining three rows from the app's own feature detection. That is
    the one option this project takes nowhere: a capability row is evidence, not
    an inference, and a guess that happens to be right costs more than a wrong
    guess ever would.

- **Choice:** key WebKit's rows by `process.platform` and leave the other engines
  keyed by engine. The Linux row was then read out of a real run: a short-lived
  `diag/webkit-caps` branch pointed the Linux values at `?` and made the four
  assertions `expect.soft`, so one dispatched run reported every row's real value
  instead of only the first failure. `win32` keeps the values already measured
  here; `darwin` stays `?`, because guessing for a platform that has never run
  anything would be the same mistake one level down.

- **Reason:** the table's job is to state what a browser can do, and a browser's
  answer depends on the build, not on its name. Keying by platform makes that
  dependence visible instead of hiding it behind a row that was only ever true
  of the machine it was measured on. The `?` rows keep the honesty the rest of
  the suite has: an unmeasured platform fails loudly rather than passing on
  somebody else's numbers.

- **Cost and limits:** a WebKit run on macOS now fails the capability spec until
  somebody measures it, which is intended — that failure is the report. The diag
  branch cost one deliberate red run on its own branch and is deleted; nothing in
  `main`'s history records a wrong value.

- **Verified:** CI run `39239882157` reported `WebRTC yes / File System Access no
  / OPFS yes / Save sink opfs` on Linux, against `no / no / yes / opfs` on
  Windows; `npm run test:webkit` still passes 22 locally. This entry also
  corrects three places that had recorded the Linux build as having no WebRTC at
  all — `playwright.config.ts`, `docs/INTEROP.md`, `docs/TESTING.md` — and the
  entry above, which reported that first dispatch as a pass when it went red on
  this row.

## 2026-10-19 · jsdom gets a frame clock, so a pending effect cannot outlive a test

- **Problem:** the first gate run after the capability fix failed with
  `ReferenceError: window is not defined` from `src/ui/App.tsx`, thrown from a
  timer after a test file had already ended. All 356 tests passed; Vitest counts
  the unhandled error and exits 1, so the gate went red. The cause is
  `preact/hooks`: with no `requestAnimationFrame` it flushes effects on a
  one-second debounce, so on a runner quick enough to finish a component test in
  under a second the effect was still queued when jsdom was torn down under it.
  It passed everywhere slower — the worst possible failure shape, and the reason
  it survived until the first run on CI hardware.

- **Alternatives considered:**
  - Guard the effect with `typeof window === "undefined"`. Rejected: that hides a
    real unmount from the tests instead of fixing the timing, and it would ship
    in production code to satisfy a harness.
  - Add `unmount()` to every affected test. Rejected: the race is in which timer
    wins, not in what any one test does, and seven component files would each
    need the same new line.
  - Slow the runner or the tests. Rejected for the same reason as any other
    workaround: it makes the next real regression harder to see, not easier.

- **Choice:** give jsdom `pretendToBeVisual`, so `requestAnimationFrame` exists
  and preact flushes on a frame like a browser, and drain one frame at the end of
  every jsdom test in `vitest.setup.ts`. The frame clock is pinned by
  `tests/unit/test-env.test.ts`, which asserts the API exists and actually
  advances — the assertion is the thing that failed before, so it is the thing
  worth keeping.

- **Reason:** the tests were asserting against a browser model jsdom did not
  have, and the gap only showed up as an unhandled error with no test attached
  to it. Making the environment match what the code runs against is the fix that
  does not need a human to remember next time.

- **Cost and limits:** about 25 ms per jsdom test, paid by seven files. The drain
  is registered only where there is a window, so the node-environment unit and
  integration tests are untouched. It does not make unrelated timing bugs
  impossible; it makes this one impossible to miss.

- **Verified:** `npm run ci` green locally (358 unit/integration, 28 e2e) and the
  gate run on the runner that produced the failure passes. The watchdog
  (`t3-code` scheduled task) is updated to watch the full scheduled-run matrix,
  and the first automatic run (2026-10-19 03:17 UTC, `39227011502`) failed the
  WebKit leg — confirming the manual-dispatch observation was real.

## 2026-10-19 · Firefox cannot gather ICE in the runner; the app is not at fault

- **Problem:** `tests/e2e/pairing-transfer.spec.ts` passes 28/28 on Chromium
  (Linux) and 28/28 on Firefox (Windows, local), but on Firefox (Linux, hosted
  `ubuntu-latest`) the two specs that pair over a live network fail - `:112`
  "pairs two browsers, matches words, and exchanges a file and a note" and
  `:277` "the guest sees the connection drop when the host disappears" - with
  the app's own `ICE_GATHER_TIMEOUT` ("Couldn't find a network path. Check
  Wi-Fi."). The trace shows why: the app's peer connection goes
  `iceConnectionState: failed` immediately, **zero** `icecandidate` events, and
  `iceGatheringState: new` - the engine never started gathering. The offline
  spec (`:189`, DoD 6) passes, because it pairs with the network cut.

- **Choice:** record the gap rather than change the app or the spec. The
  product is not at fault - the *same* app code produces a correct offer
  wherever the engine cooperates (the app's own `PeerSession.createOffer()`
  succeeds against the same origin in the same run, and the same gather
  succeeds in a plain Node process on the same machine, in about thirty
  milliseconds). Nothing in the app is changed to make a harness behave.

- **Reason:** the earlier version of this entry blamed the app's three-second
  gather budget and the missing multicast, and both were wrong. The budget is
  not the constraint - the engine fails *before* gathering starts, so waiting
  longer cannot help, and a document that has failed once never recovers
  (measured: the same document, ten seconds later, still `state: new`). The
  multicast is not the constraint either: with
  `media.peerconnection.ice.obfuscate_host_addresses` off, the engine still
  fails, and the candidates it does gather elsewhere are plain addresses.
  Changing `GATHER_TIMEOUT_MS` to cover a runner quirk would have made every
  browser's honest fast-fail into a hidden delay, and injecting STUN or
  retries into the spec would have turned a real limitation into an invisible
  gap. Not knowing is acceptable; making it disappear by changing the
  measurement is not.

- **What was ruled out, by measurement:** the shipped CSP (`connect-src 'self'`
  - removing the header made one probe pass, and a policy matrix showed the
  difference was the interception, not the policy); the service worker (blocked,
  allowed and removed were all the same); the user agent (Playwright's desktop
  descriptors pin a Windows UA on a Linux runner, but removing it changed
  nothing); a user gesture; the app's own code; the context options (a bare
  `browser.newContext()` fails the same way); the launch options (a project
  with nothing but `defaultBrowserType` fails the same way); the environment
  (every variable the runner adds, removed one at a time); the page's load
  order; the precache; concurrency (four browsers at once all gather, in a
  plain process); and the network's own state (a cold browser and a warm one
  behave the same, in the runner). A blank page in the same browser gathers
  every time, and the same gather on the app's page in a plain Node process
  gathers every time.

- **Cost and limits:** the nightly's Firefox leg used to run the whole gate, and
  would have been red on the two pairing specs every single night. A leg that
  is always red proves nothing about the other twenty-five specs it also runs,
  and a watchdog that reports a known limitation every morning is a watchdog
  people stop reading - so the leg was narrowed rather than left broken. The
  coverage question is settled below.

- **The narrowing.** Firefox's project now excludes the pairing spec **on
  Linux** (on Windows it still runs, and passes there), so on the runner the
  Firefox collection is smaller than the README's figures - the same situation
  the WebKit leg is in, and for the same reason. That makes the Firefox leg a
  job of its own running `npm run test:firefox`, exactly like the WebKit leg:
  the gate's figures are the gate's, and the gate stays Chromium's on both Node
  lines. The gate's other stages do not depend on the engine, so nothing is
  lost by them running in the Chromium legs only. The exclusion is per project
  rather than a skip inside the file, because a skip hides the fact that this
  engine collects a smaller suite - and that difference is exactly what keeps
  the leg off the figure check.

- **Verified:** CI runs `39243475462` (widened matrix, all four legs),
  `39244996799` and `39265197964` (the same after the user agent was unpinned),
  and the focused dispatches, all showing the same two failures with the same
  `ICE_GATHER_TIMEOUT`; the trace artifacts show
  `iceConnectionState: failed` with no candidate events; `tests/e2e/degradation.spec.ts`
  still pins the missing-API path on all three engines with nothing stubbed;
  `tests/unit/ci-parity.test.ts` pins the new legs - the gate's is Chromium and
  checks the figures, the Firefox one runs `npm run test:firefox` and the
  WebKit one `npm run test:webkit`, neither of which is a gate stage;
  `tests/unit/e2e-browsers.test.ts` pins that Firefox excludes the pairing spec
  on Linux and only there; and on Windows `npm run test:firefox` still collects
  and passes all twenty-eight, pairing included.

- **Open risk for M8:** the Firefox pairing path on Linux has never completed
  an automated run. Whether the cause is the hosted runner's network, the
  Firefox build's ICE behaviour, or an interaction between the two is still
  unverified; the manual device matrix still needs a second physical device on
  a real network, and a real pairing with Firefox on a Linux desktop is the
  only verification that closes this.

## 2026-10-19 · `v1.0` stays where it is, and `v1.0.1` names the corrected state

- **Problem:** the `v1.0` tag points at `8b56413`, which is now thirteen
  commits behind `main`. Leaving it is not a statement that the release is
  broken - the app is byte-identical between the two, the only difference
  being one line of `package.json` - but the tagged tree does contain two
  claims that have since been shown false: that WebKit's Linux build has WebRTC
  disabled, and that the WebKit leg was dispatched by hand and passed. It also
  contains a CI arrangement whose nightly had never run green.

- **Choice:** leave `v1.0` exactly where it is, and tag the corrected state
  `v1.0.1`.

- **Reason:** a tag says what *was* released, and re-pointing it rewrites that
  for anyone who recorded the old one - and a tag that tracks `main` is a branch
  wearing a tag's clothes, stale again with the next commit. The `v1.0` release
  was real: the same app, the same behaviour, the same version in
  `package.json`. What it lacked was a name for "v1.0 with CI that actually
  runs and documentation that is true", and a second, additive tag gives that
  without rewriting anything. It is honestly a patch: no product behaviour
  changed between the two, only the CI shape and the record - and this log
  already refuses to relabel published history for the sake of tidiness, which
  is the same rule applied in the other direction.

- **Cost and limits:** two tags for one line of work, and a reader who wants
  "the release" now has to know which of the two they mean. The README's
  Status section names `v1.0.1` as the current one, and this entry says what
  the difference is, so neither has to be inferred. The alternative - moving
  `v1.0` - would have been one command and would have looked tidier while
  quietly changing what `v1.0` means for everyone who already fetched it.

- **Verified:** `git diff v1.0..main -- src/ public/ scripts/ package.json` is
  one added line; the two claims are corrected in the 2026-10-19 entry above
  and in the 2026-10-15 entry it supersedes; the nightly's legs are green as
  recorded in the entries above.

## 2026-10-19 · Two PRD 13.1 claims were documentation; now they are tests

- **Problem:** PRD §13.1 lists the unit suite, and `docs/TESTING.md` repeated
  that list as a description of what the suite covers - including "filename
  sanitizer (table-driven with hostile inputs)" and "backpressure controller
  (simulated `bufferedAmount`)". Neither had a test. The sanitizer had one
  assertion, in the sink spec, covering the path-separator case; the
  backpressure controller had none at all, so the one thing standing between a
  fast sender and a browser's memory was described in the docs and exercised
  nowhere. §13.3 asks for the camera scanner to be tested "with a fake video
  stream feeding a generated QR image": the pixels half was covered (a rendered
  QR is rasterised and decoded back with the real jsQR), but the stream half -
  the part only a camera reaches - was not.

- **Choice:** write the three missing tests rather than soften the claim. The
  filename table is hostile inputs with the expected answer beside each row;
  the backpressure controller is driven by a stub channel whose `bufferedAmount`
  the test moves, through both the event path and the poll fallback; the
  scanner is given a fake stream and a stub detector, and the assertions are
  about the wiring - the camera constraints, the code that comes back, the
  duplicate suppression, the clean release.

- **Reason:** a documented capability that no test exercises is a claim, and
  this project has already been bitten by exactly that twice today - the
  WebKit leg's "passed" line and the Linux build's WebRTC - both of which were
  written down and false. The cost of the table is that a change in the rules
  now shows up as a changed row, which is the point of writing it down.

- **Cost and limits:** the scanner's test drives a stub detector, so it proves
  the plumbing and not the vision; the real decode is covered separately by the
  uqr → jsQR round trip, and a real camera is still a manual row. The
  backpressure test asserts the PRD's thresholds rather than any engine's
  behaviour, so it would not notice an engine that fires the event late - the
  poll fallback is there for that, and it is tested.

- **Verified:** `npm run test` is 385 green (was 361); the three files are
  `tests/unit/filename.test.ts`, `tests/unit/backpressure.test.ts` and
  `tests/unit/scanner.test.ts`; `npm run ci` is green and the README's figures
  follow.

## 2026-10-19 · NFR-4's memory bound was stated and never measured

- **Problem:** NFR-4 says "streaming sinks keep heap under 150 MB regardless of
  file size", and M5's done-when asks for a 2 GB transfer on Chromium with the
  heap under 150 MB. Nothing measured the heap. The nearest thing was a 50 MB
  round trip labelled "NFR-2/NFR-3 smoke" - throughput and reliability, not
  memory - and the stock test channel keeps every frame it delivers in an
  inbox, so a heap measurement through it would have measured the harness
  rather than the app.

- **Choice:** measure the bound with a channel that keeps nothing and a sink
  that throws the bytes away, and check the structural claim beside it: every
  frame on the wire carries at most one chunk's payload, and the number of
  frames is the number of chunks the file has. The two sizes are compared -
  8 MB and 32 MB - because the requirement is "regardless of file size", and a
  single size could not show that.

- **Reason:** the app is genuinely streaming (the sender reads `blob.stream()`
  and cuts 16 KiB chunks; the hasher is incremental), so the bound holds and
  the test is there to keep it true - a regression to `await blob.arrayBuffer()`
  would show up as a heap that grows with the file, which is exactly the shape
  the second assertion rules out. Comparing the two sizes rather than one is
  what makes the test independent of the runner's own heap noise.

- **Cost and limits:** the measurement is of a Node process, not of a browser
  tab, so it is a proxy for NFR-4 rather than the thing itself; the real
  browser number still wants the 2 GB transfer on Chromium, which is a
  hardware row. The thresholds are generous on purpose (16 MB of slack between
  the two sizes) so the test fails on a real regression rather than on a
  runner's garbage collection.

- **Verified:** `tests/integration/memory.test.ts` - the frame count equals
  `ceil(size / CHUNK_SIZE)` and no frame exceeds `CHUNK_SIZE + 9` bytes; the
  heap for a 32 MB transfer stays under 150 MB and within 16 MB of the heap an
  8 MB transfer costs. `npm run test` is 393 green.

## 2026-10-19 · The legal deliverables were declared in package.json and never written

- **Problem:** PRD §15 asks for an MIT licence with third-party notices, terms,
  a privacy page that states exactly what it does not do, and the naming rule
  that keeps this project clear of Apple's. The privacy page and the naming
  rule were both already true. The other two were not there at all:
  `package.json` declared `"license": "MIT"` and there was no `LICENSE` file
  in the repository, no third-party notices, and no terms - so a release
  built from this tree would have declared a licence in its metadata and
  shipped none of its text, and would have shipped without terms.

- **Choice:** write the three missing documents, and a test that checks them,
  so the release cannot lose them again. The licence is the standard MIT text
  with the holder as "Dropbeam contributors" - the package already declared
  MIT, so the only decision was the file. The notices list the five libraries
  that reach the browser (preact, uqr, jsqr, hash-wasm, fflate) with their
  licences, read from the installed packages rather than written by hand, and
  point at the Apache-2.0 text for `jsqr`. The terms say what §15 says they
  must: the tool is provided as-is, the user is responsible for what they
  send, and there is a prohibited-use notice.

- **Reason:** a document that is missing cannot be read, and a licence
  declared in a package manifest is not a licence. The test is the part that
  matters: it reads the licences from `node_modules`, so a dependency that
  changes licence - or a new one that reaches the bundle - fails the suite
  rather than being forgotten here, and it checks the naming rule against
  everything that ships rather than against the documentation.

- **Cost and limits:** the terms and the copyright holder are legal text, and
  PRD §20 asks for approval of legal text; both are written from §15's own
  wording and are offered here for that review rather than treated as settled.
  The notices cover the shipped dependencies; the development tools are not
  shipped and are named in `package.json` instead.

- **Verified:** `tests/unit/legal.test.ts` - the licence file exists and
  matches `package.json`'s declaration, every shipped dependency has a row
  with its real licence, the privacy page states all four things §15 lists,
  the terms cover the three, and nothing under `src/` or in `index.html` names
  another product. `npm run test` is 399 green.

## 2026-10-19 · The size figure was the uncompressed size wearing the gzip label

- **Problem:** the README published "137.0 KB gz of a 153.6 KB budget", and the
  budget was PRD NFR-1's - "initial JS must stay under 150 KB gzipped". The
  script behind it never measured a gzip size at all: `dist/` holds
  uncompressed assets, so its `gunzipSync` call always threw and fell back to
  the raw file size, and the result was printed with a "B gz" label. The
  published number was therefore three times the truth - the bundle a browser
  downloads is about 45 KB - and the gate was holding a budget on the wrong
  quantity while describing it as the right one.

- **Choice:** measure both, and publish both. The gzip size is computed here
  (the assets are compressed on the way out by the static host, so the script
  compresses them the same way) and is the figure NFR-1 is about, so it is the
  one the README leads with. The uncompressed size keeps its own budget - the
  line this project has been holding all along - and is published next to it,
  because quoting only the compressed number would read as three times the
  headroom there is.

- **Reason:** a number that describes the wrong quantity is worse than a big
  number, because it looks measured. Publishing both says the truth about the
  download *and* keeps the stricter limit visible, and the gate does not get
  looser: both budgets have to pass.

- **Cost and limits:** the README's figure changes, and the earlier entries in
  this log that quote "KB gz" figures were quoting the uncompressed size under
  that label. They are left as they are - rewriting them would rewrite the
  record rather than correct it - and this entry says what the old figures
  were.

- **Verified:** `npm run size` prints `initial JS total: 45091 B gz (budget
  153600 B)` and `initial JS uncompressed: 140491 B (budget 153600 B)`; the
  README's figure is rewritten by the gate, and `gate-figures.test.ts` pins
  both numbers in the summary and in the log line.

## 2026-10-19 · The transfer row's own comment claimed a speed and an ETA it did not show

- **Problem:** PRD §10.1 screen 6 asks for transfer rows with "icon, name,
  size, progress bar, **speed, ETA** and cancel", and `ProgressRow`'s doc
  comment repeated that list - but the component rendered the name, the size,
  the bar, a percentage and the cancel button, and nothing else. It also
  carried its phase labels ("Queued", "Waiting for approval", ...) as English
  literals inside the component, so a Hindi user saw English in the middle of
  the transfer list - the one place in the app where a phase matters most.

- **Choice:** show the speed and the ETA, and translate the phases. The rate is
  measured in the row rather than carried in the session's progress report,
  because a rate is only meaningful over an interval and the row is what sees
  every sample; it is smoothed, so one slow tick cannot reset the number and
  one fast tick cannot spike it. The phase labels moved into both catalogs.

- **Reason:** the component's comment is a claim about the component, and it
  was false in the same way the size figure was - a list of things the file
  said it did, which it did not do. And an untranslated label in the transfer
  list is the defect DoD 12's "both languages" is about, in the place where
  the user is watching bytes move.

- **Cost and limits:** the per-file icon §10.1 also lists is still not there -
  the row leads with the file's name, and adding artwork per file type is a
  design decision rather than a missing line, so it is recorded as open rather
  than quietly dropped from the list. The speed and the ETA are estimates from
  the samples seen so far: a transfer that has not moved yet shows neither.

- **Verified:** `tests/unit/ui.test.tsx` covers the Hindi phase label, the
  speed and the ETA appearing once there is a rate, and their absence when
  the transfer is not running; the two catalogs stay in parity. `npm run test`
  is 408 green.

## 2026-10-19 · Three transfer-screen requirements were listed and not built

- **Problem:** PRD §10.1 screen 6 asks for transfer rows with "icon, name,
  size, progress bar, speed, ETA and cancel", plus "totals"; FR-15 asks for
  progress "per file and total" with a "rolling 2 s average" speed; FR-20 asks
  for "Save, **Open** (images/PDF/video preview where cheap), Copy path (n/a)
  and 'Send back'" after completion; FR-19 asks for a warning that locking the
  screen may pause the transfer. What the app had: the rows, without a total,
  without a speed or an ETA, a saved row that only named the file, and no
  warning. `SaveResult.url` existed and was never used.

- **Choice:** build the three that can be built honestly. A **totals** line
  over the files that are moving, with the same parts as a row. A **speed and
  ETA** measured as FR-15 words it - a rolling two-second average, kept in a
  small `RateMeter` shared by the rows and the totals. An **Open** action on a
  saved file, offered only when the sink kept the bytes and therefore has a URL
  to open; a file that streamed to disk has nothing to open, and offering a
  broken action would be worse than not offering one. And the **screen-lock
  warning**, in the transfer screen rather than the settings sheet, because that
  is where the transfer is.

- **Reason:** the PRD's list is a contract, and three of its items were simply
  absent while the screen looked finished. "Send back" is the one that is not
  built, and the reason is the privacy model: the app does not keep a received
  file's bytes, so sending it back would mean reading them back out of the
  sink, which only the OPFS sink can do. That is a design decision rather than
  a missing line, so it is recorded here rather than quietly dropped.

- **Cost and limits:** the per-file icon §10.1 lists is still not there - the
  row leads with the file's name, and per-type artwork is a design decision
  rather than a missing line, so it is open for the same reason. The speed and
  the ETA are estimates from the samples seen so far: a transfer that has not
  moved yet shows neither, and the ETA is as good as the rate behind it.

- **Verified:** `tests/unit/transfer-ui.test.tsx` covers the totals (750 of
  2000 bytes, 38%), the Open action appearing only for a sink with a URL, and
  the warning appearing only while something is moving;
  `tests/unit/ui.test.tsx` covers the rolling rate and the phase labels.
  `npm run test` is 412 green.

## 2026-10-19 · The per-file icon and "Send back" are built, not deferred

- **Problem:** the two PRD items left open by the previous entry were both
  recorded as design decisions rather than missing lines. They were not
  missing lines after all: the icon is a drawing, and "Send back" turns out to
  be possible for every sink, because every sink can still read its own output.

- **Choice:** build both. The **icon** is a small inline SVG per file kind -
  image, video, audio, document, archive, code, file - chosen from the media
  type and falling back to the extension, drawn flat and stroked in
  `currentColor` like the rest of the app's artwork, and hidden from assistive
  technology because the file's name sits right beside it. To choose the icon
  at all, a file's media type now travels with its progress record.
  **"Send back"** reads the file back from where the sink put it and sends
  that: the app still never holds a received file's bytes, so each sink now
  offers a `read()` on its result, and the action is offered whenever one
  exists.

- **Reason:** the reason "Send back" was thought impossible was that the app
  does not keep received bytes - but the bytes were never the app's to keep:
  they were in the sink, and all three sinks (memory, OPFS and File System
  Access) can still reach what they wrote. The privacy model is unchanged, and
  the action turned out to be cheaper than the decision to defer it.

- **Cost and limits:** a file whose sink cannot be read back does not offer
  the action, rather than offering one that fails - which today means none of
  them, but the shape is the honest one. The icon is one glyph per *kind*, not
  per format: a `.heic` is an image, a `.docx` is a document. A "Send back" of
  a very large file re-reads it from the sink, which is a copy the user may
  not expect; the button says what it does, and the read is streaming.

- **Verified:** `tests/unit/file-icon.test.tsx` covers the kind mapping, the
  extension fallback, the icon being decorative and stroked, and "Send back"
  reading the file back and sending it - and not being offered when the sink
  cannot read it. The release audit and the pairing spec now ask for the
  note's Send button *exactly*, because a role name matches a substring and
  "Send back" contains "Send". `npm run test` is 418 green.

---

## 2026-10-20 · The dev page's policy was in force twice, and the stricter one won

- **Problem:** `npm run dev` — the command the README's quick start gives —
  rendered the app with no CSS at all: the body fell back to Times New Roman
  and the page showed up as raw HTML. The console said why, three times per
  load: "Applying inline style violates the following Content Security Policy
  directive 'style-src 'self''".

- **Choice:** the dev plugin now *replaces* the policy in the page it serves
  rather than adding a second one beside it. `index.html` still ships the
  PRD policy verbatim and the production build output is unchanged; the
  served HTML in dev carries exactly one policy, the relaxed one.

- **Reason:** a document may carry several policies, but a resource then has
  to satisfy all of them — the effective restriction is their intersection,
  so the stricter policy wins. Prepending a looser dev policy to the strict
  shipped one therefore left the strict one in charge, and Vite's injected
  `<style>` elements are exactly what `style-src 'self'` blocks. The
  relaxation had been in the codebase since M4 and had never been exercised,
  because every check in the gate runs against the production build, where
  the policy is one policy and the stylesheet is a real file.

- **Verified:** `tests/unit/csp.test.ts` now runs the dev transform over the
  real `index.html` and holds it to one policy, the relaxed one, with nothing
  else relaxed. In a browser, the dev page loads three stylesheets, uses the
  app's own faces, and logs no console error.

## 2026-10-20 · Four defects a browser found and the tests did not

- **Problem:** driving the app in a real browser, end to end, turned up four
  things the suite was green about.

  - A file offered in the *second* batch lost its name and size on the
    sender's side: the row said `file-3` and `0 B`. The session pre-tracked
    outbound files at `parity + 1 + index * 2` — the batch's own index —
    while the sender allocates fids from a counter that keeps counting across
    batches. The two agreed for the first batch and drifted after it, and
    the row was created from the fallback path that has no name to give.
  - The speed read `2.6 MB/s/s`: `formatRate()` already carries the unit and
    the sentence carried it a second time.
  - All three modal dialogs answered `aria-labelledby` with the first heading
    in the document, so the host's approval prompt was announced as "Scan
    reply" — the title of the prompt rendered before it. They shared one
    `id="prompt-title"`.
  - The transfer rows were centred in the list rather than running edge to
    edge: a generic `.row` rule set `align-items: center` and the later rule
    that turned the row into a column did not reset it, so `.row-head` shrank
    to its content and its `space-between` had nothing to spread.

- **Choice:** the sender is now the only place that allocates fids, and it
  announces them as it allocates them (`onAllocated`), so a row is created
  with the file's real name and size. The duplicated allocator is gone. The
  speed sentence no longer carries a unit of its own. Each prompt's heading
  has its own id, from `useId()`. The transfer row stretches its children, so
  the name and the size sit at the two edges.

- **Reason:** each of these was a place where two pieces of the code believed
  the same fact — the fid, the unit, the heading, the alignment — and only
  one of them was right. The fix in every case is to have one owner.

- **Verified:** `tests/integration/transfer-session.test.ts` sends two batches
  and asserts every row carries a name the user picked; `tests/unit/ui.test.tsx`
  asserts the speed carries one unit and that two prompts have different
  ids, each naming its own heading; `tests/e2e/pairing-transfer.spec.ts`
  measures the rendered geometry of a real row. In a browser, the second
  batch's row reads `second.bin` and `1.0 MB`, the totals line reads
  `3.0 MB/s`, the approval dialog is announced as "Allow connection from This
  device?", and the file's size sits flush with the right edge of the list.

- **Cost and limits:** the `onAllocated` callback is the sender telling the
  session what it is about to hear about, so the session no longer derives
  fids — the two cannot drift, because there is only one. The speed's unit is
  still Latin-script in both languages, as the sizes have always been; the
  unit belongs to the value, not to the sentence, which is what the ETA has
  always done.

---

## 2026-10-20 · The site publishes what an agent asks for, and nothing it cannot back

- **Problem:** the static host answers *every* path with the app's
  `index.html`, so a crawler asking for `/llms.txt` or for
  `/.well-known/ai-catalog.json` was handed a page of markup. Lighthouse read
  that as a broken agent-discovery setup, and the agentic-browsing category
  scored 50 - the one Lighthouse number this project did not have.

- **Choice:** publish both files, and let the catalogue be empty.
  `public/llms.txt` describes the app in the shape the format asks for - one
  H1, a short summary, and links to the documentation that exists.
  `public/.well-known/ai-catalog.json` is a valid manifest that names the
  publisher and lists no entries.

- **Reason:** the empty catalogue is the honest one. The app has no
  server-side API for an agent to call, and a manifest full of invented URLs
  would be a false claim rather than a discovery aid. Publishing the files
  fixes what was actually wrong - the two answers now mean something - without
  claiming anything untrue about what the app offers.

- **Cost and limits:** both files are precached by the worker, because the
  precache is the whole emitted tree; a crawl of the site is still a crawl of
  an app that has no pages to read. The category measures how legible a site
  is to an agent, and this one is legible in the only way it can be: a short
  description and a link to the documentation.

- **Verified:** `tests/unit/agent-discovery.test.ts` holds the shape of both
  files, checks that every link in `llms.txt` points at a document that is
  actually in the repository, and asserts the catalogue's emptiness on
  purpose, so a future entry has to satisfy the spec to be added. The
  release audit now reports 100 for agentic-browsing, alongside 99 / 100 /
  100 / 100 for the other four categories.

---

## 2026-10-20 · One PRD, and the brief it came from kept where it can be found

- **Problem:** the repository carried two files with the same title, the same
  version line and almost the same 800 lines: `PRD-Dropbeam-FINAL.md` at the
  root and `docs/PRD.md`. Both were added in the M0 commit, and from there
  only one of them moved: `docs/PRD.md` took the resumable transfers, the
  per-chunk repair, the recoverable-drop grace and the memory-sink correction,
  while the root copy was never touched again. Nothing said which was which,
  so a reader opening the one at the root had no way to know it was a frozen
  snapshot - and the project's own authority for the CSP policy, the test that
  reads it, and the README's link all point at the other one.

- **Choice:** the root copy moves to `docs/PRD-original-brief.md` and says, in
  its first line, what it is: the brief as it was handed to the build, frozen
  on 2026-10-03, with the living PRD named and the rule stated - where they
  differ, `docs/PRD.md` counts. The living PRD now says the same about
  itself, and the README's documentation list carries both, so the front
  door names the pair.

- **Reason:** the project keeps records rather than deleting them, and the
  brief is a real record - it is the input the whole build answered to, and
  section 20 of the living PRD quotes it. What it should not be is a second
  candidate for the authority, sitting where the reader looks first. A
  document that cannot be maintained should say so at the top, in the same
  words, for both copies.

- **Also:** the formatters stopped being re-exported from the component that
  happened to use them. `src/ui/format.ts` has been their home since they
  moved there, but `ProgressRow.tsx` still re-exported all three and the
  unit test still imported one of them from the component. The re-export is
  gone and the test imports from where the formatters live.

- **Verified:** the tree is the same otherwise - no broken relative link in
  any tracked markdown, no source file nothing else mentions, and nothing
  untracked outside the ignored build and tool directories. The gate is
  green, and the CSP test still reads the policy out of `docs/PRD.md`.
