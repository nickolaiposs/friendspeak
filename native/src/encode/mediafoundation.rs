// Windows Media Foundation: hardware H.264 through the video encoders the GPU
// driver registers (NVENC on NVIDIA, AMF on AMD, Quick Sync on Intel). Only
// hardware transforms are enumerated, so when this opens the stream really is
// hardware encoded; otherwise the layer falls back to OpenH264.
//
// Hardware transforms are asynchronous: they announce through an event queue
// when they want a frame (METransformNeedInput) and when one is ready
// (METransformHaveOutput). encode() hides that: it waits for the first, submits
// the frame, then waits a short while for the second.
use std::collections::VecDeque;
use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::thread::ThreadId;
use std::time::{Duration, Instant};

use windows::core::{Interface, GUID};
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_CBR, eAVEncCommonRateControlMode_PeakConstrainedVBR, eAVEncH264VProfile_Base, eAVEncH264VProfile_High, ICodecAPI, IMFActivate, IMFMediaEventGenerator, IMFMediaType,
    IMFSample, IMFTransform, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample, MFMediaType_Video, MFShutdown, MFStartup, MFTEnumEx, MFVideoFormat_H264, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, CODECAPI_AVEncCommonMaxBitRate, CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonRateControlMode, CODECAPI_AVEncMPVDefaultBPictureCount,
    CODECAPI_AVEncMPVGOPSize, CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode, MEError, METransformHaveOutput, METransformNeedInput, MFSTARTUP_FULL, MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, MFT_MESSAGE_NOTIFY_END_STREAMING, MFT_MESSAGE_NOTIFY_START_OF_STREAM,
    MFT_OUTPUT_DATA_BUFFER, MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MF_E_NO_EVENTS_AVAILABLE, MF_E_TRANSFORM_NEED_MORE_INPUT, MF_E_TRANSFORM_STREAM_CHANGE,
    MF_EVENT_FLAG_NO_WAIT, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE, MF_MT_MPEG_SEQUENCE_HEADER, MF_MT_PIXEL_ASPECT_RATIO,
    MF_MT_SUBTYPE, MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;

use super::{has_idr, Config, Encoded, Encoder};
use crate::frame::Nv12;
use crate::log;

// How long a frame gets to come out before encode() gives up on it. The encoder keeps going, and the
// frame, if it still arrives, is handed back with a later call.
const OUT_WAIT: Duration = Duration::from_millis(100);
// The first NeedInput after streaming starts can take a while on a cold GPU
const IN_WAIT: Duration = Duration::from_millis(1500);

// COM and Media Foundation for this thread, undone in Drop (the last field of Mf, so after its objects)
struct Runtime {
    thread: ThreadId,
    com: bool,
}

impl Runtime {
    fn start() -> Result<Self, String> {
        // SAFETY: plain initialization calls. A thread that is already apartment-threaded refuses MTA; Media
        // Foundation works there too, we just mustn't uninitialize what we didn't initialize.
        unsafe {
            let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                if com {
                    CoUninitialize();
                }
                return Err(format!("Media Foundation won't start: {e}"));
            }
            Ok(Self { thread: std::thread::current().id(), com })
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // SAFETY: balances the calls in start(); CoUninitialize only on the thread that initialized
        unsafe {
            let _ = MFShutdown();
            if self.com && std::thread::current().id() == self.thread {
                CoUninitialize();
            }
        }
    }
}

pub struct Mf {
    mft: IMFTransform,
    events: IMFMediaEventGenerator,
    codec: Option<ICodecAPI>,
    activate: IMFActivate,
    cfg: Config,
    high: bool,
    bps: u32,
    fps: f32,
    n: i64,                       // frames submitted, for sample times
    need: u32,                    // NeedInput events not yet answered with a frame
    ready: VecDeque<Encoded>,     // finished units not yet handed out
    provides: bool,               // the transform allocates its own output samples
    out_size: u32,                // the output buffer size it asks us for when it doesn't
    cbr: bool,                    // rate control mode got set to constant bitrate
    warned: bool,                 // already said a keyframe came without parameter sets
    _rt: Runtime,
}

// SAFETY: an Mf is created and used on one layer thread. Its interface pointers belong to Media Foundation
// objects living in the multithreaded apartment (and the async transforms are free-threaded), so moving the
// struct there from the thread that built it is sound; nothing is shared between threads.
unsafe impl Send for Mf {}

