// The engine: one thread that owns every stream, its layers and its viewers.
//
//   capture ──frame──> engine ──frame──> layer thread (scale, encode) ──┐
//                        ▲                                              │
//                        └──────────────── encoded access unit ─────────┘
//                        └──> each viewer on that layer (str0m: RTP, SRTP, pacing)
//
// A stream (the screen share, or the camera) is encoded once per *layer*, not
// once per viewer: a layer is a rung of the quality ladder (ladder.rs), and
// viewers whose connections and tiles call for the same rung share its
// encoder. That is what a mesh can offer in place of an SFU: the upload still
// grows with the viewers, the encoding doesn't.
//
// Everything arrives on one channel (Msg): commands from the app, frames,
// encoded units, UDP packets. Between messages the engine drives each viewer's
// Rtc to its next timeout.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, MediaKind, MediaTime, Mid, Pt};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};

use crate::audio::{self, Opus};
use crate::encode::{self, Encoded};
use crate::frame::{even, Frame, Nv12, Scaler};
use crate::ladder::{self, Rung};
use crate::log;
use crate::net::{self, Sockets};
use crate::proto::{emit, Cmd, Kind, Source, Tier};
use crate::source::{self, Capture, Sinks};

const MAX_LAYERS: usize = 3; // encoders per stream, whatever the number of viewers
const START_BPS: u64 = 2_500_000; // a viewer's first bandwidth estimate
const MIN_BPS: u32 = 150_000;
const KEY_WAIT: Duration = Duration::from_millis(60); // how long a wanted keyframe waits for a new frame before the last one is repeated
const KEY_GAP: Duration = Duration::from_millis(700); // between keyframes a layer makes on request
const TICK: Duration = Duration::from_secs(1);
const IDLE: Duration = Duration::from_millis(500); // a still screen sends no frames: the last one is repeated this often

