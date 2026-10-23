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
//
// On a server with an SFU (D70) that is how shares and cameras travel in a voice
// channel instead: published once, as simulcast, end-to-end encrypted, and
// forwarded by the server (sfu.js, this.sfu). The methods below (setMedia,
// setNativeMedia, watch, view, mediaOf, videoStats, …) take that path whenever
// there is a session and the other side's app can use it, so the stage doesn't
// need to know. The mesh path stays for DM calls, for servers without an SFU, and
// for watching a share from an app that predates it. The media sidecar (D45)
// publishes only to an SFU.
import { log } from './log.js';
import { audio, Level, MAX_USER_VOLUME } from './audio.js';
import { SfuSession } from './sfu.js';
import { settings } from './store.js';

export const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

// Capture ceilings. Screens stop at 1440p60 (see TIERS). Cameras ask for
// 1080p60 by default (4K webcam modes cost a lot to capture and rarely look
// better in a tile) but may go up to 4K at 120 fps. What each viewer actually
// gets is set per viewer (see applyView) and by WebRTC's bandwidth estimate.
export const MEDIA = {
  screen: { width: 2560, height: 1440, fps: 60 },
  camera: { width: 3840, height: 2160, fps: 120, ideal: { width: 1920, height: 1080, fps: 60 } },
};
export const KINDS = ['screen', 'camera'];
// What the sidecar may capture a camera at: the camera's own best mode up to this
export const NATIVE_CAMERA = { width: 2560, height: 1440, fps: 60 };

// Screen share quality tiers: the ceiling for capture and for what any viewer
// gets. "auto" is what the bandwidth ladder (below) climbs to by default, and
// nothing goes above MEDIA.screen. A saved tier that no longer exists (the old
// 4K120 "source") falls back to "auto".
export const TIERS = {
  auto: MEDIA.screen,
  '720p30': { width: 1280, height: 720, fps: 30 },
  '1080p60': { width: 1920, height: 1080, fps: 60 },
  '1440p60': { width: 2560, height: 1440, fps: 60 },
  // Opt-in, and only through the media sidecar with a hardware encoder (D70): the browser engine and
  // software encoding are held to 1440p60 (BROWSER_TIER)
  '2160p60': { width: 3840, height: 2160, fps: 60 },
};
// What a tier is on the browser engine's path
const BROWSER_TIER = (tier) => (tier === '2160p60' ? '1440p60' : tier);
// smooth: games and video, keep the frame rate. sharp: text and code, keep the
// pixels and drop frames instead. bpp is the bits per pixel a rung needs to look clean.
export const MODES = {
  smooth: { hint: 'motion', degrade: 'maintain-framerate', bpp: 0.04, maxFps: Infinity },
  sharp: { hint: 'detail', degrade: 'maintain-resolution', bpp: 0.02, maxFps: 30 },
};
// Voice is sent as the best Opus there is (D38): fullband stereo at the
// codec's highest bitrate, with in-band FEC, and without DTX so quiet moments
// aren't cut out. A receiver's SDP tells the sender what to encode, so these
// are written into both descriptions (see tuneOpus): ours makes a friend send
// us this, theirs makes us send it to them, whichever app version they run.
const OPUS = { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: 510000, maxplaybackrate: 48000, useinbandfec: 1, usedtx: 0, cbr: 0 };
// A server's voice quality (Settings → Server): the bitrate each of us sends
// our voice at in its channels. It is a cap on the sender, so changing it
// needs no renegotiation. DM calls always use "max".
export const AUDIO_QUALITY = { low: 32_000, standard: 64_000, high: 128_000, max: OPUS.maxaveragebitrate };

// Write OPUS into the fmtp line of every Opus payload type in an SDP
export function tuneOpus(sdp) {
  for (const pt of new Set([...sdp.matchAll(/^a=rtpmap:(\d+) opus\/48000\/2/gim)].map((m) => m[1]))) {
    const had = (old) => Object.fromEntries(old.split(';').filter(Boolean).map((kv) => kv.trim().split('=')));
    const write = (old = '') => `a=fmtp:${pt} ` + Object.entries({ ...had(old), ...OPUS }).map(([k, v]) => `${k}=${v}`).join(';');
    const fmtp = new RegExp(`^a=fmtp:${pt} (.*)$`, 'gm');
    sdp = fmtp.test(sdp) ? sdp.replace(fmtp, (_, old) => write(old)) : sdp.replace(new RegExp(`^a=rtpmap:${pt} opus.*$`, 'gim'), (line) => `${line}\r\n${write()}`);
  }
  return sdp;
}

// What a kind may be captured and sent at. Cameras keep the MEDIA ceiling.
const ceilingOf = (kind, tier) => (kind === 'camera' ? MEDIA.camera : TIERS[BROWSER_TIER(tier)] || TIERS.auto);

// Codec order for screen and camera tracks. A mesh runs one encoder per
// viewer, so a hardware encoder (Apple VideoToolbox, Intel Quick Sync, NVENC,
// AMF) is what keeps several viewers or streams from pinning the CPU, and
// H.264 is the codec that has one almost everywhere. Which codecs this machine
// really encodes in hardware is probed (see below) and the order follows it;
// until a probe has finished, or where the browser can't tell, the fixed order
// FIXED_ORDER applies. Negotiation drops anything the viewer can't decode and
// falls through to the next entry.
const FIXED_ORDER = [
  (c) => c.mimeType === 'video/H264' && /profile-level-id=64/.test(c.sdpFmtpLine) && /packetization-mode=1/.test(c.sdpFmtpLine), // High
  (c) => c.mimeType === 'video/H264' && /packetization-mode=1/.test(c.sdpFmtpLine),
  (c) => c.mimeType === 'video/VP9',
  (c) => c.mimeType === 'video/AV1',
  (c) => c.mimeType === 'video/VP8',
];
const fixedRank = (c) => {
  const i = FIXED_ORDER.findIndex((f) => f(c));
  if (i >= 0) return i;
  return c.mimeType === 'video/H265' ? FIXED_ORDER.length : FIXED_ORDER.length + 1; // then rtx/red/ulpfec
};

// What to ask mediaCapabilities about. contentType strings Chromium accepts for
// type 'webrtc' are an RTP mime type with its fmtp parameters; MSE-style
// ("avc1.64002a", "codecs=") ones are rejected. A bare "video/H264" is judged
// as baseline, which is software on Apple and others, so H.264 is asked per profile.
// `of` picks the probe for a codec from RTCRtpSender.getCapabilities / getParameters.
const PROBES = [
  { key: 'H264High', type: 'video/H264;profile-level-id=64002a;packetization-mode=1', of: (c) => c.mimeType === 'video/H264' && /profile-level-id=64/.test(c.sdpFmtpLine) && /packetization-mode=1/.test(c.sdpFmtpLine) },
  { key: 'H264Main', type: 'video/H264;profile-level-id=4d002a;packetization-mode=1', of: (c) => c.mimeType === 'video/H264' && /profile-level-id=4d/.test(c.sdpFmtpLine) && /packetization-mode=1/.test(c.sdpFmtpLine) },
  { key: 'H264', type: 'video/H264;profile-level-id=42e01f;packetization-mode=1', of: (c) => c.mimeType === 'video/H264' && /packetization-mode=1/.test(c.sdpFmtpLine) },
  { key: 'H265', type: 'video/H265', of: (c) => c.mimeType === 'video/H265' },
  { key: 'VP9', type: 'video/VP9;profile-id=0', of: (c) => c.mimeType === 'video/VP9' },
  { key: 'AV1', type: 'video/AV1;profile=0', of: (c) => c.mimeType === 'video/AV1' },
  { key: 'VP8', type: 'video/VP8', of: (c) => c.mimeType === 'video/VP8' },
];
const probeOf = (c) => PROBES.find((p) => p.of(c)); // High is listed before the catch-all H264
const HW_SMOOTH = ['H264High', 'H264Main', 'H264', 'AV1', 'H265', 'VP9']; // hardware first, in this order
const isH264 = (c) => c.mimeType === 'video/H264';

