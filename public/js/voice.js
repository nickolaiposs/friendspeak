// Voice channels: a full WebRTC mesh between everyone in the channel. The
// server only relays signaling; audio flows peer to peer.
//
// Screen sharing and cameras ("media") ride the same peer connections. A sender
// only sends a kind of media to peers that asked to watch it ({ watch: kind, on }
// over rtc:signal), so a 1080p60 stream doesn't cost upload bandwidth for
// everyone in the channel. Before adding tracks the sender announces the stream
// id ({ media: kind, id }) so the receiver can tell them apart. Tracks come
// and go mid-call, so signaling uses the "perfect negotiation" pattern: either
// side may offer, and on a collision the polite peer (lower socket id) yields.
import { audio, Level, MAX_USER_VOLUME } from './audio.js';
import { settings } from './store.js';

export const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

// Capture ceilings: up to 4K at 120 fps. Cameras ask for 1080p60 by default
// (4K webcam modes cost a lot to capture and rarely look better in a tile) but
// may go up to the same ceiling. What each viewer actually gets is set per
// viewer (see applyView) and by WebRTC's bandwidth estimate.
export const MEDIA = {
  screen: { width: 3840, height: 2160, fps: 120 },
  camera: { width: 3840, height: 2160, fps: 120, ideal: { width: 1920, height: 1080, fps: 60 } },
};
export const KINDS = ['screen', 'camera'];
export const SCREEN = MEDIA.screen;

// Codec order for screen and camera tracks. A mesh runs one encoder per
// viewer, so a hardware encoder (Apple VideoToolbox, Intel Quick Sync, NVENC,
// AMF) is what keeps several viewers or streams from pinning the CPU, and
// H.264 is the codec that has one almost everywhere. Negotiation drops anything
// the viewer can't decode and falls through to the next entry. H.265 comes
// last: Chrome only recently shipped it for WebRTC, only where there is
// hardware for it, and H.264 is already hardware-encoded on the same machines.
const CODEC_ORDER = [
  (c) => c.mimeType === 'video/H264' && /profile-level-id=64/.test(c.sdpFmtpLine) && /packetization-mode=1/.test(c.sdpFmtpLine), // High
  (c) => c.mimeType === 'video/H264' && /packetization-mode=1/.test(c.sdpFmtpLine),
  (c) => c.mimeType === 'video/VP9',
  (c) => c.mimeType === 'video/AV1',
  (c) => c.mimeType === 'video/VP8',
];
const rank = (c) => {
  const i = CODEC_ORDER.findIndex((f) => f(c));
  if (i >= 0) return i;
  return c.mimeType === 'video/H265' ? CODEC_ORDER.length : CODEC_ORDER.length + 1; // then rtx/red/ulpfec
};
function preferCodecs(transceiver) {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!caps || !transceiver.setCodecPreferences) return;
  try {
    transceiver.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
  } catch (e) {
    console.warn('rtc codec preferences', e);
  }
}

// Bitrate ceiling for w×h at fps: ~0.06 bits per pixel suits H.264 on screen
// content and motion (1080p60 ≈ 7.5 Mbps; 4K120 hits the 50 Mbps cap). Below
// 30 fps each frame needs more bits, hence the floor. It is a ceiling only; the
// bandwidth estimate decides what is actually sent.
const bitrateFor = (w, h, fps) => Math.round(Math.min(50e6, Math.max(2.5e6, w * h * Math.max(fps, 30) * 0.06)));

export class VoiceClient {
  constructor(socket, { onPeersChange, onMediaChange } = {}) {
    this.socket = socket;
    this.channelId = null;
    // sid -> { pc, audioEl, analyser, setGain, dispose, chain, state, polite,
    //          out: { kind -> transceivers sending our media to them },
    //          in: { kind -> { id, stream } they send us } }
    this.peers = new Map();
    this.deafened = false;
    this.local = { screen: null, camera: null }; // our own captures (MediaStream)
    this.onPeersChange = onPeersChange || (() => {});
    this.onMediaChange = onMediaChange || (() => {});
    this.onSignal = (msg) => this.handleSignal(msg);
    this.onPeerLeft = ({ sid }) => this.dropPeer(sid);
    socket.on('rtc:signal', this.onSignal);
    socket.on('voice:peer-left', this.onPeerLeft);
  }

  async join(channelId) {
    await this.leave(true);
    this.micError = null;
    try {
      await audio.startMic();
    } catch (e) {
      // No mic (denied, missing, or insecure page): join listen-only. The
      // soundboard is mixed into the same outgoing track, so it still works.
      this.micError = e;
      audio.ensure();
    }
    const res = await this.socket.emitWithAck('voice:join', { channelId });
    if (res.error) throw new Error(res.error);
    this.channelId = channelId;
    // The newcomer calls everyone already in the room.
    for (const sid of res.peers) this.call(sid);
  }