pub enum Msg {
    Cmd(Cmd),
    Frame(Kind),
    Audio { kind: Kind, pcm: Vec<f32> },
    Ended { kind: Kind, why: String },
    Packet { kind: Kind, viewer: String, local: SocketAddr, src: SocketAddr, data: Vec<u8>, at: Instant },
    Stun(Vec<SocketAddr>),
    LayerUp { kind: Kind, id: u32, name: &'static str, hw: bool, high: bool, note: Option<String> },
    Encoded { kind: Kind, id: u32, unit: Encoded, at: Instant, ms: f32 },
    LayerDown { kind: Kind, id: u32, why: String },
}

enum LayerMsg {
    Frame(Arc<Frame>, Instant, bool), // the picture, when it is shown, and whether to make a keyframe
    Rates(u32, f32),
}

struct Layer {
    id: u32,
    rung: Rung,
    high: bool, // wanted profile; `is_high` is what the encoder really makes
    tx: SyncSender<LayerMsg>,
    bps: u32,
    name: &'static str,
    hw: bool,
    is_high: bool,
    up: bool,
    want_key: bool,
    last_key: Option<Instant>,
    due: Option<Instant>, // when a layer slower than the capture takes its next frame
    frames: u32, // encoded since the last tick
    fps: f32,
    ms: f32, // encode time per frame, smoothed
    note: Option<String>,
}

#[derive(Default, Clone, Copy)]
struct View {
    w: f32,
    h: f32,
    hidden: bool,
}

struct Viewer {
    rtc: Rtc,
    socks: Sockets,
    own: bool,
    mid: Mid,
    audio: Option<Mid>,
    pt_opus: Option<Pt>,
    pending: Option<SdpPendingOffer>,
    pt_base: Option<Pt>,
    pt_high: Option<Pt>,
    answered: bool,
    connected: bool,
    need_key: bool,
    view: View,
    estimate: f64, // bits per second
    ladder: ladder::State,
    layer: Option<u32>,
    timeout: Instant,
    stun_id: [u8; 12],
    stun_done: bool,
    dead: bool,
    // stats
    bytes: u64,
    bytes_prev: u64,
    sent_bps: f64,
    rtt: Option<f32>,
    loss: Option<f32>,
    nacks: u64,
    plis: u64,
    cand: Option<String>,
}

struct Stream {
    kind: Kind,
    tier: Tier,
    sharp: bool,
    hw: bool,
    _capture: Capture,
    slot: Arc<Mutex<Option<Frame>>>,
    last: Option<(Arc<Frame>, Instant)>, // the newest frame and when it was last fed to the layers
    opus: Option<Opus>,
    audio_time: u64, // in samples
    audio_at: Option<Instant>, // when sound last arrived
    src: (usize, usize), // size of the captured frames; (0, 0) before the first
    rungs: Vec<Rung>,
    layers: Vec<Layer>,
    next_layer: u32,
    viewers: HashMap<String, Viewer>,
    started: Instant,
    cap_frames: u32,
    cap_fps: f32,
}

struct Engine {
    tx: Sender<Msg>,
    streams: HashMap<Kind, Stream>,
    stun: Vec<SocketAddr>,
    stun_asked: bool,
}

pub fn run(tx: Sender<Msg>, rx: Receiver<Msg>) {
    emit(json!({
        "ev": "ready",
        "version": env!("CARGO_PKG_VERSION"),
        "sources": source::kinds(),
        "hardware": encode::hardware_names(),
        "audio": source::audio(),
    }));
    let mut e = Engine { tx, streams: HashMap::new(), stun: Vec::new(), stun_asked: false };
    let mut tick = Instant::now() + TICK;
    loop {
        let now = Instant::now();
        let mut wake = tick;
        for s in e.streams.values() {
            if let Some((_, fed)) = &s.last {
                wake = wake.min(*fed + if s.layers.iter().any(|l| l.want_key) { KEY_WAIT } else { IDLE });
            }
            for v in s.viewers.values() {
                wake = wake.min(v.timeout);
            }
        }
        match rx.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(Msg::Cmd(Cmd::Quit)) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(msg) => e.handle(msg),
            Err(RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        for s in e.streams.values_mut() {
            s.idle(now);
            let kind = s.kind;
            for (id, v) in s.viewers.iter_mut() {
                if v.timeout <= now && !v.dead {
                    let _ = v.rtc.handle_input(Input::Timeout(now));
                    drain(kind, id, v, &mut s.layers);
                }
            }
            s.reap();
        }
        if now >= tick {
            tick = now + TICK;
            for s in e.streams.values_mut() {
                s.tick(&e.tx, now);
            }
        }
    }
}

// Poll a viewer's Rtc until it has nothing more to say (str0m's single-mutation
// rule: every change is followed by a drain)
fn drain(kind: Kind, id: &str, v: &mut Viewer, layers: &mut [Layer]) {
    loop {
        match v.rtc.poll_output() {
            Ok(Output::Timeout(t)) => {
                v.timeout = t;
                return;
            }
            Ok(Output::Transmit(t)) => v.socks.send(t.source, t.destination, &t.contents),
            Ok(Output::Event(ev)) => match ev {
                Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                    // Gone for good as far as ICE can tell. The app decides what to do with the viewer.
                    v.connected = false;
                    emit(json!({ "ev": "viewer", "kind": kind, "viewer": id, "state": "disconnected" }));
                }
                Event::Connected => {
                    v.connected = true;
                    v.need_key = true;
                    if let Some(l) = layers.iter_mut().find(|l| Some(l.id) == v.layer) {
                        l.want_key = true;
                    }
                    emit(json!({ "ev": "viewer", "kind": kind, "viewer": id, "state": "connected" }));
                }
                Event::KeyframeRequest(_) => {
                    v.plis += 1;
                    if let Some(l) = layers.iter_mut().find(|l| Some(l.id) == v.layer) {
                        l.want_key = true;
                    }
                }
                Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => v.estimate = estimate.as_f64(),
                Event::MediaEgressStats(m) => {
                    v.bytes = m.bytes;
                    v.nacks = m.nacks;
                    if let Some(r) = m.rtt {
                        v.rtt = Some(r.as_secs_f32() * 1000.0);
                    }
                    if m.loss.is_some() {
                        v.loss = m.loss;
                    }
                }
                Event::PeerStats(p) => {
                    if let Some(pair) = p.selected_candidate_pair {
                        v.cand = Some(format!("{} → {}", reach(&pair.local.addr), reach(&pair.remote.addr)));
                        if v.rtt.is_none() {
                            v.rtt = pair.current_round_trip_time.map(|d| d.as_secs_f32() * 1000.0);
                        }
                    }
                }
                _ => {}
            },
            Err(e) => {
                log!("{kind:?} viewer {id}: {e}");
                v.dead = true;
                return;
            }
        }
    }
}

impl Engine {
    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Cmd(cmd) => self.command(cmd),
            Msg::Frame(kind) => {
                if let Some(s) = self.streams.get_mut(&kind) {
                    s.frame(&self.tx);
                }
            }
            Msg::Audio { kind, pcm } => {
                if let Some(s) = self.streams.get_mut(&kind) {
                    s.sound(&pcm);
                }
            }
            Msg::Ended { kind, why } => {
                if self.streams.remove(&kind).is_some() {
                    emit(json!({ "ev": "stopped", "kind": kind, "reason": why }));
                }
            }
            Msg::Packet { kind, viewer, local, src, data, at } => {
                let Some(s) = self.streams.get_mut(&kind) else { return };
                let Some(v) = s.viewers.get_mut(&viewer) else { return };
                if self.stun.contains(&src) {
                    if let (false, Some(public)) = (v.stun_done, net::binding_response(&data, &v.stun_id)) {
                        v.stun_done = true;
                        if let Ok(c) = Candidate::server_reflexive(public, local, "udp") {
                            if let Some(c) = v.rtc.add_local_candidate(c) {
                                let line = c.to_sdp_string();
                                emit(json!({ "ev": "signal", "kind": kind, "viewer": viewer, "data": { "candidate": { "candidate": line, "sdpMid": v.mid.to_string(), "sdpMLineIndex": 0 } } }));
                            }
                            drain(kind, &viewer, v, &mut s.layers);
                        }
                    }
                    return;
                }
                let Ok(contents) = data.as_slice().try_into() else { return };
                let input = Input::Receive(at, Receive { proto: Protocol::Udp, source: src, destination: local, contents });
                if v.rtc.accepts(&input) {
                    if let Err(e) = v.rtc.handle_input(input) {
                        log!("{kind:?} viewer {viewer}: {e}");
                    }
                    drain(kind, &viewer, v, &mut s.layers);
                }
            }
            Msg::Stun(addrs) => {
                self.stun = addrs;
                for s in self.streams.values_mut() {
                    for v in s.viewers.values_mut() {
                        ask_stun(&self.stun, v);
                    }
                }
            }
            Msg::LayerUp { kind, id, name, hw, high, note } => {
                let Some(s) = self.streams.get_mut(&kind) else { return };
                if let Some(l) = s.layers.iter_mut().find(|l| l.id == id) {
                    l.name = name;
                    l.hw = hw;
                    l.is_high = high;
                    l.up = true;
                    if let Some(n) = &note {
                        log!("{kind:?} {}x{}: {n}", l.rung.w, l.rung.h);
                    }
                    l.note = note;
                }
            }
            Msg::Encoded { kind, id, unit, at, ms } => {
                if let Some(s) = self.streams.get_mut(&kind) {
                    s.encoded(id, unit, at, ms);
                }
            }
            Msg::LayerDown { kind, id, why } => {
                log!("{kind:?} layer {id} failed: {why}");
                if self.streams.remove(&kind).is_some() {
                    emit(json!({ "ev": "stopped", "kind": kind, "reason": format!("encoder failed: {why}") }));
                }
            }
        }
    }

    fn command(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Start { kind, source, tier, mode, hw, stun } => {
                self.streams.remove(&kind);
                if !self.stun_asked && !stun.is_empty() {
                    self.stun_asked = true;
                    net::resolve(stun, self.tx.clone());
                }
                match Stream::start(kind, &source, tier, mode == "sharp", hw, &self.tx) {
                    Ok(s) => {
                        self.streams.insert(kind, s);
                        emit(json!({ "ev": "started", "kind": kind }));
                    }
                    Err(e) => emit(json!({ "ev": "error", "kind": kind, "message": e })),
                }
            }
            Cmd::Quality { kind, tier, mode } => {
                if let Some(s) = self.streams.get_mut(&kind) {
                    s.tier = tier;
                    s.sharp = mode == "sharp";
                    s.relayout(&self.tx);
                }
            }
            Cmd::Stop { kind } => {
                self.streams.remove(&kind);
            }
            Cmd::Viewer { kind, viewer, own } => {
                let Some(s) = self.streams.get_mut(&kind) else { return };
                s.viewers.remove(&viewer);
                match new_viewer(kind, &viewer, own, s.opus.is_some() && !own, &self.tx) {
                    Ok(mut v) => {
                        ask_stun(&self.stun, &mut v);
                        drain(kind, &viewer, &mut v, &mut s.layers);
                        s.viewers.insert(viewer, v);
                    }
                    Err(e) => emit(json!({ "ev": "viewer", "kind": kind, "viewer": viewer, "state": "failed", "message": e })),
                }
            }
            Cmd::Unviewer { kind, viewer } => {
                if let Some(s) = self.streams.get_mut(&kind) {
                    s.viewers.remove(&viewer);
                    s.plan(&self.tx);
                }
            }
            Cmd::Signal { kind, viewer, data } => {
                let Some(s) = self.streams.get_mut(&kind) else { return };
                let Some(v) = s.viewers.get_mut(&viewer) else { return };
                if let Err(e) = signal(v, &data) {
                    log!("{kind:?} viewer {viewer}: {e}");
                    emit(json!({ "ev": "viewer", "kind": kind, "viewer": viewer, "state": "failed", "message": e }));
                    s.viewers.remove(&viewer);
                    return;
                }
                drain(kind, &viewer, v, &mut s.layers);
                s.plan(&self.tx);
            }
            Cmd::View { kind, viewer, w, h, hidden } => {
                let Some(s) = self.streams.get_mut(&kind) else { return };
                let Some(v) = s.viewers.get_mut(&viewer) else { return };
                v.view = View { w: w.max(0.0), h: h.max(0.0), hidden };
                s.plan(&self.tx);
            }
            Cmd::Quit => {}
        }
    }
}

