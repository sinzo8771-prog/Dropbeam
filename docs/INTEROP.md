# Interop matrix

Codec used per browser pair, plus notes. `DB1` = minimal descriptor (PRD
8.2.1), `DB0` = full-SDP fallback.

## Automated (CI / local)

| Pair                                                                                              | Route                                                       | Codec | Result                                                           | Date       |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----- | ---------------------------------------------------------------- | ---------- |
| Real DB1 pipeline ↔ same pipeline                                                                 | same process, WebRTC transport faked                        | DB1   | pass (`npm run ci`)                                              | 2026-10-10 |
| Chromium ↔ Chromium (same tab)                                                                    | loopback transport, in-app self-test                        | —     | pass (FR-62)                                                     | 2026-10-10 |
| Chromium ↔ Chromium (two browser contexts)                                                        | real WebRTC over loopback, DB1 codes exchanged as text/link | DB1   | pass (`tests/e2e/pairing-transfer.spec.ts`)                      | 2026-10-10 |
| Chromium ↔ Chromium (peer disconnect)                                                             | same pair, host device removed                              | —     | guest reaches `PEER_LOST` with no console errors                 | 2026-10-10 |
| Chromium ↔ Chromium (OPFS save path)                                                              | guest without File System Access                            | —     | file staged and saved (PRD 8.5 Firefox/Safari sink)              | 2026-10-10 |
| Firefox ↔ Firefox (two browser contexts)                                                          | the nightly's second engine, same suite                     | DB1   | pass (19/19 on Windows; the nightly runs it on Linux)            | 2026-10-15 |
| WebKit, whole suite minus the pairing and offline specs                                           | `npm run test:webkit`, scheduled and dispatched leg          | —     | 22/22 on Windows and on Linux, real capability rows per platform  | 2026-10-19 |
| Chromium ↔ Firefox (two engines)                                                                  | real WebRTC, DB1 code pasted                                | DB1   | pass (`scripts/interop-matrix.mjs`)                              | 2026-10-10 |
| Firefox ↔ Chromium (two engines)                                                                  | real WebRTC, DB1 code pasted                                | DB1   | pass (`scripts/interop-matrix.mjs`)                              | 2026-10-10 |
| Chromium settings sheet (theme, hi, reduce motion, wake lock, STUN, persistence, Devanagari face) | —                                                           | —     | pass (`tests/e2e/settings.spec.ts`)                              | 2026-10-10 |
| Production build, home screen                                                                     | Lighthouse, mobile profile, STUN off                        | —     | perf 99, a11y 100, bp 100, seo 100 (`scripts/audit-release.mjs`) | 2026-10-13 |
| Production build, two browser contexts                                                            | network audit of a full pairing + file + note transfer      | DB1   | 14 requests, 0 off-origin (DoD 5)                                | 2026-10-13 |
| Production build, network cut                                                                     | app boots from cache; both devices still exchange codes     | DB1   | pass (`tests/e2e/offline.spec.ts`, DoD 6)                        | 2026-10-18 |

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

The Firefox row is the same suite on the second engine
(`E2E_BROWSERS=firefox`), which the nightly runs on Linux beside Chromium.
Two things had to move for it, and neither is a change to the app: the
clipboard is seeded differently, because Playwright answers `Unknown
permission: clipboard-read` on Firefox (`playwright.config.ts` and the spec
say so where it happens), and the peer-drop assertion waits 45 s instead of
the app's exact 30 s worst case, because Firefox reports only `disconnected`
for longer than Chromium and the doubled deadline landed outside the old
window.

