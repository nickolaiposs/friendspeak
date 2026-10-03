// OpenH264 (Cisco, BSD): Constrained Baseline in software. The fallback
// everywhere, and the only encoder when hardware acceleration is off.
use std::ffi::c_void;

use openh264::encoder::{BitRate, Complexity, Encoder as Oh, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, RateControlMode, SpsPpsStrategy, UsageType};
use openh264::formats::YUVSlices;
use openh264::OpenH264API;
use openh264_sys2::{SBitrateInfo, ENCODER_OPTION_BITRATE, ENCODER_OPTION_FRAME_RATE, ENCODER_OPTION_MAX_BITRATE, SPATIAL_LAYER_ALL};

use super::{Config, Encoded, Encoder};
use crate::frame::Nv12;

pub struct Soft {
    enc: Oh,
    u: Vec<u8>,
    v: Vec<u8>,
    out: Vec<u8>,
}

impl Soft {
    pub fn new(cfg: Config) -> Result<Self, String> {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8) as u16;
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(cfg.bps))
            .max_frame_rate(FrameRate::from_hz(cfg.fps))
            .usage_type(if cfg.sharp { UsageType::ScreenContentRealTime } else { UsageType::CameraVideoRealTime })
            .rate_control_mode(RateControlMode::Bitrate)
            .sps_pps_strategy(SpsPpsStrategy::ConstantId)
            .complexity(Complexity::Low)
            .skip_frames(true)
            .intra_frame_period(IntraFramePeriod::from_num_frames(0)) // keyframes on request only (PLI)
            .num_threads(threads);
        let enc = Oh::with_api_config(OpenH264API::from_source(), config).map_err(|e| e.to_string())?;
        Ok(Self { enc, u: Vec::new(), v: Vec::new(), out: Vec::new() })
    }
}

impl Encoder for Soft {
    fn encode(&mut self, f: &Nv12, key: bool) -> Result<Option<Encoded>, String> {
        let n = f.w * f.h / 4;
        self.u.resize(n, 0);
        self.v.resize(n, 0);
        for (i, uv) in f.uv.chunks_exact(2).enumerate() {
            self.u[i] = uv[0];
            self.v[i] = uv[1];
        }
        if key {
            self.enc.force_intra_frame();
        }
        let src = YUVSlices::new((&f.y, &self.u, &self.v), (f.w, f.h), (f.w, f.w / 2, f.w / 2));
        let bits = self.enc.encode(&src).map_err(|e| e.to_string())?;
        let kind = bits.frame_type();
        if matches!(kind, FrameType::Skip | FrameType::Invalid) {
            return Ok(None);
        }
        self.out.clear();
        bits.write_vec(&mut self.out);
        if self.out.is_empty() {
            return Ok(None);
        }
        Ok(Some(Encoded { data: self.out.clone(), key: matches!(kind, FrameType::IDR) }))
    }

    fn set_rates(&mut self, bps: u32, fps: f32) {
        let mut info = SBitrateInfo { iLayer: SPATIAL_LAYER_ALL, iBitrate: bps as i32 };
        let mut hz = fps;
        // SAFETY: the options take a pointer to exactly these types, read during the call
        unsafe {
            let raw = self.enc.raw_api();
            raw.set_option(ENCODER_OPTION_BITRATE, &mut info as *mut _ as *mut c_void);
            raw.set_option(ENCODER_OPTION_MAX_BITRATE, &mut info as *mut _ as *mut c_void);
            raw.set_option(ENCODER_OPTION_FRAME_RATE, &mut hz as *mut _ as *mut c_void);
        }
    }

    fn name(&self) -> &'static str {
        "OpenH264"
    }
    fn hardware(&self) -> bool {
        false
    }
    fn high(&self) -> bool {
        false
    }
}
