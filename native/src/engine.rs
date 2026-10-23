// The engine: one thread that owns every share, its simulcast layers and its connection to the SFU.
//
//   capture ──frame──> engine ──frame──> layer thread (scale, encode, encrypt) ──┐
//                        ▲                                                       │
//                        └──────────────── encrypted access unit ────────────────┘
//                        └──> the share's connection to the SFU (str0m: ICE, DTLS-SRTP, RTP, BWE)
//
// A share is published once (D70): a few simulcast layers, rungs of the quality ladder (ladder.rs), each
// encoded once and sent on one connection to the friendspeak server's SFU, which forwards to each viewer
// the layer that suits their tile and their link. Nothing here knows who watches.
//
// Every encoded unit is encrypted (e2ee.rs) before it leaves its layer's thread: the server forwards what
// it can't read. A share has no key until the app gives it one, and nothing is sent without one.
//
// The upload is the budget: str0m's bandwidth estimate decides how many layers run. When it can't carry
// them all, the top layer's encoder stops (the SFU moves its viewers down); when the estimate has room
// again, it starts again. Lower layers keep their own bitrate; the top one gets what is left.
//
// Everything arrives on one channel (Msg): commands from the app, frames, encoded units, UDP packets.
// Between messages the engine drives each connection's Rtc to its next timeout.
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use str0m::bwe::{Bitrate, BweKind};
use str0m::config::Fingerprint;
use str0m::media::{Frequency, MediaKind, MediaTime, Mid, Pt, Rid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc};

use crate::audio::{self, Opus};
use crate::e2ee;
use crate::encode::{self, Trim};
use crate::frame::{even, Frame, Nv12, Scaler};
use crate::ladder::{self, Rung, MAX_LAYERS};
use crate::log;
use crate::net::{self, Sockets};
use crate::proto::{emit, Cmd, DtlsFingerprint, IceCandidate, IceParameters, Kind, Source, Tier};
use crate::source::{self, Capture, Sinks};

const START_BPS: u64 = 2_500_000; // the first bandwidth estimate
const MIN_BPS: u32 = 150_000;
const KEY_WAIT: Duration = Duration::from_millis(60); // how long a wanted keyframe waits for a new frame before the last one is repeated
const KEY_GAP: Duration = Duration::from_millis(700); // between keyframes a layer makes on request
const TICK: Duration = Duration::from_secs(1);
const IDLE: Duration = Duration::from_millis(500); // a still screen sends no frames: the last one is repeated this often
const CONNECT_WAIT: Duration = Duration::from_secs(15); // the SFU didn't answer by then: the share can't be published
// The upload budget. A layer runs while the estimate times FIT covers it and every layer below it; a
// stopped one starts again once the estimate covers it with UP to spare.
const FIT: f64 = 0.9;
const UP: f64 = 1.2;
const DOWN_TICKS: u8 = 2;
const UP_TICKS: u8 = 3;
const HOLD: Duration = Duration::from_secs(8); // no layer starts again this long after one stopped
const SEVERE: f64 = 0.6; // the estimate fell below this share of what runs: drop to what fits at once, not a layer a tick
// A layer the budget drops is reported off at once, so the SFU moves its viewers down (at a keyframe of the
// layer below, which it asks for), and its encoder runs this much longer so they have something to watch until then
const LEAVE: Duration = Duration::from_millis(1500);
// The estimate starts as a guess (START_BPS): no layer is stopped until it has had this long to measure the link
const SETTLE: Duration = Duration::from_secs(4);
const SPEND: f64 = 0.85; // of the estimate, what the encoders together are told to spend
// The top layer may spend up to this many times what its rung needs, not up to its ceiling: every viewer on
// it gets the same stream, and the sharer's upload says nothing about their downloads
const TOP_HEADROOM: f64 = 1.3;
// The software encoder's ceiling: past 1440p60 it can't keep up (D46, D70)
const SOFT_MAX: (usize, usize, f32) = (2560, 1440, 60.0);

// Payload types and header extension ids as they are told to the SFU. The ids are str0m's own map
// (ExtensionMap::standard), which is what it writes.
const PT_VIDEO: u8 = 96;
const PT_RTX: u8 = 97;
const PT_OPUS: u8 = 111;
const VIDEO_MID: &str = "0";
const AUDIO_MID: &str = "1";
const RIDS: [&str; MAX_LAYERS] = ["r0", "r1", "r2"];

