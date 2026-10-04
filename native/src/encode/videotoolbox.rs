// Apple VideoToolbox: hardware H.264 (the media engine on Apple silicon, Quick
// Sync on Intel Macs). The session is told to require hardware, so when this
// opens the stream really is hardware encoded; otherwise the layer falls back
// to OpenH264.
use std::ffi::{c_int, c_void};
use std::ptr::{null_mut, NonNull};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{kCMTimeInvalid, kCMVideoCodecType_H264, CMSampleBuffer, CMTime, CMVideoFormatDescriptionGetH264ParameterSetAtIndex};
use objc2_core_video::{
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane,
    CVPixelBufferGetHeightOfPlane, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferPool, CVPixelBufferUnlockBaseAddress,
};
use objc2_video_toolbox::{
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AverageBitRate, kVTCompressionPropertyKey_DataRateLimits, kVTCompressionPropertyKey_ExpectedFrameRate,
    kVTCompressionPropertyKey_MaxKeyFrameInterval, kVTCompressionPropertyKey_ProfileLevel, kVTCompressionPropertyKey_RealTime, kVTEncodeFrameOptionKey_ForceKeyFrame,
    kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel, kVTProfileLevel_H264_High_AutoLevel, kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder, VTCompressionSession,
    VTEncodeInfoFlags, VTSessionSetProperty,
};

use super::{has_idr, Config, Encoded, Encoder};
use crate::frame::Nv12;

// What the output callback hands back: a unit, an error, or None for a frame rate control dropped
type Slot = Sender<Result<Option<Encoded>, String>>;

pub struct Vt {
    session: CFRetained<VTCompressionSession>,
    slot: *mut Slot, // owned; handed to the output callback
    n: i64,
    done: Receiver<Result<Option<Encoded>, String>>,
    fps: f32,
    high: bool,
    force: CFRetained<CFDictionary<CFString, CFType>>,
}

// SAFETY: the session is used from one layer thread; the callback only sends on the channel
unsafe impl Send for Vt {}

// AVCC (length-prefixed NAL units, parameter sets in the format description) to Annex B
unsafe fn annex_b(buf: &CMSampleBuffer) -> Result<Encoded, String> {
    let desc = buf.format_description().ok_or("no format description")?;
    let block = buf.data_buffer().ok_or("no data")?;
    let len = block.data_length();
    let mut bytes = vec![0u8; len];
    if len > 0 && block.copy_data_bytes(0, len, NonNull::new(bytes.as_mut_ptr() as *mut c_void).unwrap()) != 0 {
        return Err("can't read the encoded frame".into());
    }
    let (mut count, mut header): (usize, c_int) = (0, 0);
    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(&desc, 0, null_mut(), null_mut(), &mut count, &mut header) != 0 {
        return Err("no H.264 parameter sets".into());
    }
    let header = header as usize;
    let mut nals = Vec::with_capacity(len + 64);
    let mut at = 0;
    while at + header <= len {
        let n = bytes[at..at + header].iter().fold(0usize, |n, b| (n << 8) | *b as usize);
        at += header;
        let nal = bytes.get(at..at + n).ok_or("truncated NAL unit")?;
        nals.extend_from_slice(&[0, 0, 0, 1]);
        nals.extend_from_slice(nal);
        at += n;
    }
    let key = has_idr(&nals);
    if !key {
        return Ok(Encoded { data: nals, key });
    }
    let mut out = Vec::with_capacity(nals.len() + 128);
    for i in 0..count {
        let (mut p, mut n): (*const u8, usize) = (std::ptr::null(), 0);
        if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(&desc, i, &mut p, &mut n, null_mut(), null_mut()) != 0 || p.is_null() {
            return Err("can't read a parameter set".into());
        }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(std::slice::from_raw_parts(p, n));
    }
    out.extend_from_slice(&nals);
    Ok(Encoded { data: out, key })
}

unsafe extern "C-unwind" fn output(slot: *mut c_void, _frame: *mut c_void, status: i32, _flags: VTEncodeInfoFlags, buf: *mut CMSampleBuffer) {
    // `slot` lives until the session is invalidated in Drop
    let slot = &*(slot as *const Slot);
    let res = match (status, buf.as_ref()) {
        (0, Some(buf)) => annex_b(buf).map(Some),
        (0, None) => Ok(None),
        (e, _) => Err(format!("VideoToolbox error {e}")),
    };
    let _ = slot.send(res);
}

fn set(session: &VTCompressionSession, key: &CFString, value: &CFType) -> Result<(), String> {
    // SAFETY: every caller passes the value type the key documents
    match unsafe { VTSessionSetProperty(session, key, Some(value)) } {
        0 => Ok(()),
        e => Err(format!("VideoToolbox property {key}: error {e}")),
    }
}

