// Direct messages, peer to peer and end-to-end encrypted (D28, D32).
//
// Servers are only meeting points and mailboxes. The client keeps a socket on
// the /dm namespace of every bookmarked server, and (as a guest, without the
// password) of the servers its contacts said they can be reached on. Such a
// server reports who is reachable, relays the WebRTC handshake, and holds
// sealed messages for people who are away. It can't read or forge them:
// everything is sealed with a key only the two people have (identity.js).
//
// Messages travel over a data channel when both are online, and are stored
// only on the two devices (IndexedDB). Anything that can't be delivered
// directly is left in the other person's mailbox on a server they use.
//
// Data channel frames:
//   { t: 'id', card }          plain, first thing on every connection
//   { t: 'x', d }              a sealed op (below)
//   binary                     a sealed chunk of an image: u32 transfer, u32 index, bytes
//   plain ops                  only with apps from before D32, which have no keys
// Ops:
//   { t: 'hello', p: { name, color, avatar?, status, relays } }   on open and on profile change
//   { t: 'msg', op, m: { id, text, gif, replyTo, ts, files? } }
//   { t: 'edit', op, id, text, edited }  { t: 'del', op, id }  { t: 'react', op, id, emoji, on }
//   { t: 'ack', op }   { t: 'typing' }
//   { t: 'call', d }   call signaling, handed to call.js (D33); sealed only, never queued or mailed
//   { t: 'want', id }  { t: 'file', id, x, size, n }  { t: 'gone', id }   image transfer
// Every op with an `op` id is queued until acked, so it survives restarts.
// Applying one twice is harmless: the last few hundred ids are remembered.
// A mailbox blob is JSON { v: 1, card, d }: the sender's card and one sealed
// op, which also carries `r`, the sender's relays.
import { dmStore } from './store.js';
import { uid, isImage } from './util.js';
import { ICE } from './voice.js';
import { identityFor, verifyCard, addressOf, pairKey, seal, unseal, sealJson, unsealJson, cleanRelays, friendCode, parseFriendCode } from './identity.js';

const MAX_TEXT = 4000;
const MAX_HELLO = 150 * 1024; // data channel messages above ~256KB aren't reliable; drop the avatar instead
const MAX_BLOB = 160 * 1024; // what a mailbox accepts (MAX_MAIL_BLOB in server.js)
const MAX_GUEST_RELAYS = 8;
const OPEN_AFTER = 12e3; // a connection that hasn't opened by now is dropped, so the next attempt starts fresh
const MAIL_AFTER = 8e3; // online but no connection yet (strict NATs): use the mailbox after this long
const MAIL_AGAIN = 14 * 864e5; // mailed and never acked: leave it again
const CHUNK = 16 * 1024;
const BUFFER_HIGH = 1024 * 1024;
const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
export const MAX_FILE = 10 * 1024 * 1024; // per image
export const MAX_FILES = 4; // per message
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const warn = (what) => (e) => console.warn(what, e);
// What goes on the wire: `at` and `mailed` are our own bookkeeping
const wire = ({ at, mailed, ...op }) => op;

export class DirectMessages {
  // on: { change(), presence(), message(peerId, m), update(peerId, m), deleted(peerId, id), typing(peerId), progress(peerId, fileId, fraction), call(peerId, d) }
  constructor(on) {
    this.on = on;
    this.me = null;
    this.identity = null; // { card, address, dhKey, login() }
    this.bookmarks = []; // the saved servers
    this.contacts = new Map(); // peerId -> { key, owner, id, name, color, avatar, status, last, unread, outbox: [op], card?, relays, seen, wants, conflict? }
    this.threads = new Map(); // peerId -> Promise<messages[]>, oldest first
    this.servers = new Map(); // address -> { socket, password, guest, online: Set<profileId>, mail }
    this.peers = new Map(); // peerId -> { pc, dc, via, polite, chain, ignoreOffer, open, ready, key, legacy, sent, asked, tx, xfers, nextX }
    this.rx = new Map(); // peerId -> promise chain, so received ops apply in order
    this.keys = new Map(); // peerId -> { s, key }: the shared key, per pinned card
    this.mailing = new Set(); // peerIds with a mailbox delivery in flight
    this.urls = new Map(); // file key -> Promise<object URL | null>
    setInterval(() => this.flushAll(), 20e3); // retry connections that failed
  }