pub enum Msg {
    Cmd(Cmd),
    Frame(Kind),
    Audio { kind: Kind, pcm: Vec<f32> },
    Ended { kind: Kind, why: String },
    Packet { kind: Kind, local: SocketAddr, src: SocketAddr, data: Vec<u8>, at: Instant },
    LayerUp { kind: Kind, id: u32, name: &'static str, hw: bool, high: bool, note: Option<String> },
    Encoded { kind: Kind, id: u32, data: Vec<u8>, key: bool, at: Instant, ms: f32 },
    LayerDown { kind: Kind, id: u32, why: String },
}

enum LayerMsg {
    Frame(Arc<Frame>, Instant, bool), // the picture, when it is shown, and whether to make a keyframe
    Rates(u32, f32),
}

// A running encoder for one layer
struct Enc {
    id: u32,
    rung: Rung,
    tx: SyncSender<LayerMsg>,
    bps: u32,
    name: &'static str,
    hw: bool,
    is_high: bool,
    up: bool,
    want_key: bool,
    last_key: Option<Instant>,
    due: Option<Instant>, // when a layer slower than the capture takes its next frame
    frames: u32,          // encoded since the last tick
    fps: f32,
    ms: f32, // encode time per frame, smoothed
    note: Option<String>,
}

// One simulcast encoding: declared when the share is published, and idle while the source is too small
// for it (`rung` None) or the budget has it stopped (`on` false)
struct Layer {
    rid: Rid,
    rung: Option<Rung>,
    on: bool,
    leaving: Option<Instant>, // dropped by the budget: the encoder stops then
    enc: Option<Enc>,
    bytes: u64,
    bytes_prev: u64,
    sent_bps: f64,
}

// The share's connection to the SFU
struct Conn {
    rtc: Rtc,
    socks: Sockets,
    sound: bool,
    connect_at: Option<Instant>, // when the SFU's parameters arrived
    connected: bool,
    ever: bool, // it was connected once
    since: Option<Instant>, // when it connected
    failed: bool,
    timeout: Instant,
    estimate: f64, // bits per second
    bytes: u64,
    bytes_prev: u64,
    sent_bps: f64,
    rtt: Option<f32>,
    loss: Option<f32>,
    nacks: u64,
    plis: u64,
    cand: Option<String>,
}

#[derive(Default)]
struct Budget {
    down: u8,
    up: u8,
    hold: Option<Instant>,
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
    audio_time: u64,           // in samples
    audio_at: Option<Instant>, // when sound last arrived
    src: (usize, usize),       // size of the captured frames; (0, 0) before the first
    layers: Vec<Layer>,        // lowest first
    next_enc: u32,
    key: Arc<Mutex<Option<e2ee::Key>>>, // what everything this share sends is encrypted with
    conn: Conn,
    budget: Budget,
    clamped: bool, // software encoding held the tier to SOFT_MAX
    replan: bool,  // the connection came up: the encoders can start
    tx: Sender<Msg>,
    started: Instant,
    cap_frames: u32,
    cap_fps: f32,
}

struct Engine {
    tx: Sender<Msg>,
    streams: HashMap<Kind, Stream>,
}

pub fn run(tx: Sender<Msg>, rx: Receiver<Msg>) {
    emit(json!({
        "ev": "ready",
        "version": env!("CARGO_PKG_VERSION"),
        "sources": source::kinds(),
        "hardware": encode::hardware_names(),
        "audio": source::audio(),
        "sfu": 1,
    }));
    let mut e = Engine { tx, streams: HashMap::new() };
    let mut tick = Instant::now() + TICK;
    loop {
        let now = Instant::now();
        let mut wake = tick.min(now + TICK);
        for s in e.streams.values() {
            if let Some((_, fed)) = &s.last {
                wake = wake.min(*fed + if s.layers.iter().filter_map(|l| l.enc.as_ref()).any(|e| e.want_key) { KEY_WAIT } else { IDLE });
            }
            wake = wake.min(s.conn.timeout);
        }
        match rx.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(Msg::Cmd(Cmd::Quit)) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(msg) => {
                e.handle(msg);
                for s in e.streams.values_mut().filter(|s| s.replan) {
                    s.replan = false;
                    s.plan();
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        let now = Instant::now();
        let mut gone = Vec::new();
        for s in e.streams.values_mut() {
            s.idle(now);
            if s.conn.timeout <= now && !s.conn.failed {
                let _ = s.conn.rtc.handle_input(Input::Timeout(now));
                s.drain();
            }
            if let Some(why) = s.lost(now) {
                gone.push((s.kind, why));
            }
        }
        for (kind, why) in gone {
            e.streams.remove(&kind);
            log!("{kind:?}: {why}");
            emit(json!({ "ev": "stopped", "kind": kind, "reason": why }));
        }
        if now >= tick {
            tick = now + TICK;
            for s in e.streams.values_mut() {
                s.tick(now);
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
                    s.frame();
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
            Msg::Packet { kind, local, src, data, at } => {
                net::QUEUED.fetch_sub(1, Ordering::Relaxed);
                let Some(s) = self.streams.get_mut(&kind) else { return };
                let Ok(contents) = data.as_slice().try_into() else { return };
                let input = Input::Receive(at, Receive { proto: Protocol::Udp, source: src, destination: local, contents });
                if s.conn.rtc.accepts(&input) {
                    if let Err(e) = s.conn.rtc.handle_input(input) {
                        log!("{kind:?}: {e}");
                    }
                    s.drain();
                }
            }
            Msg::LayerUp { kind, id, name, hw, high, note } => {
                let Some(s) = self.streams.get_mut(&kind) else { return };
                if let Some(e) = s.layers.iter_mut().filter_map(|l| l.enc.as_mut()).find(|e| e.id == id) {
                    e.name = name;
                    e.hw = hw;
                    e.is_high = high;
                    e.up = true;
                    if let Some(n) = &note {
                        log!("{kind:?} {}x{}: {n}", e.rung.w, e.rung.h);
                    }
                    e.note = note;
                }
                s.clamp_soft();
            }
            Msg::Encoded { kind, id, data, key, at, ms } => {
                if let Some(s) = self.streams.get_mut(&kind) {
                    s.encoded(id, data, key, at, ms);
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
            Cmd::Start { kind, source, tier, mode, hw, key } => {
                let tier = tier.clamped();
                self.streams.remove(&kind);
                let started = e2ee::Key::from_hex(key.index, &key.key).and_then(|key| Stream::start(kind, &source, tier, mode == "sharp", hw, key, &self.tx));
                match started {
                    Ok(mut s) => {
                        emit(json!({ "ev": "started", "kind": kind, "publish": s.publish() }));
                        self.streams.insert(kind, s);
                    }
                    Err(e) => emit(json!({ "ev": "error", "kind": kind, "message": e })),
                }
            }
            Cmd::Connect { kind, ice, candidates, fingerprints } => {
                let Some(s) = self.streams.get_mut(&kind) else { return };
                if let Err(e) = s.connect(&ice, &candidates, &fingerprints) {
                    log!("{kind:?}: can't connect to the SFU: {e}");
                    self.streams.remove(&kind);
                    emit(json!({ "ev": "stopped", "kind": kind, "reason": format!("can't connect to the server: {e}") }));
                }
            }
            Cmd::Quality { kind, tier, mode } => {
                let tier = tier.clamped();
                if let Some(s) = self.streams.get_mut(&kind) {
                    s.tier = tier;
                    s.clamped = false;
                    s.sharp = mode == "sharp";
                    s.relayout();
                    s.clamp_soft();
                }
            }
            Cmd::Key { key } => match e2ee::Key::from_hex(key.index, &key.key) {
                Ok(k) => {
                    for s in self.streams.values() {
                        *s.key.lock().unwrap() = Some(k.clone());
                    }
                }
                Err(e) => log!("a media key was refused: {e}"),
            },
            Cmd::Stop { kind } => {
                self.streams.remove(&kind);
            }
            Cmd::Quit => {}
        }
    }
}

// How an address was reached, without putting the address itself into stats people copy and paste
fn reach(addr: &SocketAddr) -> &'static str {
    match addr.ip() {
        IpAddr::V4(ip) if ip.is_loopback() => "loopback/udp",
        IpAddr::V4(ip) if ip.is_private() => "lan/udp",
        _ => "public/udp",
    }
}

impl Conn {
    // `high`: the H.264 profile this share is published as (High when hardware encodes it, Constrained
    // Baseline for OpenH264); `sound`: it has a share's audio
    fn new(kind: Kind, high: bool, sound: bool, tx: &Sender<Msg>) -> Result<Conn, String> {
        let socks = net::open(kind, tx).map_err(|e| e.to_string())?;
        let now = Instant::now();
        let mut cfg = Rtc::builder().clear_codecs().enable_bwe(Some(Bitrate::bps(START_BPS))).set_stats_interval(Some(TICK));
        // Level 5.2: 2160p60 fits (5.1 tops out at 2160p30)
        cfg.codec_config().add_h264(PT_VIDEO.into(), Some(PT_RTX.into()), true, if high { 0x64_00_34 } else { 0x42_e0_34 });
        if sound {
            cfg.codec_config().enable_opus(true, false);
        }
        let mut rtc = cfg.build(now);
        for (addr, _) in &socks.list {
            if let Ok(c) = Candidate::host(*addr, "udp") {
                rtc.add_local_candidate(c);
            }
        }
        let mut api = rtc.direct_api();
        // The SFU is ICE-lite: we are the side that checks and nominates
        api.set_ice_controlling(true);
        let video = Mid::from(VIDEO_MID);
        api.declare_media(video, MediaKind::Video);
        for rid in RIDS {
            let (ssrc, rtx) = (api.new_ssrc(), api.new_ssrc());
            api.declare_stream_tx(ssrc, Some(rtx), video, Some(Rid::from(rid)));
        }
        if sound {
            let audio = Mid::from(AUDIO_MID);
            api.declare_media(audio, MediaKind::Audio);
            let ssrc = api.new_ssrc();
            api.declare_stream_tx(ssrc, None, audio, None);
        }
        Ok(Conn {
            rtc,
            socks,
            sound,
            connect_at: None,
            connected: false,
            ever: false,
            since: None,
            failed: false,
            timeout: now,
            estimate: START_BPS as f64,
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
}

impl Stream {
    fn start(kind: Kind, source: &Source, tier: Tier, sharp: bool, hw: bool, key: e2ee::Key, tx: &Sender<Msg>) -> Result<Stream, String> {
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
        let conn = Conn::new(kind, hw, opus.is_some(), tx)?;
        let capture = source::start(source, &tier, sinks)?;
        let layers = RIDS.iter().map(|rid| Layer { rid: Rid::from(*rid), rung: None, on: true, leaving: None, enc: None, bytes: 0, bytes_prev: 0, sent_bps: 0.0 }).collect();
        let mut s = Stream {
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
            layers,
            next_enc: 0,
            key: Arc::new(Mutex::new(Some(key))),
            conn,
            budget: Budget::default(),
            clamped: false,
            replan: false,
            tx: tx.clone(),
            started: Instant::now(),
            cap_frames: 0,
            cap_fps: 0.0,
        };
        // With hardware acceleration off nothing will encode past the software ceiling
        if !hw {
            s.hold_to_soft();
        }
        Ok(s)
    }

    // What the app hands the SFU to publish this share: the DTLS fingerprint, and the RTP parameters of
    // the video (one encoding per simulcast layer, lowest first) and of the audio, in mediasoup's terms
    fn publish(&mut self) -> Value {
        let fp = self.conn.rtc.direct_api().local_dtls_fingerprint().clone();
        let value = fp.bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":");
        let video = Mid::from(VIDEO_MID);
        let mut api = self.conn.rtc.direct_api();
        let encodings: Vec<Value> = RIDS
            .iter()
            .filter_map(|rid| {
                let s = api.stream_tx_by_mid(video, Some(Rid::from(*rid)))?;
                Some(json!({ "rid": rid, "ssrc": *s.ssrc(), "rtx": s.rtx().map(|r| json!({ "ssrc": *r })) }))
            })
            .collect();
        let audio = self.conn.sound.then(|| api.stream_tx_by_mid(Mid::from(AUDIO_MID), None).map(|s| *s.ssrc())).flatten();
        let ext = |uri: &str, id: u8| json!({ "uri": uri, "id": id, "encrypt": false, "parameters": {} });
        let twcc = ext("http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01", 3);
        let send_time = ext("http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time", 2);
        let rtcp = json!({ "cname": "friendspeak-media", "reducedSize": true });
        let fb = |types: &[(&str, &str)]| types.iter().map(|(t, p)| json!({ "type": t, "parameter": p })).collect::<Vec<_>>();
        let profile = if self.hw { "640034" } else { "42e034" };
        json!({
            "dtls": { "role": "client", "fingerprints": [{ "algorithm": fp.hash_func, "value": value }] },
            "video": {
                "mid": VIDEO_MID,
                "codecs": [
                    { "mimeType": "video/H264", "payloadType": PT_VIDEO, "clockRate": 90000,
                      "parameters": { "packetization-mode": 1, "profile-level-id": profile, "level-asymmetry-allowed": 1 },
                      "rtcpFeedback": fb(&[("nack", ""), ("nack", "pli"), ("ccm", "fir"), ("transport-cc", "")]) },
                    { "mimeType": "video/rtx", "payloadType": PT_RTX, "clockRate": 90000, "parameters": { "apt": PT_VIDEO }, "rtcpFeedback": [] },
                ],
                "headerExtensions": [
                    ext("urn:ietf:params:rtp-hdrext:sdes:mid", 4),
                    ext("urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id", 10),
                    ext("urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id", 11),
                    twcc.clone(),
                    send_time.clone(),
                ],
                "encodings": encodings,
                "rtcp": rtcp.clone(),
            },
            "audio": audio.map(|ssrc| json!({
                "mid": AUDIO_MID,
                "codecs": [{ "mimeType": "audio/opus", "payloadType": PT_OPUS, "clockRate": 48000, "channels": 2,
                             "parameters": { "minptime": 10, "useinbandfec": 1, "stereo": 1, "sprop-stereo": 1 },
                             "rtcpFeedback": fb(&[("transport-cc", "")]) }],
                "headerExtensions": [ext("urn:ietf:params:rtp-hdrext:sdes:mid", 4), twcc, send_time],
                "encodings": [{ "ssrc": ssrc }],
                "rtcp": rtcp,
            })),
            "layers": RIDS.len(),
        })
    }

    // The SFU's side: its ICE credentials and candidates and its DTLS fingerprint. The checks start here.
    fn connect(&mut self, ice: &IceParameters, candidates: &[IceCandidate], fingerprints: &[DtlsFingerprint]) -> Result<(), String> {
        if self.conn.connect_at.is_some() {
            return Err("already connecting".into());
        }
        let fp = fingerprints.iter().find(|f| f.algorithm.eq_ignore_ascii_case("sha-256")).ok_or("no sha-256 fingerprint")?;
        let fp: Fingerprint = format!("sha-256 {}", fp.value).parse()?;
        let mut added = 0;
        for c in candidates.iter().take(8) {
            // UDP only (D70: the SFU's TCP listener is optional and off by default). Names were resolved by the app.
            if !c.protocol.is_empty() && !c.protocol.eq_ignore_ascii_case("udp") {
                continue;
            }
            let Ok(ip) = c.address.parse::<IpAddr>() else { continue };
            if let Ok(c) = Candidate::host(SocketAddr::new(ip, c.port), "udp") {
                self.conn.rtc.add_remote_candidate(c);
                added += 1;
            }
        }
        if added == 0 {
            return Err("no UDP candidate".into());
        }
        let mut api = self.conn.rtc.direct_api();
        api.set_remote_ice_credentials(IceCreds { ufrag: ice.username_fragment.clone(), pass: ice.password.clone() });
        api.set_remote_fingerprint(fp);
        api.start_dtls(true).map_err(|e| e.to_string())?;
        self.conn.connect_at = Some(Instant::now());
        self.drain();
        Ok(())
    }

    // Poll the connection until it has nothing more to say (str0m's single-mutation rule: every change is
    // followed by a drain)
    fn drain(&mut self) {
        let kind = self.kind;
        loop {
            match self.conn.rtc.poll_output() {
                Ok(Output::Timeout(t)) => {
                    self.conn.timeout = t;
                    return;
                }
                Ok(Output::Transmit(t)) => self.conn.socks.send(t.source, t.destination, &t.contents),
                Ok(Output::Event(ev)) => match ev {
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                        if self.conn.connected {
                            self.conn.connected = false;
                            emit(json!({ "ev": "state", "kind": kind, "state": "disconnected" }));
                        }
                    }
                    Event::Connected => {
                        self.conn.connected = true;
                        log!("{kind:?}: publishing to the server");
                        emit(json!({ "ev": "state", "kind": kind, "state": "connected" }));
                        for e in self.layers.iter_mut().filter_map(|l| l.enc.as_mut()) {
                            e.want_key = true;
                        }
                        self.conn.ever = true;
                        self.conn.since.get_or_insert(Instant::now());
                        self.replan = true;
                    }
                    Event::KeyframeRequest(r) => {
                        self.conn.plis += 1;
                        let rid = r.rid;
                        if let Some(e) = self.layers.iter_mut().find(|l| Some(l.rid) == rid).and_then(|l| l.enc.as_mut()) {
                            e.want_key = true;
                        }
                    }
                    Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => self.conn.estimate = estimate.as_f64(),
                    Event::MediaEgressStats(m) => {
                        if let Some(l) = self.layers.iter_mut().find(|l| m.rid.is_some() && Some(l.rid) == m.rid) {
                            l.bytes = m.bytes;
                        }
                        self.conn.nacks = self.conn.nacks.max(m.nacks);
                        if let Some(r) = m.rtt {
                            self.conn.rtt = Some(r.as_secs_f32() * 1000.0);
                        }
                        if m.loss.is_some() {
                            self.conn.loss = m.loss;
                        }
                    }
                    Event::PeerStats(p) => {
                        self.conn.bytes = p.bytes_tx;
                        if let Some(pair) = p.selected_candidate_pair {
                            self.conn.cand = Some(format!("{} → {}", reach(&pair.local.addr), reach(&pair.remote.addr)));
                            if self.conn.rtt.is_none() {
                                self.conn.rtt = pair.current_round_trip_time.map(|d| d.as_secs_f32() * 1000.0);
                            }
                        }
                    }
                    _ => {}
                },
                Err(e) => {
                    log!("{kind:?}: {e}");
                    self.conn.failed = true;
                    return;
                }
            }
        }
    }

    // Why the share can't go on, if it can't: the connection broke, or the SFU never answered
    fn lost(&self, now: Instant) -> Option<String> {
        if self.conn.failed || !self.conn.rtc.is_alive() {
            return Some("the connection to the server broke".into());
        }
        match self.conn.connect_at {
            Some(at) if !self.conn.ever && now.saturating_duration_since(at) > CONNECT_WAIT => {
                Some("the server's media port did not answer (is its UDP port open?)".into())
            }
            _ => None,
        }
    }

    // The ceiling: the source, no bigger than the tier, and the layers below it
    fn relayout(&mut self) {
        let (sw, sh) = self.src;
        if sw == 0 {
            return;
        }
        let scale = (sw as f32 / self.tier.width as f32).max(sh as f32 / self.tier.height as f32).max(1.0);
        let (w, h) = (even((sw as f32 / scale) as usize), even((sh as f32 / scale) as usize));
        let fps = if self.sharp { self.tier.fps.min(30.0) } else { self.tier.fps };
        let rungs = ladder::layers(self.sharp, w, h, fps);
        for (i, l) in self.layers.iter_mut().enumerate() {
            l.rung = rungs.get(i).copied();
        }
        self.plan();
    }

    // Software encoding (hardware acceleration off, or a hardware encoder that failed) is held to 1440p60
    fn hold_to_soft(&mut self) -> bool {
        let (w, h, fps) = SOFT_MAX;
        if self.tier.width * self.tier.height <= w * h && self.tier.fps <= fps {
            return false;
        }
        let scale = (self.tier.width as f32 / w as f32).max(self.tier.height as f32 / h as f32).max(1.0);
        self.tier = Tier { width: even((self.tier.width as f32 / scale) as usize), height: even((self.tier.height as f32 / scale) as usize), fps: self.tier.fps.min(fps) };
        self.clamped = true;
        emit(json!({ "ev": "quality", "kind": self.kind, "clamped": { "width": self.tier.width, "height": self.tier.height, "fps": self.tier.fps } }));
        true
    }

    fn clamp_soft(&mut self) {
        let soft = self.layers.iter().filter_map(|l| l.enc.as_ref()).any(|e| e.up && !e.hw);
        if soft && !self.clamped && self.hold_to_soft() {
            log!("{:?}: software encoding, held to {}x{} at {} fps", self.kind, self.tier.width, self.tier.height, self.tier.fps);
            self.relayout();
        }
    }

    fn frame(&mut self) {
        let Some(frame) = self.slot.lock().unwrap().take() else { return };
        if frame.w < 2 || frame.h < 2 {
            return;
        }
        self.cap_frames += 1;
        let frame = Arc::new(frame);
        let at = frame.at;
        // Before the layers are planned: a new one opens its encoder for this kind of frame
        self.last = Some((frame.clone(), at));
        if self.src != (frame.w, frame.h) {
            self.src = (frame.w, frame.h);
            self.relayout();
        }
        self.feed(frame, at);
    }

    // A still screen delivers nothing. Repeat its last frame when a layer waits for a keyframe, and now and
    // then so the stream (and its bandwidth estimate) stays alive.
    fn idle(&mut self, now: Instant) {
        let Some((frame, fed)) = &self.last else { return };
        let wait = if self.layers.iter().filter_map(|l| l.enc.as_ref()).any(|e| e.want_key) { KEY_WAIT } else { IDLE };
        if now.saturating_duration_since(*fed) >= wait {
            let frame = frame.clone();
            self.feed(frame, now);
        }
    }

    fn feed(&mut self, frame: Arc<Frame>, at: Instant) {
        self.last = Some((frame.clone(), at));
        // The capture runs at the tier's rate. A layer slower than that (sharp mode, a lower layer at 30 under
        // a 60 fps tier) is handed only the frames that keep its own pace.
        let cap_fps = self.tier.fps;
        for e in self.layers.iter_mut().filter_map(|l| l.enc.as_mut()) {
            // A layer at the capture's rate takes every frame: frames never arrive evenly, and timing them would drop some
            if e.rung.fps < cap_fps {
                let step = Duration::from_secs_f32(1.0 / e.rung.fps);
                match e.due {
                    Some(due) if at + step / 4 < due => continue,
                    Some(due) => e.due = Some((due + step).max(at)),
                    None => e.due = Some(at + step),
                }
            }
            let key = e.want_key && e.last_key.map_or(true, |t| at.saturating_duration_since(t) >= KEY_GAP);
            match e.tx.try_send(LayerMsg::Frame(frame.clone(), at, key)) {
                Ok(()) => {
                    if key {
                        e.want_key = false;
                        e.last_key = Some(at);
                    }
                }
                Err(TrySendError::Full(_)) => {} // the encoder is still on the last one: drop, don't queue
                Err(TrySendError::Disconnected(_)) => {}
            }
        }
    }

    // The share's sound, encrypted like the video
    fn sound(&mut self, pcm: &[f32]) {
        let Some(opus) = self.opus.as_mut() else { return };
        let now = Instant::now();
        // Some captures deliver nothing while nothing plays (Windows process loopback). The clock the viewers
        // play by has to move through that silence too, or what follows would be heard late.
        if let Some(last) = self.audio_at {
            let gap = now.saturating_duration_since(last);
            if gap > Duration::from_millis(200) {
                self.audio_time += (gap.as_secs_f64() * audio::RATE as f64) as u64;
            }
        }
        self.audio_at = Some(now);
        let key = self.key.lock().unwrap().clone();
        let (conn, time) = (&mut self.conn, &mut self.audio_time);
        let mut wrote = false;
        opus.push(pcm, |packet| {
            let at = MediaTime::new(*time, Frequency::FORTY_EIGHT_KHZ);
            *time += audio::FRAME as u64;
            let (Some(key), true) = (key.as_ref(), conn.connected) else { return };
            let data = e2ee::encrypt(e2ee::Codec::Opus, packet, key, &mut e2ee::random_iv);
            if let Some(w) = conn.rtc.writer(Mid::from(AUDIO_MID)) {
                let _ = w.write(Pt::from(PT_OPUS), now, at, data);
                wrote = true;
            }
        });
        if wrote {
            self.drain();
        }
    }

    fn encoded(&mut self, id: u32, data: Vec<u8>, key: bool, at: Instant, ms: f32) {
        let Some(l) = self.layers.iter_mut().find(|l| l.enc.as_ref().is_some_and(|e| e.id == id)) else { return };
        let e = l.enc.as_mut().unwrap();
        e.frames += 1;
        e.ms = if e.ms == 0.0 { ms } else { e.ms * 0.9 + ms * 0.1 };
        let _ = key;
        if !self.conn.connected {
            return;
        }
        let rid = l.rid;
        let time = MediaTime::new((at.saturating_duration_since(self.started).as_secs_f64() * 90_000.0) as u64, Frequency::NINETY_KHZ);
        if let Some(w) = self.conn.rtc.writer(Mid::from(VIDEO_MID)) {
            if let Err(e) = w.rid(rid).write(Pt::from(PT_VIDEO), at, time, data) {
                log!("{:?} {rid}: write: {e}", self.kind);
            }
        }
        self.drain();
    }

    // Once a second: frame rates, the budget, the encoders' rates, and the stats for the app
    fn tick(&mut self, now: Instant) {
        self.cap_fps = self.cap_frames as f32;
        self.cap_frames = 0;
        for l in self.layers.iter_mut() {
            l.sent_bps = l.bytes.saturating_sub(l.bytes_prev) as f64 * 8.0;
            l.bytes_prev = l.bytes;
            if let Some(e) = l.enc.as_mut() {
                e.fps = e.frames as f32;
                e.frames = 0;
            }
        }
        self.conn.sent_bps = self.conn.bytes.saturating_sub(self.conn.bytes_prev) as f64 * 8.0;
        self.conn.bytes_prev = self.conn.bytes;
        if self.conn.connected {
            self.budget(now);
        }
        self.plan();
        self.stats();
    }

    // What a layer needs, at the rate the capture really delivers
    fn need(&self, r: &Rung) -> f64 {
        ladder::need(r, self.sharp, self.cap_fps).clamp(MIN_BPS as f64, ladder::ceiling(r) as f64)
    }

    // Stop the top layer when the estimate can't carry what runs, start the next when it can with room to spare
    fn budget(&mut self, now: Instant) {
        // cost[k]: what the lowest k layers need together
        let mut cost = vec![0.0];
        for r in self.layers.iter().filter_map(|l| l.rung) {
            cost.push(cost.last().unwrap() + self.need(&r));
        }
        let layers = cost.len() - 1;
        let on = self.layers.iter().filter(|l| l.rung.is_some() && l.on).count();
        let est = self.conn.estimate;
        if self.conn.since.is_none_or(|t| now.saturating_duration_since(t) < SETTLE) {
            return;
        }
        let b = &mut self.budget;
        if on > 1 && est * FIT < cost[on] {
            b.down += 1;
            b.up = 0;
            // A link that suddenly carries far less (a cap, someone else's download) can't wait two ticks a
            // layer: what doesn't fit is dropped together, before the queue overflows and the loss drags the
            // estimate down further
            let severe = est < SEVERE * cost[on];
            if b.down >= DOWN_TICKS || severe {
                b.down = 0;
                b.hold = Some(now + HOLD);
                let keep = if severe { (1..on).rev().find(|k| cost[*k] <= est * FIT).unwrap_or(1) } else { on - 1 };
                for l in &mut self.layers[keep..on] {
                    l.on = false;
                    l.leaving = Some(now + LEAVE);
                    log!("{:?}: {} stopped, the upload ({:.1} Mbit/s) can't carry it", self.kind, l.rid, est / 1e6);
                }
            }
            return;
        }
        b.down = 0;
        if on < layers && b.hold.map_or(true, |h| now >= h) && est >= UP * cost[on + 1] {
            b.up += 1;
            if b.up >= UP_TICKS {
                b.up = 0;
                self.layers[on].on = true;
                self.layers[on].leaving = None;
                log!("{:?}: {} started again ({:.1} Mbit/s up)", self.kind, self.layers[on].rid, est / 1e6);
            }
        } else {
            b.up = 0;
        }
    }

    // Which encoders run, and what each spends. Called whenever something that decides it changed.
    fn plan(&mut self) {
        // Before the connection is up, or before the first frame, nothing is encoded
        let live = self.conn.connected && self.last.is_some();
        // Stopped layers above the first stopped one stay stopped: layers run from the bottom up
        let mut gap = false;
        for l in self.layers.iter_mut() {
            if l.rung.is_some() && !l.on {
                gap = true;
            } else if gap {
                l.on = false;
            }
        }
        let now = Instant::now();
        for i in 0..self.layers.len() {
            let l = &mut self.layers[i];
            if l.leaving.is_some_and(|t| now >= t) {
                l.leaving = None;
            }
            // A leaving layer keeps its encoder until the SFU has moved its viewers off it
            let want = live && (l.on || l.leaving.is_some()) && l.rung.is_some();
            let rung = self.layers[i].rung;
            let same = self.layers[i].enc.as_ref().map(|e| Some(e.rung) == rung);
            match (want, same) {
                (false, Some(_)) => self.layers[i].enc = None,
                (true, Some(false)) | (true, None) => {
                    let enc = self.spawn(rung.unwrap());
                    self.layers[i].enc = Some(enc);
                }
                _ => {}
            }
        }
        // Lower layers spend what they need; the top one what is left of the estimate, up to TOP_HEADROOM times its need.
        // A leaving layer gets what is left after that.
        let mut left = self.conn.estimate * SPEND;
        let mut running: Vec<usize> = (0..self.layers.len()).filter(|i| self.layers[*i].enc.is_some() && self.layers[*i].on).collect();
        running.extend((0..self.layers.len()).filter(|i| self.layers[*i].enc.is_some() && !self.layers[*i].on));
        let mut total = 0.0;
        let on = running.iter().filter(|i| self.layers[**i].on).count();
        for (n, &i) in running.iter().enumerate() {
            let rung = self.layers[i].enc.as_ref().unwrap().rung;
            let need = self.need(&rung);
            let top = n + 1 >= on; // the best layer that is on, or one that is leaving
            let bps = if top { left.min(need * TOP_HEADROOM).clamp(MIN_BPS as f64, ladder::ceiling(&rung) as f64) } else { need.min(left).max(MIN_BPS as f64) };
            left = (left - bps).max(0.0);
            let e = self.layers[i].enc.as_mut().unwrap();
            let bps = bps as u32;
            if (bps as f64 - e.bps as f64).abs() > 0.05 * e.bps as f64 {
                // A layer with a frame waiting has no room for this; it is asked again at the next plan
                if e.tx.try_send(LayerMsg::Rates(bps, e.rung.fps)).is_ok() {
                    e.bps = bps;
                }
            }
        }
        for l in self.layers.iter() {
            if let Some(r) = l.rung {
                total += ladder::ceiling(&r) as f64;
            }
        }
        // Let the estimate grow to what every layer could use
        if self.conn.connected {
            self.conn.rtc.bwe().set_desired_bitrate(Bitrate::bps((total * 1.2) as u64));
            self.drain();
        }
    }

    fn spawn(&mut self, rung: Rung) -> Enc {
        let id = self.next_enc;
        self.next_enc += 1;
        let (ltx, lrx) = std::sync::mpsc::sync_channel::<LayerMsg>(1);
        // What the rung needs at its own frame rate, whatever the capture delivers right now: the encoder sizes
        // its rate control for this (plan() sends what the budget allows right after)
        let bps = (ladder::need(&rung, self.sharp, 0.0) as u32).clamp(MIN_BPS, ladder::ceiling(&rung));
        let cfg = encode::Config { w: rung.w, h: rung.h, fps: rung.fps, bps, max_bps: ladder::ceiling(&rung), high: self.hw, sharp: self.sharp };
        let (kind, hw, out, key) = (self.kind, self.hw, self.tx.clone(), self.key.clone());
        let like = self.last.as_ref().map(|(frame, _)| frame.clone());
        let spawned = std::thread::Builder::new().name(format!("layer-{}p", rung.h)).spawn(move || {
            let opened = encode::open(cfg, hw, like.as_deref());
            drop(like);
            let (mut enc, note) = match opened {
                Ok(x) => x,
                Err(why) => return drop(out.send(Msg::LayerDown { kind, id, why })),
            };
            let _ = out.send(Msg::LayerUp { kind, id, name: enc.name(), hw: enc.hardware(), high: enc.high(), note });
            let mut scaler = Scaler::new(hw);
            let mut trim = Trim::default();
            let mut nv12 = Nv12::default();
            let mut cfg = cfg;
            while let Ok(msg) = lrx.recv() {
                match msg {
                    LayerMsg::Rates(bps, fps) => {
                        cfg.bps = bps;
                        cfg.fps = fps;
                        enc.set_rates((bps as f32 * trim.factor()) as u32, fps);
                    }
                    LayerMsg::Frame(frame, at, want_key) => {
                        let t = Instant::now();
                        let mut res = match enc.encode_frame(&frame, want_key) {
                            Some(res) => res,
                            None => scaler.nv12(&frame, cfg.w, cfg.h, &mut nv12).and_then(|()| enc.encode(&nv12, want_key)),
                        };
                        if let (Err(why), true) = (&res, enc.hardware()) {
                            // The hardware encoder gave up mid-stream: carry on in software (the engine then holds
                            // the share to what software can do)
                            let note = format!("{} failed ({why}); now software", enc.name());
                            match encode::open(cfg, false, None) {
                                Ok((soft, _)) => {
                                    enc = soft;
                                    trim = Trim::default();
                                    let _ = out.send(Msg::LayerUp { kind, id, name: enc.name(), hw: false, high: enc.high(), note: Some(note) });
                                    // The hardware encoder may have taken the frame as it was: make the picture now
                                    res = scaler.nv12(&frame, cfg.w, cfg.h, &mut nv12).and_then(|()| enc.encode(&nv12, true));
                                }
                                Err(e) => res = Err(e),
                            }
                        }
                        match res {
                            Ok(Some(unit)) => {
                                if let Some(factor) = trim.spent(Instant::now(), unit.data.len(), unit.key, cfg.bps) {
                                    enc.set_rates((cfg.bps as f32 * factor) as u32, cfg.fps);
                                }
                                // Encrypted here, before it leaves the thread: no key, nothing is sent (D70)
                                let Some(k) = key.lock().unwrap().clone() else { continue };
                                let data = e2ee::encrypt(e2ee::Codec::H264, &unit.data, &k, &mut e2ee::random_iv);
                                let ms = t.elapsed().as_secs_f32() * 1000.0;
                                if out.send(Msg::Encoded { kind, id, data, key: unit.key, at, ms }).is_err() {
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
            let _ = self.tx.send(Msg::LayerDown { kind, id, why: e.to_string() });
        }
        Enc { id, rung, tx: ltx, bps, name: "", hw: false, is_high: false, up: false, want_key: true, last_key: None, due: None, frames: 0, fps: 0.0, ms: 0.0, note: None }
    }

    // One sample a second for the app's stats panel: the connection, and each layer
    fn stats(&self) {
        let layers: Vec<Value> = self
            .layers
            .iter()
            .filter_map(|l| {
                let r = l.rung?;
                let e = l.enc.as_ref();
                Some(json!({
                    "rid": l.rid.to_string(),
                    "w": r.w,
                    "h": r.h,
                    "fps": e.map(|e| e.fps),
                    "rungFps": r.fps,
                    "on": l.on && e.is_some(),
                    "mbps": e.map(|e| e.bps as f64 / 1e6),
                    "needMbps": self.need(&r) / 1e6,
                    "sentMbps": l.sent_bps / 1e6,
                    "impl": e.filter(|e| e.up).map(|e| e.name),
                    "hw": e.filter(|e| e.up).map(|e| e.hw),
                    "profile": e.filter(|e| e.up).map(|e| if e.is_high { "High" } else { "Constrained Baseline" }),
                    "encMs": e.map(|e| e.ms),
                    "note": e.and_then(|e| e.note.clone()),
                }))
            })
            .collect();
        emit(json!({
            "ev": "stats",
            "kind": self.kind,
            "state": if self.conn.connected { "connected" } else if self.conn.connect_at.is_some() { "connecting" } else { "new" },
            "native": true,
            "codec": "H264",
            "availMbps": self.conn.estimate / 1e6,
            "sentMbps": self.conn.sent_bps / 1e6,
            "rtt": self.conn.rtt,
            "loss": self.conn.loss,
            "nack": self.conn.nacks,
            "pli": self.conn.plis,
            "cand": self.conn.cand,
            "capW": self.src.0,
            "capH": self.src.1,
            "capFps": self.cap_fps,
            "mode": if self.sharp { "sharp" } else { "smooth" },
            "tier": { "width": self.tier.width, "height": self.tier.height, "fps": self.tier.fps },
            "clamped": self.clamped,
            "layers": layers,
        }));
    }
}
