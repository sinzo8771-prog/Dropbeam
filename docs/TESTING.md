# Testing

Commands:

| Command             | What it runs                                               |
| ------------------- | ---------------------------------------------------------- |
| `npm run typecheck` | `tsc --noEmit` (strict)                                    |
| `npm run lint`      | ESLint flat config                                         |
| `npm test`          | Vitest: `tests/unit` + `tests/integration`                 |
| `npm run test:e2e`  | Playwright, two browser contexts (Chromium/Firefox/WebKit) |
| `npm run ci`        | typecheck → lint → test → build → size budget              |

## Unit (`tests/unit`)

Codecs (round trip, size budget, invalid input), SDP template, compact candidate
parsing, multi-frame QR assemble/shuffle/duplicates, pairing-link build/parse,
single-QR budget vs multi-frame fallback, QR pixel round trip (uqr → jsQR),
filename sanitizer (table-driven with hostile inputs), protocol encode/decode,
backpressure controller (simulated `bufferedAmount`), state machine transitions
and timeouts, verification phrase determinism (PRD 13.1).

## Integration (`tests/integration`)

Two `RTCPeerConnection`s in one page (loopback) transferring: 0-byte file,
1 byte, 16 KiB ± 1, 5 MB; cancel mid-way; decline; hash mismatch injection;
peer drop (PRD 13.2).

## End-to-end (`tests/e2e`)

Two browser contexts, manual handshake by passing the code string between them
(simulates the paste route) (PRD 13.3).

## Manual device matrix

Recorded in `docs/INTEROP.md` (PRD 13.4).
