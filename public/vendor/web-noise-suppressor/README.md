# Vendored: RNNoise as an AudioWorklet

Prebuilt files, copied unchanged from the npm package
[`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) **0.4.1** (`dist/`).
The client has no build step (D1), so they are loaded as they are. `audio.js` uses them for the
"High" noise reduction level (D35).

| File | What it is |
|---|---|
| `rnnoise/workletProcessor.js` | the `AudioWorkletProcessor` (`@sapphi-red/web-noise-suppressor/rnnoise`), bundled with the glue code of `@shiguredo/rnnoise-wasm` 2022.2.0 |
| `rnnoise_simd.wasm`, `rnnoise.wasm` | [RNNoise](https://github.com/xiph/rnnoise) compiled to WebAssembly, with and without SIMD |
| `LICENSE` | the package's licence (MIT) |

Licences: the package is MIT (`LICENSE`), `@shiguredo/rnnoise-wasm` is Apache-2.0, and RNNoise
itself is BSD 3-clause (Copyright (c) 2017 Mozilla, 2007-2017 Jean-Marc Valin, 2005-2017 Xiph.Org
Foundation, 2003-2004 Mark Borgerding; see `COPYING` in the RNNoise repository).

To update: `npm pack @sapphi-red/web-noise-suppressor`, copy the same three files from `dist/`,
and change the version above. The package's `index.js` is not used: `audio.js` fetches the wasm
and creates the node itself.
