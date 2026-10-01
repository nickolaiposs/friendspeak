// Audio graph:
//
//   mic ──> micGain ──> gate(mute/PTT) ──┬──> outDest (MediaStream sent to peers)
//                                        └──> selfAnalyser (speaking indicator)
//   soundboard clips ──> sbBus ──────────┬──> outDest
//                                        ├──> selfAnalyser
//                                        └──> monitor ──> speakers (hear it yourself)
//
// Mixing the soundboard into the outgoing stream is what lets friends hear it.
import { settings } from './store.js';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micStream = null;
    this.micSource = null;
    this.buffers = new Map(); // soundId -> AudioBuffer
    this.playing = new Set();
    this.muted = false;
    this.pttHeld = false;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const s = settings.get();
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.micGain = ctx.createGain();
    this.micGain.gain.value = s.micVolume;
    this.gate = ctx.createGain();
    this.sbBus = ctx.createGain();
    this.sbBus.gain.value = s.soundboardVolume;
    this.monitor = ctx.createGain();
    this.monitor.gain.value = s.soundboardMonitor ? 1 : 0;
    this.outDest = ctx.createMediaStreamDestination();
    this.selfAnalyser = ctx.createAnalyser();
    this.selfAnalyser.fftSize = 512;

    this.micGain.connect(this.gate);
    this.gate.connect(this.outDest);
    this.gate.connect(this.selfAnalyser);
    this.sbBus.connect(this.outDest);
    this.sbBus.connect(this.selfAnalyser);
    this.sbBus.connect(this.monitor);
    this.monitor.connect(ctx.destination);
    this.updateGate();
  }

  get outStream() {
    this.ensure();
    return this.outDest.stream;
  }

  async startMic() {
    this.ensure();
    this.stopMic();
    const s = settings.get();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone access needs https or localhost');
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: s.inputDevice ? { ideal: s.inputDevice } : undefined,
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseSuppression,
        autoGainControl: true,
      },
    });
    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.micSource.connect(this.micGain);
  }

  stopMic() {
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSource = this.micStream = null;
  }

  setMicVolume(v) {
    if (this.micGain) this.micGain.gain.value = v;
  }
  setSoundboardVolume(v) {
    if (this.sbBus) this.sbBus.gain.value = v;
  }
  setMonitor(on) {
    if (this.monitor) this.monitor.gain.value = on ? 1 : 0;
  }
  setMuted(m) {
    this.muted = m;
    this.updateGate();
  }
  setPttHeld(held) {
    this.pttHeld = held;
    this.updateGate();
  }
  updateGate() {
    if (!this.gate) return;
    const open = !this.muted && (!settings.get().ptt || this.pttHeld);
    this.gate.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  // ----- soundboard -----

  async decode(sound) {
    this.ensure();
    if (this.buffers.has(sound.id)) return this.buffers.get(sound.id);
    const buf = await this.ctx.decodeAudioData(await sound.blob.arrayBuffer());
    this.buffers.set(sound.id, buf);
    return buf;
  }

  forget(id) {
    this.buffers.delete(id);
  }

  async play(sound) {
    const buf = await this.decode(sound);
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = sound.volume ?? 1;
    src.buffer = buf;
    src.connect(g).connect(this.sbBus);
    const entry = { src, id: sound.id };
    this.playing.add(entry);
    src.onended = () => {
      this.playing.delete(entry);
      this.onPlayingChange?.();
    };
    src.start();
    this.onPlayingChange?.();
  }

  stopAll() {
    for (const p of this.playing) p.src.stop();
    this.playing.clear();
    this.onPlayingChange?.();
  }

  isPlaying(id) {
    for (const p of this.playing) if (p.id === id) return true;
    return false;
  }

  // ----- levels -----

  analyserFor(stream) {
    this.ensure();
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    return { analyser: an, dispose: () => src.disconnect() };
  }

  static level(analyser) {
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    return Math.sqrt(sum / data.length);
  }

  // Little UI cues (join / leave / mute), synthesized so there are no asset files.
  cue(kind) {
    if (!settings.get().cues) return;
    this.ensure();
    const tones = {
      join: [523, 784],
      leave: [784, 523],
      peerJoin: [660, 880],
      peerLeave: [880, 660],
      mute: [440],
      unmute: [660],
      message: [988],
    }[kind];
    if (!tones) return;
    const t0 = this.ctx.currentTime;
    tones.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      o.connect(g).connect(this.ctx.destination);
      o.start(t);
      o.stop(t + 0.15);
    });
  }
}

export const Level = AudioEngine.level;
export const audio = new AudioEngine();
