// Direct messages, peer to peer (D28).
//
// Every bookmarked server doubles as a meeting point: the client keeps a
// socket on its /dm namespace, which reports who is reachable and relays the
// WebRTC handshake. The messages themselves travel over an encrypted data
// channel and are stored only on the two devices (IndexedDB). Anything sent
// while the other person is offline waits in the sender's outbox until both
// are online at the same time, on any server they share.
//
// Wire format (JSON over the data channel):
//   { t: 'hello', p: { name, color, avatar?, status } }   on open and on profile change
//   { t: 'msg', op, m: { id, text, gif, replyTo, ts } }
//   { t: 'edit', op, id, text, edited }  { t: 'del', op, id }  { t: 'react', op, id, emoji, on }
//   { t: 'ack', op }   { t: 'typing' }
//   { t: 'call', d }   call signaling, handed to call.js (D32); not queued
// Every op except hello/typing/ack is queued until acked, so it survives
// restarts. Applying one twice is harmless (messages dedupe by id, react
// carries the target state).
import { dmStore } from './store.js';
import { uid, isImage } from './util.js';
import { ICE } from './voice.js';

const MAX_TEXT = 4000;
const MAX_HELLO = 200 * 1024; // data channel messages above ~256KB aren't reliable; drop the avatar instead
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

export class DirectMessages {
  // on: { change(), presence(), message(peerId, m), update(peerId, m), deleted(peerId, id), typing(peerId), call(peerId, d) }
  constructor(on) {
    this.on = on;
    this.me = null;
    this.contacts = new Map(); // peerId -> { key, owner, id, name, color, avatar, status, last, unread, outbox: [op] }
    this.threads = new Map(); // peerId -> Promise<messages[]>, oldest first
    this.servers = new Map(); // address -> { socket, password, online: Set<profileId> }
    this.peers = new Map(); // peerId -> { pc, dc, via, polite, chain, ignoreOffer, open, sent: Set<op> }
    this.rx = new Map(); // peerId -> promise chain, so received ops apply in order
    setInterval(() => this.flushAll(), 20e3); // retry connections that failed
  }

  // (Re)start as a local profile, with the bookmarked servers to meet on
  async start(profile, servers) {
    this.stop();
    const me = (this.me = profile);
    const contacts = await dmStore.contacts(profile.id).catch(() => []);
    if (this.me !== me) return; // switched again meanwhile
    this.contacts = new Map(contacts.map((c) => [c.id, c]));
    this.setServers(servers);
    this.on.change();
  }

  stop() {
    for (const peer of this.peers.values()) peer.pc.close();
    for (const { socket } of this.servers.values()) socket.disconnect();
    this.peers.clear();
    this.servers.clear();
    this.threads.clear();
    this.rx.clear();
    this.contacts.clear();
  }

  // ---------- servers (rendezvous only) ----------

  setServers(list) {
    if (!this.me) return;
    const want = new Map(list.map((s) => [s.address, s.password || '']));
    for (const [addr, s] of this.servers) {
      if (want.get(addr) === s.password) continue;
      s.socket.disconnect();
      this.servers.delete(addr);
    }
    for (const [addr, password] of want) if (!this.servers.has(addr)) this.connectServer(addr, password);
    this.on.presence();
  }

  connectServer(address, password) {
    // forceNew: its own connection, so it never shares reconnect settings with the chat socket
    const socket = io(address + '/dm', { auth: { profileId: this.me.id, password }, forceNew: true, transports: ['websocket', 'polling'], reconnectionDelayMax: 30e3 });
    const s = { socket, password, online: new Set() };
    this.servers.set(address, s);
    socket.on('online', (ids) => {
      s.online = new Set(ids);
      this.on.presence();
      this.flushAll();
    });
    socket.on('presence', ({ id, online }) => {
      if (online) s.online.add(id);
      else s.online.delete(id);
      this.on.presence();
      if (online) this.flush(id);
    });
    socket.on('disconnect', () => (s.online.clear(), this.on.presence()));
    // Banned or wrong password: don't keep knocking
    socket.on('connect_error', (err) => /banned|password/i.test(err.message) && socket.disconnect());
    socket.on('signal', ({ from, data }) => this.handleSignal(from, data, socket));
  }

  // Reachable through at least one server we share
  online(peerId) {
    for (const s of this.servers.values()) if (s.socket.connected && s.online.has(peerId)) return true;
    return false;
  }

  via(peerId) {
    for (const s of this.servers.values()) if (s.socket.connected && s.online.has(peerId)) return s.socket;
    return null;
  }

