// H.264 encoders behind one trait. A layer asks for the best one this machine
// has: the platform's hardware encoder when hardware acceleration is on (the
// default), OpenH264 in software otherwise or when the hardware one can't start.
use crate::frame::Nv12;

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
    pub high: bool,  // High profile when the encoder can; Constrained Baseline otherwise
    pub sharp: bool, // screen text: spend bits on detail, not motion
}

pub trait Encoder: Send {
    // None: the encoder kept the frame to itself (rate control dropped it)
    fn encode(&mut self, frame: &Nv12, key: bool) -> Result<Option<Encoded>, String>;
    fn set_rates(&mut self, bps: u32, fps: f32);
    fn name(&self) -> &'static str;
    fn hardware(&self) -> bool;
    fn high(&self) -> bool;
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

// The encoder for a layer, and why hardware was passed over when it was
pub fn open(cfg: Config, hw: bool) -> Result<(Box<dyn Encoder>, Option<String>), String> {
    #[allow(unused_mut)]
    let mut why = None;
    if hw {
        #[cfg(target_os = "macos")]
        match videotoolbox::Vt::new(cfg) {
            Ok(e) => return Ok((Box::new(e), None)),
            Err(e) => why = Some(format!("VideoToolbox: {e}")),
        }
        #[cfg(target_os = "windows")]
        match mediafoundation::Mf::new(cfg) {
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
