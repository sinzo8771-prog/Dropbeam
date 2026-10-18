# Testing

Commands:

| Command                      | What it runs                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `npm run typecheck`          | `tsc --noEmit` (strict)                                                        |
| `npm run lint`               | ESLint flat config                                                             |
| `npm test`                   | Vitest: `tests/unit` + `tests/integration`                                     |
| `npm run test:e2e`           | Playwright against the production build (Chromium; `E2E_BROWSERS=firefox`)     |
| `npm run test:webkit`        | The WebKit leg: every spec but pairing, run on WebKit                          |
| `npm run ci`                 | The gate: every stage in `package.json`'s `gate` list, then the README figures |
| `npm run audit:release`      | Lighthouse mobile + same-origin network audit (starts its own preview)         |
| `npm run docs:figures`       | The gate, forcing the README figures to be written rather than checked         |
| `npm run docs:figures:check` | The gate, forcing the README figures to be checked rather than written         |

## Unit (`tests/unit`)

Codecs (round trip, size budget, invalid input), SDP template, compact candidate
parsing, multi-frame QR assemble/shuffle/duplicates, pairing-link build/parse
(including the in-tab `hashchange` route), single-QR budget vs multi-frame
fallback, QR pixel round trip (uqr → jsQR), filename sanitizer (table-driven
with hostile inputs), protocol encode/decode, backpressure controller
(simulated `bufferedAmount`), state machine transitions and timeouts,
verification phrase determinism, settings store allowlist and hostile payloads
(FR-40), the settings sheet UI (FR-41), wake-lock acquire/release/support
detection, the code-expiry countdown, the font contract (subset per family,
family names the stacks actually declare), PWA manifest/service worker, and
the contrast gate computed from the shipped tokens (PRD 13.1).

`pwa.test.ts` also pins the worker's offline contract, which is DoD 6 rather
than DoD 8: that `public/sw.js` carries the `__PRECACHE__` marker
`scripts/postbuild.mjs` rewrites (a build where that marker has gone missing
must fail rather than ship a shell-only precache behind a green run), that the
install adds the rest of the precache one entry at a time so one 404 cannot cost
the app every offline asset, and that no bare `caches.match(` survives in the
worker — every lookup goes through the `ignoreVary` helper, because `Vary:
Origin` from a static server otherwise stops a precached chunk from matching
itself. Both of those were real bugs; see `docs/DECISIONS.md`.

Three suites guard the build rather than a module. `ci-parity.test.ts` fails if
`.github/workflows/ci.yml` starts enumerating the gate's stages again — it did
once, and CI quietly stopped running `pwa:health` — if the `gate` list in
`package.json` names a script that does not exist, or one that would run the
gate again, or if the gate and the doc-figure commands drift onto different
runners. It rejects the `run: |` block scalar that its line-based reader could
not see, so the parity checks cannot pass vacuously. `gate-figures.test.ts`
covers the README figures described below. `design-gates.test.ts` covers DoD
11's copy clause and the stylesheet half of its gradient rule: the banned-word
list is read out of `PRODUCT.md` rather than restated, so editing that sentence
changes the gate instead of leaving it testing a stale list, and the scan
covers both i18n catalogues and every shipped component, because a word typed
into a translation is as much part of the product as one typed into a component.
`e2e-browsers.test.ts` covers which
engines the e2e stage drives: that the default stays Chromium alone, because the
published figures come from a default run; that `npm run test:webkit` resolves to
WebKit on any platform rather than silently running Chromium; that WebKit's
project excludes exactly the one spec its build cannot run and no other, checked
against the specs actually on disk; and that a misspelled engine stops the run
instead of testing less than it was asked to.

Two suites guard the storage layer rather than a module. `sinks.test.ts` covers
each sink's optional per-chunk repair methods (FR-17) — reading staged bytes
back at an offset, rewriting a chunk in place with its neighbours intact, and
refusing both once OPFS has aborted and dropped its handle — because repair was
otherwise only ever driven through a `MemorySink`, leaving the two disk paths
every desktop and Firefox user takes unverified. It also covers the OPFS write
probe the panel reports (`probeOpfsWrite`): that it answers false rather than
throwing on every failure mode — no namespace, an unopenable directory, a
namespace that cannot write — that it cleans its scratch file up even when the
write fails, and that reachability and writability are separate answers, and
that a sink's own reason code survives `toErrorCode` — the function that puts it
on the wire. `source-hygiene.test.ts` fails
the suite if any tracked text file carries a control character: a NUL makes git
treat the file as binary, and a binary file gets no diff for a reviewer to read.
Which files are text is decided by extension, not by asking git, since a file
already carrying the byte would be reported binary and quietly skipped.