// How an address was reached, without putting the address itself into stats people copy and paste
fn reach(addr: &SocketAddr) -> &'static str {
    match addr.ip() {
        std::net::IpAddr::V4(ip) if ip.is_loopback() => "loopback/udp",
        std::net::IpAddr::V4(ip) if ip.is_private() => "lan/udp",
        _ => "public/udp",
    }
}

fn ask_stun(stun: &[SocketAddr], v: &mut Viewer) {
    if v.stun_done || v.own {
        return;
    }
    let req = net::binding_request(&v.stun_id);
    for server in stun.iter().take(1) {
        // From the default route's socket; the others are LAN-only or VPNs
        if let Some((local, _)) = v.socks.list.first() {
            v.socks.send(*local, *server, &req);
        }
    }
}

// `sound`: the stream has audio and this viewer gets it (our own preview doesn't: we'd hear the share twice)
fn new_viewer(kind: Kind, id: &str, own: bool, sound: bool, tx: &Sender<Msg>) -> Result<Viewer, String> {
    let socks = net::open(kind, id, own, tx).map_err(|e| e.to_string())?;
    let now = Instant::now();
    let mut rtc = Rtc::builder()
        .clear_codecs()
        .enable_h264(true)
        .enable_opus(sound, false)
        .enable_bwe(Some(Bitrate::bps(START_BPS)))
        .set_stats_interval(Some(Duration::from_secs(1)))
        .build(now);
    for (addr, _) in &socks.list {
        if let Ok(c) = Candidate::host(*addr, "udp") {
            rtc.add_local_candidate(c);
        }
    }
    let mut api = rtc.sdp_api();
    let name = format!("fs-{}", if kind == Kind::Screen { "screen" } else { "camera" });
    let mid = api.add_media(MediaKind::Video, Direction::SendOnly, Some(name.clone()), Some(format!("{name}-video")), None);
    let audio = sound.then(|| api.add_media(MediaKind::Audio, Direction::SendOnly, Some(name.clone()), Some(format!("{name}-audio")), None));
    let (offer, pending) = api.apply().ok_or("no offer")?;
    emit(json!({ "ev": "signal", "kind": kind, "viewer": id, "data": { "sdp": { "type": "offer", "sdp": offer.to_sdp_string() } } }));
    Ok(Viewer {
        rtc,
        socks,
        own,
        mid,
        audio,
        pt_opus: None,
        pending: Some(pending),
        pt_base: None,
        pt_high: None,
        answered: false,
        connected: false,
        need_key: true,
        view: View::default(),
        estimate: START_BPS as f64,
        ladder: ladder::State::default(),
        layer: None,
        timeout: now,
        stun_id: net::txid(),
        stun_done: false,
        dead: false,
        bytes: 0,
        bytes_prev: 0,
        sent_bps: 0.0,
        rtt: None,
        loss: None,
        nacks: 0,
        plis: 0,
        cand: None,
    })
}