  async leave(silent = false) {
    if (!this.channelId) return;
    for (const sid of [...this.peers.keys()]) this.dropPeer(sid);
    if (!silent) this.socket.emit('voice:leave');
    this.channelId = null;
    for (const kind of KINDS) this.stopMedia(kind, true);
    audio.stopMic();
  }

  destroy() {
    this.leave();
    this.socket.off('rtc:signal', this.onSignal);
    this.socket.off('voice:peer-left', this.onPeerLeft);
  }

  createPeer(sid) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const peer = {
      pc,
      chain: Promise.resolve(),
      state: 'connecting',
      audioEl: null,
      analyser: null,
      polite: this.socket.id < sid,
      ignoreOffer: false,
      out: { screen: [], camera: [] },
      in: { screen: null, camera: null },
      view: { screen: null, camera: null }, // how big they display our media: { w, h, hidden }
    };
    this.peers.set(sid, peer);
    for (const track of audio.outStream.getAudioTracks()) pc.addTrack(track, audio.outStream);
    pc.onicecandidate = (e) => e.candidate && this.send(sid, { candidate: e.candidate });
    // Fires for the first offer and again whenever media tracks are added or removed.
    pc.onnegotiationneeded = () =>
      this.enqueue(sid, async () => {
        if (pc.signalingState !== 'stable') return; // re-fires once we're back to stable
        await pc.setLocalDescription();
        this.send(sid, { sdp: pc.localDescription });
      });
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      if (pc.connectionState === 'failed') pc.restartIce?.();
      this.onPeersChange();
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      const kind = KINDS.find((k) => peer.in[k]?.id === stream.id);
      if (kind) {
        peer.in[kind].stream = stream;
        this.onMediaChange(sid, kind);
        return;
      }
      if (e.track.kind === 'video') return; // unannounced; shouldn't happen
      // Chromium only delivers a remote stream to the audio graph while a
      // media element plays it. The element stays silent: the voice is heard
      // through audio.voiceInput, where its volume can go above 100%.
      if (!peer.audioEl) {
        peer.audioEl = new Audio();
        peer.audioEl.autoplay = true;
        peer.audioEl.muted = true;
      }
      peer.audioEl.srcObject = stream;
      peer.audioEl.play().catch(() => {});
      peer.dispose?.();
      Object.assign(peer, audio.voiceInput(stream));
      this.applyVolume(sid);
    };
    return peer;
  }

  // Serialize signaling per peer so ICE candidates never race the SDP.
  enqueue(sid, fn) {
    const peer = this.peers.get(sid);
    peer.chain = peer.chain.then(fn).catch((e) => console.warn('rtc', sid, e));
    return peer.chain;
  }

  // Adding the voice track in createPeer triggers negotiationneeded, which sends the offer.
  call(sid) {
    this.createPeer(sid);
    audio.cue('peerJoin');
    this.onPeersChange();
  }

  handleSignal({ from, data }) {
    if (!this.channelId) return;
    let peer = this.peers.get(from);
    if (!peer) {
      if (data.sdp?.type !== 'offer') return;
      peer = this.createPeer(from);
      audio.cue('peerJoin');
      this.onPeersChange();
    }
    // Media control messages share the per-peer queue so they stay ordered
    // with the SDP they announce.
    if (KINDS.includes(data.watch)) {
      return this.enqueue(from, () => {
        peer.view[data.watch] = null;
        return data.on ? this.sendMediaTo(from, data.watch) : this.unsendMediaTo(from, data.watch);
      });
    }
    if (KINDS.includes(data.view)) {
      return this.enqueue(from, () => {
        peer.view[data.view] = { w: Math.max(0, +data.w || 0), h: Math.max(0, +data.h || 0), hidden: !!data.hidden };
        return this.applyView(from, data.view);
      });
    }
    if (KINDS.includes(data.media)) {
      return this.enqueue(from, () => {
        peer.in[data.media] = typeof data.id === 'string' ? { id: data.id, stream: null } : null;
        this.onMediaChange(from, data.media);
      });
    }
    this.enqueue(from, async () => {
      const pc = peer.pc;
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && pc.signalingState !== 'stable';
        peer.ignoreOffer = collision && !peer.polite;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(data.sdp); // rolls back our own offer if we're polite
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription();
          this.send(from, { sdp: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    });
  }

  // ----- screen sharing & camera -----

  // `stream` comes from getDisplayMedia (screen) or getUserMedia (camera).
  // Nobody receives it until they watch.
  setMedia(kind, stream) {
    this.stopMedia(kind, true);
    this.local[kind] = stream;
    for (const t of stream.getTracks()) this.watchTrack(kind, stream, t);
    this.emitMedia();
    this.onMediaChange(this.socket.id, kind);
  }

  watchTrack(kind, stream, t) {
    if (t.kind === 'video') t.contentHint = 'motion'; // favour frame rate over per-frame sharpness
    // e.g. the browser's own "Stop sharing" bar; stop() on a swapped-out track doesn't fire this
    t.addEventListener('ended', () => this.local[kind] === stream && stream.getTracks().includes(t) && this.stopMedia(kind));
  }

  // Swap what we capture (another screen or window) without ending the share.
  // The MediaStream object and its id stay the same, and every viewer's
  // senders get the new tracks through replaceTrack, which needs no
  // renegotiation. Only a share that gains audio adds a transceiver.
  async replaceMedia(kind, next) {
    const stream = this.local[kind];
    if (!stream) return this.setMedia(kind, next);
    const old = stream.getTracks();
    for (const t of old) stream.removeTrack(t);
    for (const t of next.getTracks()) {
      stream.addTrack(t);
      this.watchTrack(kind, stream, t);
    }
    const jobs = [];
    for (const [sid, peer] of this.peers) {
      if (!peer.out[kind].length) continue;
      jobs.push(
        this.enqueue(sid, async () => {
          for (const k of ['video', 'audio']) {
            const track = stream.getTracks().find((t) => t.kind === k) || null;
            // sender.track can be null, the receiver side of a transceiver always knows its kind
            const tr = peer.out[kind].find((t) => t.receiver.track.kind === k);
            if (tr) await tr.sender.replaceTrack(track);
            else if (track) this.addMediaTransceiver(peer, kind, stream, track);
          }
          await this.applyView(sid, kind); // new source size → new scale and bitrate
        })
      );
    }
    await Promise.all(jobs);
    old.forEach((t) => t.stop());
    this.onMediaChange(this.socket.id, kind);
  }

  stopMedia(kind, silent = false) {
    const stream = this.local[kind];
    if (!stream) return;
    this.local[kind] = null;
    for (const sid of this.peers.keys()) this.unsendMediaTo(sid, kind);
    stream.getTracks().forEach((t) => t.stop());
    if (!silent) this.emitMedia();
    this.onMediaChange(this.socket.id, kind);
  }

  emitMedia() {
    this.socket.emit('voice:media', { screen: !!this.local.screen, camera: !!this.local.camera });
  }

  sendMediaTo(sid, kind) {
    const peer = this.peers.get(sid);
    const stream = this.local[kind];
    if (!peer || !stream || peer.out[kind].length) return;
    this.send(sid, { media: kind, id: stream.id });
    for (const track of stream.getTracks()) this.addMediaTransceiver(peer, kind, stream, track);
  }

  addMediaTransceiver(peer, kind, stream, track) {
    const video = track.kind === 'video';
    const tr = peer.pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [video ? this.encodingFor(peer, kind, track) : { maxBitrate: 192_000 }],
    });
    // Before negotiationneeded's offer runs (it is queued behind this task)
    if (video) preferCodecs(tr);
    peer.out[kind].push(tr);
  }

  // Encoding for one viewer: no bigger than they display it (in device
  // pixels), and paused while their window is hidden. Their encoder then does
  // only the work that is actually seen, e.g. a camera in a 266px tile is
  // encoded small instead of at full capture size.
  encodingFor(peer, kind, track) {
    // || rather than defaults: some sources (canvas captures) report 0
    const set = track.getSettings();
    const width = set.width || MEDIA[kind].width;
    const height = set.height || MEDIA[kind].height;
    const frameRate = set.frameRate || MEDIA[kind].fps;
    const view = peer.view[kind];
    let scale = 1;
    if (view?.w && view?.h) {
      // The screen is letterboxed (contain) and cameras are cropped (cover)
      const fit = kind === 'screen' ? Math.max : Math.min;
      scale = Math.max(1, fit(width / view.w, height / view.h));
    }
    const fps = Math.min(frameRate, MEDIA[kind].fps);
    return {
      active: !view?.hidden,
      scaleResolutionDownBy: scale,
      maxFramerate: fps,
      maxBitrate: bitrateFor(width / scale, height / scale, fps),
    };
  }

  async applyView(sid, kind) {
    const peer = this.peers.get(sid);
    const stream = this.local[kind];
    if (!peer || !stream) return;
    for (const tr of peer.out[kind]) {
      const track = tr.sender.track;
      if (track?.kind !== 'video') continue;
      const want = this.encodingFor(peer, kind, track);
      const params = tr.sender.getParameters();
      const enc = params.encodings?.[0];
      if (!enc) continue;
      // Skip tiny changes so resizing a window doesn't keep poking the encoder
      const near = (a, b) => Math.abs((a || 0) - b) < 0.1 * b;
      if (enc.active === want.active && near(enc.scaleResolutionDownBy || 1, want.scaleResolutionDownBy) && near(enc.maxBitrate, want.maxBitrate)) continue;
      Object.assign(enc, want);
      await tr.sender.setParameters(params);
    }
  }

  // Tell a peer how big we show their screen or camera (device pixels), or that
  // we can't see it right now, so they can size their encoder for us.
  view(sid, kind, { w = 0, h = 0, hidden = false } = {}) {
    if (!this.peers.has(sid)) return;
    this.send(sid, { view: kind, w: Math.round(w), h: Math.round(h), hidden });
  }

  unsendMediaTo(sid, kind) {
    const peer = this.peers.get(sid);
    if (!peer?.out[kind].length) return;
    for (const tr of peer.out[kind]) tr.stop();
    peer.out[kind] = [];
    this.send(sid, { media: kind, id: null });
  }

  // Ask a peer to start (or stop) sending us their screen or camera.
  watch(sid, kind, on = true) {
    const peer = this.peers.get(sid);
    if (!peer) return;
    if (!on) peer.in[kind] = null;
    this.send(sid, { watch: kind, on });
  }

  // What the encoders/decoder are doing, for the stage header. For our own
  // share: one entry per viewer. For someone else's: what we receive.
  async videoStats(sid, kind) {
    const codecName = (stats, id) => stats.get(id)?.mimeType?.replace('video/', '') || '?';
    if (sid === this.socket.id) {
      const out = [];
      for (const peer of this.peers.values()) {
        const tr = peer.out[kind].find((t) => t.sender.track?.kind === 'video');
        if (!tr) continue;
        const stats = await tr.sender.getStats().catch(() => null);
        stats?.forEach((r) => {
          if (r.type !== 'outbound-rtp') return;
          out.push({
            codec: codecName(stats, r.codecId),
            hw: r.powerEfficientEncoder,
            w: r.frameWidth,
            h: r.frameHeight,
            fps: r.framesPerSecond,
            mbps: r.targetBitrate / 1e6,
            limit: r.qualityLimitationReason,
            paused: peer.view[kind]?.hidden,
          });
        });
      }
      return out;
    }
    const tr = this.peers.get(sid)?.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video' && this.mediaOf(sid, kind)?.getTracks().includes(t.receiver.track));
    if (!tr) return null;
    const stats = await tr.receiver.getStats().catch(() => null);
    let res = null;
    stats?.forEach((r) => {
      if (r.type === 'inbound-rtp') res = { codec: codecName(stats, r.codecId), hw: r.powerEfficientDecoder };
    });
    return res;
  }

  mediaOf(sid, kind) {
    return sid === this.socket.id ? this.local[kind] : this.peers.get(sid)?.in[kind]?.stream || null;
  }

  dropPeer(sid) {
    const peer = this.peers.get(sid);
    if (!peer) return;
    peer.pc.close();
    peer.dispose?.();
    if (peer.audioEl) {
      peer.audioEl.pause();
      peer.audioEl.srcObject = null;
    }
    this.peers.delete(sid);
    if (this.channelId) audio.cue('peerLeave');
    this.onPeersChange();
    for (const kind of KINDS) if (peer.in[kind]) this.onMediaChange(sid, kind);
  }

  send(to, data) {
    this.socket.emit('rtc:signal', { to, data: JSON.parse(JSON.stringify(data)) });
  }

  setDeafened(d) {
    this.deafened = d;
    for (const sid of this.peers.keys()) this.applyVolume(sid);
  }

  // Per-user volume and mute are keyed by profile id so they survive reconnects.
  applyVolume(sid) {
    const peer = this.peers.get(sid);
    if (!peer?.setGain) return;
    const pid = this.profileIdFor?.(sid);
    const st = settings.get();
    const v = this.deafened || st.userMutes[pid] ? 0 : (st.userVolumes[pid] ?? 1);
    peer.setGain(Math.min(MAX_USER_VOLUME, Math.max(0, +v || 0)));
  }

  levels() {
    const out = new Map();
    for (const [sid, p] of this.peers) out.set(sid, p.analyser && !this.deafened ? Level(p.analyser) : 0);
    return out;
  }
}
