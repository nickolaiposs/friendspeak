// Audio graph:
//
//   mic ──> micGain ──┬──> gate(mute/PTT/mic test) ──┬──> outDest (MediaStream sent to peers)
//                     ├──> micAnalyser (Settings)    └──> selfAnalyser (speaking indicator)
//                     └──> loop (mic test) ──> master
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
//
// The mic is sent as it is captured (D38): no echo cancellation, automatic
// gain or gate. The one option is the browser's noise suppression.
import { settings } from './store.js';

export const MAX_USER_VOLUME = 3;

// A boosted voice passes through this so its peaks are squeezed under full
// scale instead of clipping. Hard knee: below the threshold it changes nothing.
const LIMITER = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.2 };
// DynamicsCompressorNode adds makeup gain on its own: 0.6 of (in dB) what it
// takes off a full-scale signal. This takes it back out.
const LIMITER_TRIM = 10 ** ((0.6 * LIMITER.threshold * (1 - 1 / LIMITER.ratio)) / 20);

// The graph runs at the rate Opus sends, so nothing is resampled on the way
// out. The browser resamples for devices at other rates.
const SAMPLE_RATE = 48000;

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micStream = null;
    this.micSource = null;
    this.buffers = new Map(); // soundId -> AudioBuffer
    this.playing = new Set();
    this.muted = false;
    this.pttHeld = false;
    this.micRun = 0; // bumped by every mic start and stop, so a slow start can tell it was overtaken
    this.micInfo = null; // what the running mic applies: { label, want, got }
    this.micTest = false; // Settings' mic test is running (setMicTest)
    this.monitorOn = false;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const s = settings.get();
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try {
      ctx = new AC({ sampleRate: SAMPLE_RATE });
    } catch {
      ctx = new AC();
    }
    this.ctx = ctx;
    this.micGain = ctx.createGain();
    this.micGain.gain.value = s.micVolume;
    this.gate = ctx.createGain();
    this.sbBus = ctx.createGain();
    this.sbBus.gain.value = s.soundboardVolume;
    this.monitor = ctx.createGain();
    this.loop = ctx.createGain();
    this.loop.gain.value = 0;
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = s.voiceVolume;
    this.cueBus = ctx.createGain();
    this.cueBus.gain.value = s.cueVolume;
    this.master = ctx.createGain();
    this.master.gain.value = s.masterVolume;
    this.outDest = ctx.createMediaStreamDestination();
    this.selfAnalyser = ctx.createAnalyser();
    this.selfAnalyser.fftSize = 512;
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;

    this.micGain.connect(this.gate);
    this.micGain.connect(this.micAnalyser);
    this.micGain.connect(this.loop);
    this.loop.connect(this.master);
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
    this.setMonitor(s.soundboardMonitor);
    if (s.outputDevice) this.setOutputDevice(s.outputDevice);
  }

  get outStream() {
    this.ensure();
    return this.outDest.stream;
  }

  async startMic() {
    this.ensure();
    this.stopMic();
    const run = this.micRun;
    const s = settings.get();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone access needs https or localhost');
    const want = { echoCancellation: false, autoGainControl: false, noiseSuppression: !!s.noiseSuppression };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: s.inputDevice ? { ideal: s.inputDevice } : undefined, ...want },
    });
    if (run !== this.micRun) return stream.getTracks().forEach((t) => t.stop()); // stopped or restarted meanwhile
    this.micStream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    const track = stream.getAudioTracks()[0];
    // A device or OS may refuse a constraint without failing; Settings shows what was applied
    this.micInfo = { label: track.label, want, got: track.getSettings() };
    this.micSource.connect(this.micGain);
  }

  stopMic() {
    this.micRun++;
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSource = this.micStream = this.micInfo = null;
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
    if (this.voiceBus) this.voiceBus.gain.value = this.micTest ? 0 : v;
  }
  setCueVolume(v) {
    if (this.cueBus) this.cueBus.gain.value = v;
  }
  // '' is the system default. A device that is gone leaves the output where it was.
  setOutputDevice(deviceId) {
    this.ctx?.setSinkId?.(deviceId || '').catch(() => {});
  }
  setMonitor(on) {
    this.monitorOn = on;
    if (this.monitor) this.monitor.gain.value = on && !this.micTest ? 1 : 0;
  }
  // Mic test (Settings): you hear your own mic and nothing else. Friends'
  // voices and your soundboard go quiet here, and the mic is kept from friends
  // as if muted. Screen share audio plays in <video> elements, which main.js
  // mutes for the test.
  setMicTest(on) {
    this.ensure();
    this.micTest = on;
    this.loop.gain.value = on ? 1 : 0;
    this.setVoiceVolume(settings.get().voiceVolume);
    this.setMonitor(this.monitorOn);
    this.updateGate();
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
    const open = !this.muted && !this.micTest && (!settings.get().ptt || this.pttHeld);
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
    const st = settings.get();
    if (!st.cues || st.sounds[kind] === false) return;
    this.play(kind);
  }

  // Settings preview: plays even when that sound is turned off (the volume still applies)
  preview(kind) {
    this.play(kind);
  }

  play(kind) {
    this.ensure();
    const tones = {
      join: [523, 784],
      leave: [784, 523],
      peerJoin: [660, 880],
      peerLeave: [880, 660],
      mute: [440],
      unmute: [660],
      dm: [988, 1175],
      mention: [880, 1319, 880],
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

// Every cue the settings list, in display order
export const CUES = [
  { kind: 'join', label: 'You join voice' },
  { kind: 'leave', label: 'You leave voice' },
  { kind: 'peerJoin', label: 'Someone joins your channel' },
  { kind: 'peerLeave', label: 'Someone leaves your channel' },
  { kind: 'mute', label: 'Mute' },
  { kind: 'unmute', label: 'Unmute' },
  { kind: 'dm', label: 'Direct message' },
  { kind: 'mention', label: 'Mention or reply' },
  { kind: 'ring', label: 'Incoming call' },
  { kind: 'calling', label: 'Outgoing call (ringing)' },
];

export const Level = AudioEngine.level;
export const audio = new AudioEngine();
