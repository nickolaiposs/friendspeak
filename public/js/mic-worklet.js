// The mic's noise gate and speaker mode. This file runs on the audio thread
// (audio.js loads it with audioWorklet.addModule), not in the page.
//
//   input 0: the mic (after noise reduction)   output: the mic, gated and ducked
//   input 1: everything the app plays (the sidechain for speaker mode)
//
// Noise gate: the mic passes while its level is above a threshold and is
// silenced below it. The threshold is set by hand ('manual') or follows the
// room ('auto': a little above the measured noise floor).
// Speaker mode: while the app is playing something, the mic is turned down, so
// what the speakers put back into it doesn't reach friends as an echo.
//
// Settings arrive on the port as { gate, threshold, duck }. About 45 times a
// second the processor posts { level, threshold, open, ducked } (dB) for the
// level display in Settings.

const HOLD = 0.25; // s the gate stays open after the level drops
const HYSTERESIS = 5; // dB between opening and closing, so it doesn't chatter
const AUTO = { above: 10, min: -60, max: -25 }; // auto threshold: dB above the floor, and its limits
const DUCK = { above: -50, gain: 10 ** (-18 / 20), hold: 0.3 }; // playback louder than this ducks the mic by 18 dB
const REPORT = 1024; // samples between level reports

const db = (meanSquare) => 10 * Math.log10(meanSquare + 1e-12);
const meanSquare = (buf) => {
  if (!buf) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return sum / buf.length;
};
// Per-sample smoothing factor for a time constant in seconds
const coef = (seconds) => 1 - Math.exp(-1 / (seconds * sampleRate));

class MicGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = { gate: 'off', threshold: -50, duck: false };
    this.port.onmessage = (e) => Object.assign(this.cfg, e.data);
    this.smooth = 0; // mean square over ~10 ms, for closing
    this.slow = 0; // mean square over ~100 ms, for the noise floor
    this.floor = -60; // dB
    this.open = false;
    this.hold = 0;
    this.duckHold = 0;
    this.gain = 1;
    this.duck = 1;
    this.peak = -120; // loudest block since the last report
    this.sinceReport = 0;
    this.k = { open: coef(0.002), close: coef(0.06), duck: coef(0.005), unduck: coef(0.12) };
  }

  process(inputs, outputs) {
    const mic = inputs[0][0];
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const dt = n / sampleRate;
    const { gate, duck } = this.cfg;

    const ms = meanSquare(mic);
    const level = db(ms);
    this.smooth += (ms - this.smooth) * (1 - Math.exp(-dt / 0.01));
    this.slow += (ms - this.slow) * (1 - Math.exp(-dt / 0.1));

    // Noise floor: drops quickly to any quieter level, creeps up otherwise
    // (slower still while something well above it, most likely speech, goes on)
    const slow = Math.max(-100, db(this.slow));
    if (slow < this.floor) this.floor += (slow - this.floor) * 0.2;
    else this.floor += (slow < this.floor + 10 ? 2 : 0.5) * dt;
    this.floor = Math.min(this.floor, AUTO.max);

    const threshold = gate === 'auto' ? Math.min(AUTO.max, Math.max(AUTO.min, this.floor + AUTO.above)) : this.cfg.threshold;
    if (level > threshold) {
      this.open = true;
      this.hold = HOLD;
    } else if (this.open) {
      if (db(this.smooth) > threshold - HYSTERESIS) this.hold = HOLD;
      else if ((this.hold -= dt) <= 0) this.open = false;
    }

    if (duck && db(meanSquare(inputs[1][0])) > DUCK.above) this.duckHold = DUCK.hold;
    else if (this.duckHold > 0) this.duckHold -= dt;
    const ducked = duck && this.duckHold > 0;

    const gateTo = gate === 'off' || this.open ? 1 : 0;
    const duckTo = ducked ? DUCK.gain : 1;
    const kGate = gateTo > this.gain ? this.k.open : this.k.close;
    const kDuck = duckTo < this.duck ? this.k.duck : this.k.unduck;
    if (mic) {
      for (let i = 0; i < n; i++) {
        this.gain += (gateTo - this.gain) * kGate;
        this.duck += (duckTo - this.duck) * kDuck;
        out[i] = mic[i] * this.gain * this.duck;
      }
    } else {
      this.gain = gateTo;
      this.duck = duckTo;
    }

    this.peak = Math.max(this.peak, level);
    if ((this.sinceReport += n) >= REPORT) {
      this.port.postMessage({ level: this.peak, threshold, open: gate === 'off' || this.open, ducked });
      this.peak = -120;
      this.sinceReport = 0;
    }
    return true;
  }
}

registerProcessor('fs-mic-gate', MicGate);