// The viewer's answer, or one of their ICE candidates
fn signal(v: &mut Viewer, data: &Value) -> Result<(), String> {
    if let Some(sdp) = data.get("sdp") {
        if sdp.get("type").and_then(Value::as_str) != Some("answer") {
            return Err("expected an answer".into());
        }
        let text = sdp.get("sdp").and_then(Value::as_str).ok_or("no sdp")?;
        let answer = SdpAnswer::from_sdp_string(text).map_err(|e| e.to_string())?;
        let pending = v.pending.take().ok_or("no offer pending")?;
        v.rtc.sdp_api().accept_answer(pending, answer).map_err(|e| e.to_string())?;
        let writer = v.rtc.writer(v.mid).ok_or("no video line in the answer")?;
        let mut constrained = false;
        for p in writer.payload_params() {
            let spec = p.spec();
            if spec.codec != Codec::H264 || spec.format.packetization_mode != Some(1) {
                continue;
            }
            let id = spec.format.profile_level_id.unwrap_or(0);
            match id >> 16 {
                0x64 => v.pt_high = v.pt_high.or(Some(p.pt())),
                // Constrained Baseline (0x42 with constraint_set1) is what every H.264 decoder plays
                0x42 if id & 0x4000 != 0 && !constrained => {
                    constrained = true;
                    v.pt_base = Some(p.pt());
                }
                0x42 | 0x4d if v.pt_base.is_none() => v.pt_base = Some(p.pt()),
                _ => {}
            }
        }
        if let Some(w) = v.audio.and_then(|mid| v.rtc.writer(mid)) {
            v.pt_opus = w.payload_params().find(|p| p.spec().codec == Codec::Opus).map(|p| p.pt());
        }
        if v.pt_base.is_none() && v.pt_high.is_none() {
            return Err("the viewer can't decode H.264".into());
        }
        v.answered = true;
        return Ok(());
    }
    if let Some(c) = data.get("candidate") {
        // { candidate: "candidate:…" } as RTCIceCandidate.toJSON() gives it; "" ends the list
        let line = c.get("candidate").and_then(Value::as_str).or(c.as_str()).unwrap_or("");
        if line.is_empty() {
            return Ok(());
        }
        // Names we can't resolve (mDNS ".local") and TCP candidates are skipped, not fatal
        if let Ok(c) = Candidate::from_sdp_string(line.trim_start_matches("a=")) {
            if c.proto() == Protocol::Udp && c.addr().is_ipv4() {
                v.rtc.add_remote_candidate(c);
            }
        }
    }
    Ok(())
}