fn pair(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

fn variant_u32(v: u32) -> VARIANT {
    VARIANT::from(v)
}

// The format both sides agree on: size, rate and (for the H.264 side) bitrate and profile
fn media_type(cfg: &Config, fps: f32, bps: u32, h264: Option<i32>) -> Result<IMFMediaType, String> {
    let e = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
    // SAFETY: attribute calls on a media type we just created
    unsafe {
        let t = MFCreateMediaType().map_err(e("media type"))?;
        t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(e("major type"))?;
        t.SetGUID(&MF_MT_SUBTYPE, if h264.is_some() { &MFVideoFormat_H264 } else { &MFVideoFormat_NV12 }).map_err(e("subtype"))?;
        t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(e("interlace"))?;
        t.SetUINT64(&MF_MT_FRAME_SIZE, pair(cfg.w as u32, cfg.h as u32)).map_err(e("frame size"))?;
        t.SetUINT64(&MF_MT_FRAME_RATE, pair((fps.clamp(1.0, 240.0) * 1000.0) as u32, 1000)).map_err(e("frame rate"))?;
        t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pair(1, 1)).map_err(e("aspect ratio"))?;
        if let Some(profile) = h264 {
            t.SetUINT32(&MF_MT_AVG_BITRATE, bps).map_err(e("bitrate"))?;
            t.SetUINT32(&MF_MT_MPEG2_PROFILE, profile as u32).map_err(e("profile"))?;
        }
        Ok(t)
    }
}

impl Mf {
    pub fn new(cfg: Config) -> Result<Self, String> {
        // Enumerating needs Media Foundation up. Startup is counted, so each encoder takes its own hold below
        // and this one ends with the function.
        let _rt = Runtime::start()?;
        let acts = hardware_encoders()?;
        let mut last = String::from("no hardware H.264 encoder");
        for act in acts {
            match Self::open(cfg, act) {
                Ok(mf) => return Ok(mf),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    // One candidate encoder, configured and streaming
    fn open(cfg: Config, act: IMFActivate) -> Result<Self, String> {
        let e = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
        let rt = Runtime::start()?;
        // SAFETY: the calls below follow the documented order for an asynchronous encoder MFT: unlock, tune,
        // output type, input type, start streaming
        unsafe {
            let mft: IMFTransform = act.ActivateObject().map_err(e("can't start the encoder"))?;
            // Hardware transforms refuse everything until told the caller understands the event model
            if let Ok(attrs) = mft.GetAttributes() {
                attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(e("can't unlock the encoder"))?;
            }
            let events: IMFMediaEventGenerator = mft.cast().map_err(|_| "the encoder isn't asynchronous".to_string())?;
            let codec = mft.cast::<ICodecAPI>().ok();
            let mut me = Self {
                mft,
                events,
                codec,
                activate: act,
                cfg,
                high: cfg.high,
                bps: cfg.bps,
                fps: cfg.fps,
                n: 0,
                need: 0,
                ready: VecDeque::new(),
                provides: false,
                out_size: 0,
                cbr: false,
                warned: false,
                _rt: rt,
            };
            me.tune();
            // High profile where asked; an encoder that refuses it gets Baseline instead
            let mut profile = if cfg.high { eAVEncH264VProfile_High.0 } else { eAVEncH264VProfile_Base.0 };
            let out = media_type(&cfg, cfg.fps, cfg.bps, Some(profile))?;
            if me.mft.SetOutputType(0, &out, 0).is_err() {
                if profile == eAVEncH264VProfile_Base.0 {
                    return Err("the encoder takes no H.264 output at this size".into());
                }
                profile = eAVEncH264VProfile_Base.0;
                me.high = false;
                let out = media_type(&cfg, cfg.fps, cfg.bps, Some(profile))?;
                me.mft.SetOutputType(0, &out, 0).map_err(e("the encoder takes no H.264 output at this size"))?;
            }
            let input = media_type(&cfg, cfg.fps, cfg.bps, None)?;
            me.mft.SetInputType(0, &input, 0).map_err(e("the encoder takes no NV12 input"))?;
            // Some drivers only honor these once the types are set
            me.tune();
            let info = me.mft.GetOutputStreamInfo(0).map_err(e("no output stream info"))?;
            me.provides = info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
            me.out_size = if info.cbSize > 0 { info.cbSize } else { (cfg.w * cfg.h * 3 / 2).max(1 << 20) as u32 };
            me.mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0).map_err(e("can't flush the encoder"))?;
            me.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(e("can't start streaming"))?;
            me.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(e("can't start the stream"))?;
            Ok(me)
        }
    }

    fn set(&self, api: &GUID, v: u32) -> bool {
        let Some(codec) = &self.codec else { return false };
        let v = variant_u32(v);
        // SAFETY: `v` is a valid VARIANT holding a 32-bit integer, which is what these properties take
        unsafe { codec.SetValue(api, &v) }.is_ok()
    }

    // Everything the transform may or may not support. Each is best effort: an encoder that lacks one still
    // streams, just less ideally.
    fn tune(&mut self) {
        self.set(&CODECAPI_AVLowLatencyMode, 1);
        self.set(&CODECAPI_AVEncMPVDefaultBPictureCount, 0);
        // Keyframes only when asked for (so a loss doesn't have to wait for the next one)
        let _ = self.set(&CODECAPI_AVEncMPVGOPSize, u32::MAX) || self.set(&CODECAPI_AVEncMPVGOPSize, i32::MAX as u32);
        self.cbr = self.set(&CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR.0 as u32);
        if !self.cbr {
            self.set(&CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32);
        }
        self.rates();
    }

    fn rates(&self) {
        self.set(&CODECAPI_AVEncCommonMeanBitRate, self.bps);
        if !self.cbr {
            self.set(&CODECAPI_AVEncCommonMaxBitRate, self.bps.saturating_add(self.bps / 2));
        }
    }

    // The SPS and PPS the encoder announces in its output type (empty if it doesn't)
    fn sequence_header(&self) -> Vec<u8> {
        // SAFETY: blob reads sized by the blob's own reported length
        unsafe {
            let Ok(t) = self.mft.GetOutputCurrentType(0) else { return Vec::new() };
            let Ok(len) = t.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER) else { return Vec::new() };
            let mut buf = vec![0u8; len as usize];
            if t.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut buf, None).is_err() {
                return Vec::new();
            }
            buf
        }
    }