// bucket "WxH@fps" -> { key -> { supported, smooth, powerEfficient } }, or a
// promise while the probe runs. Module level: the answer belongs to the
// machine, not the call.
const probed = new Map();
// H.264 turned out to be software encoded although the probe said hardware
// (see VoiceClient.guard). Remembered for the rest of the session, per kind:
// the screen and the camera can differ.
const h264Software = { screen: false, camera: false };

const bucketOf = (kind, tier, mode) => {
  const cap = kind === 'camera' ? MEDIA.camera.ideal : ceilingOf(kind, tier);
  return `${cap.width}x${cap.height}@${Math.min(cap.fps, MODES[mode].maxFps)}`;
};

// Probe every codec at one size and fps, once. Never throws.
function probe(bucket) {
  if (probed.has(bucket) || !navigator.mediaCapabilities?.encodingInfo) return;
  const [, w, h, fps] = bucket.match(/(\d+)x(\d+)@(\d+)/).map(Number);
  const bitrate = bitrateFor(w, h, fps);
  const ask = (p) =>
    navigator.mediaCapabilities
      .encodingInfo({ type: 'webrtc', video: { contentType: p.type, width: w, height: h, bitrate, framerate: fps } })
      .then((r) => [p.key, { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient }])
      .catch(() => [p.key, null]);
  const run = Promise.all(PROBES.map(ask)).then((all) => probed.set(bucket, Object.fromEntries(all)));
  probed.set(bucket, run);
  run.catch(() => probed.delete(bucket));
}

// Codecs best first for a kind and mode, from the probe for this size when it
// has finished, else the fixed order. `list` is RTCRtpSender.getCapabilities
// codecs or a sender's negotiated ones. Sorting is stable, so entries with the
// same score keep the browser's order.
function rankCodecs(list, kind, tier, mode, h264Soft = h264Software[kind]) {
  const res = probed.get(bucketOf(kind, tier, mode));
  if (!res || typeof res.then === 'function') return [...list].sort((a, b) => fixedRank(a) - fixedRank(b));
  const sharp = mode === 'sharp';
  const tail = (c) => (isH264(c) && !/packetization-mode=1/.test(c.sdpFmtpLine) ? 6 : fixedRank(c)); // rtx/red/ulpfec and mode 0
  const score = (c) => {
    const p = probeOf(c);
    const r = p && res[p.key];
    if (!p || !r) return 100 + tail(c);
    const hw = r.powerEfficient && !(h264Soft && isH264(c));
    if (sharp) {
      if (p.key === 'AV1' && r.smooth) return 0;
      if (hw && p.key.startsWith('H264')) return 1 + (p.key === 'H264High' ? 0 : 1);
      if (hw && p.key === 'H265') return 3;
      if (p.key === 'VP9' && r.smooth) return 4;
      return 10 + tail(c);
    }
    if (hw && HW_SMOOTH.includes(p.key)) return HW_SMOOTH.indexOf(p.key);
    if (r.smooth && !isH264(c)) return 10 + ['VP9', 'VP8', 'AV1'].indexOf(p.key);
    if (isH264(c)) return 20;
    return 30 + tail(c);
  };
  return [...list].sort((a, b) => score(a) - score(b));
}

function preferCodecs(transceiver, kind, tier, mode) {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!caps || !transceiver.setCodecPreferences) return;
  try {
    transceiver.setCodecPreferences(rankCodecs(caps, kind, tier, mode));
  } catch (e) {
    console.warn('rtc codec preferences', e);
  }
}

// Relative bits a codec needs for the same picture, times the mode's bpp (see
// rungNeed). Starting values to be tuned from measurements, not measured ones.
// maxBitrate (bitrateFor) is deliberately not scaled: the ceiling stays.
const CODEC_EFFICIENCY = { H264: 1.0, VP8: 1.1, VP9: 0.75, H265: 0.7, AV1: 0.65 };
const bppFor = (mode, codec) => MODES[mode].bpp * (CODEC_EFFICIENCY[codec] ?? 1);

// Bitrate ceiling for w×h at fps: ~0.06 bits per pixel suits H.264 on screen
// content and motion (1080p60 ≈ 7.5 Mbps, 1440p60 ≈ 13 Mbps; capped at 50 Mbps). Below
// 30 fps each frame needs more bits, hence the floor. It is a ceiling only; the
// bandwidth estimate decides what is actually sent.
const bitrateFor = (w, h, fps) => Math.round(Math.min(50e6, Math.max(2.5e6, w * h * Math.max(fps, 30) * 0.06)));

// ----- bandwidth and load ladder -----
// Each viewer's encoder sits on a rung (height, fps) that the sampler moves up
// and down from the sender stats. Tuning, all in one place:
const LADDER_HEIGHTS = [2160, 1440, 1080, 720, 540, 360]; // smooth rungs at or below the ceiling
const SHARP_FPS = [30, 15, 8]; // sharp keeps full size and drops frames first
const SHARP_LOW_FPS = 8; // then lower heights at this rate
const LOW_FPS = 30; // smooth's last rung, when the tier is faster than this
const DOWN_FIT = 0.85; // target below this share of a rung's need means it does not fit
const DOWN_SAMPLES = 2; // consecutive samples before a bitrate step down
const USING_BUDGET = 0.7; // sent / target at least this: the encoder really is bitrate-bound
const UP_HEADROOM = 1.15; // target needed, as a multiple of the next rung's need, to climb
const APP_LIMITED = 0.6; // sent / target below this: the app, not bits, is the limit (static content)
const UP_SAMPLES = 3; // consecutive samples before a step up
const LOAD_FPS = 0.7; // encoded fps below this share of capture and rung fps: encoder can't keep up
const LOAD_SAMPLES = 3; // consecutive samples before a load step down
const SETTLE_MS = 2000; // ignore samples this long after a step; the encoder is still reconfiguring
const BITRATE_HOLD_MS = 8000; // no step up this long after a bitrate step down
const LOAD_HOLD_MS = 20000; // ...and after a load step down
const SOFT_SAMPLES = 5; // consecutive samples of software H.264 before the probe is overruled
const NEED_MIN_FPS = 30; // a rung is costed at the source's real frame rate, but not below this
const SRC_FPS_DECAY = 0.9; // per sample; the source rate is a decaying peak so a pause in motion doesn't flap the rung

