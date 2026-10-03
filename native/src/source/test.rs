// A moving test pattern, for verifying the pipeline without a screen or
// camera (the counterpart of Chromium's --use-fake-device-for-media-stream).
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use super::{Capture, Sinks};
use crate::frame::{even, Frame, Pixels};
use crate::proto::{Source, Tier};

pub fn start(source: &Source, tier: &Tier, sinks: Sinks) -> Result<Capture, String> {
    let audio = source.audio;
    let (w, h) = (even(tier.width), even(tier.height));
    let fps = tier.fps.clamp(1.0, 120.0);
    let (cap, stop) = Capture::new();
    std::thread::Builder::new()
        .name("test-source".into())
        .spawn(move || {
            let step = Duration::from_secs_f32(1.0 / fps);
            let mut next = Instant::now();
            let mut n = 0usize;
            let mut phase = 0f32;
            while !stop.load(Ordering::Relaxed) {
                let mut y = vec![0u8; w * h];
                let mut uv = vec![128u8; w * h / 2];
                // Vertical bars that drift, and a bright box that crosses the frame
                let shift = n * 4;
                for (r, row) in y.chunks_exact_mut(w).enumerate() {
                    for (x, p) in row.iter_mut().enumerate() {
                        *p = 40 + ((((x + shift) / 64) % 8) * 24) as u8 + ((r / 90) % 2 * 8) as u8;
                    }
                }
                let bx = (n * 9) % (w - 120);
                let by = (h / 2).saturating_sub(60);
                for r in by..(by + 120).min(h) {
                    y[r * w + bx..r * w + bx + 120].fill(235);
                }
                for (r, row) in uv.chunks_exact_mut(w).enumerate() {
                    for (x, p) in row.chunks_exact_mut(2).enumerate() {
                        p[0] = (96 + (x * 64 / (w / 2))) as u8;
                        p[1] = (96 + (r * 64 / (h / 2))) as u8;
                    }
                }
                if audio {
                    // A 440 Hz tone, as much of it as one frame lasts
                    let samples = (48_000.0 / fps) as usize;
                    let mut pcm = Vec::with_capacity(samples * 2);
                    for _ in 0..samples {
                        let v = (phase * std::f32::consts::TAU).sin() * 0.2;
                        phase = (phase + 440.0 / 48_000.0).fract();
                        pcm.extend_from_slice(&[v, v]);
                    }
                    (sinks.audio)(pcm);
                }
                (sinks.video)(Frame { w, h, at: Instant::now(), px: Pixels::Nv12 { y, y_stride: w, uv, uv_stride: w } });
                n += 1;
                next += step;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    next = now;
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(cap)
}
