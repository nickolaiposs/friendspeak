// Audio graph:
//
//   mic ──> micMono ──> denoise ──> micPre ──> noise gate ──> micGain ──> limiter ──┬──> gate(mute/PTT/mic test) ──┬──> outDest (MediaStream sent to peers)
//                                                                                   ├──> micAnalyser (Settings)    └──> selfAnalyser (speaking indicator)
//                                                                                   └──> loop (mic test) ──> master
//   soundboard clips ──> sbBus ──────────────────────┬──> outDest
//                                                    ├──> selfAnalyser
//                                                    └──> monitor ──> master (hear it yourself)
//
//   friend's voice ──> user gain ──> voiceBus ──> limiter ──> master
//                 └──> analyser (speaking indicator)
//   cues ──> cueBus ──> master ──> speakers (the chosen output device)
//
// Mixing the soundboard into the outgoing stream is what lets friends hear it.
// Voices play through the graph instead of <audio> elements because an
// element's volume stops at 100%, and a gain node can boost a quiet friend.
//
// The mic gets the browser's echo cancellation and automatic gain, our noise
// suppression (DeepFilterNet in a worklet, denoise-worklet.js) and our noise
// gate (gate-worklet.js), each a setting (D44, D47, D48). It is made mono
// first: many mics capture stereo with the voice on one side only.
import { settings } from './store.js';

export const MAX_USER_VOLUME = 3;
export const MAX_MIC_VOLUME = 4;
export const MAX_VOICES_VOLUME = 2;

// The mic and the sum of everyone's voices pass through this, so boosted peaks
// are squeezed under full scale instead of clipping. Hard knee: below the
// threshold it changes nothing.
const LIMITER = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.2 };
// DynamicsCompressorNode adds makeup gain on its own: 0.6 of (in dB) what it
// takes off a full-scale signal. This takes it back out.
const LIMITER_TRIM = 10 ** ((0.6 * LIMITER.threshold * (1 - 1 / LIMITER.ratio)) / 20);

// The graph runs at the rate Opus sends, so nothing is resampled on the way
// out. The browser resamples for devices at other rates.
const SAMPLE_RATE = 48000;

