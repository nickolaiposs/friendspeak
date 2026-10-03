// The quality ladder: which size and frame rate a viewer gets for the bitrate
// their connection carries and the size they show the stream at. The same
// shape as the Chromium path's ladder in public/js/voice.js (D36), so a share
// behaves alike on both: "smooth" lowers resolution first, "sharp" lowers
// frame rate first.
use std::time::{Duration, Instant};

use crate::frame::even;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rung {
    pub w: usize,
    pub h: usize,
    pub fps: f32,
}

const HEIGHTS: [usize; 4] = [1080, 720, 540, 360];
const SHARP_FPS: [f32; 3] = [30.0, 15.0, 8.0];
const LOW_FPS: f32 = 30.0;
const BPP_SMOOTH: f64 = 0.04; // bits per pixel a rung needs to look clean
const BPP_SHARP: f64 = 0.02;
const DOWN_FIT: f64 = 0.85; // estimate below this share of the rung's need: it doesn't fit
const UP_HEADROOM: f64 = 1.15; // estimate needed, as a multiple of the next rung's need, to climb
const DOWN_TICKS: u8 = 2;
const UP_TICKS: u8 = 3;
const HOLD: Duration = Duration::from_secs(8); // no climbing this long after a step down

// Rungs from best to worst for a ceiling of w×h at up to fps
pub fn rungs(sharp: bool, w: usize, h: usize, fps: f32) -> Vec<Rung> {
    let at = |hh: usize, f: f32| Rung { w: even(hh * w / h), h: even(hh), fps: f };
    let lower = HEIGHTS.iter().copied().filter(|x| *x < h);
    if sharp {
        let mut out: Vec<Rung> = Vec::new();
        for f in SHARP_FPS {
            let f = f.min(fps);
            if !out.iter().any(|r| r.fps == f) {
                out.push(at(h, f));
            }
        }
        let low = SHARP_FPS[2].min(fps);
        out.extend(lower.map(|x| at(x, low)));
        return out;
    }
    let mut out = vec![at(h, fps)];
    out.extend(lower.map(|x| at(x, fps)));
    if fps > LOW_FPS {
        let last = *out.last().unwrap();
        out.push(Rung { fps: LOW_FPS, ..last });
    }
    out
}

// Bits per second a rung needs. `src_fps` is what the capture really delivers.
pub fn need(r: &Rung, sharp: bool, src_fps: f32) -> f64 {
    let fps = if src_fps > 0.0 { r.fps.min(src_fps.max(if sharp { 5.0 } else { 30.0 })) } else { r.fps };
    (r.w * r.h) as f64 * fps as f64 * if sharp { BPP_SHARP } else { BPP_SMOOTH }
}

// The most an encoder on this rung may spend
pub fn ceiling(r: &Rung) -> u32 {
    ((r.w * r.h) as f64 * r.fps.max(30.0) as f64 * 0.07).clamp(600_000.0, 50_000_000.0) as u32
}

// First rung that is no bigger than needed for a view of `view_h` pixels (0: unknown)
pub fn cap(rungs: &[Rung], view_h: f32) -> usize {
    if view_h <= 0.0 {
        return 0;
    }
    let mut idx = 0;
    for (i, r) in rungs.iter().enumerate() {
        // Still at least as tall as the view (with a little slack), and not a lower frame rate
        if r.h as f32 >= view_h * 0.9 && r.fps == rungs[0].fps {
            idx = i;
        }
    }
    idx
}

fn fit(rungs: &[Rung], sharp: bool, src_fps: f32, bps: f64, headroom: f64) -> usize {
    rungs.iter().position(|r| need(r, sharp, src_fps) * headroom <= bps).unwrap_or(rungs.len() - 1)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct State {
    pub idx: Option<usize>,
    down: u8,
    up: u8,
    hold: Option<Instant>,
}

impl State {
    // One decision per second. `floor` is the best rung worth sending (cap()).
    pub fn step(&mut self, rungs: &[Rung], sharp: bool, src_fps: f32, bps: f64, floor: usize, now: Instant) -> usize {
        let last = rungs.len() - 1;
        let floor = floor.min(last);
        let Some(idx) = self.idx else {
            let i = fit(rungs, sharp, src_fps, bps, 1.0).max(floor);
            self.idx = Some(i);
            return i;
        };
        let mut idx = idx.min(last).max(floor);
        let bound = bps < DOWN_FIT * need(&rungs[idx], sharp, src_fps);
        self.down = if bound { self.down + 1 } else { 0 };
        if self.down >= DOWN_TICKS && idx < last {
            idx = (idx + 1).max(fit(rungs, sharp, src_fps, bps, 1.0));
            self.down = 0;
            self.up = 0;
            self.hold = Some(now + HOLD);
        } else if idx > floor && self.hold.map_or(true, |h| now >= h) {
            let room = bps >= UP_HEADROOM * need(&rungs[idx - 1], sharp, src_fps);
            self.up = if room { self.up + 1 } else { 0 };
            if self.up >= UP_TICKS {
                idx = fit(rungs, sharp, src_fps, bps, UP_HEADROOM).max(floor).min(idx - 1);
                self.up = 0;
            }
        } else {
            self.up = 0;
        }
        self.idx = Some(idx);
        idx
    }

    pub fn reset(&mut self) {
        *self = State::default();
    }
}