  // (Re)start as a local profile, with the bookmarked servers to meet on
  async start(profile, servers) {
    this.stop();
    const me = (this.me = profile);
    this.bookmarks = servers;
    const [identity, contacts] = await Promise.all([identityFor(profile), dmStore.contacts(profile.id).catch(() => [])]);
    if (this.me !== me) return; // switched again meanwhile
    this.identity = identity;
    // Contacts saved before D32 lack the newer fields
    this.contacts = new Map(contacts.map((c) => [c.id, Object.assign(c, { relays: c.relays || [], seen: c.seen || [], wants: c.wants || [] })]));
    this.syncServers();
    this.on.change();
  }

  stop() {
    for (const peer of this.peers.values()) peer.pc.close();
    for (const { socket } of this.servers.values()) socket.disconnect();
    for (const url of this.urls.values()) url.then((u) => u && URL.revokeObjectURL(u));
    this.identity = null;
    this.peers.clear();
    this.servers.clear();
    this.threads.clear();
    this.rx.clear();
    this.contacts.clear();
    this.keys.clear();
    this.mailing.clear();
    this.urls.clear();
  }

  // ---------- servers (rendezvous and mailboxes) ----------

  setServers(list) {
    this.bookmarks = list;
    this.syncServers();
  }

  // Where friends can find me: sent in hello, mail and friend codes
  relays() {
    return cleanRelays(this.bookmarks.map((s) => s.address));
  }

  // Bookmarked servers with their password, plus contacts' relays as a guest
  syncServers() {
    if (!this.me || !this.identity) return;
    const want = new Map(this.bookmarks.map((s) => [s.address, { password: s.password || '', guest: false }]));
    let guests = 0;
    for (const c of this.contacts.values())
      for (const r of c.relays) if (!want.has(r) && guests < MAX_GUEST_RELAYS) (want.set(r, { password: '', guest: true }), guests++);
    for (const [addr, s] of this.servers) {
      const w = want.get(addr);
      if (w && w.password === s.password && w.guest === s.guest) continue;
      s.socket.disconnect();
      this.servers.delete(addr);
    }
    for (const [addr, w] of want) if (!this.servers.has(addr)) this.connectServer(addr, w);
    for (const s of this.servers.values()) if (s.guest && s.socket.connected) this.watch(s);
    this.on.presence();
  }