// Scale (>= the given one's neighbourhood) at which width/scale and height/scale
// both come out even: the hardware H.264 encoder rejects odd frame sizes. The
// nearest even width whose proportional height is an even integer (within
// rounding) wins; the given scale when none is found.
export function evenScale(width, height, scale) {
  const w0 = Math.round(width / scale / 2) * 2;
  for (let d = 0; d <= 32; d += 2) {
    for (const w of d ? [w0 - d, w0 + d] : [w0]) {
      const hh = (height * w) / width;
      const r = Math.round(hh);
      if (w > 0 && w <= width && r % 2 === 0 && Math.abs(hh - r) < 0.2 && Math.floor(hh) === r) return width / w;
    }
  }
  return scale;
}
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
// Mbps a rung needs. `srcFps` is what the source really delivers (see
// ladderStep): a 120 fps tier on a screen that produces 35 frames a second
// needs the bits for 35, not 120. Without it the rung's own rate is used.
const rungNeed = (r, bpp, srcFps) => (r.w * r.h * (srcFps ? Math.min(r.fps, Math.max(NEED_MIN_FPS, srcFps)) : r.fps) * bpp) / 1e6;

// Best rung whose need (times headroom) fits the target bitrate; the lowest when none does
function ladderFit(rungs, bpp, target, headroom = 1, srcFps) {
  for (let i = 0; i < rungs.length; i++) if (rungNeed(rungs[i], bpp, srcFps) * headroom <= target) return i;
  return rungs.length - 1;
}

// Rungs from best to worst for a ceiling of w×h at up to fps
export function ladderRungs(mode, w, h, fps) {
  const at = (hh, f) => ({ w: even((hh * w) / h), h: even(hh), fps: f });
  if (mode === 'sharp') {
    const top = [...new Set(SHARP_FPS.map((f) => Math.min(f, fps)))].filter((f) => f <= fps);
    const lower = LADDER_HEIGHTS.filter((x) => x < h);
    return [...top.map((f) => at(h, f)), ...lower.map((x) => at(x, Math.min(SHARP_LOW_FPS, fps)))];
  }
  const heights = [h, ...LADDER_HEIGHTS.filter((x) => x < h)];
  const rungs = heights.map((x) => at(x, fps));
  if (fps > LOW_FPS) rungs.push(at(heights.at(-1), LOW_FPS));
  return rungs;
}

// The simulcast layers the browser engine publishes to the SFU (D70), lowest first: 360p, then 720p (1080p
// under a taller ceiling), then the ceiling, as the sidecar's ladder::layers does. `smooth` keeps the frame
// rate above the lowest layer; `sharp` runs its best layer at 30 and the others at 15. Each is
// { w, h, fps, scale (of the track), maxBitrate }.
export function simulcastLayers(kind, track, { tier, mode }) {
  const cap = ceilingOf(kind, tier);
  const set = track?.getSettings() || {};
  const width = set.width || cap.width;
  const height = set.height || cap.height;
  const top = Math.min(1, cap.width / width, cap.height / height); // fit inside the ceiling
  const H = even(height * top);
  const fps = Math.min(set.frameRate || cap.fps, kind === 'camera' ? MEDIA.camera.ideal.fps : cap.fps);
  const sharp = kind === 'screen' && mode === 'sharp';
  const heights = [H > 360 && 360, H > 1440 ? 1080 : H > 720 ? 720 : 0, H].filter(Boolean);
  return heights.map((h, i) => {
    const last = i === heights.length - 1;
    const f = sharp ? Math.min(fps, last ? 30 : 15) : i === 0 && heights.length > 1 ? Math.min(fps, 30) : fps;
    const scale = evenScale(width, height, height / h);
    const w = even(width / scale);
    return { w, h: even(height / scale), fps: f, scale, maxBitrate: bitrateFor(w, even(height / scale), f) };
  });
}

// One decision per second for one viewer. `st` is { idx, down, load, up, hold,
// settle, srcFps } (idx null until the first usable target; srcFps the recent
// peak of the capture's real frame rate), `s` the sender sample
// ({ mbps, sentMbps, capFps, fps, encMs, limit }), `rungs` from ladderRungs,
// `now` in ms. Returns the new state; pure so it can be driven with synthetic samples.
export function ladderStep(st, s, rungs, bpp, now) {
  const srcFps = s.capFps > 0 ? Math.max(s.capFps, (st.srcFps || 0) * SRC_FPS_DECAY) : st.srcFps;
  st = { ...st, srcFps };
  const last = rungs.length - 1;
  const need = (r) => rungNeed(r, bpp, srcFps);
  const fit = (target, headroom) => ladderFit(rungs, bpp, target, headroom, srcFps);
  const target = s.mbps > 0 ? s.mbps : 0;
  const sent = s.sentMbps;
  if (st.idx == null) return target ? { ...st, idx: fit(target), settle: now + SETTLE_MS } : st;
  const idx = Math.min(st.idx, last);
  const cur = rungs[idx];
  if (now < st.settle) return { ...st, idx, down: 0, load: 0, up: 0 };
  const interval = 1000 / cur.fps;
  const overloaded = s.limit === 'cpu' || (s.fps != null && s.capFps && s.encMs != null && s.fps < LOAD_FPS * Math.min(s.capFps, cur.fps) && s.encMs > interval);
  const bound = !!target && sent != null && target < DOWN_FIT * need(cur) && sent >= USING_BUDGET * target;
  const load = overloaded ? st.load + 1 : 0;
  const down = bound ? st.down + 1 : 0;
  const stepped = (i, hold) => ({ ...st, idx: i, down: 0, load: 0, up: 0, hold: now + hold, settle: now + SETTLE_MS });
  if (load >= LOAD_SAMPLES && idx < last) return stepped(idx + 1, LOAD_HOLD_MS);
  if (down >= DOWN_SAMPLES && idx < last) return stepped(Math.max(idx + 1, fit(target)), BITRATE_HOLD_MS);
  let up = 0;
  if (idx > 0 && now >= st.hold && !load) {
    const byRate = !!target && target >= UP_HEADROOM * need(rungs[idx - 1]);
    const appLimited = !!target && sent != null && sent < APP_LIMITED * target && s.limit !== 'cpu';
    up = byRate || appLimited ? st.up + 1 : 0;
    if (up >= UP_SAMPLES) return stepped(byRate ? fit(target, UP_HEADROOM) : idx - 1, 0);
  }
  return { ...st, idx, down, load, up };
}

// Per-second rate of a counter between two samples (scaled), or null
function rate(cur, prev, key, scale = 1) {
  const dt = prev && (cur.t - prev.t) / 1000;
  return dt > 0 && cur[key] != null && prev[key] != null && cur[key] >= prev[key] ? ((cur[key] - prev[key]) / dt) * scale : null;
}

// Delta of one counter per delta of another (e.g. encode time per frame), or null
function ratio(cur, prev, num, den, scale = 1) {
  const d = prev && cur[den] - prev[den];
  return d > 0 && cur[num] != null && prev[num] != null && cur[num] >= prev[num] ? ((cur[num] - prev[num]) / d) * scale : null;
}