// Noise suppression (D47): the worklet, and what it runs. See public/vendor/deepfilternet/README.md.
const DENOISE = {
  worklet: new URL('./denoise-worklet.js', import.meta.url),
  wasm: new URL('../vendor/deepfilternet/df_bg.wasm', import.meta.url),
  model: new URL('../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz', import.meta.url),
};
// settings.noiseSuppressionLimit: how far noise is turned down, in dB. The slider's top means no limit.
export const DENOISE_LIMIT = { min: 6, max: 40, step: 2, none: 100 };
const GATE_WORKLET = new URL('./gate-worklet.js', import.meta.url);
// settings.micGate: the level the noise gate opens at, in dB (D48). The slider's bottom means no gate.
export const GATE = { min: -80, max: -10 };

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
    // Noise suppression: 'off' | 'on' | 'failed' (can't run here: error says why, and the mic is sent as it is)
    this.denoise = { state: 'off', error: '', node: null, loaded: null };
    // Noise gate: its worklet, and its latest report, { level, open } (dB, before the gate)
    this.micGate = { node: null, loaded: null, live: null };
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
    // Both channels of a stereo mic summed into one: a mic on one side (an
    // audio interface's input 1, many headsets) stays at full level and in
    // both ears. A mono track only fills channel 0, so it passes unchanged.
    this.micSplit = ctx.createChannelSplitter(2);
    this.micMono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    this.micSplit.connect(this.micMono, 0);
    this.micSplit.connect(this.micMono, 1);
    this.micPre = ctx.createGain(); // the mic after noise suppression, before the noise gate
    this.micGain = ctx.createGain();
    this.micGain.gain.value = s.micVolume;
    const micOut = this.limiter(this.micGain);
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

    this.micMono.connect(this.micPre).connect(this.micGain);
    micOut.connect(this.gate);
    micOut.connect(this.micAnalyser);
    micOut.connect(this.loop);
    this.loop.connect(this.master);
    this.gate.connect(this.outDest);
    this.gate.connect(this.selfAnalyser);
    this.sbBus.connect(this.outDest);
    this.sbBus.connect(this.selfAnalyser);
    this.sbBus.connect(this.monitor);
    this.monitor.connect(this.master);
    this.limiter(this.voiceBus).connect(this.master);
    this.cueBus.connect(this.master);
    this.master.connect(ctx.destination);
    this.updateGate();
    this.setMonitor(s.soundboardMonitor);
    if (s.outputDevice) this.setOutputDevice(s.outputDevice);
  }

  denoiseFailed(error) {
    console.warn('noise suppression:', error);
    Object.assign(this.denoise, { state: 'failed', error });
  }

  // Starts the noise suppression worklet with its wasm and model (22 MB, from
  // the app's own files) and puts it between micMono and micPre, where it
  // stays for good. Resolves to whether it runs.
  async loadDenoise() {
    const d = this.denoise;
    const ctx = this.ctx;
    try {
      if (ctx.sampleRate !== SAMPLE_RATE) throw new Error(`the audio device runs at ${ctx.sampleRate} Hz and it needs 48000`);
      const [wasm, model] = await Promise.all([
        WebAssembly.compileStreaming(fetch(DENOISE.wasm)),
        fetch(DENOISE.model).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('its model is missing')))),
        ctx.audioWorklet.addModule(DENOISE.worklet),
      ]);
      // The compiled module can only travel as an option: a message carrying one never arrives
      const node = new AudioWorkletNode(ctx, 'fs-denoise', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1], processorOptions: { wasm, model } });
      const { error } = await new Promise((resolve) => {
        node.port.onmessage = (e) => resolve(e.data);
        node.onprocessorerror = () => resolve({ error: 'it stopped' });
        setTimeout(() => resolve({ error: 'it took too long to start' }), 10000);
      });
      if (error) throw new Error(error);
      node.port.onmessage = (e) => e.data.error && this.denoiseFailed(e.data.error); // a frame failed: it is a wire again
      node.onprocessorerror = () => this.denoiseFailed('it stopped');
      this.micMono.disconnect(this.micPre);
      this.micMono.connect(node).connect(this.micPre);
      d.node = node;
      return true;
    } catch (e) {
      this.denoiseFailed(e.message);
      return false;
    }
  }

  // Makes noise suppression match settings.noiseSuppression and its limit.
  // Works live: once the worklet is in the graph (the first time it's switched
  // on) this is a message to it, and nothing is rewired. Never throws: when it
  // can't run, the mic is sent as it is and Settings says so.
  async applyDenoise() {
    this.ensure();
    const d = this.denoise;
    if (settings.get().noiseSuppression) d.loaded ||= this.loadDenoise();
    if (!d.loaded || !(await d.loaded) || d.state === 'failed') return;
    const s = settings.get(); // as it is now: it may have changed while the model loaded
    d.node.port.postMessage({ on: !!s.noiseSuppression, limit: s.noiseSuppressionLimit });
    d.state = s.noiseSuppression ? 'on' : 'off';
  }

  // Puts the noise gate's worklet between micPre and micGain, where it stays
  // for good. Resolves to whether it runs.
  async loadGate() {
    const ctx = this.ctx;
    try {
      await ctx.audioWorklet.addModule(GATE_WORKLET);
      const node = new AudioWorkletNode(ctx, 'fs-gate', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
      node.port.onmessage = (e) => (this.micGate.live = e.data);
      this.micPre.disconnect(this.micGain);
      this.micPre.connect(node).connect(this.micGain);
      this.micGate.node = node;
      return true;
    } catch (e) {
      console.warn('noise gate:', e); // the mic is sent ungated
      return false;
    }
  }

  // Makes the noise gate match settings.micGate. Works live: a message to the
  // worklet. Never throws.
  async applyGate() {
    this.ensure();
    const g = this.micGate;
    g.loaded ||= this.loadGate();
    if (!(await g.loaded)) return;
    const threshold = settings.get().micGate;
    g.node.port.postMessage({ threshold: threshold > GATE.min ? threshold : null });
  }

  // node ──> limiter ──> trim; returns the trim to connect onward
  limiter(node) {
    const trim = new GainNode(this.ctx, { gain: LIMITER_TRIM });
    node.connect(new DynamicsCompressorNode(this.ctx, LIMITER)).connect(trim);
    return trim;
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
    // Noise suppression is ours (applyDenoise), never the browser's
    const want = { echoCancellation: this.wantEcho(), autoGainControl: !!s.autoGain, noiseSuppression: false };
    const denoise = Promise.all([this.applyDenoise(), this.applyGate()]);
    // Chromium ignores an `ideal` deviceId for mics (measured: Electron 44 gave
    // the default every time), so the chosen one is exact, and the default
    // stands in while it's unplugged.
    const open = (deviceId) => navigator.mediaDevices.getUserMedia({ audio: { deviceId, ...want } });
    let stream;
    try {
      stream = await open(s.inputDevice ? { exact: s.inputDevice } : undefined);
    } catch (e) {
      if (!s.inputDevice || !['OverconstrainedError', 'NotFoundError'].includes(e.name)) throw e;
      stream = await open(undefined);
    }
    await denoise; // so the mic doesn't start out unprocessed
    if (run !== this.micRun) return stream.getTracks().forEach((t) => t.stop()); // stopped or restarted meanwhile
    this.micStream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    const track = stream.getAudioTracks()[0];
    // A device or OS may refuse a constraint without failing; Settings shows what was applied
    this.micInfo = { label: track.label, want, got: track.getSettings() };
    this.micSource.connect(this.micSplit);
    // Unplugged mid-call: start again, which falls back to the default device
    track.addEventListener('ended', () => run === this.micRun && this.startMic().catch((e) => console.warn('mic: restart', e)));
    if (want.echoCancellation !== this.wantEcho()) await this.startMic(); // a mic test began or ended while it started
  }

  // Echo cancellation is its setting, except in a mic test: the test plays your
  // own voice, which the canceller would take for a friend's and turn your mic down.
  wantEcho() {
    return !!settings.get().echoCancellation && !this.micTest;
  }

  stopMic() {
    this.micRun++;
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSource = this.micStream = this.micInfo = null;
  }

  // Switch microphones, live in a call: the outgoing track stays the same, so
  // nothing renegotiates. With start false (no call, no mic test) it only saves the choice.
  async setInputDevice(deviceId, start = !!this.micStream) {
    settings.set({ inputDevice: deviceId });
    if (start) await this.startMic();
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
  // mutes for the test. A running mic restarts if the test changes whether it
  // is echo cancelled (wantEcho); resolves when it has.
  async setMicTest(on) {
    this.ensure();
    this.micTest = on;
    this.loop.gain.value = on ? 1 : 0;
    this.setVoiceVolume(settings.get().voiceVolume);
    this.setMonitor(this.monitorOn);
    this.updateGate();
    if (this.micStream && this.micInfo.want.echoCancellation !== this.wantEcho()) await this.startMic();
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
    gain.connect(this.voiceBus); // the bus has the limiter
    return {
      analyser,
      setGain: (v) => gain.gain.setTargetAtTime(v, ctx.currentTime, 0.015),
      dispose: () => {
        src.disconnect();
        gain.disconnect();
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
    this.tone(kind);
  }

  // Settings preview: plays even when that sound is turned off (the volume still applies)
  preview(kind) {
    this.tone(kind);
  }

  // Not named play: that is the soundboard's, and a second play() replaced it
  tone(kind) {
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
