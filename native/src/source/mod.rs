// Where frames (and a share's audio) come from. Each capture runs on its own
// thread (or the OS's) and hands what it gets to the sinks; dropping the
// Capture stops it.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::frame::Frame;
use crate::proto::{Source, Tier};

#[cfg(target_os = "windows")]
mod audio_win;
#[cfg(target_os = "macos")]
mod camera_mac;
#[cfg(target_os = "windows")]
mod camera_win;
#[cfg(target_os = "macos")]
mod screen_mac;
#[cfg(target_os = "windows")]
mod screen_win;
mod test;

pub struct Sinks {
    pub video: Box<dyn Fn(Frame) + Send + Sync + 'static>,
    // Interleaved stereo at 48 kHz
    pub audio: Box<dyn Fn(Vec<f32>) + Send + Sync + 'static>,
    // Called once if the capture ends by itself (window closed, device unplugged)
    pub ended: Box<dyn Fn(String) + Send + Sync + 'static>,
}

pub struct Capture {
    stop: Arc<AtomicBool>,
}

impl Capture {
    fn new() -> (Self, Arc<AtomicBool>) {
        let stop = Arc::new(AtomicBool::new(false));
        (Self { stop: stop.clone() }, stop)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn start(source: &Source, tier: &Tier, sinks: Sinks) -> Result<Capture, String> {
    match source.kind.as_str() {
        "test" => test::start(source, tier, sinks),
        #[cfg(target_os = "macos")]
        "screen" | "window" => screen_mac::start(source, tier, sinks),
        #[cfg(target_os = "macos")]
        "camera" => camera_mac::start(source, tier, sinks),
        #[cfg(target_os = "windows")]
        "screen" | "window" => screen_win::start(source, tier, sinks),
        #[cfg(target_os = "windows")]
        "camera" => camera_win::start(source, tier, sinks),
        other => Err(format!("no native capture for \"{other}\" on this OS")),
    }
}

// Which kinds of source this build captures
pub fn kinds() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    return &["screen", "window", "camera", "test"];
    #[cfg(target_os = "windows")]
    return &["screen", "window", "camera", "test"];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return &["test"];
}

// Whether a share's audio can be captured here, without friendspeak's own sound in it
pub fn audio() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}