  connectServer(address, { password, guest }) {
    // forceNew: its own connection, so it never shares reconnect settings with the chat socket
    const socket = io(address + '/dm', {
      auth: { profileId: this.me.id, password, guest: guest || undefined },
      forceNew: true,
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: guest ? 120e3 : 30e3,
    });
    const s = { address, socket, password, guest, online: new Set(), mail: false };
    this.servers.set(address, s);
    socket.on('connect', () => guest && this.watch(s));
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
      // Gone from every server: they closed the app. Don't wait for the
      // connection to time out before using their mailbox.
      else if (!this.online(id) && this.peers.has(id)) this.lost(id, this.peers.get(id).pc);
    });
    socket.on('disconnect', () => (s.online.clear(), (s.mail = false), this.on.presence()));
    // Banned, wrong password, or a server that takes no guests: don't keep knocking
    socket.on('connect_error', (err) => /banned|password/i.test(err.message) && socket.disconnect());
    socket.on('signal', ({ from, data }) => this.handleSignal(from, data, socket));
    // Servers with mailboxes (D32) ask who we are: prove it with the profile's key
    socket.on('challenge', async ({ nonce } = {}) => {
      const identity = this.identity;
      if (typeof nonce !== 'string' || !identity) return;
      const res = await socket
        .timeout(10e3)
        .emitWithAck('identify', { s: identity.card.s, sig: await identity.login(nonce) })
        .catch(() => null);
      if (!res?.ok || this.servers.get(address) !== s || !socket.connected) return;
      s.mail = true;
      this.on.presence();
      this.flushAll();
    });
    socket.on('mail', (items) => this.receiveMail(s, items));
  }

  // A guest isn't told who is on the server, only about the people it asks for
  async watch(s) {
    const ids = [...this.contacts.values()].filter((c) => c.relays.includes(s.address)).map((c) => c.id);
    const res = await s.socket
      .timeout(10e3)
      .emitWithAck('watch', ids)
      .catch(() => null);
    if (!Array.isArray(res?.online) || this.servers.get(s.address) !== s) return;
    s.online = new Set(res.online);
    this.on.presence();
    this.flushAll();
  }

  // Reachable through at least one server we share
  online(peerId) {
    return !!this.via(peerId);
  }

  via(peerId) {
    for (const s of this.servers.values()) if (s.socket.connected && s.online.has(peerId)) return s.socket;
    return null;
  }

  // Servers that take mail right now
  mailRelays() {
    return [...this.servers.values()].filter((s) => s.mail && s.socket.connected);
  }

  // Whether a message to them can be left in a mailbox while they're away
  canMail(peerId) {
    return !!this.contacts.get(peerId)?.card && this.mailRelays().length > 0;
  }

  // ---------- peer connections ----------

  connected(peerId) {
    return !!this.peers.get(peerId)?.ready;
  }

  connect(peerId) {
    if (!this.me || !this.identity || this.peers.has(peerId)) return;
    const via = this.via(peerId);
    if (via) this.createPeer(peerId, via);
  }

  createPeer(peerId, via) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const peer = {
      pc,
      via,
      polite: this.me.id < peerId,
      chain: Promise.resolve(),
      ignoreOffer: false,
      open: false,
      ready: false, // we know how to talk to them: sealed (key) or the old plain way (legacy)
      key: null,
      legacy: false,
      sent: new Set(), // op ids
      asked: new Set(), // file ids
      tx: Promise.resolve(), // sealing is async: this keeps what we send in order
      xfers: new Map(), // transfer number -> image being received
      nextX: 1,
    };
    this.peers.set(peerId, peer);
    // Negotiated on both sides with the same id, so neither has to wait for ondatachannel
    const dc = (peer.dc = pc.createDataChannel('dm', { negotiated: true, id: 0 }));
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_HIGH / 4;
    dc.onopen = () => {
      peer.open = true;
      try {
        dc.send(JSON.stringify({ t: 'id', card: this.identity.card }));
      } catch {}
      this.enqueueRx(peerId, () => this.greet(peerId, peer));
    };
    dc.onclose = () => this.lost(peerId, pc);
    dc.onmessage = (e) => this.enqueueRx(peerId, () => this.frame(peerId, peer, e.data));
    pc.onicecandidate = (e) => e.candidate && peer.via.emit('signal', { to: peerId, data: { candidate: e.candidate } });
    // Only the first offer: a DM connection never renegotiates. (The answering
    // side also fires this for its data channel; it already has a description.)
    pc.onnegotiationneeded = () =>
      this.enqueue(peer, async () => {
        if (pc.signalingState !== 'stable' || pc.localDescription) return;
        await pc.setLocalDescription();
        peer.via.emit('signal', { to: peerId, data: { sdp: pc.localDescription } });
      });
    pc.onconnectionstatechange = () => ['failed', 'closed'].includes(pc.connectionState) && this.lost(peerId, pc);
    // A connection can sit in "new" forever without failing (a freshly started
    // app sometimes gathers no ICE candidates for its first one), and nothing
    // would ever retry it. Give up on it and try again if something is waiting.
    setTimeout(() => {
      if (peer.open || this.peers.get(peerId)?.pc !== pc) return;
      this.lost(peerId, pc);
      this.flush(peerId);
    }, OPEN_AFTER);
    return peer;
  }

  drop(peerId, pc) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.pc !== pc) return;
    this.peers.delete(peerId);
    pc.close();
    this.on.presence();
  }

  // The connection went away by itself: what was waiting on it goes to their mailbox
  lost(peerId, pc) {
    if (this.peers.get(peerId)?.pc !== pc) return;
    this.drop(peerId, pc);
    const c = this.contacts.get(peerId);
    if (c?.outbox.length) this.mailOut(c);
  }

  enqueue(peer, fn) {
    peer.chain = peer.chain.then(fn).catch(warn('dm rtc'));
  }

  // Perfect negotiation, as in voice.js; the polite side (lower profile id) yields
  handleSignal(from, data, socket) {
    if (!this.me || !this.identity || !data || typeof from !== 'string') return;
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

  // ---------- sealing ----------

  // The direction is part of what's authenticated
  aad(to, kind = 'dm') {
    return `${kind}|${this.me.id}|${to}`;
  }

  aadFrom(from, kind = 'dm') {
    return `${kind}|${from}|${this.me.id}`;
  }

  async keyFor(c) {
    const hit = this.keys.get(c.id);
    if (hit?.s === c.card.s && hit.d === c.card.d) return hit.key;
    const key = await pairKey(this.identity, c.card);
    this.keys.set(c.id, { s: c.card.s, d: c.card.d, key });
    return key;
  }

  // The channel just opened: with a pinned key we can talk right away
  async greet(peerId, peer) {
    const c = this.contacts.get(peerId);
    if (!c?.card || peer.key) return;
    peer.key = await this.keyFor(c);
    this.setReady(peerId, peer);
  }

  setReady(peerId, peer) {
    if (peer.ready || this.peers.get(peerId) !== peer) return;
    peer.ready = true;
    this.sendHello(peerId);
    this.flush(peerId);
    this.on.presence();
  }

  // Their card, first thing on the connection. The first one we see for a
  // profile id is pinned; a different key later is refused until trusted.
  async handleId(peerId, peer, raw) {
    const card = await verifyCard(raw);
    if (!card || card.id !== peerId) return this.drop(peerId, peer.pc);
    let c = this.contacts.get(peerId);
    if (c?.card && c.card.s !== card.s) {
      this.conflict(c, card);
      return this.drop(peerId, peer.pc);
    }
    c ||= this.addContact({ id: peerId });
    if (c.card?.d !== card.d) {
      c.card = card;
      this.saveContact(c);
    }
    peer.key = await this.keyFor(c);
    peer.legacy = false;
    this.setReady(peerId, peer);
  }

  conflict(c, card) {
    if (c.conflict?.s === card.s) return;
    c.conflict = card;
    this.saveContact(c);
    this.on.change();
  }

  // Accept the key that was refused (they reinstalled, or lost their profile)
  trustNewKey(peerId) {
    const c = this.contacts.get(peerId);
    if (!c?.conflict) return;
    c.card = c.conflict;
    delete c.conflict;
    this.keys.delete(peerId);
    this.saveContact(c);
    this.on.change();
    this.flush(peerId);
    this.connect(peerId);
  }

  // ---------- sending ----------

  link(peer, fn) {
    return (peer.tx = peer.tx.then(fn).catch(warn('dm send')));
  }

  send(peerId, obj) {
    const peer = this.peers.get(peerId);
    if (!peer?.ready || peer.dc.readyState !== 'open') return false;
    if (peer.key) this.link(peer, async () => peer.dc.send(JSON.stringify({ t: 'x', d: await sealJson(peer.key, this.aad(peerId), obj) })));
    else this.link(peer, () => peer.dc.send(JSON.stringify(obj)));
    return true;
  }

  sendHello(peerId) {
    const { name, color, avatar, status } = this.me;
    const p = { name, color, avatar, status, relays: this.relays() };
    if (JSON.stringify(p).length > MAX_HELLO) delete p.avatar;
    this.send(peerId, { t: 'hello', p });
  }

  // Send what's waiting: directly if we can, else connect and use their mailbox
  flush(peerId) {
    const c = this.contacts.get(peerId);
    if (!c || !this.identity) return;
    const peer = this.peers.get(peerId);
    if (peer?.ready) {
      for (const op of c.outbox) if (!peer.sent.has(op.op) && this.send(peerId, wire(op))) peer.sent.add(op.op);
      for (const id of c.wants) if (!peer.asked.has(id) && peer.key && this.send(peerId, { t: 'want', id })) peer.asked.add(id);
      return;
    }
    if (!peer && (c.outbox.length || c.wants.length)) this.connect(peerId);
    if (c.outbox.length) this.mailOut(c);
  }

  flushAll() {
    for (const id of this.contacts.keys()) this.flush(id);
  }

  // Leave queued ops in their mailbox, in order. They stay in the outbox
  // until acked, so a direct connection later sends them again (harmless).
  async mailOut(c) {
    if (!c.card || this.mailing.has(c.id) || !this.mailRelays().length) return;
    const now = Date.now();
    const online = this.online(c.id);
    const due = c.outbox.filter((op) => !(op.mailed > now - MAIL_AGAIN) && (!online || now - (op.at || 0) > MAIL_AFTER));
    if (!due.length) return;
    this.mailing.add(c.id);
    try {
      for (const op of due) {
        if (!c.outbox.includes(op)) continue; // acked or taken back meanwhile
        const res = await this.mail(c, wire(op));
        if (res === 'big') continue;
        if (!res) break;
        op.mailed = Date.now();
        this.saveContact(c);
        if (op.t !== 'msg') continue;
        const m = (await this.history(c.id)).find((x) => x.id === op.m.id);
        if (m?.pending && !m.mailed) {
          m.mailed = true;
          await dmStore.putMessage(m);
          this.on.update(c.id, m);
        }
      }
    } catch (e) {
      console.warn('dm mail', e);
    } finally {
      this.mailing.delete(c.id);
    }
  }

  // true if some server took it for them
  async mail(c, op) {
    const blob = JSON.stringify({ v: 1, card: this.identity.card, d: await sealJson(await this.keyFor(c), this.aad(c.id), { ...op, r: this.relays() }) });
    if (blob.length > MAX_BLOB) return 'big';
    const to = await addressOf(c.card.s);
    const res = await Promise.all(
      this.mailRelays().map((s) =>
        s.socket
          .timeout(10e3)
          .emitWithAck('mail:put', { to, blob })
          .catch(() => null)
      )
    );
    return res.some((r) => r?.ok);
  }

  ack(peerId, op) {
    if (this.send(peerId, { t: 'ack', op })) return;
    const c = this.contacts.get(peerId);
    if (c?.card && this.mailRelays().length) this.mail(c, { t: 'ack', op }).catch(warn('dm mail'));
  }

  // ---------- contacts and threads ----------

  contactKey(peerId) {
    return this.me.id + '|' + peerId;
  }

  // Start (or refresh) a conversation. `p.card` comes from a server's member
  // list; it's pinned only if we don't know a key for them yet.
  addContact(p) {
    let c = this.contacts.get(p.id);
    if (!c) {
      c = { key: this.contactKey(p.id), owner: this.me.id, id: p.id, name: 'unknown', color: '#8b6cf6', avatar: '', status: '', last: 0, unread: 0, outbox: [], relays: [], seen: [], wants: [] };
      this.contacts.set(p.id, c);
    }
    Object.assign(c, { name: p.name || c.name, color: p.color || c.color, avatar: p.avatar ?? c.avatar, status: p.status ?? c.status });
    this.saveContact(c);
    if (p.card && !c.card) this.pin(c, p.card);
    this.on.change();
    return c;
  }

  async pin(c, raw) {
    const card = await verifyCard(raw);
    if (!card || card.id !== c.id || c.card || this.contacts.get(c.id) !== c) return;
    c.card = card;
    this.saveContact(c);
    this.on.change();
    this.flush(c.id);
  }

  setRelays(c, list) {
    const relays = cleanRelays(list);
    if (relays.join() === c.relays.join()) return;
    c.relays = relays;
    this.saveContact(c);
    this.syncServers();
  }

  // My friend code: my card and where to find me
  myCode() {
    return friendCode(this.identity, this.me, this.relays());
  }

  // Add someone from their friend code; resolves to { id } or { error }
  async addFriend(text) {
    const code = await parseFriendCode(text);
    if (!code) return { error: 'That doesn’t look like a friend code' };
    const { card } = code;
    if (card.id === this.me.id) return { error: 'That’s your own friend code' };
    const known = this.contacts.get(card.id);
    if (known?.card && known.card.s !== card.s) return { error: `This code has a different key than the one saved for ${known.name}. If you trust it, delete that conversation first.` };
    const c = this.addContact({ id: card.id, name: known ? undefined : code.name });
    c.card = card;
    this.saveContact(c);
    this.setRelays(c, [...code.relays, ...c.relays]);
    this.syncServers(); // a guest relay we're already on needs to watch them too
    return { id: card.id };
  }

  saveContact(c) {
    dmStore.putContact(c).catch(warn('dm save'));
  }

  async removeContact(peerId) {
    const c = this.contacts.get(peerId);
    if (!c) return;
    this.contacts.delete(peerId);
    this.threads.delete(peerId);
    this.keys.delete(peerId);
    const peer = this.peers.get(peerId);
    if (peer) this.drop(peerId, peer.pc);
    for (const [key, url] of this.urls) if (key.startsWith(c.key + '|')) (this.urls.delete(key), url.then((u) => u && URL.revokeObjectURL(u)));
    await dmStore.removeThread(c.key);
    this.syncServers();
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
    for (const [id, peer] of this.peers) if (peer.ready) this.sendHello(id);
  }

  // ---------- my actions ----------

  queue(peerId, op) {
    const c = this.contacts.get(peerId);
    c.outbox.push({ ...op, op: uid(), at: Date.now() });
    this.saveContact(c);
    this.flush(peerId);
  }

  // Images need a friend with keys (an app from D32 on)
  canSendFiles(peerId) {
    return !!this.contacts.get(peerId)?.card;
  }

  // Why an image can't be sent, or null
  fileError(file) {
    if (!IMAGE.test(file.type)) return `"${file.name}" isn’t a png, jpg, gif or webp image`;
    if (!file.size) return `"${file.name}" is empty`;
    if (file.size > MAX_FILE) return `"${file.name}" is over ${MAX_FILE / 1024 / 1024} MB`;
    return null;
  }

  // `files`: images (File or Blob). The message carries their thumbnails; the
  // images themselves stay here and are fetched by the other side (want/file).
  async sendMessage(peerId, { text, gif, replyTo, files = [] }) {
    const c = this.contacts.get(peerId);
    const list = await this.history(peerId);
    const id = uid();
    const metas = [];
    for (const file of files.slice(0, MAX_FILES)) {
      const meta = { id: uid(), name: str(file.name, 200) || 'image', type: file.type, size: file.size, ...(await thumbnail(file)) };
      await dmStore.putFile({ key: c.key + '|' + meta.id, thread: c.key, id: meta.id, msg: id, blob: file, type: file.type, name: meta.name, size: file.size });
      metas.push(meta);
    }
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
    if (metas.length) m.files = metas;
    list.push(m);
    c.last = m.ts;
    await dmStore.putMessage(m);
    this.on.message(peerId, m);
    this.queue(peerId, { t: 'msg', m: { id: m.id, text: m.text, gif: m.gif, replyTo: m.replyTo, ts: m.ts, files: m.files } });
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
    await this.removeFiles(peerId, m);
    this.on.deleted(peerId, id);
    if (m.note) return; // they never had it
    const c = this.contacts.get(peerId);
    // Never sent: just take it (and anything queued about it) back out of the outbox
    const queued = c.outbox.find((op) => op.t === 'msg' && op.m.id === id);
    if (queued && !queued.mailed && !this.peers.get(peerId)?.sent.has(queued.op)) {
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

  // Everything from one person is handled in order, whichever way it came
  enqueueRx(peerId, fn) {
    const next = (this.rx.get(peerId) || Promise.resolve()).then(fn).catch(warn('dm receive'));
    this.rx.set(peerId, next);
    return next;
  }

  async frame(peerId, peer, data) {
    if (this.peers.get(peerId) !== peer) return;
    if (typeof data !== 'string') return this.chunk(peerId, peer, new Uint8Array(data));
    let op;
    try {
      op = JSON.parse(data);
    } catch {
      return;
    }
    if (!op || typeof op !== 'object') return;
    if (op.t === 'id') return this.handleId(peerId, peer, op.card);
    if (op.t === 'x') {
      if (!peer.key || typeof op.d !== 'string') return;
      const inner = await unsealJson(peer.key, this.aadFrom(peerId), op.d).catch(() => null);
      if (inner && typeof inner === 'object') await this.apply(peerId, inner, peer);
      return;
    }
    // Not sealed: only from someone who has never shown a key (an app from
    // before D32). Once a key is pinned, plain ops are ignored.
    if (peer.key || this.contacts.get(peerId)?.card) return;
    if (!peer.legacy) {
      peer.legacy = true;
      this.setReady(peerId, peer);
    }
    if (['hello', 'typing', 'ack', 'msg', 'edit', 'del', 'react'].includes(op.t)) await this.apply(peerId, op, peer);
  }

  // Mail a server held for us (or passed on live): [{ id, blob }]
  async receiveMail(s, items) {
    if (!Array.isArray(items)) return;
    const done = [];
    for (const it of items.slice(0, 1000)) {
      if (typeof it?.id === 'string') done.push(it.id); // readable or not, it never needs delivering again
      await this.openMail(it?.blob).catch(warn('dm mail'));
    }
    if (done.length) s.socket.emit('mail:ack', { ids: done });
  }

  async openMail(blob) {
    if (typeof blob !== 'string' || blob.length > MAX_BLOB || !this.identity) return;
    const env = JSON.parse(blob);
    const card = await verifyCard(env?.card);
    if (!card || card.id === this.me.id || typeof env.d !== 'string') return;
    let c = this.contacts.get(card.id);
    if (c?.card && c.card.s !== card.s) return this.conflict(c, card);
    const key = c?.card ? await this.keyFor(c) : await pairKey(this.identity, card);
    const op = await unsealJson(key, this.aadFrom(card.id), env.d); // throws unless they sealed it for us
    if (!op || typeof op !== 'object') return;
    if (!c?.card) {
      c ||= this.addContact({ id: card.id });
      c.card = card;
      this.saveContact(c);
    }
    if (op.r) this.setRelays(c, op.r);
    await this.enqueueRx(card.id, () => this.apply(card.id, op, null));
  }

  // `peer`: the connection it came over, or null for mail
  async apply(peerId, op, peer) {
    if (op.t === 'typing') return this.on.typing(peerId);
    if (op.t === 'hello') return this.applyHello(peerId, op.p || {});
    if (op.t === 'want') return peer?.key && this.serve(peerId, peer, str(op.id, 64));
    if (op.t === 'file') return peer?.key && this.startFile(peerId, peer, op);
    if (op.t === 'gone') return peer?.key && this.fileGone(peerId, str(op.id, 64));
    if (op.t === 'call') return peer?.key && this.on.call?.(peerId, op.d); // only from a friend whose key we know
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
          delete m.mailed;
          await dmStore.putMessage(m);
          this.on.update(peerId, m);
        }
      }
      return;
    }
    if (typeof op.op !== 'string' || !op.op || op.op.length > 64) return;
    c ||= this.addContact({ id: peerId });
    // Seen before (sent again, or replayed by a relay): just confirm it
    if (c.seen.includes(op.op)) return this.ack(peerId, op.op);
    const list = await this.history(peerId);
    const id = str(op.id ?? op.m?.id, 64);
    const m = list.find((x) => x.id === id);
    if (op.t === 'msg' && !m && id && op.m) {
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
      // Images only from a friend with a key, and never under a file id this thread already has
      const taken = new Set(list.flatMap((x) => (x.files || []).map((f) => f.id)));
      const files = c.card ? cleanFiles(op.m.files).filter((f) => !taken.has(f.id)) : [];
      if (files.length) msg.files = files;
      if (msg.text || msg.gif || msg.files) {
        list.push(msg);
        list.sort((a, b) => a.ts - b.ts);
        c.last = Math.max(c.last, msg.ts);
        c.unread = (c.unread || 0) + 1;
        c.wants.push(...files.map((f) => f.id));
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
      await this.removeFiles(peerId, m);
      this.on.deleted(peerId, id);
    } else if (op.t === 'react' && m) {
      const emoji = str(op.emoji, 64);
      if (emoji && !!op.on !== !!m.reactions[emoji]?.includes(peerId)) {
        toggleReaction(m, emoji, peerId);
        await dmStore.putMessage(m);
        this.on.update(peerId, m);
      }
    }
    c.seen.push(op.op);
    if (c.seen.length > 400) c.seen.splice(0, 100);
    this.saveContact(c);
    this.ack(peerId, op.op);
    this.flush(peerId); // fetch its images now, or connect to
  }

  applyHello(peerId, p) {
    const avatar = typeof p.avatar === 'string' && (isImage(p.avatar) ? /^(data:image\/(png|jpe?g|gif|webp);base64,|https:\/\/)/.test(p.avatar) : p.avatar.length <= 16) ? p.avatar : undefined;
    const known = this.contacts.get(peerId);
    const c = this.addContact({
      id: peerId,
      name: str(p.name, 32).trim() || known?.name || 'unknown',
      color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : undefined,
      avatar,
      status: str(p.status, 64),
    });
    if (Array.isArray(p.relays)) this.setRelays(c, p.relays);
  }

  // ---------- images ----------

  fileKey(peerId, fileId) {
    return this.contactKey(peerId) + '|' + fileId;
  }

  // An object URL for an image on this device; null while it hasn't arrived
  fileUrl(peerId, fileId) {
    const key = this.fileKey(peerId, fileId);
    if (!this.urls.has(key))
      this.urls.set(
        key,
        dmStore
          .file(key)
          .then((rec) => (rec?.blob ? URL.createObjectURL(rec.blob) : null))
          .catch(() => null)
      );
    return this.urls.get(key);
  }

  forgetUrl(key) {
    this.urls.get(key)?.then((u) => u && URL.revokeObjectURL(u));
    this.urls.delete(key);
  }

  // A message is gone: so are its images, and any wish for them
  async removeFiles(peerId, m) {
    if (!m.files?.length) return;
    const c = this.contacts.get(peerId);
    const ids = m.files.map((f) => f.id);
    if (c && c.wants.some((id) => ids.includes(id))) {
      c.wants = c.wants.filter((id) => !ids.includes(id));
      this.saveContact(c);
    }
    for (const id of ids) {
      const key = this.fileKey(peerId, id);
      this.forgetUrl(key);
      await dmStore.removeFile(key).catch(warn('dm file'));
    }
  }

  // They asked for one of my images: a header, then sealed chunks. Each chunk
  // waits its turn on the send chain, so messages aren't stuck behind it.
  async serve(peerId, peer, id) {
    const list = await this.history(peerId);
    const mine = list.some((m) => m.author === this.me.id && m.files?.some((f) => f.id === id));
    const rec = mine ? await dmStore.file(this.fileKey(peerId, id)).catch(() => null) : null;
    if (!rec?.blob) return this.send(peerId, { t: 'gone', id });
    const { blob } = rec;
    const x = peer.nextX++;
    const n = Math.ceil(blob.size / CHUNK);
    if (!this.send(peerId, { t: 'file', id, x, size: blob.size, n })) return;
    const dc = peer.dc;
    const aad = this.aad(peerId, 'dmf');
    (async () => {
      for (let i = 0; i < n && dc.readyState === 'open'; i++) {
        const body = new Uint8Array(await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
        const plain = new Uint8Array(8 + body.length);
        const view = new DataView(plain.buffer);
        view.setUint32(0, x);
        view.setUint32(4, i);
        plain.set(body, 8);
        const sealed = await seal(peer.key, aad, plain);
        await this.link(peer, async () => {
          if (dc.bufferedAmount > BUFFER_HIGH) await drained(dc);
          if (dc.readyState === 'open') dc.send(sealed);
        });
      }
    })().catch(warn('dm file'));
  }

  // The header of an image we asked for
  async startFile(peerId, peer, op) {
    const c = this.contacts.get(peerId);
    const id = str(op.id, 64);
    if (!c?.wants.includes(id) || !Number.isInteger(op.x) || peer.xfers.size >= 16) return;
    const m = (await this.history(peerId)).find((x) => x.author === peerId && x.files?.some((f) => f.id === id));
    const meta = m?.files.find((f) => f.id === id);
    if (!meta || op.size !== meta.size) return;
    peer.xfers.set(op.x, { id, msg: m, meta, parts: [], got: 0, next: 0 });
  }

  async chunk(peerId, peer, bytes) {
    if (!peer.key || bytes.length < 12 + 16 + 8) return;
    const plain = await unseal(peer.key, this.aadFrom(peerId, 'dmf'), bytes).catch(() => null);
    if (!plain) return;
    const view = new DataView(plain.buffer, plain.byteOffset);
    const x = view.getUint32(0);
    const xf = peer.xfers.get(x);
    if (!xf) return;
    const body = plain.subarray(8);
    // Chunks arrive in order on a reliable channel: anything else is broken
    if (view.getUint32(4) !== xf.next++ || !body.length || xf.got + body.length > xf.meta.size) return peer.xfers.delete(x);
    xf.parts.push(body);
    xf.got += body.length;
    this.on.progress(peerId, xf.id, xf.got / xf.meta.size);
    if (xf.got < xf.meta.size) return;
    peer.xfers.delete(x);
    const c = this.contacts.get(peerId);
    if (!c?.wants.includes(xf.id)) return; // the message was deleted meanwhile
    const key = this.fileKey(peerId, xf.id);
    await dmStore.putFile({ key, thread: c.key, id: xf.id, msg: xf.msg.id, blob: new Blob(xf.parts, { type: xf.meta.type }), type: xf.meta.type, name: xf.meta.name, size: xf.meta.size });
    c.wants = c.wants.filter((id) => id !== xf.id);
    this.saveContact(c);
    this.forgetUrl(key);
    this.on.update(peerId, xf.msg);
  }

  // They no longer have it (they deleted the conversation on their side)
  async fileGone(peerId, id) {
    const c = this.contacts.get(peerId);
    if (!c?.wants.includes(id)) return;
    c.wants = c.wants.filter((x) => x !== id);
    this.saveContact(c);
    const m = (await this.history(peerId)).find((x) => x.files?.some((f) => f.id === id));
    if (!m) return;
    m.files.find((f) => f.id === id).gone = true;
    await dmStore.putMessage(m);
    this.on.update(peerId, m);
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

// What someone says about the images in their message, made safe to store and show
function cleanFiles(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list.slice(0, MAX_FILES) : []) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !/^[\w-]{1,64}$/.test(f.id) || out.some((x) => x.id === f.id)) continue;
    if (!IMAGE.test(f.type) || !Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_FILE) continue;
    const dim = (v) => Math.max(1, Math.min(Math.round(+v) || 1, 20000));
    const thumb = typeof f.thumb === 'string' && f.thumb.length <= 40e3 && /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(f.thumb) ? f.thumb : '';
    out.push({ id: f.id, name: str(f.name, 200) || 'image', type: f.type, size: f.size, w: dim(f.w), h: dim(f.h), thumb });
  }
  return out;
}

// { w, h, thumb }: the image's size and a small preview that fits in a message
async function thumbnail(file) {
  const bmp = await createImageBitmap(file);
  const { width: w, height: h } = bmp;
  let thumb = '';
  for (const [max, q] of [
    [320, 0.7],
    [200, 0.6],
    [120, 0.5],
    [64, 0.4],
  ]) {
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) });
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    thumb = canvas.toDataURL('image/webp', q);
    if (thumb.length <= 16e3) break;
    thumb = '';
  }
  bmp.close();
  return { w, h, thumb };
}

// Resolves when the channel's send buffer has room again (or it closed)
const drained = (dc) =>
  new Promise((resolve) => {
    const done = () => {
      dc.removeEventListener('bufferedamountlow', done);
      dc.removeEventListener('close', done);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', done);
    dc.addEventListener('close', done);
  });
