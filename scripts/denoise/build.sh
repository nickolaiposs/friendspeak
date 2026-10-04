#!/usr/bin/env bash
# Builds the DeepFilterNet wasm that noise suppression runs (D47) into
# public/vendor/deepfilternet/: upstream's libDF at a pinned commit, with
# libdf.patch and the versions in Cargo.lock. Runs in Docker, so the only
# thing it needs on this machine is Docker. See that folder's README.md.
set -euo pipefail

COMMIT=d375b2d8309e0935d165700c91da9de862a99c31 # Rikorose/DeepFilterNet main, 2024-10-17
RUST_IMAGE=rust:1.99-bookworm
WASM_PACK=0.13.1
BINARYEN=123

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../public/vendor/deepfilternet"

docker run --rm -i -v "$here:/recipe:ro" -v "$out:/out" \
  -e COMMIT="$COMMIT" -e WASM_PACK="$WASM_PACK" -e BINARYEN="$BINARYEN" "$RUST_IMAGE" bash -euo pipefail <<'IN'
git clone -q https://github.com/Rikorose/DeepFilterNet /src
cd /src
git checkout -q "$COMMIT"
git apply /recipe/libdf.patch
cp /recipe/Cargo.lock Cargo.lock
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked --version "$WASM_PACK"
curl -sSL "https://github.com/WebAssembly/binaryen/releases/download/version_$BINARYEN/binaryen-version_$BINARYEN-$(uname -m)-linux.tar.gz" | tar xz -C /tmp

cd libDF
# getrandom 0.4 (a dependency of tract) needs its backend named for wasm
export RUSTFLAGS='-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals --cfg getrandom_backend="wasm_js"'
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
# wasm-pack's own wasm-opt step is skipped: it doesn't pass the feature flags
wasm-pack build --no-opt --target web --release --features wasm --locked
"/tmp/binaryen-version_$BINARYEN/bin/wasm-opt" -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int \
  --enable-mutable-globals --enable-reference-types --enable-sign-ext pkg/df_bg.wasm -o /out/df_bg.wasm
cp pkg/df.js ../LICENSE-APACHE ../LICENSE-MIT /out/
cp ../models/DeepFilterNet3_onnx.tar.gz /out/
IN

cd "$out" && shasum -a 256 df_bg.wasm df.js DeepFilterNet3_onnx.tar.gz