## Integration (`tests/integration`)

Two `RTCPeerConnection`s in one page (loopback) transferring: 0-byte file,
1 byte, 16 KiB A→1, 5 MB; cancel mid-way; decline; hash mismatch injection;
peer drop. The pairing integration drives two `SessionController`s with real
DB1 codes and covers expiry, cleanup and the snapshot's `codeExpiresAt`
(PRD 13.2). The resume integration (`resume.test.ts`) drops a transfer after
two chunks — a channel that stops forwarding mid-file, control frames
included — re-pairs, and proves the receiver's parked offset continues with
exactly the missing chunk re-crossing the wire and the file verifying
byte-identical; it also pins that memory sinks start over (with a fresh
prompt), that a clean transfer leaves nothing parked, and that `chunks` past
the end of a file are rejected on the wire (PRD 9.4). The per-chunk repair
suite in `transfer.test.ts` corrupts chunks in flight and covers: one bad
chunk repaired with the file saved byte-identical and exactly one `repair`
request sent; every chunk corrupted in the same pass (only the re-sent
chunks arrive clean, or the handshake cannot succeed); the re-sent chunks
still corrupt, which is terminal after the single re-verify; and a sink
that cannot read its staged bytes back, never even asking for a plan. A sink
that refuses the file is covered in the same file: the receiver replaces it with
memory for that one file (driven once with a double, once through the real
`OpfsSink` against the exact `UnknownError` Playwright's WebKit build throws), a
file past the memory cap still reports the sink's own reason, a resumed transfer
is never restarted into memory, and a cancelled picker is reported rather than
quietly absorbed. The
heartbeat suite in `transfer.test.ts` pins `PEER_LOST` at the plain pong
timeout and the recoverable-drop grace: while the wired `pcState` reads
`disconnected` the deadline doubles, and `failed` / `closed` still fail at
the plain one.

## End-to-end (`tests/e2e`)

Real Chromium against the production build, with the service worker and its
stamped build id in place:

- **Pairing and transfer** — two separate browser contexts (two "devices")
  pair over loopback WebRTC through the link and paste routes, match
  verification words, pass the host approval gate, move a file and a note in
  both directions, and check that neither page logged an error; a second spec
  covers the peer-drop reason code (PRD 13.3, 12).
- **Settings sheet** — theme tokens, Hindi + the Devanagari face actually
  loading, reduce-motion token override, persistence across reload with the
  FR-40 key list, and modal semantics (Escape) (FR-41).
- **Degradation** — the app in a browser with no WebRTC: the "can't do direct
  transfers" message on both home-screen entry points and on the shared `#j=`
  link route, the self-test's `unsupported` stage with the PRD 7.1 wording, and
  the sink-detection contract behind `chooseSink()` (PRD 8.5). Chromium and
  Firefox get the API removed by an init script; on WebKit it is genuinely absent,
  and `npm run test:webkit` runs the same file that way.
- **Debug panel** — the 8-tap reveal gesture against real timers, the real
  service-worker health rows, and the capability rows (FR-50): WebRTC, File
  System Access, OPFS, whether OPFS can actually be written to, and the sink
  `chooseSink()` would take. Those rows are the one engine-keyed part of an
  otherwise engine-agnostic suite, because they report the browser's own APIs;
  the table in the spec holds the per-engine answer and `docs/INTEROP.md` the
  measurements behind it.
- **Offline** — the app half of DoD 6. Two online visits (so the worker has
  cached the shell _and_ the hashed assets), the network cut, then a reload
  served out of the cache: the home screen boots, a deep `?screen=` route
  resolves, and the settings sheet opens. That last step is the one that earns
  the spec — the sheet is a code-split chunk, so it is exactly what a
  shell-only precache gets wrong, and the failure a user sees is a dead button
  rather than an error. A third test restores the network and checks the app
  recovers rather than staying stuck offline.
- **Shipped-UI design gates** — DoD 11's pixel clauses, against real computed
  styles rather than a grep: every element on the home screen, settings, help
  and the self-test is checked for a gradient in either `background` or
  `background-image`, and no `.panel` may sit inside another `.panel` (PRD 10.2
  allows two surface levels, page and panel). The hidden debug panel is walked
  too, on the grounds that a rule which only holds where nobody looks is not a
  rule.

### What "offline" cannot mean here

DoD 6's pairing half — "airplane mode + hotspot still pairs" — is **not**
automated, and the reason is worth stating rather than working around.
Playwright's `setOffline` cuts the whole network stack, WebRTC included, so two
offline contexts reach `WAITING_FOR_REPLY` and then `FAILED`: that is the
emulated network refusing ICE, not the app refusing anything. DoD 6's case is
the opposite one, where the internet is gone and the _local link to the peer is
not_, which needs a second network the peer can still reach. One machine with
two browser contexts does not have that.

So `pairing-transfer.spec.ts` pairs two offline devices **as far as the codes
go** — both produce an offer and a reply from cached pages with the origin
unreachable, through the shared-link route, with no console errors — and stops
there. The data channel stays a row in the manual matrix, needing a phone on the
other end of a real hotspot.

`offline.spec.ts` is also excluded from WebKit, for a different reason: this
build's service workers work (the app installs, claims and caches on it), but it
cannot _navigate_ with the network emulated down — every test fails with an
internal error on the reload. So DoD 6 has **no** automated coverage on the engine
that most resembles Safari, which is why its row in the manual matrix is not
optional. `playwright.config.ts` records both exclusions and why, and
`e2e-browsers.test.ts` names the excluded specs rather than counting them, so the
next one has to be written down too.

Every one of those specs is engine-agnostic, which is what lets the nightly run
the whole suite on Firefox and the WebKit leg run all but pairing on WebKit. The
one exception is the pairing spec, which needs real WebRTC and is therefore
excluded from WebKit's project rather than skipped inside the file.

## Manual device matrix

Recorded in `docs/INTEROP.md` (PRD 13.4). The rows that need only
different engines are automated locally (`scripts/interop-matrix.mjs`:
Chromium ↔ Chromium and Chromium ↔ Firefox, both directions). What is
left needs physical devices: the camera QR route, Wi-Fi / hotspot /
guest-network behaviour, real Safari, and mobile power/screen review.

## Release audit (`npm run audit:release`)

The last stage of `npm run ci`, so DoD 8 and DoD 5 block a release instead
of waiting for someone to remember to run a script. `scripts/audit-release.mjs`
starts and stops its own `vite preview` server on :4198 (bound to 127.0.0.1;
it needs `npm run build` to have run), runs Lighthouse's mobile profile
against a Playwright-managed Chromium, and watches the network through a full
two-context pairing + file + note transfer.

Three numeric gates, each failing the build rather than printing advice:
performance ≥ 90 and accessibility ≥ 95 (DoD 8 verbatim) and zero off-origin
requests (DoD 5). Best practices and SEO are printed but deliberately
ungated — neither is a DoD threshold — and so is Lighthouse's
`agentic-browsing` category. Installability is `npm run pwa:health`'s job,
since Lighthouse 13 no longer scores a PWA category. Lighthouse is a pinned
devDependency and never reaches the shipped bundle.

To re-run just this stage: `npm run audit:release`.

## Doc figures (taken by the gate)

The test counts and the gzip figure in `README.md` are measured, not typed.
`npm run ci` is `scripts/gate.mjs`: it runs every stage of the `gate` list in
order, streaming their output, and then reads the figures out of the output of
the stages it has just run. Measurement and publication are the same run, so the
numbers in the document and the tests they describe cannot disagree.

`scripts/gate-figures.mjs` does the reading and the rewriting. Each figure must
match exactly once or the run stops — two matches means the summary is
ambiguous, which is not something to guess at — and each replacement in
`README.md` must match exactly once too, so a reworded sentence stops the run
instead of silently editing nothing. A replacement touches the matched text only
(no re-wrapping, so the result stays Prettier-stable), must still match its own
pattern afterwards, and must not change the file's line endings. Nothing is
written when a stage is red.

Where the figures go depends on where the gate runs. A developer's run writes
them, so the tree it leaves behind is correct; under CI it only checks, since a
stale `README.md` has to fail the build rather than be quietly corrected in a
throwaway checkout. `npm run docs:figures` forces the write, and
`npm run docs:figures:check` forces the check.

`tests/unit/gate-figures.test.ts` drives both halves with synthetic summaries
instead of a 60-second gate run — including the abort paths: an ambiguous
summary, a figure whose stage printed nothing, a reworded sentence, and a CRLF
file.

## Impeccable detector (DoD 11)

DoD 11 asks that "the Impeccable detector reports zero findings". It does, on
the running production build, at both viewports:

```
npm run build && npm run preview -- --port 4199 --strictPort
npx impeccable detect http://localhost:4199                      # desktop
npx impeccable detect --viewport 390x844 http://localhost:4199   # mobile
```

Both return exit 0 with no findings (2026-10-18, impeccable 4.6.0).

**A zero from that scanner is worth nothing until you have seen it fail.** "No
findings" and "not looking at anything" print the same thing, so the run above
was validated by planting a violation — `#f2f2f2` text on `#f0f0f0` — in the
primary button and confirming the scan reports it and exits 2. It does:

```
low-contrast  1.0:1 (need 4.5:1) — text #f2f2f2 on #f0f0f0
              div.home-actions > button.btn.btn-primary
```

Two things this taught, both worth keeping:

- **The scan really does read the rendered SPA.** It is worth doubting — a
  scanner pointed at a client-rendered app can easily snapshot an empty
  `#app` and report a clean bill of health for having measured nothing. Planting
  the violation is what distinguishes those, and here it renders fine.
- **Plant the violation where the cascade lets it win.** The first attempt was
  injected at the top of the `.btn-primary` rule and silently did nothing,
  because `background: var(--accent)` sits a line or two further down the same
  rule. Two clean scans followed, and the wrong conclusion drawn from them was
  that the scanner could not see the app at all. If a planted violation reports
  nothing, suspect the probe before you trust the tool.

The detector has no rule for gradients or nested cards — those are product rules
(PRD 10.2), not scanner rules, and they are gated by `design-gates.test.ts` and
`tests/e2e/design-gates.spec.ts` instead. This gate is deliberately a documented
command rather than a ninth gate stage: the scanner is an unpinned `npx` package
that launches its own browser, which is a poor thing to make every pull request
depend on.

## On CI

`.github/workflows/ci.yml` installs one browser and then runs `npm run ci` — one
command, so the job cannot fall behind the gate, and `ci-parity.test.ts` fails if
the stages are ever listed there again. It runs on pushes to `main`, on pull
requests, and nightly at 03:17 UTC.

The job is a matrix with two axes: Node (`22`) and engine (`chromium`). A push or
a pull request runs one leg, which is the answer that diff deserves as fast as it
can be given. The scheduled run widens both axes — Node 22 and 24, Chromium and
Firefox — for four legs, because those combinations are about drift rather than
about the change in hand. Every leg runs the same command, and every leg checks
the README figures against what it measured: the specs are engine-agnostic, so
each engine collects the same tests, and a leg that disagreed with the README
would be telling us the suite had become engine-dependent.

The engine comes from `E2E_BROWSERS` (see `playwright.config.ts`), which defaults
to Chromium; otherwise the npm script's own name decides, so `npm run test:webkit`
means WebKit wherever it is run. Firefox is the second engine because its WebRTC
works.

A third job runs the WebKit leg — `npm run test:webkit`, never a leg of the
gate and never on a push or pull request. Playwright's WebKit build has no
`RTCPeerConnection`, so its project excludes the pairing spec and it collects
fewer tests than the README states: as a matrix engine it would fail the figure
check for a difference that is not a regression, and a local `write` run would
have recorded the smaller count as the published one. So
`scripts/gate-figures.mjs` refuses `E2E_BROWSERS=webkit` outright, naming the
command meant for it; `ci-parity.test.ts` pins that the leg stays a separate job
that installs its own browser first, and never appears in the `gate` list; and
`gate-figures.test.ts` covers the refusal itself. What the leg buys is the one
thing no other engine can give — the degradation path against a real absence of
the API, with nothing stubbed (see docs/INTEROP.md).

The leg runs on the schedule, and on demand: the workflow takes a
`workflow_dispatch` trigger and the job's own condition accepts that event too.
A job reachable only at 03:17 UTC is a job nobody can check — a bad browser
version or a renamed step would go unnoticed for a day at a time, and a green
nightly would say nothing about whether the leg had ever executed. Both halves
are pinned, because they fail in opposite directions: the trigger without the
condition would leave the leg unreachable, and the condition without the
trigger would leave it reported as `skipped`, which reads as health.

The scheduled run also exists for what no commit can trigger: the runner
environment itself — the Ubuntu image, the browser builds, what npm hands back —
drifts on its own. It takes the default branch, and because `CI` is set there it
checks the README figures rather than writing them, so the Linux half of those
numbers is verified on a machine nobody develops on.
