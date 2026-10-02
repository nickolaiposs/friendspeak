// Calls in direct messages (D33): voice, camera and screen sharing with one
// friend, peer to peer.
//
// A call rides the DM link (dm.js). Ringing and the WebRTC handshake travel
// over the DM data channel as { t: 'call', d }, so no server takes part beyond
// the DM rendezvous. The media runs on a peer connection of its own, driven by
// a VoiceClient (voice.js) whose "socket" is the DM link. That way mute,
// push-to-talk, the soundboard, cameras and screen shares behave exactly as in
// a voice channel.
//
// d, always with the call's id:
//   { k: 'ring', id, video }     invite (video: the caller turns their camera on)
//   { k: 'accept', id }
//   { k: 'end', id, why }        see WHY
//   { k: 'rtc', id, data }       a VoiceClient signal: sdp, candidate, media, watch, view
//   { k: 'state', id, screen, camera, muted, deafened }
// They are sealed like every DM op (D32), and dm.js only hands over those from
// a friend whose key is known. An app from before calls ignores all of them,
// so the caller rings until it gives up.
import { VoiceClient, KINDS } from './voice.js';
import { uid } from './util.js';

const RING_MS = 40e3; // how long a call rings
const LINK_MS = 30e3; // how long to wait for the DM link before ringing (dm.js retries a stuck one after 12 s)
const LOST_MS = 20e3; // how long the media may be down before the call ends
const CHANNEL = 'call'; // VoiceClient wants a channel id; a call has one room
const WHY = ['hangup', 'cancel', 'declined', 'busy', 'unanswered', 'gone', 'lost'];

export class DmCalls {
  // on: { change(), active(call), ended(call, why, mine) }
  // call.state: 'calling' (we ring them), 'ringing' (they ring us), 'active'
  constructor(dm, on) {
    this.dm = dm;
    this.on = on;
    this.cur = null; // one call at a time
    this.muted = false;
    this.deafened = false;
    setInterval(() => this.linkChanged(), 5e3); // keep the DM link up while a call needs it
  }

  with(peerId) {
    return this.cur?.peerId === peerId ? this.cur : null;
  }

  // The live call's VoiceClient (takes the camera and the screen share), or null
  get voice() {
    return this.cur?.state === 'active' ? this.cur.voice : null;
  }

  fresh(id, peerId, out, video) {
    return { id, peerId, out, video, state: out ? 'calling' : 'ringing', rung: false, voice: null, started: 0, queue: [], remote: {}, watching: {}, timer: null, lost: null };
  }

  start(peerId, video = false) {
    if (this.cur || !this.dm.contacts.has(peerId)) return false;
    const c = (this.cur = this.fresh(uid(), peerId, true, video));
    c.timer = setTimeout(() => this.end(c, 'unreachable', false), LINK_MS);
    this.dm.connect(peerId);
    this.ring(c);
    this.on.change();
    return true;
  }

