// The mic's noise suppression: DeepFilterNet, in wasm (D47). This file runs on
// the audio thread (audio.js loads it with audioWorklet.addModule), not in the page.
//
//   input: the mic, mono, at 48 kHz   output: the mic with the noise turned down
//
// The page makes the node with processorOptions { wasm, model } (a compiled
// WebAssembly.Module and the model file's bytes) and gets { ready, ms } or
// { error } back. It starts as a wire: the input is copied to the output, with
// no delay. A message { on } switches between the wire and the model, and
// { limit } sets how far noise is turned down, in dB (100 and above: no
// limit). Both can also be given as options. An { error } can come later too,
// if a frame fails: it is a wire again from then on.
//
// The model takes frames of 480 samples and the audio thread asks for blocks
// of 128, so processed samples wait in a queue. It starts with enough silence
// in it (448 samples) that a block is always there to hand out. With the
// model's own 30 ms that makes the mic 39 ms late while this is on.
import './denoise-shim.js';
import { initSync, df_create, df_get_frame_length, df_process_frame, df_set_atten_lim } from '../vendor/deepfilternet/df.js';

const BLOCK = 128;
const IDLE = 100; // silent frames in a row (1 s) before the model is left alone: a stopped mic costs nothing
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

class Denoise extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.df = 0; // the model's state (a pointer into the wasm), once loaded
    this.on = false;
    this.limit = 100;
    this.port.onmessage = (e) => this.message(e.data);
    this.port.onmessageerror = () => this.port.postMessage({ error: 'its files could not be handed to the audio thread' });
    this.message(options.processorOptions);
  }

  message(m) {
    if ('limit' in m) {
      this.limit = m.limit;
      if (this.df) df_set_atten_lim(this.df, m.limit);
    }
    if (m.wasm) this.load(m.wasm, m.model);
    if ('on' in m) {
      const on = !!m.on && !!this.df;
      if (on && !this.on) this.reset();
      this.on = on;
    }
  }

  load(wasm, model) {
    if (this.df) return this.port.postMessage({ ready: true, ms: 0 });
    try {
      const t = Date.now();
      initSync(wasm);
      this.df = df_create(new Uint8Array(model), this.limit);
      const frame = df_get_frame_length(this.df);
      this.frame = new Float32Array(frame);
      this.lead = frame - gcd(frame, BLOCK);
      this.queue = new Float32Array(this.lead + frame);
      this.reset();
      this.port.postMessage({ ready: true, ms: Date.now() - t });
    } catch (e) {
      this.fail(e);
    }
  }

  fail(e) {
    this.df = 0;
    this.on = false;
    this.port.postMessage({ error: String(e?.message || e) });
  }

  // An empty frame, and a queue holding only its lead of silence
  reset() {
    this.filled = 0;
    this.queue.fill(0);
    this.queued = this.lead;
    this.quiet = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0][0];
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.on) {
      if (input) out.set(input);
      return true;
    }
    const { frame, queue } = this;
    for (let i = 0; i < out.length; ) {
      const n = Math.min(out.length - i, frame.length - this.filled);
      if (input) frame.set(input.subarray(i, i + n), this.filled);
      else frame.fill(0, this.filled, this.filled + n);
      this.filled += n;
      i += n;
      if (this.filled < frame.length) break;
      this.filled = 0;
      this.quiet = frame.some((v) => v !== 0) ? 0 : this.quiet + 1;
      if (this.quiet > IDLE) {
        queue.fill(0, this.queued, this.queued + frame.length);
      } else {
        try {
          queue.set(df_process_frame(this.df, frame), this.queued);
        } catch (e) {
          this.fail(e);
          if (input) out.set(input);
          return true;
        }
      }
      this.queued += frame.length;
    }
    out.set(queue.subarray(0, out.length));
    queue.copyWithin(0, out.length, this.queued);
    this.queued -= out.length;
    return true;
  }
}

registerProcessor('fs-denoise', Denoise);
