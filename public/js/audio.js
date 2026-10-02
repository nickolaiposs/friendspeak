// Audio graph:
//
//   mic ──> micGain ──> gate(mute/PTT) ──┬──> outDest (MediaStream sent to peers)
//                                        └──> selfAnalyser (speaking indicator)
//   soundboard clips ──> sbBus ──────────┬──> outDest
//                                        ├──> selfAnalyser
//                                        └──> monitor ──> master (hear it yourself)
//
//   friend's voice ──> user gain ──(limiter while boosted)──> voiceBus ──> master
//                 └──> analyser (speaking indicator)
//   cues ──> cueBus ──> master ──> speakers (the chosen output device)
//
// Mixing the soundboard into the outgoing stream is what lets friends hear it.
// Voices play through the graph instead of <audio> elements because an
// element's volume stops at 100%, and a gain node can boost a quiet friend.
import { settings } from './store.js';

export const MAX_USER_VOLUME = 3;

// A boosted voice passes through this so its peaks are squeezed under full
// scale instead of clipping. Hard knee: below the threshold it changes nothing.
const LIMITER = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.2 };
// DynamicsCompressorNode adds makeup gain on its own: 0.6 of (in dB) what it
// takes off a full-scale signal. This takes it back out.
const LIMITER_TRIM = 10 ** ((0.6 * LIMITER.threshold * (1 - 1 / LIMITER.ratio)) / 20);

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
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = s.voiceVolume;
    this.cueBus = ctx.createGain();
    this.cueBus.gain.value = s.cueVolume;
    this.master = ctx.createGain();
    this.master.gain.value = s.masterVolume;
    this.outDest = ctx.createMediaStreamDestination();
    this.selfAnalyser = ctx.createAnalyser();
    this.selfAnalyser.fftSize = 512;

    this.micGain.connect(this.gate);
    this.gate.connect(this.outDest);
    this.gate.connect(this.selfAnalyser);
    this.sbBus.connect(this.outDest);
    this.sbBus.connect(this.selfAnalyser);
    this.sbBus.connect(this.monitor);
    this.monitor.connect(this.master);
    this.voiceBus.connect(this.master);
    this.cueBus.connect(this.master);
    this.master.connect(ctx.destination);
    this.updateGate();
    if (s.outputDevice) this.setOutputDevice(s.outputDevice);
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
  setMasterVolume(v) {
    if (this.master) this.master.gain.value = v;
  }
  setVoiceVolume(v) {
    if (this.voiceBus) this.voiceBus.gain.value = v;
  }
  setCueVolume(v) {
    if (this.cueBus) this.cueBus.gain.value = v;
  }
  // '' is the system default. A device that is gone leaves the output where it was.
  setOutputDevice(deviceId) {
    this.ctx?.setSinkId?.(deviceId || '').catch(() => {});
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

  // A friend's incoming voice. setGain takes 0..MAX_USER_VOLUME.
  voiceInput(stream) {
    this.ensure();
    const ctx = this.ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = ctx.createGain();
    src.connect(analyser);
    src.connect(gain);
    gain.connect(this.voiceBus);
    let limiter = null; // { comp, trim }, only in the path while boosted
    return {
      analyser,
      setGain: (v) => {
        gain.gain.setTargetAtTime(v, ctx.currentTime, 0.015);
        if (v > 1 === !!limiter) return;
        gain.disconnect();
        limiter?.trim.disconnect();
        limiter = null;
        if (v > 1) {
          limiter = { comp: new DynamicsCompressorNode(ctx, LIMITER), trim: new GainNode(ctx, { gain: LIMITER_TRIM }) };
          gain.connect(limiter.comp).connect(limiter.trim).connect(this.voiceBus);
        } else gain.connect(this.voiceBus);
      },
      dispose: () => {
        src.disconnect();
        gain.disconnect();
        limiter?.trim.disconnect();
      },
    };
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
      ring: [659, 880, 659, 880],
      calling: [494, 494],
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
      o.connect(g).connect(this.cueBus);
      o.start(t);
      o.stop(t + 0.15);
    });
  }
}

export const Level = AudioEngine.level;
export const audio = new AudioEngine();
