// The SFU (D70): screen shares, cameras and a share's sound are published once, as simulcast, to a mediasoup
// router per voice channel, which forwards each viewer the layer that fits their tile and their link.
// Everything it forwards is end-to-end encrypted by the apps (public/js/e2ee.js, native/src/e2ee.rs): the
// server never has a media key. Voice stays on the mesh (voice.js), and DM calls never come here.
//
// This module owns the mediasoup objects. server.js checks who may do what (permsOf, D43) and validates
// what arrives, then calls in here; what has to go out to sockets goes through `emit`.
//
//   workers      one per SFU_WORKERS (default 1), each with a WebRtcServer on a UDP port of its own:
//                udpPort, udpPort + 1, … (a WebRtcServer serves only its own worker's routers)
//   rooms        channelId → { router, worker, peers }: a router per voice channel, made when the first app
//                asks for its capabilities and closed when the last socket in it has left
//   peers        sid → { channelId, transports, producers, consumers }: one per socket that publishes or watches
const os = require('os');

// The codecs every router has: what the sidecar and Chromium send. Level 5.2 (…34) carries 2160p60;
// H.264's level is not matched (level-asymmetry-allowed), the profile is.
const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e034', 'level-asymmetry-allowed': 1 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '640034', 'level-asymmetry-allowed': 1 } },
];
// What a publisher is: the page itself, or the sidecar for the kind it shares. A socket has at most one
// send transport per publisher and one receive transport.
const OWNERS = ['page', 'screen', 'camera'];
// What a producer carries
const KINDS = { screen: 'video', camera: 'video', shareAudio: 'audio' };
const MAX_CONSUMERS = 64; // per socket
const MAX_LAYERS = 3;
const UP_AFTER_DOWN_MS = 2000; // a consumer moves up no sooner than this after it moved down
const MAX_INCOMING = 60e6; // bits per second a send transport takes (2160p60 at its ceiling, with room)
const START_BITRATE = 4_000_000; // where the estimate of a viewer's link starts (see transport())
// A viewer whose link can't carry the lowest layer of everything they watch (D73). Their streams are served in order
// of priority (the stream they enlarged, other screens, cameras), and while the estimate stays under what the
// lowest layers need for STARVE_AFTER_MS, their lowest-priority camera is paused, one at a time; it comes back once
// the estimate has room for it, with FEED_ROOM to spare, for FEED_AFTER_MS.
const PRIORITY = { focus: 3, screen: 2, camera: 1 };
const STARVE_AFTER_MS = 3000;
const FEED_AFTER_MS = 10_000;
const FEED_ROOM = 1.2;
const LOW_BPP = 0.04; // bits per pixel a layer needs (the sidecar's ladder::need for smooth)
const LOW_MIN_BPS = 150_000;
const LOW_GUESS_BPS = 300_000; // a lowest layer whose size the publisher didn't say
// Keyframes (D70): mediasoup asks a publisher for one no more often than this, and a viewer's own asks for one stream
// are taken no more often than KEYFRAME_ASK_MS. A viewer asking over and over would otherwise keep the sharer's
// encoder making keyframes, which every viewer of that layer pays for in picture quality.
const KEYFRAME_DELAY_MS = 1000;
const KEYFRAME_ASK_MS = 1000;

// An error whose words are for the app (server.js passes them on); anything else is answered in general terms
const refuse = (message) => Object.assign(new Error(message), { expose: true });
// A loopback or private (LAN) address, as a socket's peer
const isLoopback = (ip) => /^(127\.|::1$)/.test(String(ip || '').replace(/^::ffff:/i, ''));
const isLocal = (ip) => isLoopback(ip) || /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(String(ip || '').replace(/^::ffff:/i, ''));