  ring(c) {
    if (c.rung || c.state !== 'calling' || !this.dm.sendCall(c.peerId, { k: 'ring', id: c.id, video: c.video })) return;
    c.rung = true;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => this.end(c, 'unanswered'), RING_MS);
  }

  accept() {
    return this.cur?.state === 'ringing' ? this.activate(this.cur) : false;
  }

  hangup() {
    const c = this.cur;
    if (c) this.end(c, c.state === 'calling' ? 'cancel' : c.state === 'ringing' ? 'declined' : 'hangup');
  }

  // Our mute and deafen state (shared with voice channels)
  sync(muted, deafened) {
    Object.assign(this, { muted, deafened });
    const c = this.cur;
    if (c?.state !== 'active') return;
    c.voice.setDeafened(deafened);
    this.sendState(c);
  }

  // The DM link to someone opened or dropped
  linkChanged() {
    const c = this.cur;
    if (!c) return;
    if (!this.dm.connected(c.peerId)) return this.dm.connect(c.peerId);
    this.ring(c);
    while (c.queue.length && this.dm.sendCall(c.peerId, c.queue[0])) c.queue.shift();
  }

  // Signals wait for the link if it dropped: a lost offer would stall the media
  send(c, d) {
    const msg = { ...d, id: c.id };
    if (!c.queue.length && this.dm.sendCall(c.peerId, msg)) return;
    if (c.queue.length < 500) c.queue.push(msg);
    this.dm.connect(c.peerId);
  }

  sendState(c) {
    const { screen, camera } = c.voice.local;
    this.send(c, { k: 'state', screen: !!screen, camera: !!camera, muted: this.muted, deafened: this.deafened });
  }

  // What VoiceClient uses of a chat socket
  link(c) {
    return {
      id: this.dm.me.id,
      on() {},
      off() {},
      emit: (event, payload) => {
        if (this.cur !== c) return;
        if (event === 'rtc:signal') this.send(c, { k: 'rtc', data: payload.data });
        else if (event === 'voice:media') this.sendState(c);
      },
      emitWithAck: async () => ({ peers: c.out ? [c.peerId] : [] }), // the caller makes the offer
    };
  }

  async activate(c) {
    clearTimeout(c.timer);
    c.state = 'active';
    c.started = Date.now();
    c.voice = new VoiceClient(this.link(c), { onPeersChange: () => this.peersChanged(c), onMediaChange: () => this.cur === c && this.on.change() });
    c.voice.profileIdFor = (sid) => sid; // the "socket ids" here are profile ids
    c.lost = setTimeout(() => this.end(c, 'lost'), LOST_MS + 10e3);
    this.on.change();
    await c.voice.join(CHANNEL); // starts the microphone
    if (this.cur !== c) return c.voice.leave(true), false; // ended meanwhile
    c.voice.setDeafened(this.deafened);
    if (!c.out) this.send(c, { k: 'accept' });
    this.sendState(c);
    this.on.active(c);
    this.on.change();
    return true;
  }

  peersChanged(c) {
    if (this.cur !== c) return;
    const up = c.voice.peers.get(c.peerId)?.state === 'connected';
    if (up) {
      clearTimeout(c.lost);
      c.lost = null;
    } else if (!c.lost) c.lost = setTimeout(() => this.end(c, 'lost'), LOST_MS);
    this.watch(c);
    this.on.change();
  }

  // One viewer, so there's nothing to opt into (unlike D22): receive whatever they share
  watch(c) {
    if (!c.voice?.peers.has(c.peerId)) return;
    for (const kind of KINDS) {
      const want = !!c.remote[kind];
      if (!!c.watching[kind] === want) continue;
      c.watching[kind] = want;
      c.voice.watch(c.peerId, kind, want);
    }
  }

  // mine: we ended it (false: they did, and `why` is their reason)
  end(c, why, notify = true, mine = true) {
    if (this.cur !== c) return;
    this.cur = null;
    clearTimeout(c.timer);
    clearTimeout(c.lost);
    if (notify) this.dm.sendCall(c.peerId, { k: 'end', id: c.id, why });
    c.voice?.leave(true);
    this.on.ended(c, why, mine);
    this.on.change();
  }

  // Profile switch: nothing of the previous profile's call survives
  stop() {
    this.hangup();
  }

  receive(peerId, d) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id || d.id.length > 64) return;
    let c = this.cur;
    if (d.k === 'ring') {
      if (c?.peerId === peerId && c.id === d.id) return;
      if (c?.state === 'calling' && c.peerId === peerId) {
        // We rang each other at the same moment. Keep the call of the higher
        // profile id: the other side drops its own and picks this one up.
        if (this.dm.me.id > peerId) return;
        clearTimeout(c.timer);
        c = this.cur = this.fresh(d.id, peerId, false, c.video);
        return void this.activate(c);
      }
      if (c) return void this.dm.sendCall(peerId, { k: 'end', id: d.id, why: 'busy' });
      c = this.cur = this.fresh(d.id, peerId, false, !!d.video);
      c.timer = setTimeout(() => this.end(c, 'unanswered', false, false), RING_MS + 5e3); // in case their "cancel" never arrives
      return this.on.change();
    }
    if (!c || c.id !== d.id || c.peerId !== peerId) {
      // A call we don't have (we restarted, or already hung up): let them know
      if (d.k !== 'end') this.dm.sendCall(peerId, { k: 'end', id: d.id, why: 'gone' });
      return;
    }
    if (d.k === 'end') return this.end(c, WHY.includes(d.why) ? d.why : 'hangup', false, false);
    if (d.k === 'accept') return void (c.state === 'calling' && this.activate(c));
    if (c.state !== 'active') return;
    if (d.k === 'rtc' && d.data && typeof d.data === 'object') c.voice.handleSignal({ from: peerId, data: d.data });
    else if (d.k === 'state') {
      c.remote = { screen: !!d.screen, camera: !!d.camera, muted: !!d.muted, deafened: !!d.deafened };
      this.watch(c);
      this.on.change();
    }
  }
}
