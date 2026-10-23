// The quality ladder: rungs of size and frame rate, and what each needs. A share is published as a few
// simulcast layers taken from it (D70): the best rung, and below it what grid tiles and thin links take.
// The SFU picks a layer per viewer from their tile size and their link, so there is no per-viewer state
// here any more. The same shape as the browser engine's ladder in public/js/voice.js (D36): "smooth"
// keeps the frame rate on every layer, "sharp" keeps the pixels and runs slower.
use crate::frame::even;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rung {
    pub w: usize,
    pub h: usize,
    pub fps: f32,
}

// How many simulcast layers a share declares when it is published. A share whose source is too small for
// all of them leaves the top ones idle.
pub const MAX_LAYERS: usize = 3;
const BPP_SMOOTH: f64 = 0.04; // bits per pixel a rung needs to look clean
const BPP_SHARP: f64 = 0.02;
const LOW: usize = 360; // the layer grid tiles get
const LOW_FPS: f32 = 30.0;
const SHARP_FPS: f32 = 30.0; // sharp's best layer
const SHARP_LOWER_FPS: f32 = 15.0; // and the layers below it

// The layers for a ceiling of w×h at up to fps, lowest first. The middle layer is 1080p under a 2160p
// ceiling and 720p under anything from 1080p to 1440p; a ceiling of 720p or less has two layers, and one
// of 360p or less only one.
pub fn layers(sharp: bool, w: usize, h: usize, fps: f32) -> Vec<Rung> {
    let at = |hh: usize, f: f32| Rung { w: even(hh * w / h), h: even(hh), fps: f };
    let (top_fps, lower_fps, low_fps) = if sharp { (fps.min(SHARP_FPS), fps.min(SHARP_LOWER_FPS), fps.min(SHARP_LOWER_FPS)) } else { (fps, fps, fps.min(LOW_FPS)) };
    let mut out = Vec::new();
    if h > LOW {
        out.push(at(LOW, low_fps));
    }
    let mid = if h > 1440 { 1080 } else if h > 720 { 720 } else { 0 };
    if mid > 0 {
        out.push(at(mid, lower_fps));
    }
    out.push(at(h, top_fps));
    out
}

// Bits per second a rung needs. `src_fps` is what the capture really delivers.
pub fn need(r: &Rung, sharp: bool, src_fps: f32) -> f64 {
    let fps = if src_fps > 0.0 { r.fps.min(src_fps.max(if sharp { 5.0 } else { 30.0 })) } else { r.fps };
    (r.w * r.h) as f64 * fps as f64 * if sharp { BPP_SHARP } else { BPP_SMOOTH }
}

// The most an encoder on this rung may spend
pub fn ceiling(r: &Rung) -> u32 {
    ((r.w * r.h) as f64 * r.fps.max(30.0) as f64 * 0.07).clamp(600_000.0, 60_000_000.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layers_by_ceiling() {
        let hs = |v: Vec<Rung>| v.iter().map(|r| (r.h, r.fps as u32)).collect::<Vec<_>>();
        assert_eq!(hs(layers(false, 3840, 2160, 60.0)), vec![(360, 30), (1080, 60), (2160, 60)]);
        assert_eq!(hs(layers(false, 2560, 1440, 60.0)), vec![(360, 30), (720, 60), (1440, 60)]);
        assert_eq!(hs(layers(false, 1280, 720, 30.0)), vec![(360, 30), (720, 30)]);
        assert_eq!(hs(layers(true, 2560, 1440, 60.0)), vec![(360, 15), (720, 15), (1440, 30)]);
        assert_eq!(hs(layers(false, 640, 360, 60.0)), vec![(360, 60)]);
        assert!(layers(false, 3840, 2160, 60.0).len() <= MAX_LAYERS);
    }
}