// deadTransportMs: how long a transport may be without a path (its ICE disconnected) before it is closed, with its
// producers, so the room doesn't keep what an app gave up on (0: never)
function createSfu({ workers = 1, udpPort, tcpPort = 0, announced = '', deadTransportMs = 30_000, log = console, emit, who = (sid) => sid, channelName = (id) => id }) {
  let mediasoup;
  const pool = []; // { worker, server, port, index, routers: Set(channelId) }
  const rooms = new Map();
  const peers = new Map();
  let closed = false;
  let changed = () => {}; // set by onChange: the admin dashboard's hint, rate-limited there

  const lan = () =>
    Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);

  async function spawn(index) {
    const port = udpPort + index;
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    const listenInfos = [{ protocol: 'udp', ip: '0.0.0.0', announcedAddress: '127.0.0.1', port }];
    if (tcpPort) listenInfos.push({ protocol: 'tcp', ip: '0.0.0.0', announcedAddress: '127.0.0.1', port: tcpPort + index });
    let server;
    try {
      server = await worker.createWebRtcServer({ listenInfos });
    } catch (err) {
      worker.close();
      throw new Error(`UDP port ${port}${tcpPort ? ` or TCP port ${tcpPort + index}` : ''}: ${err.message}`);
    }
    const slot = { worker, server, port, index, routers: new Set() };
    pool[index] = slot;
    worker.on('died', (err) => died(slot, err));
    log.log(`[sfu] worker ${index + 1} started (pid ${worker.pid}, UDP port ${port}${tcpPort ? `, TCP port ${tcpPort + index}` : ''})`);
    return slot;
  }

  // A worker died: everyone it carried is told to start over, and a new one takes its place
  function died(slot, err) {
    if (closed) return;
    log.error(`[sfu] worker ${slot.index + 1} (pid ${slot.worker.pid}) died: ${err && err.message}`);
    const sids = new Set();
    for (const id of slot.routers) {
      const room = rooms.get(id);
      if (!room) continue;
      for (const sid of room.peers) sids.add(sid);
      rooms.delete(id);
    }
    slot.routers.clear();
    for (const sid of sids) forget(sid);
    pool[slot.index] = null;
    const again = (n) =>
      spawn(slot.index)
        .then(() => emit.to([...sids], 'sfu:reset', {}))
        .catch((e) => {
          log.error(`[sfu] could not restart worker ${slot.index + 1}: ${e.message}`);
          if (n < 5 && !closed) setTimeout(() => again(n + 1), 2000 * (n + 1));
        });
    again(0);
    changed();
  }

  async function start() {
    mediasoup = require('mediasoup');
    const count = Math.max(1, Math.min(workers | 0 || 1, os.cpus().length));
    for (let i = 0; i < count; i++) await spawn(i);
  }

  async function roomFor(channelId) {
    let room = rooms.get(channelId);
    if (room) return room.ready;
    const slot = pool.filter(Boolean).sort((a, b) => a.routers.size - b.routers.size)[0];
    if (!slot) throw refuse('The server’s media relay is restarting');
    room = { id: channelId, slot, peers: new Set(), router: null };
    rooms.set(channelId, room);
    slot.routers.add(channelId);
    room.ready = slot.worker.createRouter({ mediaCodecs: MEDIA_CODECS }).then(
      (router) => {
        room.router = router;
        log.log(`[sfu] opened ${channelName(channelId)}`);
        changed();
        return room;
      },
      (err) => {
        rooms.delete(channelId);
        slot.routers.delete(channelId);
        throw err;
      }
    );
    return room.ready;
  }

  // Close a room whose last transport is gone
  function tidy(room) {
    if (!room || rooms.get(room.id) !== room) return;
    // Someone still there: in the room by its caps, a transport, or both
    for (const sid of room.peers) if (peers.has(sid)) return;
    rooms.delete(room.id);
    room.slot.routers.delete(room.id);
    room.router?.close();
    for (const sid of room.peers) peers.delete(sid);
    log.log(`[sfu] closed ${channelName(room.id)}`);
    changed();
  }

  function peerOf(sid, channelId) {
    let peer = peers.get(sid);
    if (peer && peer.channelId !== channelId) {
      leave(sid);
      peer = null;
    }
    if (!peer) {
      peer = { sid, channelId, transports: new Map(), producers: new Map(), consumers: new Map() };
      peers.set(sid, peer);
    }
    rooms.get(channelId)?.peers.add(sid);
    return peer;
  }

  // The router's capabilities, for the app's mediasoup-client Device. The socket counts as in the room from
  // here on, so its leaving closes the room once nobody is left (an app asks for these when it joins voice)
  async function caps(sid, channelId) {
    const room = await roomFor(channelId);
    peerOf(sid, channelId);
    return room.router.rtpCapabilities;
  }

  // A send transport (for `owner`: the page, or the sidecar for one kind) or the receive transport.
  // `host` is the host the socket dialed: what the app is told to send to (D70); `ip` the socket's own address.
  async function transport(sid, channelId, { direction, owner }, host, ip) {
    const room = await roomFor(channelId);
    const peer = peerOf(sid, channelId);
    owner = direction === 'recv' ? 'recv' : owner;
    for (const t of peer.transports.values()) if (t.owner === owner) closeTransport(peer, t.transport.id);
    const t = await room.router.createWebRtcTransport({
      webRtcServer: room.slot.server,
      enableUdp: true,
      enableTcp: !!tcpPort,
      preferUdp: true,
      // Where the estimate of a viewer's link starts: enough for a 720p60 layer at once when a tile is enlarged.
      // mediasoup lowers it as soon as the link says otherwise.
      initialAvailableOutgoingBitrate: START_BITRATE,
      appData: { sid, owner },
    });
    if (peers.get(sid) !== peer) {
      t.close();
      throw refuse('left the channel');
    }
    if (direction === 'send') await t.setMaxIncomingBitrate(MAX_INCOMING).catch(() => {});
    // The estimate of a viewer's link, as it changes: whether it carries the lowest layers of what they watch (D73)
    if (direction === 'recv') {
      await t.enableTraceEvent(['bwe']).catch(() => {});
      t.on('trace', (tr) => tr.type === 'bwe' && feed(peer, tr.info?.availableBitrate));
    }
    const entry = { transport: t, owner, direction, dead: null };
    peer.transports.set(t.id, entry);
    const what = direction === 'send' ? (owner === 'page' ? 'publishing' : `${owner} (sidecar)`) : 'watching';
    t.on('dtlsstatechange', (state) => {
      if (state === 'failed') log.warn(`[sfu] ${who(sid)}: a ${what} connection failed (DTLS)`);
    });
    // A transport without a path is given deadTransportMs to find one again (the app restarts ICE, D73); after that
    // it is closed with its producers, so its viewers are told and the room doesn't keep it (D73)
    t.on('icestatechange', (state) => {
      if (state === 'disconnected') {
        console.debug(`[sfu] ${who(sid)}: a ${what} connection lost its path`);
        if (deadTransportMs && !entry.dead)
          entry.dead = setTimeout(() => {
            if (peer.transports.get(t.id) !== entry || t.closed || peers.get(sid) !== peer) return;
            log.log(`[sfu] ${who(sid)}: closed a ${what} connection that had no path for ${Math.round(deadTransportMs / 1000)} s`);
            closeTransport(peer, t.id);
            changed();
          }, deadTransportMs);
      } else if (state === 'connected' || state === 'completed') {
        clearTimeout(entry.dead);
        entry.dead = null;
      }
    });
    changed();
    return { id: t.id, iceParameters: t.iceParameters, iceCandidates: candidates(t.iceCandidates, host, ip), dtlsParameters: t.dtlsParameters };
  }

  // The candidates an app is given: the dialed host (or SFU_ANNOUNCED_ADDRESS), then, for an app on this machine's
  // network, its LAN addresses (and loopback, for one on this machine), each at the transport's port. The server
  // listens on every interface, so any of them reach it. An app out on the internet couldn't reach a LAN address,
  // and isn't told what they are.
  function candidates(list, host, ip) {
    const out = [];
    const seen = new Set();
    const dialed = hostOnly(host);
    const first = announced || (/^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(dialed) ? '' : dialed);
    const addresses = [first, ...(isLocal(ip) ? lan() : []), isLoopback(ip) ? '127.0.0.1' : ''].filter(Boolean);
    for (const base of list) {
      let priority = base.priority;
      for (const address of addresses) {
        const key = `${base.protocol}|${address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...base, address, ip: address, priority: priority-- });
      }
    }
    return out;
  }

  function closeTransport(peer, id) {
    const t = peer.transports.get(id);
    if (!t) return;
    clearTimeout(t.dead);
    peer.transports.delete(id);
    for (const [pid, p] of [...peer.producers]) if (p.transportId === id) closeProducer(peer, pid);
    for (const [cid, c] of [...peer.consumers]) if (c.transportId === id) peer.consumers.delete(cid);
    t.transport.close();
  }

  // The app is done with a transport of its own (a sidecar's share ended): it goes with what it carried
  function dropTransport(sid, transportId) {
    const peer = peers.get(sid);
    if (!peer?.transports.has(transportId)) return false;
    closeTransport(peer, transportId);
    changed();
    return true;
  }

  // New ICE credentials for a transport that lost its path; the app checks again with them (D73)
  async function restartIce(sid, transportId) {
    const t = peers.get(sid)?.transports.get(transportId);
    if (!t) throw refuse('No such transport');
    return t.transport.restartIce();
  }

  async function connect(sid, transportId, dtlsParameters) {
    const t = peers.get(sid)?.transports.get(transportId);
    if (!t) throw refuse('No such transport');
    await t.transport.connect({ dtlsParameters });
  }

  // `layers`: the publisher's own account of each encoding's size, lowest first ({ w, h, fps }); the SFU
  // picks layers for viewers by it
  async function produce(sid, transportId, kind, rtpParameters, layers) {
    const peer = peers.get(sid);
    const t = peer?.transports.get(transportId);
    if (!t || t.direction !== 'send') throw refuse('No such transport');
    for (const [pid, p] of [...peer.producers]) if (p.kind === kind) closeProducer(peer, pid);
    const producer = await t.transport.produce({ kind: KINDS[kind], rtpParameters, appData: { sid, kind }, ...(KINDS[kind] === 'video' ? { keyFrameRequestDelay: KEYFRAME_DELAY_MS } : null) });
    if (peers.get(sid) !== peer || !peer.transports.has(transportId)) {
      producer.close();
      throw refuse('left the channel');
    }
    peer.producers.set(producer.id, { producer, kind, transportId, layers: layers || [] });
    producer.on('transportclose', () => peer.producers.delete(producer.id));
    log.log(`[sfu] ${who(sid)} started publishing ${kind === 'shareAudio' ? 'a share’s sound' : `a ${kind === 'screen' ? 'screen share' : 'camera'}`}${KINDS[kind] === 'video' ? ` (${rtpParameters.encodings?.length || 1} layer${(rtpParameters.encodings?.length || 1) > 1 ? 's' : ''})` : ''} in ${channelName(peer.channelId)}`);
    emit.room(peer.channelId, 'sfu:produced', { sid, producerId: producer.id, kind }, sid);
    changed();
    return producer.id;
  }

  function setLayers(sid, producerId, layers) {
    const p = peers.get(sid)?.producers.get(producerId);
    if (!p) return false;
    p.layers = layers;
    // Re-pick for everyone watching it: the same tile may want another layer now
    for (const peer of peers.values()) for (const c of peer.consumers.values()) if (c.producerId === producerId) pick(c);
    return true;
  }

  function closeProducer(peer, producerId, why) {
    const p = peer.producers.get(producerId);
    if (!p) return;
    peer.producers.delete(producerId);
    p.producer.close();
    if (why !== 'quiet') log.log(`[sfu] ${who(peer.sid)} stopped publishing ${p.kind === 'shareAudio' ? 'a share’s sound' : `a ${p.kind === 'screen' ? 'screen share' : 'camera'}`}`);
    emit.room(peer.channelId, 'sfu:producerClosed', { sid: peer.sid, producerId, kind: p.kind });
    changed();
  }

  function unpublish(sid, producerId) {
    const peer = peers.get(sid);
    if (!peer?.producers.has(producerId)) return false;
    closeProducer(peer, producerId);
    return true;
  }

  // The producer `producerId` in this socket's room, and who publishes it
  function producerIn(channelId, producerId) {
    for (const peer of peers.values()) {
      if (peer.channelId !== channelId) continue;
      const p = peer.producers.get(producerId);
      if (p) return { peer, p };
    }
    return null;
  }

  // What is published in a channel, for someone who arrives
  function list(channelId) {
    const out = [];
    for (const peer of peers.values()) if (peer.channelId === channelId) for (const [producerId, p] of peer.producers) out.push({ sid: peer.sid, producerId, kind: p.kind, layers: p.layers });
    return out;
  }

  // A consumer starts paused, on the lowest layer: a grid of tiles costs only their small layers. sfu:view moves it.
  async function consume(sid, producerId, rtpCapabilities) {
    const peer = peers.get(sid);
    if (!peer) throw refuse('Not in a voice channel');
    const room = rooms.get(peer.channelId);
    const found = room && producerIn(peer.channelId, producerId);
    if (!found) throw refuse('That stream has ended');
    if (peer.consumers.size >= MAX_CONSUMERS) throw refuse('Watching too many streams');
    if (!room.router.canConsume({ producerId, rtpCapabilities })) throw refuse('This app can’t play that stream');
    const recv = [...peer.transports.values()].find((t) => t.direction === 'recv');
    if (!recv) throw refuse('No receive transport');
    const video = found.p.producer.kind === 'video';
    const consumer = await recv.transport.consume({ producerId, rtpCapabilities, paused: true, ...(video ? { preferredLayers: { spatialLayer: 0 } } : null), appData: { sid } });
    if (peers.get(sid) !== peer) {
      consumer.close();
      throw refuse('left the channel');
    }
    // appPaused: the app paused it (it starts paused); starved: the server did, for the viewer's link (D73)
    const c = { consumer, producerId, transportId: recv.transport.id, from: found.peer.sid, kind: found.p.kind, view: null, layer: 0, downAt: 0, focus: false, appPaused: true, starved: false };
    peer.consumers.set(consumer.id, c);
    if (video) prioritize(c);
    const gone = () => {
      if (peer.consumers.get(consumer.id) === c) peer.consumers.delete(consumer.id);
      changed();
    };
    consumer.on('producerclose', () => {
      gone();
      emit.to([sid], 'sfu:consumerClosed', { consumerId: consumer.id, producerId });
    });
    consumer.on('transportclose', gone);
    consumer.on('layerschange', (l) => {
      console.debug(`[sfu] ${who(sid)} watching ${who(c.from)}: layer ${l ? l.spatialLayer : 'none'}`);
      emit.to([sid], 'sfu:layer', { consumerId: consumer.id, spatialLayer: l ? l.spatialLayer : null });
    });
    if (found.peer.sid !== sid && c.kind !== 'shareAudio') log.log(`[sfu] ${who(sid)} started watching ${who(found.peer.sid)}’s ${c.kind === 'screen' ? 'screen share' : 'camera'}`);
    changed();
    return { id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters, type: consumer.type, from: found.peer.sid, streamKind: c.kind };
  }

  const consumerOf = (sid, consumerId) => peers.get(sid)?.consumers.get(consumerId);

  async function resume(sid, consumerId) {
    const c = consumerOf(sid, consumerId);
    if (!c) throw refuse('No such consumer');
    c.appPaused = false;
    if (!c.starved) await c.consumer.resume();
  }

  async function pause(sid, consumerId) {
    const c = consumerOf(sid, consumerId);
    if (!c) throw refuse('No such consumer');
    c.appPaused = true;
    await c.consumer.pause();
  }

  // Who gets the viewer's link first when it can't carry everything (mediasoup hands out the estimate by priority)
  function prioritize(c) {
    c.consumer.setPriority(c.focus ? PRIORITY.focus : PRIORITY[c.kind] || 1).catch(() => {});
  }

  // What the lowest layer of a stream needs, from the size its publisher gives
  function lowest(c) {
    const l = producerIn(peers.get(c.consumer.appData.sid)?.channelId, c.producerId)?.p.layers?.[0];
    return l?.w && l?.h ? Math.max(LOW_MIN_BPS, l.w * l.h * Math.max(l.fps || 30, 1) * LOW_BPP) : LOW_GUESS_BPS;
  }

  // A viewer's link estimate (D73): their lowest-priority camera is paused when the estimate stays below what the
  // lowest layers of everything they watch need, and comes back when there is room for it again. At most one
  // change a second; the app is told (sfu:starved), so the tile shows the preview still instead of a frozen frame.
  function feed(peer, avail) {
    if (!Number.isFinite(avail) || peers.get(peer.sid) !== peer) return;
    const now = Date.now();
    if (now - (peer.fedAt || 0) < 1000) return;
    peer.fedAt = now;
    const video = [...peer.consumers.values()].filter((c) => c.consumer.kind === 'video' && !c.appPaused && !c.consumer.closed && c.from !== peer.sid);
    const live = video.filter((c) => !c.starved);
    const need = live.reduce((a, c) => a + lowest(c), 0);
    const byPriority = (a, b) => (b.focus ? 3 : PRIORITY[b.kind]) - (a.focus ? 3 : PRIORITY[a.kind]);
    const victim = live.filter((c) => c.kind === 'camera' && !c.focus).sort(byPriority).at(-1);
    if (avail < need && victim) {
      peer.feedSince = null;
      peer.starveSince ??= now;
      if (now - peer.starveSince < STARVE_AFTER_MS) return;
      peer.starveSince = now; // the next one no sooner than STARVE_AFTER_MS from now
      starve(peer, victim, true, avail, need);
      return;
    }
    peer.starveSince = null;
    const next = video.filter((c) => c.starved).sort(byPriority)[0];
    if (!next || avail < (need + lowest(next)) * FEED_ROOM) return void (peer.feedSince = null);
    peer.feedSince ??= now;
    if (now - peer.feedSince < FEED_AFTER_MS) return;
    peer.feedSince = null;
    starve(peer, next, false, avail, need);
  }

  function starve(peer, c, on, avail, need) {
    c.starved = on;
    console.debug(`[sfu] ${who(peer.sid)}: ${on ? 'paused' : 'resumed'} ${who(c.from)}’s camera for their link (${(avail / 1e6).toFixed(1)} Mbit/s, the lowest layers need ${(need / 1e6).toFixed(1)})`);
    (on ? c.consumer.pause() : c.appPaused ? Promise.resolve() : c.consumer.resume()).catch(() => {});
    emit.to([peer.sid], 'sfu:starved', { consumerId: c.consumer.id, starved: on });
    changed();
  }

  // A viewer's ask, at most once per KEYFRAME_ASK_MS for each stream (whatever number of consumers it has of it);
  // mediasoup then asks the publisher no more often than KEYFRAME_DELAY_MS for everyone
  function keyframe(sid, consumerId) {
    const peer = peers.get(sid);
    const c = peer?.consumers.get(consumerId);
    if (!c) return;
    const now = Date.now();
    peer.keyAsk ||= new Map(); // producerId -> when
    if (now - (peer.keyAsk.get(c.producerId) || 0) < KEYFRAME_ASK_MS) return;
    peer.keyAsk.set(c.producerId, now);
    c.consumer.requestKeyFrame().catch(() => {});
  }

  function stopConsumer(sid, consumerId) {
    const peer = peers.get(sid);
    const c = peer?.consumers.get(consumerId);
    if (!c) return false;
    peer.consumers.delete(consumerId);
    c.consumer.close();
    changed();
    return true;
  }

  // The viewer's tile, in device pixels: the smallest layer at least that tall (with a little slack, as the
  // sidecar's ladder::cap did), the top one when none is. Down at once, up no sooner than 2 s after a move down.
  // `focus`: the tile the stage shows large, served first on a thin link (D73).
  function view(sid, consumerId, w, h, focus = false) {
    const c = consumerOf(sid, consumerId);
    if (!c || c.consumer.kind !== 'video') return false;
    c.view = { w, h };
    if (c.focus !== focus) {
      c.focus = focus;
      prioritize(c);
    }
    pick(c);
    return true;
  }

  function pick(c) {
    if (!c.view || c.consumer.closed) return;
    const p = producerIn(peers.get(c.consumer.appData.sid)?.channelId, c.producerId)?.p;
    const layers = p?.layers?.length ? p.layers : null;
    // With the publisher's list, nothing above the last layer in it: a layer it left out is about to stop
    const count = Math.min(p?.producer.rtpParameters.encodings?.length || 1, layers ? layers.length : Infinity);
    let want = count - 1;
    if (layers) {
      for (let i = 0; i < count; i++) {
        if (layers[i].h >= c.view.h * 0.9) {
          want = i;
          break;
        }
      }
    } else if (c.view.h <= 400) want = 0;
    if (want === c.layer) return;
    const now = Date.now();
    if (want > c.layer && now - c.downAt < UP_AFTER_DOWN_MS) {
      clearTimeout(c.retry);
      c.retry = setTimeout(() => pick(c), UP_AFTER_DOWN_MS - (now - c.downAt) + 10);
      return;
    }
    if (want < c.layer) c.downAt = now;
    c.layer = want;
    // mediasoup keeps forwarding the layer it has until the new one has a keyframe, which it asks for itself
    c.consumer.setPreferredLayers({ spatialLayer: want }).catch(() => {});
  }

  // Everything this socket had in the SFU: it left the channel, was taken out, or went away
  function leave(sid) {
    const peer = peers.get(sid);
    if (!peer) return;
    for (const pid of [...peer.producers.keys()]) closeProducer(peer, pid);
    for (const id of [...peer.transports.keys()]) closeTransport(peer, id);
    peers.delete(sid);
    const room = rooms.get(peer.channelId);
    room?.peers.delete(sid);
    tidy(room);
    changed();
  }

  // After a worker died: drop the socket's state without telling the room (the room is gone)
  function forget(sid) {
    const peer = peers.get(sid);
    if (!peer) return;
    for (const p of peer.producers.values()) emit.room(peer.channelId, 'sfu:producerClosed', { sid, producerId: p.producer.id, kind: p.kind });
    peers.delete(sid);
  }

  // For the admin dashboard
  async function stats() {
    const workers = await Promise.all(
      pool.filter(Boolean).map(async (s) => ({ index: s.index, pid: s.worker.pid, port: s.port, routers: s.routers.size, usage: await s.worker.getResourceUsage().catch(() => null) }))
    );
    const out = [];
    for (const room of rooms.values()) {
      const members = [];
      for (const sid of room.peers) {
        const peer = peers.get(sid);
        if (!peer) continue;
        const transports = await Promise.all(
          [...peer.transports.values()].map(async (t) => {
            const [st] = await t.transport.getStats().catch(() => []);
            return { id: t.transport.id, direction: t.direction, owner: t.owner, ice: t.transport.iceState, dtls: t.transport.dtlsState, sendBitrate: st?.sendBitrate ?? null, recvBitrate: st?.recvBitrate ?? null, available: st?.availableOutgoingBitrate ?? null, probation: st?.probationSendBitrate ?? null };
          })
        );
        const producers = await Promise.all(
          [...peer.producers.entries()].map(async ([id, p]) => {
            const st = await p.producer.getStats().catch(() => []);
            return { id, kind: p.kind, paused: p.producer.paused, layers: p.layers, streams: st.map((x) => ({ rid: x.rid || null, bitrate: x.bitrate, score: x.score })) };
          })
        );
        const consumers = [...peer.consumers.entries()].map(([id, c]) => ({
          id,
          from: c.from,
          kind: c.kind,
          paused: c.consumer.paused,
          producerPaused: c.consumer.producerPaused,
          current: c.consumer.currentLayers?.spatialLayer ?? null,
          preferred: c.consumer.preferredLayers?.spatialLayer ?? null,
          view: c.view,
          focus: c.focus,
          priority: c.consumer.priority,
          starved: c.starved,
          score: c.consumer.score?.score ?? null,
        }));
        members.push({ sid, transports, producers, consumers });
      }
      out.push({ channelId: room.id, worker: room.slot.index, members });
    }
    return { workers, rooms: out };
  }

  async function close() {
    closed = true;
    for (const s of pool) s?.worker.close();
    pool.length = 0;
    rooms.clear();
    peers.clear();
  }

  return {
    start,
    caps,
    transport,
    dropTransport,
    restartIce,
    connect,
    produce,
    setLayers,
    unpublish,
    list,
    consume,
    resume,
    pause,
    stopConsumer,
    keyframe,
    view,
    leave,
    stats,
    close,
    has: (sid) => peers.has(sid),
    publishes: (sid, kind) => [...(peers.get(sid)?.producers.values() || [])].some((p) => p.kind === kind),
    onChange: (fn) => (changed = fn),
    get ports() {
      return pool.filter(Boolean).map((s) => s.port);
    },
  };
}

// "chat.example.com:3000" → "chat.example.com"; "[::1]:3000" → "::1"
function hostOnly(host) {
  const h = String(host || '').trim();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  const i = h.lastIndexOf(':');
  return (i > 0 && h.indexOf(':') === i ? h.slice(0, i) : h) || '';
}

module.exports = { createSfu, OWNERS, KINDS, MAX_LAYERS, hostOnly };