impl Stream {
    fn start(kind: Kind, source: &Source, tier: Tier, sharp: bool, hw: bool, tx: &Sender<Msg>) -> Result<Stream, String> {
        let slot: Arc<Mutex<Option<Frame>>> = Arc::new(Mutex::new(None));
        let (fill, wake) = (slot.clone(), tx.clone());
        // The newest frame waits in the slot; a frame the engine didn't get to is replaced, never queued
        let video = Box::new(move |f: Frame| {
            let was = fill.lock().unwrap().replace(f);
            if was.is_none() {
                let _ = wake.send(Msg::Frame(kind));
            }
        });
        let (sound, ended) = (tx.clone(), tx.clone());
        let sinks = Sinks {
            video,
            audio: Box::new(move |pcm| drop(sound.send(Msg::Audio { kind, pcm }))),
            ended: Box::new(move |why| drop(ended.send(Msg::Ended { kind, why }))),
        };
        let opus = if source.audio && (source::audio() || source.kind == "test") { Some(Opus::new()?) } else { None };
        let capture = source::start(source, &tier, sinks)?;
        Ok(Stream {
            kind,
            tier,
            sharp,
            hw,
            _capture: capture,
            slot,
            last: None,
            opus,
            audio_time: 0,
            audio_at: None,
            src: (0, 0),
            rungs: Vec::new(),
            layers: Vec::new(),
            next_layer: 0,
            viewers: HashMap::new(),
            started: Instant::now(),
            cap_frames: 0,
            cap_fps: 0.0,
        })
    }

    // The ceiling: the source, no bigger than the tier, and the ladder below it
    fn relayout(&mut self, tx: &Sender<Msg>) {
        let (sw, sh) = self.src;
        if sw == 0 {
            return;
        }
        let scale = (sw as f32 / self.tier.width as f32).max(sh as f32 / self.tier.height as f32).max(1.0);
        let (w, h) = (even((sw as f32 / scale) as usize), even((sh as f32 / scale) as usize));
        let fps = if self.sharp { self.tier.fps.min(30.0) } else { self.tier.fps };
        self.rungs = ladder::rungs(self.sharp, w, h, fps);
        self.layers.clear();
        for v in self.viewers.values_mut() {
            v.ladder.reset();
            v.layer = None;
        }
        self.plan(tx);
    }

    fn frame(&mut self, tx: &Sender<Msg>) {
        let Some(frame) = self.slot.lock().unwrap().take() else { return };
        if frame.w < 2 || frame.h < 2 {
            return;
        }
        self.cap_frames += 1;
        if self.src != (frame.w, frame.h) {
            self.src = (frame.w, frame.h);
            self.relayout(tx);
        }
        let frame = Arc::new(frame);
        let at = frame.at;
        self.feed(frame, at);
    }

    // A still screen delivers nothing. Repeat its last frame when a viewer waits for a keyframe, and
    // now and then so the stream (and its bandwidth estimate) stays alive.
    fn idle(&mut self, now: Instant) {
        let Some((frame, fed)) = &self.last else { return };
        let wait = if self.layers.iter().any(|l| l.want_key) { KEY_WAIT } else { IDLE };
        if now.saturating_duration_since(*fed) >= wait {
            let frame = frame.clone();
            self.feed(frame, now);
        }
    }

    fn feed(&mut self, frame: Arc<Frame>, at: Instant) {
        self.last = Some((frame.clone(), at));
        let top_fps = self.rungs.first().map_or(0.0, |r| r.fps);
        for l in self.layers.iter_mut() {
            // A layer below the capture's rate takes the frames that keep its own pace. One at the
            // capture's rate takes them all: frames never arrive evenly, and timing them would drop some.
            if l.rung.fps < top_fps {
                let step = Duration::from_secs_f32(1.0 / l.rung.fps);
                match l.due {
                    Some(due) if at + step / 4 < due => continue,
                    Some(due) => l.due = Some((due + step).max(at)),
                    None => l.due = Some(at + step),
                }
            }
            let key = l.want_key && l.last_key.map_or(true, |t| at.saturating_duration_since(t) >= KEY_GAP);
            match l.tx.try_send(LayerMsg::Frame(frame.clone(), at, key)) {
                Ok(()) => {
                    if key {
                        l.want_key = false;
                        l.last_key = Some(at);
                    }
                }
                Err(TrySendError::Full(_)) => {} // the encoder is still on the last one: drop, don't queue
                Err(TrySendError::Disconnected(_)) => {}
            }
        }
    }