    // Takes one event off the queue and acts on it. Ok(false): the queue was empty.
    fn poll(&mut self) -> Result<bool, String> {
        // SAFETY: the generator is alive as long as self; NO_WAIT makes the call non-blocking
        let ev = match unsafe { self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(ev) => ev,
            Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(false),
            Err(e) => return Err(format!("encoder events: {e}")),
        };
        // SAFETY: reading the event just received
        let kind = unsafe { ev.GetType() }.map_err(|e| e.to_string())?;
        if kind == METransformNeedInput.0 as u32 {
            self.need += 1;
        } else if kind == METransformHaveOutput.0 as u32 {
            self.output()?;
        } else if kind == MEError.0 as u32 {
            // SAFETY: reading the event just received
            let status = unsafe { ev.GetStatus() }.map(|s| s.message()).unwrap_or_default();
            return Err(format!("the encoder failed: {status}"));
        }
        Ok(true)
    }

    // Collects the finished unit the transform announced
    fn output(&mut self) -> Result<(), String> {
        let own = if self.provides { None } else { Some(self.sample_of(self.out_size)?) };
        let mut buf = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(own), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
        let mut status = 0u32;
        // SAFETY: one output buffer for the one output stream; the sample and events it hands back are taken
        // out of their ManuallyDrop wrappers right after so they are released
        let (res, sample) = unsafe {
            let res = self.mft.ProcessOutput(0, &mut buf, &mut status);
            let sample = ManuallyDrop::take(&mut buf[0].pSample);
            ManuallyDrop::drop(&mut buf[0].pEvents);
            (res, sample)
        };
        match res {
            Ok(()) => {}
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
            Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                // The output type changed under us: take the one the encoder now offers
                // SAFETY: re-selecting an output type the transform itself listed
                unsafe {
                    let t = self.mft.GetOutputAvailableType(0, 0).map_err(|e| e.to_string())?;
                    self.mft.SetOutputType(0, &t, 0).map_err(|e| e.to_string())?;
                }
                return Ok(());
            }
            Err(e) => return Err(format!("encode: {e}")),
        }
        let Some(sample) = sample else { return Ok(()) };
        // SAFETY: the buffer is locked for the copy and unlocked after; the lengths come from the buffer itself
        let mut data = unsafe {
            let b = sample.ConvertToContiguousBuffer().map_err(|e| e.to_string())?;
            let (mut p, mut len) = (std::ptr::null_mut::<u8>(), 0u32);
            b.Lock(&mut p, None, Some(&mut len)).map_err(|e| e.to_string())?;
            let v = if p.is_null() { Vec::new() } else { std::slice::from_raw_parts(p, len as usize).to_vec() };
            let _ = b.Unlock();
            v
        };
        if data.is_empty() {
            return Ok(());
        }
        let key = has_idr(&data);
        // Parameter sets: in front of every keyframe, from the output type if the encoder keeps them there
        if key && !has_nal(&data, 7) {
            let head = self.sequence_header();
            if head.is_empty() {
                if !self.warned {
                    self.warned = true;
                    log!("Media Foundation: keyframe without parameter sets");
                }
            } else {
                let mut out = Vec::with_capacity(head.len() + data.len());
                out.extend_from_slice(&head);
                out.extend_from_slice(&data);
                data = out;
            }
        }
        self.ready.push_back(Encoded { data, key });
        Ok(())
    }

    // An empty sample with a buffer of `len` bytes
    fn sample_of(&self, len: u32) -> Result<IMFSample, String> {
        // SAFETY: creating objects and attaching one to the other
        unsafe {
            let b = MFCreateMemoryBuffer(len).map_err(|e| e.to_string())?;
            let s = MFCreateSample().map_err(|e| e.to_string())?;
            s.AddBuffer(&b).map_err(|e| e.to_string())?;
            Ok(s)
        }
    }

    fn submit(&mut self, f: &Nv12, key: bool) -> Result<(), String> {
        if key {
            // Best effort: an encoder that can't force one still sends keyframes now and then
            self.set(&CODECAPI_AVEncVideoForceKeyFrame, 1);
        }
        let (ys, uvs) = (f.w * f.h, f.w * f.h / 2);
        if f.y.len() < ys || f.uv.len() < uvs {
            return Err("frame is smaller than the encoder's size".into());
        }
        let step = (10_000_000.0 / self.fps.clamp(1.0, 240.0) as f64) as i64;
        // SAFETY: the buffer is locked while the planes are copied into it (it holds ys + uvs bytes) and unlocked
        // before the transform sees it
        let sample = unsafe {
            let b = MFCreateMemoryBuffer((ys + uvs) as u32).map_err(|e| e.to_string())?;
            let mut p = std::ptr::null_mut::<u8>();
            b.Lock(&mut p, None, None).map_err(|e| e.to_string())?;
            if p.is_null() {
                let _ = b.Unlock();
                return Err("no memory for the frame".into());
            }
            std::ptr::copy_nonoverlapping(f.y.as_ptr(), p, ys);
            std::ptr::copy_nonoverlapping(f.uv.as_ptr(), p.add(ys), uvs);
            let _ = b.Unlock();
            b.SetCurrentLength((ys + uvs) as u32).map_err(|e| e.to_string())?;
            let s = MFCreateSample().map_err(|e| e.to_string())?;
            s.AddBuffer(&b).map_err(|e| e.to_string())?;
            s.SetSampleTime(self.n * step).map_err(|e| e.to_string())?;
            s.SetSampleDuration(step).map_err(|e| e.to_string())?;
            s
        };
        // SAFETY: the transform asked for this frame (need > 0) and the sample is complete
        unsafe { self.mft.ProcessInput(0, &sample, 0) }.map_err(|e| format!("encode: {e}"))?;
        self.n += 1;
        self.need -= 1;
        Ok(())
    }
}

