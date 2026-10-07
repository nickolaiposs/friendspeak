// The control protocol with the desktop app: one JSON object per line, commands
// on stdin and events on stdout (docs/ARCHITECTURE.md → Native streaming).
// stderr is the log.
use std::io::Write;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Screen,
    Camera,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Tier {
    pub width: usize,
    pub height: usize,
    pub fps: f32,
}

impl Tier {
    // The page's numbers, held to what a capture and an encoder can be asked for
    pub fn clamped(self) -> Self {
        Tier {
            width: self.width.clamp(2, 7680),
            height: self.height.clamp(2, 4320),
            fps: if self.fps.is_finite() { self.fps.clamp(1.0, 240.0) } else { 30.0 },
        }
    }
}

// What to capture. `id` is Electron's desktopCapturer id for screens and
// windows ("screen:<n>:0", "window:<n>:0"); cameras are found by `name`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Source {
    #[serde(rename = "type")]
    pub kind: String, // screen | window | camera | test
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    // A screen's position and size on the desktop, to tell displays apart where ids don't
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    // Screens and windows: also capture what the computer plays, for the viewers to hear
    #[serde(default)]
    pub audio: bool,
    // The process whose sound stays out of that audio (the app itself, so friends in the call don't hear
    // themselves back). 0: the process that started the sidecar.
    #[serde(default)]
    pub exclude_pid: u32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Cmd {
    Start {
        kind: Kind,
        source: Source,
        tier: Tier,
        #[serde(default)]
        mode: String, // smooth | sharp
        #[serde(default = "yes")]
        hw: bool,
        #[serde(default)]
        stun: Vec<String>, // host:port
    },
    Quality {
        kind: Kind,
        tier: Tier,
        #[serde(default)]
        mode: String,
    },
    Stop {
        kind: Kind,
    },
    // Someone watches: the sidecar answers with an offer for them
    Viewer {
        kind: Kind,
        viewer: String,
        #[serde(default, rename = "self")]
        own: bool, // our own preview: never the reason a stream gets worse
    },
    Unviewer {
        kind: Kind,
        viewer: String,
    },
    // Their answer or an ICE candidate
    Signal {
        kind: Kind,
        viewer: String,
        data: Value,
    },
    View {
        kind: Kind,
        viewer: String,
        #[serde(default)]
        w: f32,
        #[serde(default)]
        h: f32,
        #[serde(default)]
        hidden: bool,
    },
    Quit,
}

fn yes() -> bool {
    true
}

pub fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { eprintln!("[media] {}", format!($($arg)*)) };
}