    // The share's sound, to everyone connected (hidden or not: a minimized stream is still heard)
    fn sound(&mut self, pcm: &[f32]) {
        let Some(opus) = self.opus.as_mut() else { return };
        let (kind, now) = (self.kind, Instant::now());
        // Some captures deliver nothing while nothing plays (Windows process loopback). The clock the viewers
        // play by has to move through that silence too, or what follows would be heard late.
        if let Some(last) = self.audio_at {
            let gap = now.saturating_duration_since(last);
            if gap > Duration::from_millis(200) {
                self.audio_time += (gap.as_secs_f64() * audio::RATE as f64) as u64;
            }
        }
        self.audio_at = Some(now);
        let (viewers, time) = (&mut self.viewers, &mut self.audio_time);
        opus.push(pcm, |packet| {
            let at = MediaTime::new(*time, str0m::media::Frequency::FORTY_EIGHT_KHZ);
            *time += audio::FRAME as u64;
            for (id, v) in viewers.iter_mut() {
                let (Some(mid), Some(pt), true) = (v.audio, v.pt_opus, v.connected && !v.dead) else { continue };
                if let Some(w) = v.rtc.writer(mid) {
                    let _ = w.write(pt, now, at, packet.to_vec());
                }
                drain(kind, id, v, &mut []);
            }
        });
    }

    fn encoded(&mut self, id: u32, unit: Encoded, at: Instant, ms: f32) {
        let Some(l) = self.layers.iter_mut().find(|l| l.id == id) else { return };
        l.frames += 1;
        l.ms = if l.ms == 0.0 { ms } else { l.ms * 0.9 + ms * 0.1 };
        let high = l.is_high;
        let time = MediaTime::new((at.saturating_duration_since(self.started).as_secs_f64() * 90_000.0) as u64, str0m::media::Frequency::NINETY_KHZ);
        let data: Arc<[u8]> = unit.data.into();
        let kind = self.kind;
        let mut missed = false;
        for (vid, v) in self.viewers.iter_mut() {
            if v.layer != Some(id) || !v.connected || v.dead {
                continue;
            }
            if v.need_key {
                if !unit.key {
                    missed = true;
                    continue;
                }
                v.need_key = false;
            }
            let Some(pt) = (if high { v.pt_high } else { v.pt_base.or(v.pt_high) }) else { continue };
            let Some(writer) = v.rtc.writer(v.mid) else { continue };
            if let Err(e) = writer.write(pt, at, time, data.clone()) {
                log!("{kind:?} viewer {vid}: write: {e}");
            }
            drain(kind, vid, v, &mut []);
        }
        if missed {
            l.want_key = true;
        }
    }

    // Drop viewers whose connection broke for good
    fn reap(&mut self) {
        let kind = self.kind;
        self.viewers.retain(|id, v| {
            let gone = v.dead || !v.rtc.is_alive();
            if gone {
                emit(json!({ "ev": "viewer", "kind": kind, "viewer": id, "state": "closed" }));
            }
            !gone
        });
    }

    // Once a second: frame rates, each viewer's rung, the layers they need, and the stats for the app
    fn tick(&mut self, tx: &Sender<Msg>, now: Instant) {
        self.cap_fps = self.cap_frames as f32;
        self.cap_frames = 0;
        for l in self.layers.iter_mut() {
            l.fps = l.frames as f32;
            l.frames = 0;
        }
        for v in self.viewers.values_mut() {
            v.sent_bps = v.bytes.saturating_sub(v.bytes_prev) as f64 * 8.0;
            v.bytes_prev = v.bytes;
        }
        if !self.rungs.is_empty() {
            let (rungs, sharp, fps) = (&self.rungs, self.sharp, self.cap_fps);
            for v in self.viewers.values_mut().filter(|v| v.answered && !v.own) {
                let floor = ladder::cap(rungs, v.view.h);
                v.ladder.step(rungs, sharp, fps, v.estimate, floor, now);
            }
        }
        self.plan(tx);
        self.stats();
    }