The last two rows are the release audit (`node scripts/audit-release.mjs`,
against `vite preview`). The Lighthouse row is DoD 8: the mobile profile at
412x823 scores performance 99 (gate ≥ 90) and accessibility 100 (gate ≥ 95),
with best-practices and seo at 100. Lighthouse 13 no longer carries a PWA
category, so installability is not scored there anymore — `npm run
pwa:health` owns that half of the gate (manifest, service worker, icons,
shortcuts). The network row is DoD 5: two contexts pair, exchange a file
and a note, and every one of the 14 requests is same-origin static
(file://, script, stylesheet, font) with STUN off — nothing leaves the
device. Both gates pass.

The offline row is DoD 6, and it is **Chromium and Firefox only**. Playwright's
WebKit build cannot navigate with the network emulated down — the service
worker works there, but every offline reload fails with an internal error — so
the offline spec is excluded from that project and DoD 6 has no automated
coverage on the engine closest to Safari. That is why the real-Safari and
hotspot rows below are load-bearing rather than a formality.

What the row does show: with the network cut the app still boots out of the
service worker's cache, a deep `?screen=` route still resolves, the settings
sheet still opens, and — from two separate offline contexts — an offer and a
reply are still produced and exchanged through the shared-link route with no
console errors. It stops before the data channel, and that limit is the
emulator's rather than the app's: Playwright's `setOffline` cuts the whole
network stack, WebRTC included, so an offline pair reaches `WAITING_FOR_REPLY`
and then `FAILED` — the emulated network refusing ICE. DoD 6's case is the
opposite one, where the internet is gone and the _local link to the peer is
not_, which needs a second network the peer can still reach. That is why the
hotspot row below still needs two real devices.

Building that row found two real defects, both in the worker and both invisible
to any test that only asked "does the app boot": the precache held the shell
alone, so a device that had never opened Settings could not open Settings
offline (the settings sheet is a code-split chunk), and every cache lookup
honoured `Vary`, so `Vary: Origin` from a static server stopped a precached
chunk from matching itself. Both are fixed and covered — see
`docs/DECISIONS.md` for the reasoning and the alternatives rejected.

`unused-javascript` is the one audit scoring below 0.9 and is expected:
the home screen never runs the transfer pipeline, so most of the 135 KB
initial bundle is unused _on that route_. Splitting it further would move
latency onto the transfer path to win a number the gates do not measure.
`llms-txt` and `ai-catalog.json` belong to Lighthouse's agentic-browsing
category (50), which is about AI crawlers discovering the site and is not
a DoD requirement for a page that only talks to its paired peer.

The WebKit rows of the manual matrix **cannot be paired here**: Playwright's
WebKit build for Windows ships without `RTCPeerConnection` outright, and nothing
in this repository has ever put the Linux build's through a real peer connection.
That is why the pairing spec is excluded from WebKit's project
(`playwright.config.ts`) rather than skipped inside the spec, and why a WebKit leg
would fail the gate's own figure check: it collects a smaller suite than
`README.md` describes. So it runs off the gate, as `npm run test:webkit` on a
scheduled or dispatched job, and `scripts/gate-figures.mjs` refuses
`E2E_BROWSERS=webkit` by name.

> **The two WebKit builds are not the same browser, and the first thing that
> proves it is WebRTC.** Measured through the debug panel, on the Windows build
> and on the Linux runner:
>
> | row | Windows | Linux |
> |---|---|---|
> | WebRTC | `no` | `yes` |
> | File System Access | `no` | `no` |
> | OPFS | `yes` | `yes` |
> | Save sink | `opfs` | `opfs` |
>
> So the earlier claim that WebKit cannot pair on either platform was half
> right: the API is simply absent on one of them. Everything else the two builds
> report today is identical, and that is a measurement, not a promise — which is
> why the capability table in `tests/e2e/debug-panel.spec.ts` is keyed by
> platform for WebKit rather than by engine, and why the Windows row cannot
> stand for the Linux one.
>
> The Linux column is from the CI WebKit leg (run `39239882157`, 2026-10-19), read
> out of a run whose expected values were deliberately wrong so that every row
> reported its real value in one pass. Nothing here is inferred from the Windows
> column.

Everything else in the suite **does** run on WebKit, and it is the only engine
where the degradation path is exercised for real: the API is removed the same way
on every engine (`tests/e2e/degradation.spec.ts`), so the unsupported-browser
messaging, the self-test's `unsupported` stage, the settings sheet and the debug
panel all meet the absence the app has to survive. On Chromium and Firefox the
same spec runs too, so the pull-request legs cover the behaviour without WebKit.
That arrangement produced three findings worth recording:

- **The sink WebKit resolves to is OPFS.** No `showSaveFilePicker`, but
  `navigator.storage.getDirectory` is there, so `chooseSink()` (PRD 8.5) picks
  the Safari path. `tests/e2e/degradation.spec.ts` pins that detection input on
  every engine.
- **The OPFS write itself fails on this build.** `createWritable()` throws
  `UnknownError` on Playwright's WebKit while Firefox and Chromium both complete
  the round trip. So the save path is _not_ verified on WebKit, and no test claims
  it is — asserting a browser's own bug would turn a future WebKit fix into a red
  build. Real Safari 18+ is expected to write; that half still needs hardware.
- **The detection is shallower than the capability — and that no longer costs
  the file.** `isOpfsSupported()` checks only that `getDirectory` exists, so on a
  build like this one the app still _selects_ the OPFS sink before discovering
  that nothing can be written through it. The receiver now treats a refusal
  before a byte has landed — the sink cannot be built, or cannot be opened — as a
  reason to fall back to memory for that one file, so a device with an
  unwritable namespace gets it as a download instead of
  a failure, and the reason reported is the sink's own (`toErrorCode` honours
  `SinkError` codes instead of re-deriving one from the DOM exception).
  `tests/integration/transfer.test.ts` drives the real `OpfsSink` against the
  exact `UnknownError` measured here. The detection itself is deliberately left
  alone: there is no evidence that real Safari shares the limitation, and probing
  on every selection would cost a file creation for a case the fallback already
  absorbs.

