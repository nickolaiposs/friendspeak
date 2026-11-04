// The app's side of the SFU (D70). In a voice channel on a server that has one, screen shares, cameras
// and a share's sound are published once, as simulcast, and the server forwards each viewer one layer.
// Voice stays on the mesh (voice.js), and so do DM calls.
//
// SfuSession is one voice channel's worth: the mediasoup-client Device, a receive transport, a send
// transport for what the page itself publishes (the browser engine), and the media sidecar's publishing
// connections (native/, one per kind it shares). VoiceClient owns it and keeps its own method names
// (watch, view, mediaOf, setMedia, …), so the stage doesn't know which path a stream takes.
//
// Everything is end-to-end encrypted (e2ee.js, on a worker as an RTCRtpScriptTransform): each sender has
// a media key per channel, sealed to each member with identity.js and passed through the server as a blob
// it can't open (`sfu:keys`). When anyone leaves the channel every sender moves to a new key.
//
// Previews: a sharer posts an encrypted still of each share every 10 s; Previews (one per connection, in
// a call or not) fetches and decrypts them for the hover card.
import { Device } from '../vendor/mediasoup-client/mediasoup-client.js';
import { b64, identityFor, pairKey, sealJson, unb64, unsealJson, verifyCard } from './identity.js';
import { importMediaKey, newMediaKey } from './e2ee.js';
import { log } from './log.js';
import { nativeMedia } from './native.js';

const KEY_AAD = 'friendspeak-media-key-v1';
const PREVIEW_KEY_AAD = 'friendspeak-preview-key-v1';
const PREVIEW_AAD = 'friendspeak-preview-v1';
const USE_AFTER_MS = 1000; // a new key is used this long after it was sent, so receivers have it
const OLD_KEY_MS = 10_000; // a receiver keeps a sender's previous key this long
const PREVIEW_EVERY_MS = 10_000;
const PREVIEW_W = 320;
const PREVIEW_H = 180;
const PREVIEW_MAX = 24 * 1024 - 28; // bytes of picture, so the encrypted blob stays under the server's cap
const NATIVE_WAIT_MS = 20_000; // the sidecar's share has this long to be connected to the SFU
// A connection that lost its path (D71): "disconnected" gets this long to come back by itself; then (or at once on
// "failed") new ICE credentials, and this long to connect with them before the session starts over (reset)
const DISCONNECTED_MS = 5000;
const RESTART_WAIT_MS = 10_000;
const RETRY_MS = [2000, 4000, 8000, 15_000]; // between tries while it stays down, then every 15 s
const NATIVE_RETRY_FOR_MS = 180_000; // a sidecar share that lost its connection is published again for this long
// How far behind live a stream we watch plays (its jitter buffer's target, D71): a screen share gives a little delay
// for smooth playback; a camera, part of a conversation, stays close to real time
const SCREEN_BUFFER_MS = 200;
const CAMERA_BUFFER_MS = 60;
// An upload that can't carry a screen share and a camera together (D71): while the estimate stays under WEAK_ROOM
// times what the screen's lower layers and the camera's lowest need, for WEAK_FOR_MS, the camera sends only its
// lowest layer (180p15), and the sharer is told once. It goes back once the estimate covers the screen's lower
// layers and the whole camera STRONG_ROOM times over, for STRONG_FOR_MS.
const UPLINK_EVERY_MS = 2000;
const WEAK_ROOM = 1.2;
const WEAK_FOR_MS = 10_000;
const STRONG_ROOM = 1.5;
const STRONG_FOR_MS = 30_000;
const LOW_CAMERA = { tier: { width: 320, height: 180, fps: 15 }, mode: 'smooth' };

// socket.io's emitWithAck never settles if the socket drops mid-call; a timeout turns that into an answer
const ask = (socket, event, payload = {}) => socket.timeout(10_000).emitWithAck(event, payload).catch(() => ({ error: 'The server did not answer' }));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What each layer of a share of ours needs, in bits per second, lowest first: the sidecar says for its own; the
// browser engine's layers carry it (voice.js simulcastLayers)
const needsOf = (p) => (p.native ? (p.stats?.layers || []).map((l) => (l.needMbps || 0) * 1e6) : (p.layers || []).map((l) => l.need || 0)).filter((x) => x > 0);
// Whether a mediasoup-client transport is connected within `ms`
const connectedWithin = (t, ms) =>
  new Promise((resolve) => {
    if (t.connectionState === 'connected') return resolve(true);
    const done = (ok) => (clearTimeout(timer), t.off?.('connectionstatechange', on), resolve(ok));
    const on = (state) => (state === 'connected' ? done(true) : state === 'closed' ? done(false) : null);
    const timer = setTimeout(() => done(false), ms);
    t.on('connectionstatechange', on);
  });

// Cards and the keys two profiles share, verified and derived once per session
function keyring(profile) {
  const pairs = new Map(); // `s` of their card -> Promise<CryptoKey>
  return {
    async with(card) {
      if (!card) throw new Error('no key');
      if (!pairs.has(card.s)) {
        pairs.set(
          card.s,
          (async () => {
            const ok = await verifyCard(card);
            if (!ok) throw new Error('a card that is not signed by its key');
            return pairKey(await identityFor(profile()), ok);
          })()
        );
        pairs.get(card.s).catch(() => pairs.delete(card.s));
      }
      return pairs.get(card.s);
    },
  };
}