    // Which layers exist and who is on which. Called whenever something that decides it changed.
    fn plan(&mut self, tx: &Sender<Msg>) {
        if self.rungs.is_empty() {
            return;
        }
        let last = self.rungs.len() - 1;
        // A viewer new to the ladder (or after a quality change) starts on the rung their estimate and tile call for
        let (now, fps) = (Instant::now(), self.cap_fps);
        for v in self.viewers.values_mut().filter(|v| v.answered && !v.own) {
            let floor = ladder::cap(&self.rungs, v.view.h);
            if v.ladder.idx.map_or(true, |i| i < floor || i > last) {
                v.ladder.reset();
                v.ladder.step(&self.rungs, self.sharp, fps, v.estimate, floor, now);
            }
        }
        // What each viewer wants: (rung, High profile)
        let mut wants: HashMap<String, (usize, bool)> = HashMap::new();
        for (id, v) in &self.viewers {
            if !v.answered || v.view.hidden || v.own {
                continue;
            }
            wants.insert(id.clone(), (v.ladder.idx.unwrap_or(last), self.hw && v.pt_high.is_some()));
        }
        // At most MAX_LAYERS distinct ones: the best few and the worst; the rest move down to the next one kept
        let mut keys: Vec<(usize, bool)> = wants.values().copied().collect();
        keys.sort();
        keys.dedup();
        if keys.len() > MAX_LAYERS {
            let worst = *keys.last().unwrap();
            keys.truncate(MAX_LAYERS - 1);
            keys.push(worst);
        }
        for want in wants.values_mut() {
            if !keys.contains(want) {
                // Next kept layer that is no better and that this viewer can decode
                *want = *keys.iter().find(|k| k.0 >= want.0 && (!k.1 || want.1)).or(keys.iter().rev().find(|k| !k.1 || want.1)).unwrap_or(want);
                if !keys.contains(want) {
                    keys.push(*want);
                }
            }
        }
        // Our own preview rides on a layer that exists anyway (the smallest); alone, it gets one its size
        for (id, v) in &self.viewers {
            if !v.own || !v.answered || v.view.hidden {
                continue;
            }
            let pick = keys.iter().copied().filter(|k| !k.1 || v.pt_high.is_some()).max().unwrap_or_else(|| {
                let idx = if v.view.h > 0.0 { ladder::cap(&self.rungs, v.view.h) } else { last };
                (idx, self.hw && v.pt_high.is_some())
            });
            if !keys.contains(&pick) {
                keys.push(pick);
            }
            wants.insert(id.clone(), pick);
        }
        // Layers nobody wants any more stop; missing ones start
        let rungs = self.rungs.clone();
        self.layers.retain(|l| keys.iter().any(|k| rungs[k.0] == l.rung && k.1 == l.high));
        for k in &keys {
            if !self.layers.iter().any(|l| l.rung == rungs[k.0] && l.high == k.1) {
                let layer = self.spawn_layer(rungs[k.0], k.1, tx);
                self.layers.push(layer);
            }
        }
        for (id, v) in self.viewers.iter_mut() {
            let layer = wants.get(id).and_then(|k| self.layers.iter().find(|l| l.rung == rungs[k.0] && l.high == k.1)).map(|l| l.id);
            if layer != v.layer {
                v.layer = layer;
                v.need_key = true;
                if let Some(l) = self.layers.iter_mut().find(|l| Some(l.id) == layer) {
                    l.want_key = true;
                }
            }
        }
        // A layer spends what its slowest viewer's connection carries, and no more than the rung is worth
        let top = ladder::ceiling(&rungs[0]) as u64;
        for l in self.layers.iter_mut() {
            let on = self.viewers.values().filter(|v| v.layer == Some(l.id));
            let low = on.clone().filter(|v| !v.own).map(|v| v.estimate).fold(f64::INFINITY, f64::min);
            let want = if low.is_finite() { low * 0.85 } else { ladder::need(&l.rung, self.sharp, self.cap_fps) };
            let bps = (want as u32).clamp(MIN_BPS, ladder::ceiling(&l.rung));
            if (bps as f64 - l.bps as f64).abs() > 0.05 * l.bps as f64 {
                l.bps = bps;
                let _ = l.tx.try_send(LayerMsg::Rates(bps, l.rung.fps));
            }
        }
        // Let every estimate grow to what the best rung could use
        for v in self.viewers.values_mut().filter(|v| v.answered) {
            v.rtc.bwe().set_desired_bitrate(Bitrate::bps(top + top / 5));
        }
        let kind = self.kind;
        for (id, v) in self.viewers.iter_mut().filter(|(_, v)| v.answered) {
            drain(kind, id, v, &mut self.layers);
        }
    }

