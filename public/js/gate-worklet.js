// The mic's noise gate (D48). This file runs on the audio thread (audio.js
// loads it with audioWorklet.addModule), not in the page.
//
//   input: the mic, mono (after noise suppression)   output: the mic, gated
//
// The mic passes while its level is above a threshold and is silenced below
// it. It adds no delay. A message { threshold } sets the threshold in dB, or
// null for no gate (a wire); it can also be given as an option. About 23 times
// a second the processor posts { level, open }: the loudest block since the
// last report, in dB, before the gate, for the level bar in Settings.

const HOLD = 0.25; // s the gate stays open after the level drops
const HYSTERESIS = 5; // dB between opening and closing, so it doesn't chatter
const REPORT = 2048; // samples between level reports
const SILENT = -120; // dB

const db = (meanSquare) => 10 * Math.log10(meanSquare + 1e-12);
// Per-sample smoothing factor for a time constant in seconds
const coef = (seconds) => 1 - Math.exp(-1 / (seconds * sampleRate));

class Gate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.threshold = options.processorOptions?.threshold ?? null;
    this.port.onmessage = (e) => 'threshold' in e.data && (this.threshold = e.data.threshold);
    this.smooth = 0; // mean square over ~10 ms, for closing
    this.open = false;
    this.hold = 0;
    this.gain = 0;
    this.peak = SILENT; // loudest block since the last report
    this.sinceReport = 0;
    this.k = { open: coef(0.002), close: coef(0.06) };
  }

  process(inputs, outputs) {
    const mic = inputs[0][0];
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const dt = n / sampleRate;
    const { threshold } = this;

    let ms = 0;
    if (mic) {
      for (let i = 0; i < n; i++) ms += mic[i] * mic[i];
      ms /= n;
    }
    const level = db(ms);
    this.smooth += (ms - this.smooth) * (1 - Math.exp(-dt / 0.01));

    if (threshold == null) {
      this.open = true;
    } else if (level > threshold) {
      this.open = true;
      this.hold = HOLD;
    } else if (this.open) {
      if (db(this.smooth) > threshold - HYSTERESIS) this.hold = HOLD;
      else if ((this.hold -= dt) <= 0) this.open = false;
    }

    const to = this.open ? 1 : 0;
    if (!mic) {
      this.gain = to;
    } else if (to === 1 && this.gain > 0.9999) {
      this.gain = 1;
      out.set(mic); // open and settled: untouched
    } else {
      const k = to > this.gain ? this.k.open : this.k.close;
      for (let i = 0; i < n; i++) {
        this.gain += (to - this.gain) * k;
        out[i] = mic[i] * this.gain;
      }
    }

    this.peak = Math.max(this.peak, level);
    if ((this.sinceReport += n) >= REPORT) {
      this.port.postMessage({ level: this.peak, open: this.open });
      this.peak = SILENT;
      this.sinceReport = 0;
    }
    return true;
  }
}

registerProcessor('fs-gate', Gate);