> **Firefox on the hosted Linux runner cannot pair at all, and it is the engine
> rather than the app.** The two pairing specs fail there while passing on
> Chromium (Linux) and on Firefox (Windows, local): the app's peer connection
> goes `iceConnectionState: failed` the moment the offer is set, with no
> `icecandidate` event at all and `iceGatheringState` still `new` - the engine
> never starts gathering, so the app reports `ICE_GATHER_TIMEOUT` and shows
> "Couldn't find a network path. Check Wi-Fi." for a network that is fine.
>
> The same gather, in the same run and on the same machine, succeeds in a plain
> Node process (about thirty milliseconds) and on a blank page in the same
> browser; the app's own `PeerSession.createOffer()` succeeds against the same
> origin. Waiting does not help - a document whose first attempt failed never
> recovers - and neither does turning off candidate obfuscation, blocking or
> removing the service worker, removing the user agent, warming the browser, or
> loading the page a second time. The offline pairing spec passes, because it
> pairs with the network cut.
>
> So the pairing path in Firefox is **not** covered on the hosted runner, and a
> user whose first page in a freshly started Firefox is this app may see the
> same failure. Whether that is the runner's network or the Firefox build is
> still unknown; it is recorded in `docs/DECISIONS.md` with everything that was
> ruled out. The manual matrix below still has a Firefox row, and a real
> pairing on a Linux desktop is the only verification that closes this.

  Both halves are now visible on the device itself: the debug panel (FR-50)
  reports reachability and writability as separate rows next to the sink
  `chooseSink()` would take, so a field report from a real phone can show a
  browser staging onto a path it cannot write. Measured through the panel on the
  Windows build: `OPFS yes / OPFS write fails / Save sink opfs`, with no page
  errors. The Linux runner is not covered by that measurement — the spec only
  pins that the row answered, not how — so the two builds are recorded apart
  rather than merged.

One earlier finding from this same gap is already fixed and covered by a unit
test: the app used to answer "Join" in a browser without WebRTC with a
_network_ failure instead of "This browser can't do direct transfers". Both entry
points now run the support check, and the degradation spec guards the same
regression through the real UI.

> **Manual matrix status (2026-10-18): partially covered, and the gap is now
> smaller.** The browser pairs that do not need a phone are done above (Chromium
> ↔ Chromium and Chromium ↔ Firefox, real engines, real WebRTC), and DoD 6's
> offline claim is now automated as far as this emulator allows (above). What
> remains needs physical devices on real networks: the camera QR route, Wi-Fi /
> hotspot / guest-network behaviour, real Safari, and mobile power/screen
> review — the last gate before `v1.0` (PRD M8). **DoD 1 (500 MB QR-only Chrome
> ↔ Android), DoD 2 (50 MB QR + link Chrome ↔ iPhone) and DoD 6's data-channel
> half all live in those rows.** Nothing below can be filled in from a desk.
> Record each cell as it is tested.

## Manual (fill during M8)

Every row below needs two physical devices on a real network, so none of it can
be done from a desk. Each row says what to do and what to write down, so filling
them in is mechanical rather than a judgement call.

**For every row**, open the debug panel first (eight taps inside the right edge,
within 700 ms of each other — FR-50) and note the WebRTC, OPFS and Save sink
rows. Those are the capabilities the run is actually exercising, and a failure
with `OPFS yes / OPFS write fails` in the log is a browser bug rather than
anything this app can fix.

| Pair                             | Network                           | Route     | Codec | Result                | Notes                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------- | --------- | ----- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Chrome ↔ Android Chrome  | same Wi-Fi                        | QR        |       |                       | DoD 1: 500 MB video, QR only, matching words                                                                                                                                                                                                 |
| Windows Chrome ↔ iPhone Safari   | same Wi-Fi                        | QR + link |       |                       | DoD 2: 50 MB, then a file past the memory limit                                                                                                                                                                                              |
| Chrome ↔ Firefox                 | same Wi-Fi                        | paste     | DB1   | **engine row done**   | loopback pair pass above; still run over real Wi-Fi                                                                                                                                                                                          |
| Chrome ↔ Safari (macOS)          | same Wi-Fi                        | paste     |       |                       | Playwright's WebKit is not Safari and its builds disagree about WebRTC, so this row needs real hardware and a real Mac |
| Android Chrome ↔ Android Samsung | same hotspot                      | QR        |       |                       | no internet on the hotspot if you can arrange it                                                                                                                                                                                             |
| Any ↔ any                        | guest Wi-Fi with client isolation | —         |       | **app half verified** | handshake completes, then both sides fail in 20 s with `CONNECT_TIMEOUT` and the hotspot remedy (`tests/integration/session-pairing.test.ts`, PRD 553). Still needs a real isolated guest network to confirm the router produces this shape. |

Write the date, both browser versions, and what happened — including the reason
code if one is shown, since those are the ones worth chasing back into the tests.
A row that failed for a reason this app cannot fix (an OPFS write that throws,
a build with no `RTCPeerConnection`) is still a result; record it as one.

## Known limits

- Safari/iOS: large files limited by memory unless OPFS is available (see PRD 8.5).
- mDNS-only candidates: if `.local` names do not resolve on the network, use the
  hotspot trick or enable "Across networks" (STUN). The toggle lives in the
  settings sheet (gear icon on the home screen, FR-41).