impl Vt {
    pub fn new(cfg: Config) -> Result<Self, String> {
        let (tx, done) = channel();
        let slot: *mut Slot = Box::into_raw(Box::new(tx));
        let yes: &CFType = CFBoolean::new(true);
        let no: &CFType = CFBoolean::new(false);
        // SAFETY: plain CoreFoundation and VideoToolbox calls with the types they document
        unsafe {
            let spec = CFDictionary::<CFString, CFType>::from_slices(&[kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder], &[yes]);
            let mut raw: *mut VTCompressionSession = null_mut();
            let status = VTCompressionSession::create(None, cfg.w as i32, cfg.h as i32, kCMVideoCodecType_H264, Some(spec.as_opaque()), None, None, Some(output), slot as *mut c_void, NonNull::from(&mut raw));
            let Some(raw) = NonNull::new(raw).filter(|_| status == 0) else {
                drop(Box::from_raw(slot)); // never given to a session
                return Err(format!("no hardware H.264 encoder (error {status})"));
            };
            let session = CFRetained::from_raw(raw);
            let force = CFDictionary::<CFString, CFType>::from_slices(&[kVTEncodeFrameOptionKey_ForceKeyFrame], &[yes]);
            let mut vt = Self { session, slot, n: 0, done, fps: cfg.fps, high: cfg.high, force };
            let s = &*vt.session;
            set(s, kVTCompressionPropertyKey_RealTime, yes)?;
            set(s, kVTCompressionPropertyKey_AllowFrameReordering, no)?; // no B-frames: no added delay
            set(s, kVTCompressionPropertyKey_ProfileLevel, if cfg.high { kVTProfileLevel_H264_High_AutoLevel } else { kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel })?;
            // Keyframes only when a viewer asks (PLI) or joins
            set(s, kVTCompressionPropertyKey_MaxKeyFrameInterval, &CFNumber::new_i32(i32::MAX))?;
            vt.set_rates(cfg.bps, cfg.fps);
            let status = vt.session.prepare_to_encode_frames();
            if status != 0 {
                return Err(format!("VideoToolbox can't start (error {status})"));
            }
            Ok(vt)
        }
    }

    // A buffer the encoder can take without a copy when the session has a pool, a plain one otherwise
    unsafe fn buffer(&self, w: usize, h: usize) -> Result<CFRetained<CVPixelBuffer>, String> {
        let mut raw: *mut CVPixelBuffer = null_mut();
        let pool: Option<CFRetained<CVPixelBufferPool>> = self.session.pixel_buffer_pool();
        let status = match &pool {
            Some(pool) => CVPixelBufferPool::create_pixel_buffer(None, pool, NonNull::from(&mut raw)),
            None => CVPixelBufferCreate(None, w, h, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, None, NonNull::from(&mut raw)),
        };
        NonNull::new(raw).filter(|_| status == 0).map(|p| CFRetained::from_raw(p)).ok_or_else(|| format!("no pixel buffer (error {status})"))
    }
}

impl Encoder for Vt {
    fn encode(&mut self, f: &Nv12, key: bool) -> Result<Option<Encoded>, String> {
        // SAFETY: the buffer is locked while written, and every row copied lies inside its plane (checked below)
        unsafe {
            let buf = self.buffer(f.w, f.h)?;
            if CVPixelBufferLockBaseAddress(&buf, CVPixelBufferLockFlags(0)) != 0 {
                return Err("can't lock the pixel buffer".into());
            }
            let mut ok = true;
            for (plane, src, rows) in [(0, &f.y, f.h), (1, &f.uv, f.h / 2)] {
                let stride = CVPixelBufferGetBytesPerRowOfPlane(&buf, plane);
                let base = CVPixelBufferGetBaseAddressOfPlane(&buf, plane) as *mut u8;
                if base.is_null() || stride < f.w || CVPixelBufferGetHeightOfPlane(&buf, plane) < rows {
                    ok = false;
                    break;
                }
                for r in 0..rows {
                    std::ptr::copy_nonoverlapping(src.as_ptr().add(r * f.w), base.add(r * stride), f.w);
                }
            }
            CVPixelBufferUnlockBaseAddress(&buf, CVPixelBufferLockFlags(0));
            if !ok {
                return Err("unexpected pixel buffer layout".into());
            }
            let pts = CMTime::new((self.n as f64 * 90_000.0 / self.fps.max(1.0) as f64) as i64, 90_000);
            self.n += 1;
            let props = if key { Some(self.force.as_opaque()) } else { None };
            let status = self.session.encode_frame(&buf, pts, kCMTimeInvalid, props, null_mut(), null_mut());
            if status != 0 {
                return Err(format!("VideoToolbox encode error {status}"));
            }
            // Wait for this frame: with real time on and no reordering it is a few milliseconds. Should the
            // encoder take longer, push it; a frame that still isn't there is a failure.
            match self.done.recv_timeout(Duration::from_millis(100)) {
                Ok(res) => res,
                Err(RecvTimeoutError::Timeout) => {
                    self.session.complete_frames(pts);
                    self.done.recv_timeout(Duration::from_millis(500)).map_err(|_| "VideoToolbox returned no frame".to_string())?
                }
                Err(RecvTimeoutError::Disconnected) => Err("VideoToolbox session ended".into()),
            }
        }
    }

    fn set_rates(&mut self, bps: u32, fps: f32) {
        self.fps = fps;
        let s = &*self.session;
        let _ = set(s, unsafe { kVTCompressionPropertyKey_AverageBitRate }, &CFNumber::new_i32(bps as i32));
        let _ = set(s, unsafe { kVTCompressionPropertyKey_ExpectedFrameRate }, &CFNumber::new_f64(fps as f64));
        // A hard cap over one second, a little above the average, so a scene change can't flood a thin link
        let bytes = CFNumber::new_i64((bps as f64 * 1.25 / 8.0) as i64);
        let secs = CFNumber::new_f64(1.0);
        let limits = CFArray::<CFNumber>::from_objects(&[&*bytes, &*secs]);
        let _ = set(s, unsafe { kVTCompressionPropertyKey_DataRateLimits }, limits.as_ref());
    }

    fn name(&self) -> &'static str {
        "VideoToolbox"
    }
    fn hardware(&self) -> bool {
        true
    }
    fn high(&self) -> bool {
        self.high
    }
}

impl Drop for Vt {
    fn drop(&mut self) {
        // SAFETY: after invalidate the callback won't run again, so the slot can go
        unsafe {
            self.session.complete_frames(kCMTimeInvalid);
            self.session.invalidate();
            drop(Box::from_raw(self.slot));
        }
    }
}