export class VoiceClient {
  // isPeer(sid): whether the server lists that socket in our voice channel. A call is only taken from
  // someone it does: the server passes signals on, and without this a socket nobody can see in the
  // channel could offer us a connection and be sent our voice.
  constructor(socket, { onPeersChange, onMediaChange, isPeer } = {}) {
    this.socket = socket;
    this.isPeer = isPeer || (() => true);
    this.channelId = null;
    // sid -> { pc, audioEl, analyser, setGain, dispose, chain, state, polite,
    //          out: { kind -> transceivers sending our media to them },
    //          in: { kind -> { id, stream } they send us } }
    this.peers = new Map();
    this.statPrev = new Map(); // videoStats() previous samples: "out|in|<sid>|<kind>" -> counters
    this.deafened = false;
    this.audioQuality = 'max'; // a key of AUDIO_QUALITY (setAudioQuality)
    this.local = { screen: null, camera: null }; // our own captures (MediaStream); for a native share, what comes back from the SFU
    // A share the sidecar carries (D70): { source }
    this.native = { screen: null, camera: null };
    // The SFU (D70): a session while we are in a voice channel on a server that has one. The app sets
    // `useSfu` from the server's hello and `sfuInfo()` to what the session needs to know about the
    // connection ({ serverId(), profile(), user(sid) }). The app also sets a hook on the class:
    //   VoiceClient.onNativeLost(voice, kind, source, reason): the sidecar's share ended by itself
    this.sfu = null;
    this.useSfu = false;
    this.sfuInfo = null;
    this.quality = { screen: { tier: 'auto', mode: 'smooth' }, camera: { tier: 'camera', mode: 'smooth' } };
    this.latest = { screen: [], camera: [] }; // latest per-viewer samples from the sampler
    this.sampler = null; // 1 s interval while any media is being sent
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
    if (this.useSfu && this.sfuInfo && res.producers) this.openSfu(res.producers);
    // The newcomer calls everyone already in the room.
    for (const sid of res.peers) this.call(sid);
  }

  openSfu(producers) {
    const info = this.sfuInfo();
    const channelId = this.channelId;
    this.sfu = new SfuSession(
      {
        ...info,
        socket: this.socket,
        channelId,
        sid: () => this.socket.id,
        members: () => info.users().filter((u) => u.voice === channelId && u.sid !== this.socket.id).map((u) => u.sid),
        onChange: (sid, kind) => this.onMediaChange(sid, kind),
        onNativeLost: (kind, source, reason) => {
          const was = this.native[kind];
          this.stopMedia(kind, true);
          if (was && VoiceClient.onNativeLost) VoiceClient.onNativeLost(this, kind, source, reason);
          else this.emitMedia();
        },
        onClamped: (kind, tier) => VoiceClient.onClamped?.(this, kind, tier),
      },
      producers
    );
  }

  // Whether `sid`'s app shares and watches through the SFU (one from before it watches the old way)
  viaSfu(sid) {
    return !!this.sfu && !!this.sfuInfo?.().user(sid)?.sfu;
  }

  // Who is in the channel changed (the app calls this on every `users`): the session's keys follow it
  usersChanged() {
    this.sfu?.membersChanged().catch((e) => console.warn('sfu members', e.message));
  }

  async leave(silent = false) {
    if (!this.channelId) return;
    for (const sid of [...this.peers.keys()]) this.dropPeer(sid);
    if (!silent) this.socket.emit('voice:leave');
    this.channelId = null;
    for (const kind of KINDS) this.stopMedia(kind, true);
    this.sfu?.close();
    this.sfu = null;
    audio.stopMic();
  }

  destroy() {
    this.leave();
    this.stopSampler();
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
      viewed: { screen: null, camera: null }, // the same, for their media as we last reported it to them
      ladder: { screen: null, camera: null }, // our encoder's rung for them (see ladderStep)
      codec: { screen: null, camera: null }, // codec of their latest sample, for the ladder's bits-per-pixel
      soft: { screen: 0, camera: 0 }, // consecutive samples of software H.264 (see guard)
      note: { screen: null, camera: null }, // shown in the stats panel
      known: false, // they have our first offer or answer, so they have a peer for us (see sendSdp)
      early: [], // watch requests made before that
    };
    this.peers.set(sid, peer);
    for (const track of audio.outStream.getAudioTracks()) peer.voiceSender = pc.addTrack(track, audio.outStream);
    this.capVoice(peer);
    pc.onicecandidate = (e) => e.candidate && this.send(sid, { candidate: e.candidate });
    // Fires for the first offer and again whenever media tracks are added or removed.
    pc.onnegotiationneeded = () =>
      this.enqueue(sid, async () => {
        if (pc.signalingState !== 'stable') return; // re-fires once we're back to stable
        await this.setLocal(pc);
        this.sendSdp(sid, peer);
      });
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      if (pc.connectionState === 'failed') (log.warn(`voice connection failed for peer ${sid}`), pc.restartIce?.()); // by socket id, not name
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

  // setLocalDescription() with our Opus settings in it. Should a browser
  // refuse the edited SDP, the plain one still connects the call.
  async setLocal(pc) {
    try {
      const desc = await (pc.signalingState === 'have-remote-offer' ? pc.createAnswer() : pc.createOffer());
      await pc.setLocalDescription({ type: desc.type, sdp: tuneOpus(desc.sdp) });
    } catch (e) {
      console.warn('rtc: plain SDP', e);
      await pc.setLocalDescription();
    }
  }

  // The server's voice quality: cap what we send every peer, now and from here on
  setAudioQuality(key) {
    this.audioQuality = AUDIO_QUALITY[key] ? key : 'max';
    for (const peer of this.peers.values()) this.capVoice(peer);
  }