// ctx: { socket, channelId, serverId(), profile(), sid(), user(sid) (a `users` entry), members() (sids in
// the channel but ours), onChange(sid, kind), onNativeLost(kind, source, reason), onClamped(kind, tier) }
export class SfuSession {
  constructor(ctx, producers = []) {
    this.ctx = ctx;
    this.socket = ctx.socket;
    this.channelId = ctx.channelId;
    this.device = null;
    this.recv = null; // the receive transport (a promise while it is made)
    this.send = null; // the page's send transport (a promise while it is made)
    this.producers = new Map(); // producerId -> { sid, kind, layers }: what is published in the channel
    this.pub = { screen: null, camera: null }; // what we publish
    this.watching = new Map(); // "<sid>|<kind>" -> { sid, kind, stream, consumers: Map(producerId -> consumer), layer, view, paused }
    this.key = null; // ours: { index, raw }
    this.theirs = new Map(); // sid -> [{ index, at }]: the keys we hold for each sender
    this.members = new Set(ctx.members());
    this.ring = keyring(ctx.profile);
    this.worker = new Worker(new URL('./e2ee-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => data?.t === 'fail' && this.undecryptable(data.sender);
    this.closed = false;
    this.tries = 0; // recoveries in a row without a connection coming back (D71)
    this.renative = { screen: null, camera: null }; // a sidecar share being published again after its connection broke
    // The jitter buffer each kind of stream we watch plays with, in ms (null: the browser's own). D71.
    this.buffer = { screen: SCREEN_BUFFER_MS, camera: CAMERA_BUFFER_MS };
    this.uplink = { weak: false, weakSince: null, strongSince: null, told: false }; // D71
    this.uplinkTimer = setInterval(() => this.checkUplink().catch((e) => console.debug('sfu uplink', e.message)), UPLINK_EVERY_MS);
    for (const p of producers || []) this.producers.set(p.producerId, p);
    this.on = {
      'sfu:produced': (p) => this.produced(p),
      'sfu:producerClosed': (p) => this.producerClosed(p),
      'sfu:consumerClosed': ({ producerId }) => this.producerClosed({ producerId }),
      'sfu:keys': (m) => this.keysFrom(m).catch((e) => console.warn('sfu keys', e.message)),
      'sfu:layer': ({ consumerId, spatialLayer }) => {
        for (const w of this.watching.values()) for (const c of w.consumers.values()) if (c.id === consumerId) w.layer = spatialLayer;
      },
      // Our link can't carry this stream with the others we watch: the server paused it, or let it go again (D71)
      'sfu:starved': ({ consumerId, starved }) => {
        for (const w of this.watching.values())
          for (const c of w.consumers.values())
            if (c.id === consumerId && w.starved !== !!starved) {
              w.starved = !!starved;
              this.ctx.onChange(w.sid, w.kind);
            }
      },
      'sfu:reset': () => this.reset().catch((e) => log.warn(`sfu: could not start over: ${e.message}`)),
      'sfu:preview:want': ({ from }) => {
        for (const kind of ['screen', 'camera']) if (this.pub[kind]?.preview) this.sealPreviewKey(from, kind).catch(() => {});
      },
    };
    for (const [ev, fn] of Object.entries(this.on)) this.socket.on(ev, fn);
    this.ready = this.start();
    this.ready.catch((e) => log.warn(`sfu: could not start: ${e.message}`));
  }

  async start() {
    const caps = await ask(this.socket, 'sfu:caps');
    if (caps.error) throw new Error(caps.error);
    this.device = new Device();
    await this.device.load({ routerRtpCapabilities: caps.rtpCapabilities });
    if (!this.key) {
      this.key = await this.makeKey(1);
      this.use(this.key);
    }
    await this.sendKey([...this.members]);
  }

  // Asks the server to close something of ours. Not once the session is closed: leaving the channel closed it all there.
  closeOnServer(what) {
    if (!this.closed) ask(this.socket, 'sfu:close', what);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.uplinkTimer);
    for (const [ev, fn] of Object.entries(this.on)) this.socket.off(ev, fn);
    for (const kind of ['screen', 'camera']) this.unpublish(kind, true);
    for (const w of this.watching.values()) for (const c of w.consumers.values()) c.close();
    this.watching.clear();
    Promise.resolve(this.send).then((t) => t?.close()).catch(() => {});
    Promise.resolve(this.recv).then((t) => t?.close()).catch(() => {});
    this.worker.terminate();
  }

  // ----- keys -----

  async makeKey(index) {
    const raw = newMediaKey();
    const key = { index, raw };
    this.worker.postMessage({ t: 'key', sender: 'self', index, raw });
    this.worker.postMessage({ t: 'key', sender: this.ctx.sid(), index, raw }); // our own tile shows our frames back
    return key;
  }

  // From now on, what we send is encrypted with `key`
  use(key) {
    this.worker.postMessage({ t: 'use', index: key.index });
    if (this.pub.screen?.native || this.pub.camera?.native) nativeMedia.send({ op: 'key', key: { index: key.index, key: hex(key.raw) } });
  }

  aad(from, to) {
    return `${KEY_AAD}|${this.ctx.serverId()}|${this.channelId}|${from}|${to}`;
  }

  // Our key, sealed to each of these people (by socket id). Someone on an app without keys gets nothing:
  // they couldn't watch anyway.
  async sendKey(sids, key = this.key) {
    const me = this.ctx.profile().id;
    await Promise.all(
      sids.map(async (sid) => {
        const u = this.ctx.user(sid);
        if (!u?.card || !u.sfu) return;
        try {
          const pk = await this.ring.with(u.card);
          const blob = await sealJson(pk, this.aad(me, u.id), { i: key.index, k: b64(key.raw) });
          if (!this.closed) this.socket.emit('sfu:keys', { to: sid, blob });
        } catch (e) {
          console.warn('sfu: no key for', sid, e.message);
        }
      })
    );
  }

  async keysFrom({ from, blob }) {
    const u = this.ctx.user(from);
    if (!u?.card || typeof blob !== 'string') return;
    const pk = await this.ring.with(u.card);
    const { i, k } = await unsealJson(pk, this.aad(u.id, this.ctx.profile().id), blob);
    const raw = unb64(String(k));
    if (!(i >= 1 && i <= 255) || raw.length !== 16 || this.closed) return;
    this.worker.postMessage({ t: 'key', sender: from, index: i, raw });
    const list = (this.theirs.get(from) || []).filter((x) => x.index !== i);
    list.push({ index: i, at: Date.now() });
    this.theirs.set(from, list);
    // The previous one stays a little while: frames sent with it are still on the way
    setTimeout(() => {
      const now = this.theirs.get(from);
      if (!now || this.closed) return;
      const keep = now.filter((x) => x.index === now.at(-1).index || Date.now() - x.at < OLD_KEY_MS);
      this.theirs.set(from, keep);
      this.worker.postMessage({ t: 'forget', sender: from, keep: keep.map((x) => x.index) });
    }, OLD_KEY_MS + 100);
    // What arrived before the key was dropped: start from a keyframe
    for (const w of this.watching.values()) if (w.sid === from) for (const c of w.consumers.values()) if (c.kind === 'video') ask(this.socket, 'sfu:keyframe', { consumerId: c.id });
  }

  // Frames from `sid` don't decrypt: we have no key (yet), so ask them again by sending ours, which they answer
  undecryptable(sid) {
    if (sid !== 'self') console.debug('sfu: frames without a key from', sid);
  }

  // Who is in the channel changed: newcomers get our key, and when anyone left everyone moves to a new one
  async membersChanged() {
    const now = new Set(this.ctx.members());
    const joined = [...now].filter((s) => !this.members.has(s));
    const left = [...this.members].filter((s) => !now.has(s));
    this.members = now;
    if (!this.device) return; // start() sends to everyone there
    for (const sid of left) {
      this.theirs.delete(sid);
      this.worker.postMessage({ t: 'forget', sender: sid, keep: [] });
    }
    if (left.length) {
      const key = await this.makeKey((this.key.index % 255) + 1);
      this.key = key;
      await this.sendKey([...now], key);
      setTimeout(() => this.key === key && !this.closed && this.use(key), USE_AFTER_MS);
    } else if (joined.length) await this.sendKey(joined);
  }

  encrypt(sender, codec) {
    sender.transform = new RTCRtpScriptTransform(this.worker, { role: 'send', codec });
  }

  decrypt(receiver, sid, codec) {
    receiver.transform = new RTCRtpScriptTransform(this.worker, { role: 'recv', sender: sid, codec });
  }

  // ----- transports -----

  async transport(direction, owner) {
    const t = await ask(this.socket, 'sfu:transport', { direction, owner });
    if (t.error) throw new Error(t.error);
    return t;
  }

  wire(t) {
    t.on('connect', ({ dtlsParameters }, ok, bad) =>
      ask(this.socket, 'sfu:connect', { transportId: t.id, dtlsParameters }).then((r) => (r.error ? bad(new Error(r.error)) : ok()))
    );
    t.on('connectionstatechange', (state) => this.pathChanged(t, state));
    return t;
  }

  // A connection that loses its path (a dropped Wi-Fi, a link down for half a minute) comes back by itself, with
  // new ICE credentials, or by the session starting over (D71)
  pathChanged(t, state) {
    if (this.closed || t.closed) return;
    clearTimeout(t.appData.lost);
    if (state === 'connected') {
      if (t.appData.down) log.info(`sfu: a ${t.direction === 'send' ? 'publishing' : 'watching'} connection is back`);
      t.appData.down = false;
      this.tries = 0;
    } else if (state === 'disconnected') t.appData.lost = setTimeout(() => this.recover(t), DISCONNECTED_MS);
    else if (state === 'failed') {
      if (!t.appData.down) log.warn(`sfu: a ${t.direction === 'send' ? 'publishing' : 'watching'} connection failed (is the server's UDP port open?)`);
      this.recover(t);
    }
  }

  // New ICE credentials from the server, and the browser checks again with them. When that can't work (a server
  // from before it, a transport the server has closed) or doesn't within RESTART_WAIT_MS, the session starts
  // over. While nothing comes back it keeps trying, further apart (RETRY_MS), as long as the socket is connected.
  async recover(t) {
    if (this.closed || t.closed || t.appData.recovering || t.connectionState === 'connected') return;
    t.appData.recovering = true;
    t.appData.down = true;
    try {
      const n = this.tries++;
      if (n) await sleep(RETRY_MS[Math.min(n - 1, RETRY_MS.length - 1)]);
      if (this.closed || t.closed || t.connectionState === 'connected' || !this.socket.connected) return;
      const r = await ask(this.socket, 'sfu:restartIce', { transportId: t.id });
      if (r.error) throw new Error(r.error);
      await t.restartIce({ iceParameters: r.iceParameters });
      if (await connectedWithin(t, RESTART_WAIT_MS)) return;
      throw new Error('it did not connect again');
    } catch (e) {
      if (this.closed || t.closed || !this.socket.connected) return;
      log.warn(`sfu: a ${t.direction === 'send' ? 'publishing' : 'watching'} connection could not be restarted (${e.message}); starting over`);
      this.reset('a connection to the media relay could not be restarted').catch((err) => log.warn(`sfu: could not start over: ${err.message}`));
    } finally {
      t.appData.recovering = false;
    }
  }

  recvTransport() {
    this.recv ||= (async () => {
      await this.ready;
      return this.wire(this.device.createRecvTransport(await this.transport('recv')));
    })();
    this.recv.catch(() => (this.recv = null));
    return this.recv;
  }

  sendTransport() {
    this.send ||= (async () => {
      await this.ready;
      const t = this.wire(this.device.createSendTransport(await this.transport('send', 'page')));
      t.on('produce', ({ rtpParameters, appData }, ok, bad) =>
        ask(this.socket, 'sfu:produce', { transportId: t.id, kind: appData.kind, rtpParameters, layers: appData.layers }).then((r) =>
          r.error ? bad(new Error(r.error)) : ok({ id: r.producerId })
        )
      );
      return t;
    })();
    this.send.catch(() => (this.send = null));
    return this.send;
  }

  // ----- publishing: the browser engine -----

  // `layers`: the simulcast encodings, lowest first ({ w, h, fps, scale, maxBitrate }), from voice.js
  async publish(kind, stream, layers) {
    await this.ready;
    this.unpublish(kind, true);
    const t = await this.sendTransport();
    const p = (this.pub[kind] = { native: false, kind, stream, video: null, audio: null, preview: null, layers });
    const track = stream.getVideoTracks()[0];
    // What this machine can send: without a hardware encoder that has no High profile, though it can still receive one
    const codecs = this.device.sendRtpCapabilities.codecs.filter((c) => c.mimeType === 'video/H264' && c.parameters?.['packetization-mode'] === 1);
    const codec = codecs.find((c) => /^64/.test(c.parameters['profile-level-id'] || '')) || codecs[0];
    p.video = await t.produce({
      track,
      codec,
      // One temporal layer: Chromium's hardware H.264 encoders don't do temporal scalability and would fall back to software
      encodings: layers.map((l) => ({ scaleResolutionDownBy: l.scale, maxBitrate: l.maxBitrate, maxFramerate: l.fps, scalabilityMode: 'L1T1' })),
      stopTracks: false,
      appData: { kind, layers: layers.map(({ w, h, fps }) => ({ w, h, fps })) },
      onRtpSender: (s) => this.encrypt(s, 'H264'),
    });
    const sound = kind === 'screen' && stream.getAudioTracks()[0];
    if (sound) await this.publishSound(p, sound);
    if (this.pub[kind] !== p) return this.drop(p);
    this.startPreview(kind);
  }

  async publishSound(p, track) {
    const t = await this.sendTransport();
    p.audio = await t.produce({
      track,
      codecOptions: { opusStereo: true, opusDtx: false, opusFec: true, opusMaxAverageBitrate: 192_000 },
      stopTracks: false,
      appData: { kind: 'shareAudio' },
      onRtpSender: (s) => this.encrypt(s, 'opus'),
    });
  }

  // A new capture for a live share (another screen or window): the same producers, new tracks
  async replace(kind, stream, layers) {
    const p = this.pub[kind];
    if (!p || p.native) return this.publish(kind, stream, layers);
    p.stream = stream;
    await p.video.replaceTrack({ track: stream.getVideoTracks()[0] });
    await this.relayer(kind, layers);
    const sound = stream.getAudioTracks()[0];
    if (p.audio && sound) await p.audio.replaceTrack({ track: sound });
    else if (p.audio) (p.audio.close(), this.closeOnServer({ producerId: p.audio.id }), (p.audio = null));
    else if (sound && kind === 'screen') await this.publishSound(p, sound);
  }

  // Other sizes for the same encodings (a new tier, a new source)
  async relayer(kind, layers) {
    const p = this.pub[kind];
    if (!p || p.native || !p.video) return;
    p.layers = layers;
    const params = p.video.rtpSender.getParameters();
    params.encodings.forEach((e, i) => {
      const l = layers[Math.min(i, layers.length - 1)];
      Object.assign(e, { scaleResolutionDownBy: l.scale, maxBitrate: l.maxBitrate, maxFramerate: l.fps });
    });
    await p.video.rtpSender.setParameters(params).catch((e) => console.warn('sfu: layers', e.message));
    // A camera held to its lowest layer for a thin upload (checkUplink) still runs only that one
    const running = kind === 'camera' && this.uplink.weak ? layers.slice(0, 1) : layers;
    ask(this.socket, 'sfu:layers', { producerId: p.video.id, layers: running.map(({ w, h, fps }) => ({ w, h, fps })) });
  }

  // ----- publishing: the media sidecar -----

  // Resolves once the sidecar's share is connected to the SFU; rejects when it can't start or connect,
  // and the caller shares through the browser engine instead. `own`: the stream our own tile already shows, when
  // the same share is published again (republish), so the tile keeps it.
  async publishNative(kind, source, quality, own = null) {
    await this.ready;
    this.unpublish(kind, true, true);
    const p = (this.pub[kind] = { native: true, kind, source, quality, video: null, audio: null, transportId: null, stats: null, layers: [], own: own || new MediaStream(), preview: null });
    await new Promise((resolve, reject) => {
      p.settle = { resolve, reject };
      p.onEvent = (ev) => this.nativeEvent(p, ev).catch((e) => this.nativeFailed(p, e));
      nativeMedia.claim(kind, p.onEvent);
      nativeMedia.send({ op: 'start', kind, source, ...quality, key: { index: this.key.index, key: hex(this.key.raw) } });
      p.timer = setTimeout(() => reject(new Error('the share did not reach the server')), NATIVE_WAIT_MS);
    }).catch((e) => {
      this.unpublish(kind, true, true);
      throw e;
    });
    clearTimeout(p.timer);
    p.settle = null;
    this.watchOwn(p).catch((e) => console.warn('sfu: own tile', e.message));
    this.startPreview(kind);
  }

  nativeFailed(p, e) {
    if (p.settle) return p.settle.reject(e);
    this.nativeEnded(p, e.message);
  }

  async nativeEvent(p, ev) {
    if (this.pub[p.kind] !== p) return;
    if (ev.ev === 'error') throw new Error(ev.message || 'the capture failed');
    if (ev.ev === 'started') {
      const t = await this.transport('send', p.kind);
      p.transportId = t.id;
      nativeMedia.send({ op: 'connect', kind: p.kind, ice: t.iceParameters, candidates: t.iceCandidates, fingerprints: t.dtlsParameters.fingerprints });
      const c = await ask(this.socket, 'sfu:connect', { transportId: t.id, dtlsParameters: ev.publish.dtls });
      if (c.error) throw new Error(c.error);
      const v = await ask(this.socket, 'sfu:produce', { transportId: t.id, kind: p.kind, rtpParameters: ev.publish.video, layers: p.layers });
      if (v.error) throw new Error(v.error);
      p.video = { id: v.producerId };
      if (ev.publish.audio) {
        const a = await ask(this.socket, 'sfu:produce', { transportId: t.id, kind: 'shareAudio', rtpParameters: ev.publish.audio });
        if (!a.error) p.audio = { id: a.producerId };
      }
      if (p.connected) p.settle?.resolve();
    } else if (ev.ev === 'state') {
      // Started once it is both connected and a producer on the SFU, in whichever order those come
      p.connected = ev.state === 'connected';
      if (p.connected && p.video) p.settle?.resolve();
    } else if (ev.ev === 'stats') {
      p.stats = ev;
      // The layers' sizes, for the SFU to pick by (they follow the source and the tier). Only those that run:
      // one the upload can't carry is left out first, so the SFU moves its viewers down before it stops.
      const layers = (ev.layers || []).filter((l) => l.on).map((l) => ({ w: l.w, h: l.h, fps: l.rungFps }));
      if (p.video && JSON.stringify(layers) !== JSON.stringify(p.layers)) {
        p.layers = layers;
        ask(this.socket, 'sfu:layers', { producerId: p.video.id, layers });
      }
    } else if (ev.ev === 'quality' && ev.clamped) {
      this.ctx.onClamped?.(p.kind, ev.clamped);
    } else if (ev.ev === 'stopped') {
      if (p.settle) throw new Error(ev.reason || 'the share stopped');
      this.nativeEnded(p, ev.reason);
    }
  }

  // The sidecar's share ended by itself (the window closed, the sidecar died, the connection broke). A share
  // that only lost its connection is published again; anything else moves to the browser engine (onNativeLost).
  nativeEnded(p, reason) {
    if (this.pub[p.kind] !== p) return;
    this.unpublish(p.kind, true, true);
    if (/connection|did not answer|reach the server/i.test(reason || '') && this.socket.connected) this.republish(p.kind, p, reason);
    else this.ctx.onNativeLost(p.kind, p.source, reason);
  }

  // The same sidecar share again, from the same source, until it is connected or NATIVE_RETRY_FOR_MS have passed
  // (a link down for a while), further apart each time. Stopping the share meanwhile (unpublish) ends this.
  async republish(kind, p, reason) {
    const token = (this.renative[kind] = { since: Date.now() });
    for (let n = 0; ; n++) {
      await sleep(n ? RETRY_MS[Math.min(n - 1, RETRY_MS.length - 1)] : 1000);
      if (this.closed || this.renative[kind] !== token) return;
      if (!this.socket.connected || Date.now() - token.since > NATIVE_RETRY_FOR_MS) break;
      try {
        await this.publishNative(kind, p.source, p.quality, p.own);
        if (this.renative[kind] === token) this.renative[kind] = null;
        log.info(`sfu: the ${kind === 'screen' ? 'share' : 'camera'} is published again after ${Math.round((Date.now() - token.since) / 1000)} s`);
        return;
      } catch (e) {
        if (this.renative[kind] !== token) return;
        reason = e.message;
      }
    }
    if (this.renative[kind] !== token || this.closed) return;
    this.renative[kind] = null;
    this.ctx.onNativeLost(kind, p.source, reason);
  }

  setNativeQuality(kind, quality) {
    if (this.pub[kind]?.native) nativeMedia.send({ op: 'quality', kind, ...quality });
  }

  // Our own tile for a share the sidecar sends: its lowest layer, back from the SFU (decrypted with our own key)
  async watchOwn(p) {
    const recv = await this.recvTransport();
    const r = await ask(this.socket, 'sfu:consume', { producerId: p.video.id, rtpCapabilities: this.device.rtpCapabilities });
    if (r.error) throw new Error(r.error);
    const consumer = await recv.consume({ id: r.id, producerId: r.producerId, kind: r.kind, rtpParameters: r.rtpParameters, onRtpReceiver: (rv) => this.decrypt(rv, this.ctx.sid(), 'H264') });
    if (this.pub[p.kind] !== p) return consumer.close();
    p.ownConsumer = consumer;
    for (const old of p.own.getTracks()) p.own.removeTrack(old); // a share published again: the new track only
    p.own.addTrack(consumer.track);
    await ask(this.socket, 'sfu:resume', { consumerId: r.id });
    this.ctx.onChange(this.ctx.sid(), p.kind);
  }

  // What our own tile shows: the capture itself, or for a native share what comes back from the SFU
  own(kind) {
    const p = this.pub[kind];
    return p ? (p.native ? p.own : p.stream) : null;
  }

  // `again`: the share is about to be published again (republish), which this doesn't cancel
  unpublish(kind, quiet = false, again = false) {
    if (!again) this.renative[kind] = null;
    const p = this.pub[kind];
    if (!p) return;
    this.pub[kind] = null;
    this.drop(p);
    if (!quiet) this.ctx.onChange(this.ctx.sid(), kind);
  }

  drop(p) {
    clearInterval(p.previewTimer);
    p.previewVideo?.remove();
    clearTimeout(p.timer);
    if (p.native) {
      nativeMedia.release(p.kind, p.onEvent);
      nativeMedia.send({ op: 'stop', kind: p.kind });
      p.ownConsumer?.close();
      // Its transport, and with it what it carried (a server from before transportId closes the producers by id)
      if (p.transportId) {
        this.closeOnServer({ transportId: p.transportId, producerId: p.video?.id });
        if (p.audio) this.closeOnServer({ producerId: p.audio.id });
      }
    } else {
      for (const x of [p.video, p.audio]) {
        if (!x) continue;
        x.close();
        this.closeOnServer({ producerId: x.id });
      }
    }
  }

  // ----- an upload too thin for a screen and a camera (D71) -----

  async checkUplink() {
    const { screen: s, camera: c } = this.pub;
    const u = this.uplink;
    if (!s?.video || !c?.video) {
      if (u.weak && c?.video) await this.cameraLow(c, false);
      Object.assign(u, { weak: false, weakSince: null, strongSince: null });
      return;
    }
    const est = await this.uplinkEstimate();
    const sNeed = needsOf(s);
    const cNeed = needsOf(c);
    if (!Number.isFinite(est) || !sNeed.length || !cNeed.length) return;
    const lower = sNeed.slice(0, 2).reduce((a, x) => a + x, 0); // the screen's lower layers (both, when it has two)
    const now = Date.now();
    if (!u.weak) {
      if (est >= WEAK_ROOM * (lower + cNeed[0])) return void (u.weakSince = null);
      u.weakSince ??= now;
      if (now - u.weakSince < WEAK_FOR_MS) return;
      Object.assign(u, { weak: true, strongSince: null });
      log.info(`sfu: the upload (${(est / 1e6).toFixed(1)} Mbit/s) can't carry the screen and the camera; the camera is down to its lowest layer`);
      await this.cameraLow(c, true);
      if (!u.told) (u.told = true), this.ctx.onWeakUplink?.(true);
    } else {
      if (est < STRONG_ROOM * (lower + cNeed.reduce((a, x) => a + x, 0))) return void (u.strongSince = null);
      u.strongSince ??= now;
      if (now - u.strongSince < STRONG_FOR_MS) return;
      Object.assign(u, { weak: false, weakSince: null });
      log.info('sfu: the upload has room again; the camera is back to all its layers');
      await this.cameraLow(c, false);
      this.ctx.onWeakUplink?.(false);
    }
  }

  // The upload's estimate, in bits per second: the page's connection's (when it publishes anything) plus each
  // sidecar share's own; NaN when there is none yet
  async uplinkEstimate() {
    let est = 0;
    let any = false;
    if (['screen', 'camera'].some((k) => this.pub[k] && !this.pub[k].native) && this.send) {
      const stats = await (await this.send).getStats();
      const best = Math.max(...[...stats.values()].filter((r) => r.type === 'candidate-pair' && r.availableOutgoingBitrate > 0).map((r) => r.availableOutgoingBitrate));
      if (best > 0) (est += best), (any = true);
    }
    for (const p of [this.pub.screen, this.pub.camera]) if (p?.native && p.stats?.availMbps > 0) (est += p.stats.availMbps * 1e6), (any = true);
    return any ? est : NaN;
  }

  // The camera on its lowest layer only, or on all of them again. The SFU is told which run, so its viewers move first.
  async cameraLow(p, low) {
    if (p.native) return nativeMedia.send({ op: 'quality', kind: 'camera', ...(low ? LOW_CAMERA : p.quality) });
    const params = p.video.rtpSender.getParameters();
    params.encodings.forEach((e, i) => (e.active = !low || i === 0));
    await p.video.rtpSender.setParameters(params).catch((e) => console.warn('sfu: camera layers', e.message));
    ask(this.socket, 'sfu:layers', { producerId: p.video.id, layers: (low ? p.layers.slice(0, 1) : p.layers).map(({ w, h, fps }) => ({ w, h, fps })) });
  }

  // ----- watching -----

  produced(p) {
    this.producers.set(p.producerId, { sid: p.sid, kind: p.kind, layers: [] });
    const w = this.watching.get(`${p.sid}|${p.kind === 'shareAudio' ? 'screen' : p.kind}`);
    if (w) this.consume(w, p.producerId, p.kind).catch((e) => console.warn('sfu consume', e.message));
  }

  producerClosed({ producerId }) {
    const p = this.producers.get(producerId);
    this.producers.delete(producerId);
    for (const w of this.watching.values()) {
      const c = w.consumers.get(producerId);
      if (!c) continue;
      w.consumers.delete(producerId);
      w.stream.removeTrack(c.track);
      c.close();
      this.ctx.onChange(w.sid, w.kind);
    }
    void p;
  }

  async watch(sid, kind, on = true) {
    const key = `${sid}|${kind}`;
    const was = this.watching.get(key);
    if (!on) {
      if (!was) return;
      this.watching.delete(key);
      for (const c of was.consumers.values()) (c.close(), this.closeOnServer({ consumerId: c.id }));
      return;
    }
    if (was) return;
    const w = { sid, kind, stream: new MediaStream(), consumers: new Map(), layer: null, view: null, paused: false };
    this.watching.set(key, w);
    await this.ready;
    for (const [producerId, p] of this.producers) {
      if (p.sid === sid && (p.kind === kind || (kind === 'screen' && p.kind === 'shareAudio'))) await this.consume(w, producerId, p.kind).catch((e) => console.warn('sfu consume', e.message));
    }
  }

  async consume(w, producerId, kind) {
    if (w.consumers.has(producerId)) return;
    const recv = await this.recvTransport();
    const r = await ask(this.socket, 'sfu:consume', { producerId, rtpCapabilities: this.device.rtpCapabilities });
    if (r.error) throw new Error(r.error);
    const consumer = await recv.consume({ id: r.id, producerId, kind: r.kind, rtpParameters: r.rtpParameters, onRtpReceiver: (rv) => this.decrypt(rv, w.sid, r.kind === 'audio' ? 'opus' : 'H264') });
    if (this.watching.get(`${w.sid}|${w.kind}`) !== w || !this.producers.has(producerId)) return (consumer.close(), this.closeOnServer({ consumerId: r.id }));
    w.consumers.set(producerId, consumer);
    w.stream.addTrack(consumer.track);
    // A screen share plays a little behind live, so a short stall in the network doesn't freeze it (D71); its sound,
    // in the same stream, keeps in sync. A camera is part of a conversation and stays close to real time.
    const buffer = consumer.kind === 'video' ? this.buffer[w.kind] : null;
    if (buffer != null && 'jitterBufferTarget' in consumer.rtpReceiver) consumer.rtpReceiver.jitterBufferTarget = buffer;
    if (consumer.kind === 'video' && w.view) ask(this.socket, 'sfu:view', { consumerId: consumer.id, ...w.view });
    if (!(consumer.kind === 'video' && w.paused)) await ask(this.socket, 'sfu:resume', { consumerId: consumer.id });
    this.ctx.onChange(w.sid, w.kind);
    void kind;
  }

  // The tile's size in device pixels picks the layer (on the server); a hidden window pauses the video. `focus`:
  // the stream the stage shows large, which the server serves first when the link can't carry everything (D71).
  view(sid, kind, { w = 0, h = 0, hidden = false, focus = false } = {}) {
    const x = this.watching.get(`${sid}|${kind}`);
    if (!x) return;
    x.view = w && h ? { w: Math.round(w), h: Math.round(h), focus: !!focus } : x.view;
    for (const c of x.consumers.values()) {
      if (c.kind !== 'video') continue; // a minimized stream is still heard
      if (hidden !== x.paused) ask(this.socket, hidden ? 'sfu:pause' : 'sfu:resume', { consumerId: c.id });
      if (x.view && !hidden) ask(this.socket, 'sfu:view', { consumerId: c.id, ...x.view });
    }
    x.paused = hidden;
  }

  mediaOf(sid, kind) {
    const w = this.watching.get(`${sid}|${kind}`);
    return w?.stream.getVideoTracks().length || (kind === 'screen' && w?.stream.getTracks().length) ? w.stream : null;
  }

  // Whether `sid` publishes `kind` through the SFU right now
  publishes(sid, kind) {
    for (const p of this.producers.values()) if (p.sid === sid && p.kind === kind) return true;
    return false;
  }

  // ----- stats -----

  // The consumer's receiver stats for someone's stream, and the layer the SFU sends
  async receiver(sid, kind) {
    const w = this.watching.get(`${sid}|${kind}`);
    const c = w && [...w.consumers.values()].find((x) => x.kind === 'video');
    if (!c) return null;
    const recv = await this.recv;
    return { stats: await c.getStats(), transport: () => recv.getStats(), layer: w.layer, view: w.view, paused: w.paused, starved: !!w.starved, buffer: c.rtpReceiver?.jitterBufferTarget ?? null };
  }

  // Whether the server paused this stream for us because our link can't carry it with the rest (D71): the tile
  // shows its preview still instead of a frozen frame
  starved(sid, kind) {
    return !!this.watching.get(`${sid}|${kind}`)?.starved;
  }

  // One entry per layer of our own share, in the shape of the stats panel's sender rows
  async sender(kind) {
    const p = this.pub[kind];
    if (!p) return [];
    if (p.native) {
      const s = p.stats;
      if (!s) return [];
      return s.layers.map((l) => ({
        layer: l.rid,
        native: true,
        codec: 'H264',
        hw: l.hw,
        impl: l.impl,
        w: l.w,
        h: l.h,
        fps: l.fps,
        rungFps: l.rungFps,
        mbps: l.mbps,
        sentMbps: l.sentMbps,
        needMbps: l.needMbps,
        encMs: l.encMs,
        encP90: l.encP90,
        // Why the layer is off or slowed: the upload ('bandwidth') or the encoders ('encoder'), D71
        limit: l.limit || undefined,
        sendErrors: s.sendErrors,
        note: l.note,
        paused: !l.on,
        capW: s.capW,
        capH: s.capH,
        capFps: s.capFps,
        availMbps: s.availMbps,
        rtt: s.rtt,
        loss: s.loss,
        nack: s.nack,
        pli: s.pli,
        cand: s.cand,
        mode: s.mode,
        clamped: s.clamped,
      }));
    }
    if (!p.video) return [];
    const stats = await p.video.getStats();
    return { stats, transport: async () => (await this.send).getStats(), layers: p.layers };
  }

  // ----- previews -----

  // A preview key for this share, sealed to everyone who can see the channel (the server says who), and a
  // still of our own tile every 10 s
  async startPreview(kind) {
    const p = this.pub[kind];
    if (!p) return;
    const raw = newMediaKey();
    p.preview = { raw, key: await importMediaKey(raw) };
    const viewers = await ask(this.socket, 'sfu:preview:viewers');
    if (this.pub[kind] !== p) return;
    for (const sid of viewers.sids || []) this.sealPreviewKey(sid, kind).catch(() => {});
    const shoot = () => this.snapshot(p).catch((e) => console.debug('sfu preview', e.message));
    setTimeout(shoot, 1500); // the first frames take a moment
    p.previewTimer = setInterval(shoot, PREVIEW_EVERY_MS);
  }

  async sealPreviewKey(sid, kind) {
    const p = this.pub[kind];
    const u = this.ctx.user(sid);
    if (!p?.preview || !u?.card) return;
    const pk = await this.ring.with(u.card);
    const blob = await sealJson(pk, `${PREVIEW_KEY_AAD}|${this.ctx.serverId()}|${this.ctx.profile().id}|${u.id}`, { kind, k: b64(p.preview.raw) });
    this.socket.emit('sfu:preview:key', { to: sid, blob });
  }

  async snapshot(p) {
    const stream = this.own(p.kind);
    if (!stream?.getVideoTracks().length || this.pub[p.kind] !== p) return;
    if (!p.previewVideo) {
      p.previewVideo = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
      p.previewVideo.srcObject = stream;
      await p.previewVideo.play().catch(() => {});
      await sleep(300);
    }
    const v = p.previewVideo;
    if (!v.videoWidth) return;
    const canvas = Object.assign(document.createElement('canvas'), { width: PREVIEW_W, height: PREVIEW_H });
    const g = canvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
    const s = Math.min(PREVIEW_W / v.videoWidth, PREVIEW_H / v.videoHeight);
    const [dw, dh] = [v.videoWidth * s, v.videoHeight * s];
    g.drawImage(v, (PREVIEW_W - dw) / 2, (PREVIEW_H - dh) / 2, dw, dh);
    let pic = null;
    for (const [type, q] of [['image/webp', 0.7], ['image/webp', 0.45], ['image/jpeg', 0.5], ['image/jpeg', 0.3]]) {
      pic = await new Promise((r) => canvas.toBlob(r, type, q));
      if (pic && pic.size <= PREVIEW_MAX) break;
      pic = null;
    }
    if (!pic || this.pub[p.kind] !== p) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = new TextEncoder().encode(`${PREVIEW_AAD}|${this.ctx.serverId()}|${this.ctx.sid()}|${p.kind}`);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, p.preview.key, await pic.arrayBuffer()));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    this.socket.emit('sfu:preview', { kind: p.kind, blob: b64(out) });
  }

  // ----- a worker died on the server, or a connection couldn't be restarted: start over -----

  // One at a time: a publishing and a watching connection that fail together start over once
  reset(why = 'the server restarted its media relay') {
    if (this.closed) return Promise.resolve();
    this.resetting ||= this.startOver(why).finally(() => (this.resetting = null));
    return this.resetting;
  }

  async startOver(why) {
    log.warn(`sfu: ${why}; publishing and watching again`);
    const pubs = { ...this.pub };
    const watching = [...this.watching.values()];
    for (const kind of ['screen', 'camera']) if (this.pub[kind]) this.unpublish(kind, true);
    for (const w of watching) for (const c of w.consumers.values()) c.close();
    this.watching.clear();
    this.producers.clear();
    Promise.resolve(this.send).then((t) => t?.close()).catch(() => {});
    Promise.resolve(this.recv).then((t) => t?.close()).catch(() => {});
    this.send = this.recv = null;
    this.device = null;
    this.ready = this.start();
    await this.ready;
    const list = await ask(this.socket, 'sfu:list');
    for (const p of list.producers || []) this.producers.set(p.producerId, p);
    for (const kind of ['screen', 'camera']) {
      const p = pubs[kind];
      if (!p) continue;
      if (p.native) this.republish(kind, p, why);
      else this.publish(kind, p.stream, p.layers).catch((e) => log.warn(`sfu: could not publish again: ${e.message}`));
    }
    for (const w of watching) {
      await this.watch(w.sid, w.kind, true);
      if (w.view) this.view(w.sid, w.kind, { ...w.view, hidden: w.paused });
    }
    for (const w of watching) this.ctx.onChange(w.sid, w.kind);
  }
}

