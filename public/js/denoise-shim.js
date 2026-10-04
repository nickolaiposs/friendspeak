// The audio thread has no TextDecoder, and the DeepFilterNet wasm glue (df.js)
// makes one as it loads. It only uses it for the text of errors, which is
// ASCII. denoise-worklet.js imports this first.
globalThis.TextDecoder ??= class {
  decode(bytes) {
    let text = '';
    for (const b of bytes ?? []) text += String.fromCharCode(b);
    return text;
  }
};
