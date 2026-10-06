// H.264 encoders behind one trait. A layer asks for the best one this machine
// has: the platform's hardware encoder when hardware acceleration is on (the
// default), OpenH264 in software otherwise or when the hardware one can't start.
use std::time::{Duration, Instant};

use crate::frame::{Frame, Nv12};

#[cfg(target_os = "windows")]
mod mediafoundation;
#[cfg(feature = "software")]
mod software;
#[cfg(target_os = "macos")]
mod videotoolbox;

pub struct Encoded {
    pub data: Vec<u8>, // Annex B, with SPS and PPS in front of every keyframe
    pub key: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub w: usize,
    pub h: usize,
    pub fps: f32,
    pub bps: u32,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub max_bps: u32, // the most set_rates() will ever ask for
    pub high: bool,  // High profile when the encoder can; Constrained Baseline otherwise
    pub sharp: bool, // screen text: spend bits on detail, not motion
}

pub trait Encoder: Send {
    // None: the encoder kept the frame to itself (rate control dropped it)
    fn encode(&mut self, frame: &Nv12, key: bool) -> Result<Option<Encoded>, String>;
    // For an encoder that takes a captured frame where it is (a texture on its GPU): Some when it did. None:
    // the caller makes NV12 of it and calls encode().
    fn encode_frame(&mut self, _frame: &Frame, _key: bool) -> Option<Result<Option<Encoded>, String>> {
        None
    }
    fn set_rates(&mut self, bps: u32, fps: f32);
    fn name(&self) -> &'static str;
    fn hardware(&self) -> bool;
    fn high(&self) -> bool;
}

// What an encoder really spends against what it was told. Hardware encoders miss their bitrate by a steady
// share (measured: NVIDIA's, 10 to 15% over in High profile), and a capture that delivers more frames than
// the tier's rate does the same. Over a link that is the difference between fitting and queueing, so the
// encoder is told less until what comes out is what was asked for. Only ever less: spending under the
// target is what a calm picture looks like, and asking for more then would overshoot when it moves again.
pub struct Trim {
    factor: f32,
    last: Option<Instant>,
    span: Duration,
    spent: f64, // bits that came out over `span`
    asked: f64, // bits the targets of that time add up to
}

const TRIM_WINDOW: Duration = Duration::from_secs(2);
const TRIM_FLOOR: f32 = 0.6;

impl Default for Trim {
    fn default() -> Self {
        Self { factor: 1.0, last: None, span: Duration::ZERO, spent: 0.0, asked: 0.0 }
    }
}

impl Trim {
    pub fn factor(&self) -> f32 {
        self.factor
    }

    // One unit came out while the target was `target_bps`. Some(factor) when the encoder should now be told
    // `factor` times its target. Keyframes aren't counted: they are asked for, not a habit of the encoder.
    pub fn spent(&mut self, now: Instant, bytes: usize, key: bool, target_bps: u32) -> Option<f32> {
        let step = self.last.replace(now).map(|last| now.saturating_duration_since(last))?;
        // A still screen sends a frame now and then; that says nothing about the rate control
        if key || step > Duration::from_millis(250) {
            return None;
        }
        self.span += step;
        self.spent += bytes as f64 * 8.0;
        self.asked += target_bps as f64 * step.as_secs_f64();
        if self.span < TRIM_WINDOW {
            return None;
        }
        let ratio = (self.spent / self.asked.max(1.0)) as f32;
        (self.span, self.spent, self.asked) = (Duration::ZERO, 0.0, 0.0);
        let next = (self.factor / ratio.max(0.01)).clamp(TRIM_FLOOR, 1.0);
        // Small corrections aren't worth unsettling the encoder's rate control for
        if (next - self.factor).abs() < 0.03 {
            return None;
        }
        self.factor = next;
        Some(next)
    }
}

// Names of the hardware encoders this build knows for this OS (not a promise that one starts)
pub fn hardware_names() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    return &["VideoToolbox"];
    #[cfg(target_os = "windows")]
    return &["MediaFoundation"];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return &[];
}

// The encoder for a layer, and why hardware was passed over when it was. `like` is a frame of the kind the
// layer will get, for an encoder that can take it where it is.
#[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
pub fn open(cfg: Config, hw: bool, like: Option<&Frame>) -> Result<(Box<dyn Encoder>, Option<String>), String> {
    #[allow(unused_mut)]
    let mut why = None;
    if hw {
        #[cfg(target_os = "macos")]
        match videotoolbox::Vt::new(cfg) {
            Ok(e) => return Ok((Box::new(e), None)),
            Err(e) => why = Some(format!("VideoToolbox: {e}")),
        }
        #[cfg(target_os = "windows")]
        match mediafoundation::Mf::new(cfg, like) {
            Ok(e) => return Ok((Box::new(e), None)),
            Err(e) => why = Some(format!("Media Foundation: {e}")),
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            why = Some("no hardware encoder on this OS yet".to_string());
        }
    }
    #[cfg(feature = "software")]
    return Ok((Box::new(software::Soft::new(cfg)?), why));
    #[cfg(not(feature = "software"))]
    Err(why.unwrap_or_else(|| "built without the software encoder".to_string()))
}

// Whether an Annex B access unit holds an IDR slice (NAL type 5)
pub fn has_idr(data: &[u8]) -> bool {
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            if data[i + 3] & 0x1f == 5 {
                return true;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    false
}