// The hover card's previews, for one connection (in a call there or not). ctx: { socket, serverId(), profile(), user(sid) }
export class Previews {
  constructor(ctx) {
    this.ctx = ctx;
    this.keys = new Map(); // "<sid>|<kind>" -> CryptoKey
    this.waiting = new Map(); // sid -> resolve functions for a key that was asked for
    this.ring = keyring(ctx.profile);
    ctx.socket.on('sfu:preview:key', (m) => this.keyFrom(m).catch((e) => console.debug('preview key', e.message)));
  }

  async keyFrom({ from, blob }) {
    const u = this.ctx.user(from);
    if (!u?.card || typeof blob !== 'string') return;
    const pk = await this.ring.with(u.card);
    const { kind, k } = await unsealJson(pk, `${PREVIEW_KEY_AAD}|${this.ctx.serverId()}|${u.id}|${this.ctx.profile().id}`, blob);
    if (kind !== 'screen' && kind !== 'camera') return;
    this.keys.set(`${from}|${kind}`, await importMediaKey(unb64(String(k))));
    for (const done of this.waiting.get(from) || []) done();
    this.waiting.delete(from);
  }

  // The newest still of `sid`'s `kind`, as { url, ts } (an object URL the caller revokes), or null
  async get(sid, kind, again = true) {
    let key = this.keys.get(`${sid}|${kind}`);
    if (!key) {
      // No key yet: we came online after the share started, or were just let into the channel
      const got = new Promise((r) => (this.waiting.get(sid) || this.waiting.set(sid, []).get(sid)).push(r));
      this.ctx.socket.emit('sfu:preview:want', { sid });
      await Promise.race([got, sleep(2000)]);
      key = this.keys.get(`${sid}|${kind}`);
      if (!key) return null;
    }
    const r = await ask(this.ctx.socket, 'sfu:preview:get', { sid, kind });
    if (!r.ok) return null;
    try {
      const bytes = unb64(r.blob);
      const additionalData = new TextEncoder().encode(`${PREVIEW_AAD}|${this.ctx.serverId()}|${sid}|${kind}`);
      const pic = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData }, key, bytes.subarray(12));
      return { url: URL.createObjectURL(new Blob([pic])), ts: r.ts };
    } catch {
      // A key from their previous share: ask for this one's, once
      this.keys.delete(`${sid}|${kind}`);
      return again ? this.get(sid, kind, false) : null;
    }
  }

  // A share ended: its key goes
  forget(sid) {
    for (const k of [...this.keys.keys()]) if (k.startsWith(sid + '|')) this.keys.delete(k);
  }
}