    fn spawn_layer(&mut self, rung: Rung, high: bool, tx: &Sender<Msg>) -> Layer {
        let id = self.next_layer;
        self.next_layer += 1;
        let (ltx, lrx) = std::sync::mpsc::sync_channel::<LayerMsg>(1);
        let bps = (ladder::need(&rung, self.sharp, self.cap_fps) as u32).clamp(MIN_BPS, ladder::ceiling(&rung));
        let cfg = encode::Config { w: rung.w, h: rung.h, fps: rung.fps, bps, high, sharp: self.sharp };
        let (kind, hw, out) = (self.kind, self.hw, tx.clone());
        let spawned = std::thread::Builder::new().name(format!("layer-{}p", rung.h)).spawn(move || {
            let (mut enc, note) = match encode::open(cfg, hw) {
                Ok(x) => x,
                Err(why) => return drop(out.send(Msg::LayerDown { kind, id, why })),
            };
            let _ = out.send(Msg::LayerUp { kind, id, name: enc.name(), hw: enc.hardware(), high: enc.high(), note });
            let mut scaler = Scaler::default();
            let mut nv12 = Nv12::default();
            let mut cfg = cfg;
            while let Ok(msg) = lrx.recv() {
                match msg {
                    LayerMsg::Rates(bps, fps) => {
                        cfg.bps = bps;
                        cfg.fps = fps;
                        enc.set_rates(bps, fps);
                    }
                    LayerMsg::Frame(frame, at, key) => {
                        let t = Instant::now();
                        let mut res = scaler.nv12(&frame, cfg.w, cfg.h, &mut nv12).and_then(|()| enc.encode(&nv12, key));
                        if let (Err(why), true) = (&res, enc.hardware()) {
                            // The hardware encoder gave up mid-stream: carry on in software
                            let note = format!("{} failed ({why}); now software", enc.name());
                            match encode::open(cfg, false) {
                                Ok((soft, _)) => {
                                    enc = soft;
                                    let _ = out.send(Msg::LayerUp { kind, id, name: enc.name(), hw: false, high: enc.high(), note: Some(note) });
                                    res = enc.encode(&nv12, true);
                                }
                                Err(e) => res = Err(e),
                            }
                        }
                        match res {
                            Ok(Some(unit)) => {
                                let ms = t.elapsed().as_secs_f32() * 1000.0;
                                if out.send(Msg::Encoded { kind, id, unit, at, ms }).is_err() {
                                    return;
                                }
                            }
                            Ok(None) => {}
                            Err(why) => return drop(out.send(Msg::LayerDown { kind, id, why })),
                        }
                    }
                }
            }
        });
        if let Err(e) = spawned {
            let _ = tx.send(Msg::LayerDown { kind, id, why: e.to_string() });
        }
        Layer { id, rung, high, tx: ltx, bps, name: "", hw: false, is_high: false, up: false, want_key: true, last_key: None, due: None, frames: 0, fps: 0.0, ms: 0.0, note: None }
    }

    // One entry per viewer, in the shape the app's stats panel already shows for the Chromium path
    fn stats(&self) {
        let mut out = Vec::new();
        for (id, v) in &self.viewers {
            let l = self.layers.iter().find(|l| Some(l.id) == v.layer);
            let idx = l.and_then(|l| self.rungs.iter().position(|r| *r == l.rung));
            out.push(json!({
                "sid": id,
                "own": v.own,
                "state": if v.connected { "connected" } else if v.answered { "connecting" } else { "new" },
                "codec": "H264",
                "profile": l.filter(|l| l.up).map(|l| if l.is_high { "High" } else { "Constrained Baseline" }),
                "hw": l.filter(|l| l.up).map(|l| l.hw),
                "impl": l.filter(|l| l.up).map(|l| l.name),
                "w": l.map(|l| l.rung.w),
                "h": l.map(|l| l.rung.h),
                "fps": l.map(|l| l.fps),
                "mbps": l.map(|l| l.bps as f64 / 1e6),
                "availMbps": v.estimate / 1e6,
                "sentMbps": v.sent_bps / 1e6,
                "capW": self.src.0,
                "capH": self.src.1,
                "capFps": self.cap_fps,
                "encMs": l.map(|l| l.ms),
                "loss": v.loss,
                "rtt": v.rtt,
                "nack": v.nacks,
                "pli": v.plis,
                "cand": v.cand,
                "paused": v.view.hidden,
                "view": if v.view.w > 0.0 || v.view.hidden { json!({ "w": v.view.w, "h": v.view.h, "hidden": v.view.hidden }) } else { Value::Null },
                "rung": l.map(|l| json!({ "w": l.rung.w, "h": l.rung.h, "fps": l.rung.fps })),
                "needMbps": l.map(|l| ladder::need(&l.rung, self.sharp, self.cap_fps) / 1e6),
                "upMbps": idx.filter(|i| *i > 0).map(|i| 1.15 * ladder::need(&self.rungs[i - 1], self.sharp, self.cap_fps) / 1e6),
                "layers": self.layers.len(),
                "sharing": l.map(|l| self.viewers.values().filter(|o| o.layer == Some(l.id)).count()),
                "mode": if self.sharp { "sharp" } else { "smooth" },
                "note": l.and_then(|l| l.note.clone()),
                "native": true,
            }));
        }
        emit(json!({ "ev": "stats", "kind": self.kind, "viewers": out }));
    }
}
