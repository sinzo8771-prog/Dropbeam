# Self-hosting Dropbeam

Dropbeam is a static site: any host that serves files over HTTPS works, and
the app has no server of its own. This page covers the deploy decisions that
actually matter, and the TURN question people ask first.

## Deploy

```sh
npm ci
npm run build      # dist/ is the whole site
```

Serve `dist/` from anywhere static — GitHub Pages, Netlify, Cloudflare
Pages, S3 + CDN, nginx, Caddy. Requirements:

- **HTTPS** (or `localhost`). WebRTC, service workers, OPFS and the File
  System Access API are all restricted to secure contexts.
- **Correct MIME types** — `.webmanifest` as `application/manifest+json`,
  `.js` as `text/javascript`. nginx's default `mime.types` already does.
- **A deep-link-safe SPA fallback.** The app is a single `index.html` with
  hash-based pairing routes (`#j=` / `#a=`), so no rewrite rules are needed.
  `base: "./"` in `vite.config.ts` means the build also runs from a
  sub-path (`https://host/dropbeam/`) — but note the share-target `action`
  and the manifest `start_url` are relative (`./`), so keep them together
  under one path prefix.
- **Compression on.** The size budget (`npm run size`) counts gzipped JS;
  serve `.js`, `.css`, and `.woff2` pre-compressed.

Two headers worth setting (CSP scoping is in `index.html` as a `<meta>`,
which cannot carry `frame-ancestors`):

```
Content-Security-Policy: frame-ancestors 'none';   # clickjacking guard
X-Content-Type-Options: nosniff
```

## Keep the privacy model intact

Prompts the app relies on, if you modify it:

- The service worker asks for no external URLs; `npm run pwa:health` fails
  the build if one appears. Nothing may phone home.
- Only `localStorage` keys from the FR-40 allowlist are read or written
  (theme, language, auto-accept, ICE, wake lock, reduce motion).
- STUN is off by default; the settings sheet discloses the IP disclosure
  before enabling it.

## STUN and TURN (PRD 8.3)

| Mode    | What it does                                                      | When to use                       |
| ------- | ----------------------------------------------------------------- | --------------------------------- |
| `local` | `iceServers: []` — host candidates only, zero third-party contact | same Wi-Fi, hotspot               |
| `stun`  | one public STUN server; discloses your public IP to it            | different networks, one-sided NAT |

The settings sheet exposes **STUN only**. TURN (relaying media through a
server when both peers are behind symmetric NAT) is deliberately not in the
product: it contradicts the "nothing is uploaded" promise, because file
bytes would traverse a third party.

If you self-host and need it anyway, the seam is
`src/core/peer/ice-config.ts` — `IceSettings` → `buildRtcConfig`. A TURN
build extends the type with credentials, returns
`[{ urls: turn:…, username, credential }]`, and surfaces it in the settings
sheet like STUN. Run [coturn](https://github.com/coturn/coturn) with
`use-auth-secret` and short-lived credentials, keep `relay-ip` private, and
expect the "Across networks" copy to say so — a TURN relay sees the traffic
it forwards, and the UI must disclose exactly that (PRD 9.1/9.2).

Without TURN, the failure mode on symmetric NAT is a clean
`CONNECT_TIMEOUT` with the troubleshooting page's guidance (same Wi-Fi,
hotspot trick, or enable Across networks) — never a hang.

## Verifying a deploy

```sh
npm run pwa:health   # manifest, icons, service worker, no external fetches
npm run size         # initial JS budget
```

Then open the site on two devices on the same network and pair. If the QR
camera is unavailable, the link and paste routes pair just the same.
