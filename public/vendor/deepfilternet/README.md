# DeepFilterNet

What the mic's noise suppression runs (`public/js/denoise-worklet.js`, D47):
[DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) 3, a speech
enhancer for 48 kHz audio by Hendrik Schröter, compiled to WebAssembly.

| File | What it is | SHA-256 |
|---|---|---|
| `df_bg.wasm` | upstream's `libDF`, built with its `wasm` feature | `96669ec7ab5fdf2f346409a6e25345f77c038d0f7a0df9de6216e6442552e058` |
| `df.js` | the wasm-bindgen glue made by the same build (an ES module) | `a56f572b0159498d53ef3af7094be6401517a0ecf80417229b5d50442dab8e2d` |
| `DeepFilterNet3_onnx.tar.gz` | the model, upstream's `models/DeepFilterNet3_onnx.tar.gz`, unchanged | `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616` |

They ship inside the desktop app, so noise suppression works offline and
nothing is fetched at run time.

## Where the build comes from

`scripts/denoise/build.sh` (`npm run build:denoise`, needs Docker) makes all
three from upstream commit `d375b2d8309e0935d165700c91da9de862a99c31` (`main`,
2024-10-17) with `scripts/denoise/libdf.patch` applied and the dependency
versions in `scripts/denoise/Cargo.lock`. Rust 1.99, wasm-pack 0.13.1,
wasm-bindgen 0.2.118, binaryen 123 (`wasm-opt -O3`). The files are committed, so
nobody needs to run it to work on the app.

It is not upstream's code unchanged. The patch does two things:

- **Thresholds.** `wasm.rs` creates the model with the library's default
  thresholds, which skip the deep-filtering stage above 20 dB local SNR. On
  speech over quiet noise (the usual headset) that turns the voice down by
  5 dB, up to 10 dB in places. The patch uses the thresholds of upstream's own
  `deep-filter` program (−15, 35, 35 dB), which keeps the voice level.
- **tract 0.23.** Upstream pins the `tract` inference library at 0.21. In
  WebAssembly 0.23 is about 3.5 times faster on this model (2.8% of a core
  against 9.5%, same output), so the patch moves `libDF` to its API: renamed
  methods in `tract.rs`, `ndarray` 0.17, and `getrandom` 0.4's wasm backend.

The output was checked against upstream's native `deep-filter` 0.5.6 on the
same recording: equal to within one 16-bit step.

No prebuilt was used. The `deepfilternet3-noise-filter` npm package downloads
its wasm from its author's CDN at run time; that wasm is built from sources
that aren't published, and has the threshold problem above.

## Licences

DeepFilterNet's code and its model weights are dual-licensed MIT or Apache 2.0
(`LICENSE-MIT`, `LICENSE-APACHE`, copied from upstream). The wasm also contains
its Rust dependencies, mainly [tract](https://github.com/sonos/tract) (MIT or
Apache 2.0); `scripts/denoise/Cargo.lock` lists every one.