  capVoice(peer) {
    const params = peer.voiceSender?.getParameters();
    const enc = params?.encodings?.[0];
    const maxBitrate = AUDIO_QUALITY[this.audioQuality];
    if (!enc || enc.maxBitrate === maxBitrate) return;
    enc.maxBitrate = maxBitrate;
    peer.voiceSender.setParameters(params).catch((e) => console.warn('rtc: voice bitrate', e));
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

  handleSignal({ from, data } = {}) {
    if (!this.channelId || !data || typeof data !== 'object') return;
    let peer = this.peers.get(from);
    if (!peer) {
      if (data.sdp?.type !== 'offer' || !this.isPeer(from)) return;
      peer = this.createPeer(from);
      audio.cue('peerJoin');
      this.onPeersChange();
    }
    // Media control messages share the per-peer queue so they stay ordered
    // with the SDP they announce.
    // With an SFU our shares go only through it (D70): an app from before it asking over the mesh gets nothing
    if (KINDS.includes(data.watch)) {
      if (this.sfu) return;
      return this.enqueue(from, () => {
        peer.view[data.watch] = null;
        return data.on ? this.sendMediaTo(from, data.watch) : this.unsendMediaTo(from, data.watch);
      });
    }
    if (KINDS.includes(data.view)) {
      if (this.sfu) return;
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
        await pc.setRemoteDescription({ type: data.sdp.type, sdp: tuneOpus(String(data.sdp.sdp)) }); // rolls back our own offer if we're polite
        if (data.sdp.type === 'offer') {
          await this.setLocal(pc);
          this.sendSdp(from, peer);
        }
        this.capVoice(peer); // a sender has no encodings to cap before its first negotiation in some browsers
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

  // ----- the media sidecar (D45, D70) -----

  // Share through the sidecar: it captures `source` ({ type: 'screen' | 'window' | 'camera', id, name, audio })
  // itself and publishes it to the SFU. Our own tile shows it back from there. Rejects when there is no SFU,
  // or the sidecar can't start it or reach the server; the caller then shares through the browser engine.
  async setNativeMedia(kind, source, quality) {
    if (!this.sfu) throw new Error('native shares go through the server’s SFU, and this call has none');
    this.stopMedia(kind, true);
    this.useQuality(kind, quality);
    await this.sfu.publishNative(kind, source, this.nativeQuality(kind));
    if (!this.channelId || !this.sfu) throw new Error('left the call');
    this.native[kind] = { source };
    this.local[kind] = this.sfu.own(kind);
    this.emitMedia();
    this.onMediaChange(this.socket.id, kind);
  }

  nativeQuality(kind) {
    const { tier, mode } = this.quality[kind];
    const cap = kind === 'camera' ? NATIVE_CAMERA : TIERS[tier] || TIERS.auto;
    return { tier: { width: cap.width, height: cap.height, fps: cap.fps }, mode };
  }

  // Who receives our `kind` over the mesh right now
  sendingTo(kind) {
    return [...this.peers].filter(([, p]) => p.out[kind].length).map(([sid]) => sid);
  }

  // Replace a live share by a new one (`start` begins it: setMedia or setNativeMedia)
  // where swapping tracks isn't possible. Everyone who was receiving it gets the new one.
  async restart(kind, start, viewers = this.sendingTo(kind)) {
    this.stopMedia(kind, true);
    try {
      await start();
    } finally {
      if (!this.local[kind]) this.emitMedia();
    }
    for (const sid of viewers) if (this.peers.has(sid)) this.enqueue(sid, () => this.sendMediaTo(sid, kind));
  }

  // ----- the browser engine's captures -----

  // `stream` comes from getDisplayMedia (screen) or getUserMedia (camera).
  // Nobody receives it until they watch. `quality` is { tier, mode } (screens).
  setMedia(kind, stream, quality) {
    this.stopMedia(kind, true);
    this.useQuality(kind, quality);
    this.local[kind] = stream;
    for (const t of stream.getTracks()) this.watchTrack(kind, stream, t);
    if (this.sfu) {
      // Published to the SFU at once, encrypted; nobody receives it until they watch
      const sfu = this.sfu;
      sfu.publish(kind, stream, simulcastLayers(kind, stream.getVideoTracks()[0], this.quality[kind])).catch((e) => {
        log.warn(`sfu: could not publish ${kind}: ${e.message}`);
        if (this.sfu === sfu && this.local[kind] === stream) this.stopMedia(kind);
      });
    } else this.probeFor(kind);
    this.emitMedia();
    this.onMediaChange(this.socket.id, kind);
  }

  useQuality(kind, q) {
    if (kind !== 'screen' || !q) return;
    const cur = this.quality[kind];
    this.quality[kind] = { tier: TIERS[q.tier] ? q.tier : cur.tier, mode: MODES[q.mode] ? q.mode : cur.mode };
  }

  // Start probing what this machine encodes at the sizes this kind may use, in
  // both modes, so the answer is cached before the first viewer is added.
  probeFor(kind) {
    const { tier } = this.quality[kind];
    for (const mode of Object.keys(MODES)) probe(bucketOf(kind, tier, mode));
  }

  // Change tier and/or mode of a live share. Viewers keep their stream; each
  // encoder is re-planned for the new ceiling (see plan).
  async setQuality(kind, q) {
    this.useQuality(kind, q);
    if (this.native[kind]) return this.sfu?.setNativeQuality(kind, this.nativeQuality(kind));
    if (!this.sfu) this.probeFor(kind);
    const { mode, tier } = this.quality[kind];
    const cap = ceilingOf(kind, tier);
    for (const t of this.local[kind]?.getVideoTracks() || []) {
      t.contentHint = MODES[mode].hint;
      // The encoder ceiling enforces the tier either way, so a refusal is harmless
      const fps = Math.min(cap.fps, MODES[mode].maxFps);
      t.applyConstraints({ width: { max: cap.width }, height: { max: cap.height }, frameRate: { max: fps } }).catch(() => {});
    }
    if (this.sfu) return this.sfu.relayer(kind, simulcastLayers(kind, this.local[kind]?.getVideoTracks()[0], this.quality[kind]));
    await Promise.all(
      [...this.peers].map(([sid, peer]) => {
        if (peer.ladder[kind]) peer.ladder[kind].sig = null;
        return peer.out[kind].length && this.enqueue(sid, () => this.applyView(sid, kind));
      })
    );
  }

  watchTrack(kind, stream, t) {
    if (t.kind === 'video') t.contentHint = MODES[this.quality[kind].mode].hint;
    // e.g. the browser's own "Stop sharing" bar; stop() on a swapped-out track doesn't fire this
    t.addEventListener('ended', () => this.local[kind] === stream && stream.getTracks().includes(t) && this.stopMedia(kind));
  }

  // Swap what we capture (another screen or window) without ending the share.
  // The MediaStream object and its id stay the same, and every viewer's
  // senders get the new tracks through replaceTrack, which needs no
  // renegotiation. Only a share that gains audio adds a transceiver.
  async replaceMedia(kind, next, quality) {
    const stream = this.local[kind];
    if (!stream) return this.setMedia(kind, next, quality);
    if (this.native[kind]) return this.restart(kind, () => this.setMedia(kind, next, quality)); // native → browser engine
    this.useQuality(kind, quality);
    const old = stream.getTracks();
    for (const t of old) stream.removeTrack(t);
    for (const t of next.getTracks()) {
      stream.addTrack(t);
      this.watchTrack(kind, stream, t);
    }
    if (this.sfu) {
      await this.sfu.replace(kind, stream, simulcastLayers(kind, stream.getVideoTracks()[0], this.quality[kind])).catch((e) => log.warn(`sfu: could not switch ${kind}: ${e.message}`));
      old.forEach((t) => t.stop());
      return this.onMediaChange(this.socket.id, kind);
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
          if (peer.ladder[kind]) peer.ladder[kind].sig = null;
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
    this.sfu?.unpublish(kind, true);
    this.native[kind] = null;
    for (const sid of this.peers.keys()) this.unsendMediaTo(sid, kind);
    stream.getTracks().forEach((t) => t.stop());
    if (!silent) this.emitMedia();
    this.onMediaChange(this.socket.id, kind);
  }

  emitMedia() {
    this.socket.emit('voice:media', { screen: !!this.local.screen, camera: !!this.local.camera });
  }

  async sendMediaTo(sid, kind) {
    const peer = this.peers.get(sid);
    const stream = this.local[kind];
    if (!peer || !stream || peer.out[kind].length || this.sfu) return;
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
    if (video) preferCodecs(tr, kind, this.quality[kind].tier, this.quality[kind].mode);
    peer.out[kind].push(tr);
    if (video) this.startSampler();
  }

  // Where a viewer's encoder stands: the ceiling (capture size, tier, and how
  // big they display it) and the ladder of rungs below it. When the ceiling or
  // quality changes materially the rung is re-picked from the last target
  // bitrate, so going fullscreen or switching mode doesn't dip to the lowest rung.
  plan(peer, kind, track) {
    const { tier, mode } = this.quality[kind];
    const cap = ceilingOf(kind, tier);
    // || rather than defaults: some sources (canvas captures) report 0
    const set = track.getSettings();
    const width = set.width || cap.width;
    const height = set.height || cap.height;
    const fps = Math.min(set.frameRate || cap.fps, cap.fps, MODES[mode].maxFps);
    const view = peer.view[kind];
    let scale = Math.max(1, width / cap.width, height / cap.height);
    if (view?.w && view?.h) {
      // The screen is letterboxed (contain) and cameras are cropped (cover)
      const fit = kind === 'screen' ? Math.max : Math.min;
      scale = Math.max(scale, fit(width / view.w, height / view.h));
    }
    const ceil = { w: even(width / scale), h: even(height / scale) };
    const rungs = ladderRungs(mode, ceil.w, ceil.h, fps);
    const sig = `${tier}|${mode}|${width}x${height}`;
    let ladder = peer.ladder[kind];
    if (!ladder || ladder.sig !== sig || Math.abs(ladder.ceilH - ceil.h) > 0.1 * ceil.h) {
      const target = ladder?.target;
      const srcFps = ladder?.srcFps;
      ladder = peer.ladder[kind] = { sig, ceilH: ceil.h, idx: target ? ladderFit(rungs, bppFor(mode, peer.codec[kind]), target, 1, srcFps) : null, target, srcFps, down: 0, load: 0, up: 0, hold: 0, settle: 0 };
    }
    const rung = rungs[Math.min(ladder.idx ?? rungs.length - 1, rungs.length - 1)]; // a new viewer starts on the lowest rung
    return { mode, tier, width, height, fps, scale, ceil, rungs, ladder, rung };
  }

  // Encoding for one viewer: no bigger than they display it (in device
  // pixels), no bigger than the tier, and on the ladder's current rung. Paused
  // while their window is hidden. maxBitrate is the ceiling's, not the rung's,
  // so the bandwidth estimate can keep growing while we sit on a lower rung.
  encodingFor(peer, kind, track) {
    const p = this.plan(peer, kind, track);
    return {
      active: !peer.view[kind]?.hidden,
      scaleResolutionDownBy: evenScale(p.width, p.height, Math.max(p.scale, p.height / p.rung.h)),
      maxFramerate: p.rung.fps,
      maxBitrate: bitrateFor(p.ceil.w, p.ceil.h, p.fps),
    };
  }

  async applyView(sid, kind) {
    const peer = this.peers.get(sid);
    const stream = this.local[kind];
    if (!peer || !stream) return;
    const degrade = MODES[this.quality[kind].mode].degrade;
    for (const tr of peer.out[kind]) {
      const track = tr.sender.track;
      if (track?.kind !== 'video') continue;
      const want = this.encodingFor(peer, kind, track);
      const params = tr.sender.getParameters();
      const enc = params.encodings?.[0];
      if (!enc) continue;
      // Skip tiny changes so resizing a window doesn't keep poking the encoder
      const near = (a, b) => Math.abs((a || 0) - b) < 0.1 * b;
      const codec = this.bestCodec(params, kind);
      const sameCodec = !codec || codec.payloadType === (enc.codec || this.negotiated(params)[0])?.payloadType;
      if (sameCodec && enc.active === want.active && near(enc.scaleResolutionDownBy || 1, want.scaleResolutionDownBy) && near(enc.maxBitrate, want.maxBitrate) && enc.maxFramerate === want.maxFramerate && params.degradationPreference === degrade) continue;
      Object.assign(enc, want);
      if (!sameCodec) enc.codec = codec; // among the codecs already negotiated; no renegotiation
      params.degradationPreference = degrade;
      await tr.sender.setParameters(params);
    }
  }

  // The real video codecs a sender negotiated, in the order of the answer
  negotiated(params) {
    return (params.codecs || []).filter((c) => /^video\/(H264|H265|VP8|VP9|AV1)$/.test(c.mimeType));
  }

  // The best of a sender's negotiated codecs for the current tier and mode
  bestCodec(params, kind, h264Soft) {
    const { tier, mode } = this.quality[kind];
    return rankCodecs(this.negotiated(params), kind, tier, mode, h264Soft)[0];
  }

  // Tell a peer how big we show their screen or camera (device pixels), or that
  // we can't see it right now, so they can size their encoder for us.
  view(sid, kind, { w = 0, h = 0, hidden = false } = {}) {
    if (this.viaSfu(sid)) return this.sfu.view(sid, kind, { w, h, hidden });
    const peer = this.peers.get(sid);
    if (!peer) return;
    peer.viewed[kind] = { w: Math.round(w), h: Math.round(h), hidden };
    this.send(sid, { view: kind, ...peer.viewed[kind] });
  }

  unsendMediaTo(sid, kind) {
    const peer = this.peers.get(sid);
    if (!peer?.out[kind].length) return;
    this.statPrev.delete(`out|${sid}|${kind}`);
    for (const tr of peer.out[kind]) tr.stop();
    peer.out[kind] = [];
    this.send(sid, { media: kind, id: null });
    this.pruneSampler();
  }

  // Ask a peer to start (or stop) sending us their screen or camera.
  watch(sid, kind, on = true) {
    if (!on) this.statPrev.delete(`in|${sid}|${kind}`);
    if (this.viaSfu(sid)) return this.sfu.watch(sid, kind, on).catch((e) => console.warn('sfu watch', e.message));
    const peer = this.peers.get(sid);
    if (!peer) return;
    if (!on) peer.in[kind] = null;
    const msg = { watch: kind, on };
    if (peer.known) return this.send(sid, msg);
    peer.early = peer.early.filter((m) => m.watch !== kind);
    if (on) peer.early.push(msg);
  }

  // Our offer or answer. The other side only makes a peer for us when our
  // first offer arrives and drops anything that comes before it, so a watch
  // request made right after joining waits for this.
  sendSdp(sid, peer) {
    this.send(sid, { sdp: peer.pc.localDescription });
    peer.known = true;
    for (const msg of peer.early.splice(0)) this.send(sid, msg);
  }

  // What the encoders/decoder are doing, for the stage header and the stats
  // panel. For our own share: an array with one entry per viewer. For someone
  // else's: one object (null when nothing is received). Rates come from deltas
  // against the previous call for the same peer and kind, so they are null on
  // the first sample; call it from one place only. For our own share that place
  // is the sampler (see startSampler), which also drives the ladder; this
  // returns its latest result.
  // Sender entry: sid (viewer), codec, hw, w/h/fps (encoded), mbps (target),
  //   limit, paused, plus
  //   capture: capW, capH, capFps          (media-source)
  //   encode:  impl, scalability, sentMbps, qp (avg over interval), encMs (per frame),
  //            limitMs ({cpu, bandwidth, other, none} seconds), nack, pli, fir, rtxMbps
  //   remote:  loss (fraction 0..1), rtt (ms), jitter (s)   (remote-inbound-rtp)
  //   path:    availMbps, pathRtt (ms), cand ("host/udp → srflx/udp")
  //   viewer:  view ({ w, h, hidden }), enc ({ scale, maxMbps, maxFps, active })
  //   ladder:  rung ({ w, h, fps }), needMbps (the rung's), upMbps (target that
  //            climbs a rung, null on the top one), mode, tier
  // Receiver: codec, hw, w/h/fps, mbps (received), dropped, freezes, freezeSec,
  //   jbMs (jitter buffer delay), jitterMs (network), keyframes, qp (avg over
  //   interval), decoder, lost (packets), nack, pli, decMs, view (what we told
  //   the sender we display), plus pathRtt and cand. No availMbps: the pair's
  //   estimate is for what we send, and Chromium reports none for what we receive.
  async videoStats(sid, kind) {
    const codecName = (stats, id) => stats.get(id)?.mimeType?.replace('video/', '') || '?';
    if (sid === this.socket.id) return this.sfu?.pub[kind] ? this.sfuSenderStats(kind) : this.latest[kind] || [];
    let stats, pc, extra;
    const peer = this.peers.get(sid);
    if (this.viaSfu(sid)) {
      const r = await this.sfu.receiver(sid, kind).catch(() => null);
      if (!r) return null;
      stats = r.stats;
      pc = { getStats: r.transport };
      // The layer the SFU sends, and the size it picked it for (D70)
      extra = { layer: r.layer, view: r.paused ? { hidden: true } : r.view };
    } else {
      pc = peer?.pc;
      const tr = pc?.getTransceivers().find((t) => t.receiver.track?.kind === 'video' && this.mediaOf(sid, kind)?.getTracks().includes(t.receiver.track));
      if (!tr) return null;
      stats = await tr.receiver.getStats().catch(() => null);
      extra = { view: peer.viewed[kind] };
    }
    const r = stats && [...stats.values()].find((x) => x.type === 'inbound-rtp');
    if (!r) return null;
    const { availMbps, ...path } = await this.pathStats(stats, pc);
    const prev = this.statPrev.get(`in|${sid}|${kind}`);
    const cur = { t: r.timestamp, bytes: r.bytesReceived, jb: r.jitterBufferDelay, jbn: r.jitterBufferEmittedCount, frames: r.framesDecoded, dec: r.totalDecodeTime, qp: r.qpSum };
    this.statPrev.set(`in|${sid}|${kind}`, cur);
    return {
      codec: codecName(stats, r.codecId),
      hw: r.powerEfficientDecoder,
      w: r.frameWidth,
      h: r.frameHeight,
      fps: r.framesPerSecond,
      mbps: rate(cur, prev, 'bytes', 8e-6),
      dropped: r.framesDropped,
      freezes: r.freezeCount,
      freezeSec: r.totalFreezesDuration,
      jbMs: ratio(cur, prev, 'jb', 'jbn', 1000),
      jitterMs: r.jitter != null ? r.jitter * 1000 : undefined,
      keyframes: r.keyFramesDecoded,
      qp: ratio(cur, prev, 'qp', 'frames'),
      decoder: r.decoderImplementation,
      lost: r.packetsLost,
      nack: r.nackCount,
      pli: r.pliCount,
      decMs: ratio(cur, prev, 'dec', 'frames', 1000),
      ...extra,
      ...path,
    };
  }

  // Our own share through the SFU: one entry per simulcast layer (the sidecar's own numbers for a native share)
  async sfuSenderStats(kind) {
    const got = await this.sfu.sender(kind).catch(() => []);
    if (Array.isArray(got)) return got.map((x) => ({ ...x, tier: kind === 'screen' ? this.quality[kind].tier : undefined }));
    const { stats, transport, layers } = got;
    const codecName = (id) => stats.get(id)?.mimeType?.replace('video/', '') || '?';
    const all = [...stats.values()];
    const outs = all.filter((x) => x.type === 'outbound-rtp' && x.kind !== 'audio').sort((a, b) => String(a.rid).localeCompare(String(b.rid)));
    const path = await this.pathStats(stats, { getStats: transport });
    const src = all.find((x) => x.type === 'media-source' && x.kind !== 'audio');
    return outs.map((r, i) => {
      const key = `out|sfu|${kind}|${r.rid}`;
      const prev = this.statPrev.get(key);
      const cur = { t: r.timestamp, bytes: r.bytesSent, frames: r.framesEncoded, qp: r.qpSum, enc: r.totalEncodeTime };
      this.statPrev.set(key, cur);
      const remote = all.find((x) => x.type === 'remote-inbound-rtp' && x.localId === r.id);
      return {
        layer: r.rid || 'r' + i,
        codec: codecName(r.codecId),
        hw: r.powerEfficientEncoder,
        impl: r.encoderImplementation,
        w: r.frameWidth,
        h: r.frameHeight,
        fps: r.framesPerSecond,
        mbps: r.targetBitrate / 1e6,
        sentMbps: rate(cur, prev, 'bytes', 8e-6),
        qp: ratio(cur, prev, 'qp', 'frames'),
        encMs: ratio(cur, prev, 'enc', 'frames', 1000),
        limit: r.qualityLimitationReason,
        paused: r.active === false,
        capW: src?.width,
        capH: src?.height,
        capFps: src?.framesPerSecond,
        rung: layers?.[i] ? { w: layers[i].w, h: layers[i].h, fps: layers[i].fps } : null,
        loss: remote?.fractionLost,
        rtt: remote?.roundTripTime != null ? remote.roundTripTime * 1000 : undefined,
        mode: this.quality[kind].mode,
        tier: kind === 'screen' ? this.quality[kind].tier : undefined,
        ...path,
      };
    });
  }

  // One sample of every encoder sending `kind`, one entry per viewer
  async senderStats(kind) {
    const codecName = (stats, id) => stats.get(id)?.mimeType?.replace('video/', '') || '?';
    const out = [];
    for (const [peerSid, peer] of this.peers) {
      const tr = peer.out[kind].find((t) => t.sender.track?.kind === 'video');
      if (!tr) continue;
      const stats = await tr.sender.getStats().catch(() => null);
      if (!stats) continue;
      const reports = [...stats.values()];
      const r = reports.find((x) => x.type === 'outbound-rtp' && x.kind !== 'audio');
      if (!r) continue;
      const src = stats.get(r.mediaSourceId) || reports.find((x) => x.type === 'media-source' && x.kind !== 'audio');
      const remote = reports.find((x) => x.type === 'remote-inbound-rtp' && (x.localId === r.id || x.ssrc === r.ssrc));
      const path = await this.pathStats(stats, peer.pc);
      const prev = this.statPrev.get(`out|${peerSid}|${kind}`);
      const cur = { t: r.timestamp, bytes: r.bytesSent, frames: r.framesEncoded, qp: r.qpSum, enc: r.totalEncodeTime, rtx: r.retransmittedBytesSent };
      this.statPrev.set(`out|${peerSid}|${kind}`, cur);
      const enc = tr.sender.getParameters().encodings?.[0];
      out.push({
        sid: peerSid,
        codec: codecName(stats, r.codecId),
        hw: r.powerEfficientEncoder,
        w: r.frameWidth,
        h: r.frameHeight,
        fps: r.framesPerSecond,
        mbps: r.targetBitrate / 1e6,
        limit: r.qualityLimitationReason,
        paused: peer.view[kind]?.hidden,
        capW: src?.width,
        capH: src?.height,
        capFps: src?.framesPerSecond,
        impl: r.encoderImplementation,
        scalability: r.scalabilityMode,
        sentMbps: rate(cur, prev, 'bytes', 8e-6),
        qp: ratio(cur, prev, 'qp', 'frames'),
        encMs: ratio(cur, prev, 'enc', 'frames', 1000),
        limitMs: r.qualityLimitationDurations,
        nack: r.nackCount,
        pli: r.pliCount,
        fir: r.firCount,
        rtxMbps: rate(cur, prev, 'rtx', 8e-6),
        loss: remote?.fractionLost,
        rtt: remote?.roundTripTime != null ? remote.roundTripTime * 1000 : undefined,
        jitter: remote?.jitter,
        ...path,
        view: peer.view[kind] ? { ...peer.view[kind] } : null,
        enc: enc && { scale: enc.scaleResolutionDownBy, maxMbps: enc.maxBitrate != null ? enc.maxBitrate / 1e6 : undefined, maxFps: enc.maxFramerate, active: enc.active },
      });
    }
    return out;
  }

  // ----- sender sampling -----
  // While we send any media, sample every encoder once a second, cache the
  // result for videoStats() and let the ladder react. It runs whether or not
  // the stage is open, and nothing else may sample the senders (rates are deltas).

  startSampler() {
    this.sampler ||= setInterval(() => this.sample(), 1000);
  }

  stopSampler() {
    clearInterval(this.sampler);
    this.sampler = null;
    this.latest = { screen: [], camera: [] };
  }

  pruneSampler() {
    if (![...this.peers.values()].some((p) => KINDS.some((k) => p.out[k].length))) this.stopSampler();
  }

  async sample() {
    if (this.sampling) return;
    this.sampling = true;
    try {
      for (const kind of KINDS) {
        const entries = await this.senderStats(kind);
        if (!this.sampler) return;
        for (const e of entries) this.climb(e.sid, kind, e);
        this.latest[kind] = entries;
      }
    } finally {
      this.sampling = false;
    }
  }

  // Feed one viewer's sample to the ladder; push the new rung if it moved
  climb(sid, kind, sample) {
    const peer = this.peers.get(sid);
    const track = peer?.out[kind].find((t) => t.sender.track?.kind === 'video')?.sender.track;
    if (!track) return;
    peer.codec[kind] = sample.codec;
    const p = this.plan(peer, kind, track);
    this.guard(sid, kind, sample, p);
    const before = p.ladder.idx;
    if (!peer.view[kind]?.hidden) {
      Object.assign(p.ladder, ladderStep(p.ladder, sample, p.rungs, bppFor(p.mode, sample.codec), performance.now()));
      if (sample.mbps > 0) p.ladder.target = sample.mbps;
      if (p.ladder.idx !== before) this.enqueue(sid, () => this.applyView(sid, kind));
    }
    const at = Math.min(p.ladder.idx ?? p.rungs.length - 1, p.rungs.length - 1);
    const bpp = bppFor(p.mode, sample.codec);
    sample.rung = p.rungs[at];
    sample.needMbps = rungNeed(p.rungs[at], bpp, p.ladder.srcFps);
    sample.upMbps = at > 0 ? UP_HEADROOM * rungNeed(p.rungs[at - 1], bpp, p.ladder.srcFps) : null;
    sample.mode = p.mode;
    sample.tier = p.tier;
    // A note only stands while the codec and quality it was written for do
    const note = peer.note[kind];
    if (note && (note.tier !== p.tier || note.mode !== p.mode || !note.codecs.includes(sample.codec))) peer.note[kind] = null;
    sample.note = peer.note[kind]?.text;
  }

  // The probe can be wrong. When H.264 has been software for a few samples,
  // remember it for the session (later viewers of that kind get the right
  // order), say so in the stats, and move this viewer to the best other
  // negotiated codec. Chromium's hardware H.264 encoder (VideoToolbox here)
  // refuses frames with an odd width or height and falls back to OpenH264,
  // whatever the size otherwise, so odd-sized samples prove nothing (encodingFor
  // keeps the sizes even); neither do samples while the encoder is still
  // reconfiguring or before the stats say what limits it. Software H.264 that
  // keeps up is left alone when no other hardware codec exists.
  guard(sid, kind, sample, p) {
    const peer = this.peers.get(sid);
    const trusted = sample.limit != null && sample.w > 0 && sample.h > 0 && sample.w % 2 === 0 && sample.h % 2 === 0 && performance.now() >= p.ladder.settle;
    peer.soft[kind] = trusted && sample.codec === 'H264' && sample.hw === false ? peer.soft[kind] + 1 : trusted ? 0 : peer.soft[kind];
    if (peer.soft[kind] !== SOFT_SAMPLES) return;
    const tr = peer.out[kind].find((t) => t.sender.track?.kind === 'video');
    const params = tr.sender.getParameters();
    const next = this.bestCodec(params, kind, true);
    const name = next?.mimeType.replace('video/', '');
    const note = (text) => (peer.note[kind] = { text, tier: p.tier, mode: p.mode, codecs: ['H264', name] });
    const nextHw = next && probed.get(bucketOf(kind, p.tier, p.mode))?.[probeOf(next)?.key]?.powerEfficient;
    const keepingUp = sample.limit !== 'cpu' && !(sample.fps != null && sample.capFps && sample.fps < LOAD_FPS * Math.min(sample.capFps, p.rung.fps));
    if (!name || name === 'H264' || (!nextHw && keepingUp)) {
      note('H.264 is software here');
      return;
    }
    h264Software[kind] = true;
    note(`H.264 is software here; switched to ${name}`);
    this.enqueue(sid, () => this.applyView(sid, kind));
  }

  // Selected ICE candidate pair: availMbps, pathRtt (ms), cand. The sender/receiver
  // report set may lack transport reports, so fall back to the whole connection.
  async pathStats(stats, pc) {
    const find = (s) => {
      const all = [...s.values()];
      const id = all.find((x) => x.type === 'transport' && x.selectedCandidatePairId)?.selectedCandidatePairId;
      const pair = (id && s.get(id)) || all.find((x) => x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded');
      return pair && { pair, s };
    };
    const hit = find(stats) || find((await pc.getStats().catch(() => null)) || new Map());
    if (!hit) return {};
    const { pair, s } = hit;
    const desc = (id) => {
      const c = s.get(id);
      return c ? `${c.candidateType}/${c.protocol}` : '?';
    };
    return {
      availMbps: pair.availableOutgoingBitrate != null ? pair.availableOutgoingBitrate / 1e6 : undefined,
      pathRtt: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : undefined,
      cand: `${desc(pair.localCandidateId)} → ${desc(pair.remoteCandidateId)}`,
    };
  }

  mediaOf(sid, kind) {
    if (sid === this.socket.id) return this.local[kind];
    if (this.viaSfu(sid)) return this.sfu.mediaOf(sid, kind);
    return this.peers.get(sid)?.in[kind]?.stream || null;
  }

  dropPeer(sid) {
    const peer = this.peers.get(sid);
    if (!peer) return;
    peer.pc.close();
    peer.dispose?.();
    for (const k of KINDS) this.statPrev.delete(`out|${sid}|${k}`), this.statPrev.delete(`in|${sid}|${k}`);
    if (peer.audioEl) {
      peer.audioEl.pause();
      peer.audioEl.srcObject = null;
    }
    this.peers.delete(sid);
    this.pruneSampler();
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

  // Per-user volume and mute are keyed by profile id so they survive reconnects. Someone force-muted by a moderator is silent here
  // too (forceMutedFor(sid) is set by the app), so a modified client can't be heard by honest peers.
  applyVolume(sid) {
    const peer = this.peers.get(sid);
    if (!peer?.setGain) return;
    const pid = this.profileIdFor?.(sid);
    const st = settings.get();
    const v = this.deafened || st.userMutes[pid] || this.forceMutedFor?.(sid) ? 0 : (st.userVolumes[pid] ?? 1);
    peer.setGain(Math.min(MAX_USER_VOLUME, Math.max(0, +v || 0)));
  }

  levels() {
    const out = new Map();
    for (const [sid, p] of this.peers) out.set(sid, p.analyser && !this.deafened ? Level(p.analyser) : 0);
    return out;
  }
}
