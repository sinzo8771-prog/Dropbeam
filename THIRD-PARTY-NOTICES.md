# Third-party notices

The code in this repository is MIT licensed (see [LICENSE](LICENSE)). It ships
with the libraries below, each under its own licence. The list is generated
from `package.json`'s `dependencies` - the five libraries that end up in the
shipped bundle - and a test fails if one of them is missing from here.

## Shipped dependencies

| Package  | Version | Licence     | Used for                                       |
| --------- | ------- | ----------- | ---------------------------------------------- |
| `preact`  | 11.0.0  | MIT         | the UI                                          |
| `uqr`     | 0.1.3   | MIT         | QR encoding (rendering the code and its frames) |
| `jsqr`    | 1.4.0   | Apache-2.0 | QR decoding (the camera fallback)               |
| `hash-wasm` | 4.12.0 | MIT         | SHA-256, for the file's integrity check         |
| `fflate`  | 0.8.3   | MIT         | compression, and the fallback when the browser has no `CompressionStream` |

`jsqr` is loaded lazily, only when the browser has no native
`BarcodeDetector` (PRD 8.1), and `fflate`'s fallback chunk the same way - so
neither is in the initial bundle. `hash-wasm` and `uqr` are part of it.

## Licences

### MIT (preact, uqr, hash-wasm, fflate)

The MIT licence text is the same one this project uses, and is reproduced in
each package's own `LICENSE` file inside `node_modules`. The MIT licence
requires the copyright notice and permission notice to be included in copies
or substantial portions of the software; keeping this file, and the notices
above, satisfies that for the code as shipped.

### Apache-2.0 (jsqr)

`jsqr` is licensed under the Apache License, Version 2.0. Its full licence
text is in `node_modules/jsqr/LICENSE`, and the copyright notice it carries is
reproduced there as well. Apache-2.0 requires that a copy of the licence
travel with the software and that modified files be marked as modified. This
project uses `jsqr` unmodified.

## Development dependencies

The tools used to build and test the project - Vite, Vitest, Playwright,
ESLint, Lighthouse and the rest - are not shipped to the browser and so are
not listed here. Their licences are in their own packages, and the full list
with versions is in `package.json`.