  // ---------- peer connections ----------

  connected(peerId) {
    return !!this.peers.get(peerId)?.open;
  }

  connect(peerId) {
    if (!this.me || this.peers.has(peerId)) return;
    const via = this.via(peerId);
    if (via) this.createPeer(peerId, via);
  }

  createPeer(peerId, via) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const peer = { pc, via, polite: this.me.id < peerId, chain: Promise.resolve(), ignoreOffer: false, open: false, sent: new Set() };
    this.peers.set(peerId, peer);
    // Negotiated on both sides with the same id, so neither has to wait for ondatachannel
    peer.dc = pc.createDataChannel('dm', { negotiated: true, id: 0 });
    peer.dc.onopen = () => {
      peer.open = true;
      this.sendHello(peerId);
      this.flush(peerId);
      this.on.presence();
    };
    peer.dc.onclose = () => this.drop(peerId, pc);
    peer.dc.onmessage = (e) => this.receive(peerId, e.data);
    pc.onicecandidate = (e) => e.candidate && peer.via.emit('signal', { to: peerId, data: { candidate: e.candidate } });
    // Only the first offer: a DM connection never renegotiates. (The answering
    // side also fires this for its data channel; it already has a description.)
    pc.onnegotiationneeded = () =>
      this.enqueue(peer, async () => {
        if (pc.signalingState !== 'stable' || pc.localDescription) return;
        await pc.setLocalDescription();
        peer.via.emit('signal', { to: peerId, data: { sdp: pc.localDescription } });
      });
    pc.onconnectionstatechange = () => ['failed', 'closed'].includes(pc.connectionState) && this.drop(peerId, pc);
    return peer;
  }

  drop(peerId, pc) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.pc !== pc) return;
    this.peers.delete(peerId);
    pc.close();
    this.on.presence();
  }

  enqueue(peer, fn) {
    peer.chain = peer.chain.then(fn).catch((e) => console.warn('dm rtc', e));
  }

  // Perfect negotiation, as in voice.js; the polite side (lower profile id) yields
  handleSignal(from, data, socket) {
    if (!this.me || !data || typeof from !== 'string') return;
    let peer = this.peers.get(from);
    // An offer on a connection that already finished negotiating means they
    // started over (restarted the app, or their side failed): start over too.
    if (peer && data.sdp?.type === 'offer' && peer.pc.remoteDescription && peer.pc.signalingState === 'stable') {
      this.drop(from, peer.pc);
      peer = null;
    }
    if (!peer) {
      if (data.sdp?.type !== 'offer') return;
      peer = this.createPeer(from, socket);
    }
    peer.via = socket; // answer the way they reached us
    const pc = peer.pc;
    this.enqueue(peer, async () => {
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && pc.signalingState !== 'stable';
        peer.ignoreOffer = collision && !peer.polite;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription();
          socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
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

  send(peerId, obj) {
    const peer = this.peers.get(peerId);
    if (!peer?.open) return false;
    try {
      peer.dc.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  sendHello(peerId) {
    const { name, color, avatar, status } = this.me;
    const p = { name, color, avatar, status };
    if (JSON.stringify(p).length > MAX_HELLO) delete p.avatar;
    this.send(peerId, { t: 'hello', p });
  }

  // Send what's waiting in the outbox, or connect so we can
  flush(peerId) {
    const c = this.contacts.get(peerId);
    if (!c?.outbox.length) return;
    const peer = this.peers.get(peerId);
    if (!peer) return this.connect(peerId);
    if (!peer.open) return;
    for (const op of c.outbox) if (!peer.sent.has(op.op) && this.send(peerId, op)) peer.sent.add(op.op);
  }

  flushAll() {
    for (const id of this.contacts.keys()) this.flush(id);
  }

  // ---------- contacts and threads ----------

  contactKey(peerId) {
    return this.me.id + '|' + peerId;
  }

  // Start (or refresh) a conversation with someone seen on a server
  addContact(p) {
    let c = this.contacts.get(p.id);
    if (!c) {
      c = { key: this.contactKey(p.id), owner: this.me.id, id: p.id, name: 'unknown', color: '#5865f2', avatar: '', status: '', last: 0, unread: 0, outbox: [] };
      this.contacts.set(p.id, c);
    }
    Object.assign(c, { name: p.name || c.name, color: p.color || c.color, avatar: p.avatar ?? c.avatar, status: p.status ?? c.status });
    this.saveContact(c);
    this.on.change();
    return c;
  }

  saveContact(c) {
    dmStore.putContact(c).catch((e) => console.warn('dm save', e));
  }

  async removeContact(peerId) {
    const c = this.contacts.get(peerId);
    if (!c) return;
    this.contacts.delete(peerId);
    this.threads.delete(peerId);
    const peer = this.peers.get(peerId);
    if (peer) this.drop(peerId, peer.pc);
    await dmStore.removeThread(c.key);
    this.on.change();
  }

  history(peerId) {
    if (!this.threads.has(peerId)) {
      const thread = this.contactKey(peerId);
      this.threads.set(
        peerId,
        dmStore
          .messages(thread)
          .catch(() => [])
          .then((list) => list.sort((a, b) => a.ts - b.ts))
      );
    }
    return this.threads.get(peerId);
  }

  // The chat view is showing this conversation: connect for typing and delivery
  opened(peerId) {
    const c = this.contacts.get(peerId);
    if (c?.unread) {
      c.unread = 0;
      this.saveContact(c);
      this.on.change();
    }
    this.connect(peerId);
  }

  unreadTotal() {
    let n = 0;
    for (const c of this.contacts.values()) n += c.unread || 0;
    return n;
  }

  updateProfile(profile) {
    this.me = profile;
    for (const [id, peer] of this.peers) if (peer.open) this.sendHello(id);
  }

  // ---------- my actions ----------

  queue(peerId, op) {
    const c = this.contacts.get(peerId);
    c.outbox.push({ ...op, op: uid() });
    this.saveContact(c);
    this.flush(peerId);
  }

  async sendMessage(peerId, { text, gif, replyTo }) {
    const c = this.contacts.get(peerId);
    const list = await this.history(peerId);
    const id = uid();
    const m = {
      key: c.key + '|' + id,
      thread: c.key,
      id,
      author: this.me.id,
      name: this.me.name,
      text: str(text, MAX_TEXT),
      gif: gif || null,
      replyTo: replyTo || null,
      reactions: {},
      ts: Date.now(),
      pending: true, // until they ack it
    };
    list.push(m);
    c.last = m.ts;
    await dmStore.putMessage(m);
    this.on.message(peerId, m);
    this.queue(peerId, { t: 'msg', m: { id: m.id, text: m.text, gif: m.gif, replyTo: m.replyTo, ts: m.ts } });
  }

  async editMessage(peerId, id, text) {
    const m = (await this.history(peerId)).find((x) => x.id === id);
    if (!m || m.author !== this.me.id) return;
    m.text = str(text, MAX_TEXT);
    m.edited = Date.now();
    await dmStore.putMessage(m);
    this.on.update(peerId, m);
    this.queue(peerId, { t: 'edit', id, text: m.text, edited: m.edited });
  }

  async deleteMessage(peerId, id) {
    const list = await this.history(peerId);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0 || !(list[i].author === this.me.id || list[i].note)) return;
    const [m] = list.splice(i, 1);
    await dmStore.removeMessage(m.key);
    this.on.deleted(peerId, id);
    if (m.note) return; // they never had it
    const c = this.contacts.get(peerId);
    // Never sent: just take it (and anything queued about it) back out of the outbox
    const queued = c.outbox.find((op) => op.t === 'msg' && op.m.id === id);
    if (queued && !this.peers.get(peerId)?.sent.has(queued.op)) {
      c.outbox = c.outbox.filter((op) => !(op.id === id || op.m?.id === id));
      this.saveContact(c);
    } else this.queue(peerId, { t: 'del', id });
  }

  async react(peerId, id, emoji) {
    const m = (await this.history(peerId)).find((x) => x.id === id);
    if (!m) return;
    const on = toggleReaction(m, emoji, this.me.id);
    await dmStore.putMessage(m);
    this.on.update(peerId, m);
    this.queue(peerId, { t: 'react', id, emoji, on });
  }

  typing(peerId) {
    this.send(peerId, { t: 'typing' });
  }

  // Call signaling (call.js): only while connected, never queued
  sendCall(peerId, d) {
    return this.send(peerId, { t: 'call', d });
  }

  // A line that only this device keeps in the thread, e.g. "Missed call"
  async note(peerId, author, text, unread = false) {
    const c = this.contacts.get(peerId);
    if (!c) return;
    const list = await this.history(peerId);
    if (this.contacts.get(peerId) !== c) return; // conversation deleted, or another profile now
    const id = uid();
    const m = { key: c.key + '|' + id, thread: c.key, id, author, name: author === peerId ? c.name : this.me.name, text, gif: null, replyTo: null, reactions: {}, ts: Date.now(), note: true };
    list.push(m);
    c.last = m.ts;
    if (unread) c.unread = (c.unread || 0) + 1;
    this.saveContact(c);
    await dmStore.putMessage(m);
    this.on.message(peerId, m);
  }

  // ---------- their actions ----------

  receive(peerId, raw) {
    let op;
    try {
      op = JSON.parse(raw);
    } catch {
      return;
    }
    if (!op || typeof op !== 'object') return;
    const prev = this.rx.get(peerId) || Promise.resolve();
    this.rx.set(peerId, prev.then(() => this.apply(peerId, op)).catch((e) => console.warn('dm receive', e)));
  }

  async apply(peerId, op) {
    if (op.t === 'typing') return this.on.typing(peerId);
    if (op.t === 'hello') return this.applyHello(peerId, op.p || {});
    if (op.t === 'call') return this.on.call?.(peerId, op.d);
    let c = this.contacts.get(peerId);
    if (op.t === 'ack') {
      if (!c) return;
      const done = c.outbox.find((x) => x.op === op.op);
      if (!done) return;
      c.outbox = c.outbox.filter((x) => x !== done);
      this.saveContact(c);
      if (done.t === 'msg') {
        const m = (await this.history(peerId)).find((x) => x.id === done.m.id);
        if (m?.pending) {
          delete m.pending;
          await dmStore.putMessage(m);
          this.on.update(peerId, m);
        }
      }
      return;
    }
    if (typeof op.op !== 'string') return;
    c ||= this.addContact({ id: peerId });
    const list = await this.history(peerId);
    const id = str(op.id ?? op.m?.id, 64);
    const m = list.find((x) => x.id === id);
    if (op.t === 'msg' && !m && id) {
      const g = op.m.gif;
      const msg = {
        key: c.key + '|' + id,
        thread: c.key,
        id,
        author: peerId,
        name: c.name,
        text: str(op.m.text, MAX_TEXT),
        gif: g && typeof g.url === 'string' && /^https:\/\//.test(g.url) ? { url: g.url.slice(0, 500), w: +g.w || 200, h: +g.h || 200, title: str(g.title, 200) } : null,
        replyTo: str(op.m.replyTo, 64) || null,
        reactions: {},
        ts: Math.min(Number(op.m.ts) || Date.now(), Date.now()),
      };
      if (msg.text || msg.gif) {
        list.push(msg);
        list.sort((a, b) => a.ts - b.ts);
        c.last = Math.max(c.last, msg.ts);
        c.unread = (c.unread || 0) + 1;
        this.saveContact(c);
        await dmStore.putMessage(msg);
        this.on.message(peerId, msg);
      }
    } else if (op.t === 'edit' && m?.author === peerId) {
      m.text = str(op.text, MAX_TEXT);
      m.edited = Date.now();
      await dmStore.putMessage(m);
      this.on.update(peerId, m);
    } else if (op.t === 'del' && m?.author === peerId) {
      list.splice(list.indexOf(m), 1);
      await dmStore.removeMessage(m.key);
      this.on.deleted(peerId, id);
    } else if (op.t === 'react' && m) {
      const emoji = str(op.emoji, 64);
      if (emoji && !!op.on !== !!m.reactions[emoji]?.includes(peerId)) {
        toggleReaction(m, emoji, peerId);
        await dmStore.putMessage(m);
        this.on.update(peerId, m);
      }
    }
    this.send(peerId, { t: 'ack', op: op.op });
  }

  applyHello(peerId, p) {
    const avatar = typeof p.avatar === 'string' && (isImage(p.avatar) ? /^(data:image\/(png|jpe?g|gif|webp);base64,|https:\/\/)/.test(p.avatar) : p.avatar.length <= 16) ? p.avatar : undefined;
    const known = this.contacts.get(peerId);
    this.addContact({
      id: peerId,
      name: str(p.name, 32).trim() || known?.name || 'unknown',
      color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : undefined,
      avatar,
      status: str(p.status, 64),
    });
  }
}

// Adds or removes `who` on a reaction; returns whether it's on now
function toggleReaction(m, emoji, who) {
  const list = (m.reactions[emoji] ||= []);
  const i = list.indexOf(who);
  if (i >= 0) list.splice(i, 1);
  else list.push(who);
  if (!list.length) delete m.reactions[emoji];
  return i < 0;
}
