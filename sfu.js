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

function createSfu({ workers = 1, udpPort, tcpPort = 0, announced = '', log = console, emit, who = (sid) => sid, channelName = (id) => id }) {
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
    if (!slot) throw new Error('The server’s media relay is restarting');
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
  // `host` is the host the socket dialed: what the app is told to send to (D70).
  async function transport(sid, channelId, { direction, owner }, host) {
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
      throw new Error('left the channel');
    }
    if (direction === 'send') await t.setMaxIncomingBitrate(MAX_INCOMING).catch(() => {});
    peer.transports.set(t.id, { transport: t, owner, direction });
    t.on('dtlsstatechange', (state) => {
      if (state === 'failed') log.warn(`[sfu] ${who(sid)}: a ${direction === 'send' ? 'publishing' : 'watching'} connection failed (DTLS)`);
    });
    t.on('icestatechange', (state) => {
      if (state === 'disconnected') console.debug(`[sfu] ${who(sid)}: a connection lost its path`);
    });
    changed();
    return { id: t.id, iceParameters: t.iceParameters, iceCandidates: candidates(t.iceCandidates, host), dtlsParameters: t.dtlsParameters };
  }

  // The candidates an app is given: the dialed host (or SFU_ANNOUNCED_ADDRESS), then this machine's LAN
  // addresses, each at the transport's port. The server listens on every interface, so any of them reach it.
  function candidates(list, host) {
    const out = [];
    const seen = new Set();
    const dialed = hostOnly(host);
    const first = announced || (/^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(dialed) ? '' : dialed);
    const addresses = [first, ...lan(), '127.0.0.1'].filter(Boolean);
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
    peer.transports.delete(id);
    for (const [pid, p] of [...peer.producers]) if (p.transportId === id) closeProducer(peer, pid);
    for (const [cid, c] of [...peer.consumers]) if (c.transportId === id) peer.consumers.delete(cid);
    t.transport.close();
  }

  async function connect(sid, transportId, dtlsParameters) {
    const t = peers.get(sid)?.transports.get(transportId);
    if (!t) throw new Error('No such transport');
    await t.transport.connect({ dtlsParameters });
  }

  // `layers`: the publisher's own account of each encoding's size, lowest first ({ w, h, fps }); the SFU
  // picks layers for viewers by it
  async function produce(sid, transportId, kind, rtpParameters, layers) {
    const peer = peers.get(sid);
    const t = peer?.transports.get(transportId);
    if (!t || t.direction !== 'send') throw new Error('No such transport');
    for (const [pid, p] of [...peer.producers]) if (p.kind === kind) closeProducer(peer, pid);
    const producer = await t.transport.produce({ kind: KINDS[kind], rtpParameters, appData: { sid, kind } });
    if (peers.get(sid) !== peer || !peer.transports.has(transportId)) {
      producer.close();
      throw new Error('left the channel');
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
    if (!peer) throw new Error('Not in a voice channel');
    const room = rooms.get(peer.channelId);
    const found = room && producerIn(peer.channelId, producerId);
    if (!found) throw new Error('That stream has ended');
    if (peer.consumers.size >= MAX_CONSUMERS) throw new Error('Watching too many streams');
    if (!room.router.canConsume({ producerId, rtpCapabilities })) throw new Error('This app can’t play that stream');
    const recv = [...peer.transports.values()].find((t) => t.direction === 'recv');
    if (!recv) throw new Error('No receive transport');
    const video = found.p.producer.kind === 'video';
    const consumer = await recv.transport.consume({ producerId, rtpCapabilities, paused: true, ...(video ? { preferredLayers: { spatialLayer: 0 } } : null), appData: { sid } });
    if (peers.get(sid) !== peer) {
      consumer.close();
      throw new Error('left the channel');
    }
    const c = { consumer, producerId, transportId: recv.transport.id, from: found.peer.sid, kind: found.p.kind, view: null, layer: 0, downAt: 0 };
    peer.consumers.set(consumer.id, c);
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
    if (!c) throw new Error('No such consumer');
    await c.consumer.resume();
  }

  async function pause(sid, consumerId) {
    const c = consumerOf(sid, consumerId);
    if (!c) throw new Error('No such consumer');
    await c.consumer.pause();
  }

  // mediasoup limits how often a producer is asked
  function keyframe(sid, consumerId) {
    consumerOf(sid, consumerId)?.consumer.requestKeyFrame().catch(() => {});
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
  function view(sid, consumerId, w, h) {
    const c = consumerOf(sid, consumerId);
    if (!c || c.consumer.kind !== 'video') return false;
    c.view = { w, h };
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