// Whether an Annex B stream holds a NAL unit of this type
fn has_nal(data: &[u8], kind: u8) -> bool {
    data.windows(4).any(|w| w[0] == 0 && w[1] == 0 && w[2] == 1 && w[3] & 0x1f == kind)
}

// The hardware H.264 encoders, best first (the order Media Foundation ranks them in)
fn hardware_encoders() -> Result<Vec<IMFActivate>, String> {
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: MFTEnumEx fills `list` with `count` activation objects in memory we must free with CoTaskMemFree.
    // Taking each object out of its slot hands its reference to us.
    unsafe {
        MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), Some(&output), &mut list, &mut count)
            .map_err(|e| format!("can't list the encoders: {e}"))?;
        let mut acts = Vec::with_capacity(count as usize);
        if !list.is_null() {
            for i in 0..count as usize {
                if let Some(a) = (*list.add(i)).take() {
                    acts.push(a);
                }
            }
            CoTaskMemFree(Some(list as *const c_void));
        }
        Ok(acts)
    }
}

impl Encoder for Mf {
    fn encode(&mut self, frame: &Nv12, key: bool) -> Result<Option<Encoded>, String> {
        if frame.w != self.cfg.w || frame.h != self.cfg.h {
            return Err(format!("frame is {}x{}, the encoder {}x{}", frame.w, frame.h, self.cfg.w, self.cfg.h));
        }
        // Whatever the encoder finished since last time (and the permission slips it sent)
        while self.poll()? {}
        // It asks for a frame when it is ready for one
        let t0 = Instant::now();
        while self.need == 0 {
            if !self.poll()? {
                if t0.elapsed() > IN_WAIT {
                    return Err("the encoder stopped asking for frames".into());
                }
                std::thread::sleep(Duration::from_micros(300));
            }
        }
        self.submit(frame, key)?;
        let sent = Instant::now();
        while self.ready.is_empty() && sent.elapsed() < OUT_WAIT {
            if !self.poll()? {
                std::thread::sleep(Duration::from_micros(300));
            }
        }
        Ok(self.ready.pop_front())
    }

    fn set_rates(&mut self, bps: u32, fps: f32) {
        self.bps = bps;
        self.fps = fps;
        self.rates();
    }

    fn name(&self) -> &'static str {
        "MediaFoundation"
    }

    fn hardware(&self) -> bool {
        true
    }

    fn high(&self) -> bool {
        self.high
    }
}

impl Drop for Mf {
    fn drop(&mut self) {
        // SAFETY: orderly shutdown of the streaming transform; failures at this point don't matter
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.activate.ShutdownObject();
        }
    }
}
