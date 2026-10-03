// Cameras on macOS, through AVFoundation. The camera runs in the best mode it
// has at or below the tier (1440p60 by default), and delivers NV12.
use std::sync::atomic::Ordering;
use std::time::Duration;

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_av_foundation::{
    AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceFormat, AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession, AVCaptureVideoDataOutput, AVCaptureVideoDataOutputSampleBufferDelegate,
    AVMediaTypeVideo,
};
use objc2_core_media::{CMSampleBuffer, CMTime, CMVideoFormatDescriptionGetDimensions};
use objc2_core_video::{kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange};
use objc2_foundation::{NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};

use super::screen_mac::video;
use super::{Capture, Sinks};
use crate::log;
use crate::proto::{Source, Tier};

struct Ivars {
    sinks: Sinks,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and Output implements no Drop
    #[unsafe(super(NSObject))]
    #[name = "FSCameraOutput"]
    #[ivars = Ivars]
    struct Output;

    unsafe impl NSObjectProtocol for Output {}

    unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for Output {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        unsafe fn output(&self, _out: &AVCaptureOutput, buf: &CMSampleBuffer, _conn: &AVCaptureConnection) {
            if let Some(frame) = video(buf) {
                (self.ivars().sinks.video)(frame);
            }
        }
    }
);

impl Output {
    fn new(sinks: Sinks) -> Retained<Self> {
        let this = Self::alloc().set_ivars(Ivars { sinks });
        // SAFETY: NSObject's init
        unsafe { msg_send![super(this), init] }
    }
}

// The mode to run the camera in: the biggest picture within the tier that reaches the wanted
// frame rate, or failing that the fastest one. (width, height, fps it can do)
unsafe fn pick(device: &AVCaptureDevice, tier: &Tier) -> Option<(Retained<AVCaptureDeviceFormat>, f64)> {
    let mut best: Option<(Retained<AVCaptureDeviceFormat>, f64, (bool, i64, i64))> = None;
    for f in device.formats().iter() {
        let dim = CMVideoFormatDescriptionGetDimensions(&f.formatDescription());
        if dim.width as usize > tier.width.max(640) || dim.height as usize > tier.height.max(480) {
            continue;
        }
        let max = f.videoSupportedFrameRateRanges().iter().map(|r| r.maxFrameRate()).fold(0.0, f64::max);
        let fps = max.min(tier.fps as f64);
        // Full frame rate first, then pixels, then whatever rate is left
        let score = (fps >= tier.fps as f64 - 0.5, dim.width as i64 * dim.height as i64, fps as i64);
        if best.as_ref().map_or(true, |b| score > b.2) {
            best = Some((f.clone(), fps, score));
        }
    }
    best.map(|(f, fps, _)| (f, fps))
}

pub fn start(source: &Source, tier: &Tier, sinks: Sinks) -> Result<Capture, String> {
    // SAFETY: AVFoundation calls with the argument types it documents. The session keeps its input, output and
    // (through the output) nothing else alive, so the delegate is held by the thread below.
    unsafe {
        let media = AVMediaTypeVideo.ok_or("no video capture on this system")?;
        #[allow(deprecated)]
        let devices = AVCaptureDevice::devicesWithMediaType(media);
        // The app knows the camera by the label Chromium gives it: the device's name, sometimes with "(vid:pid)" after it
        let name = source.name.trim();
        let device = devices
            .iter()
            .find(|d| !name.is_empty() && (d.localizedName().to_string() == name || name.starts_with(&d.localizedName().to_string())))
            .or_else(|| AVCaptureDevice::defaultDeviceWithMediaType(media))
            .ok_or("no camera found")?;
        let input = AVCaptureDeviceInput::deviceInputWithDevice_error(&device).map_err(|e| e.localizedDescription().to_string())?;
        let session = AVCaptureSession::new();
        session.beginConfiguration();
        if !session.canAddInput(&input) {
            return Err("the camera is in use".into());
        }
        session.addInput(&input);
        let out = AVCaptureVideoDataOutput::new();
        let key: &NSString = &*(kCVPixelBufferPixelFormatTypeKey as *const _ as *const NSString);
        let settings = NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[&*NSNumber::new_u32(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) as &AnyObject]);
        out.setVideoSettings(Some(&settings));
        out.setAlwaysDiscardsLateVideoFrames(true);
        let output = Output::new(sinks);
        let queue = DispatchQueue::new("friendspeak.camera", None);
        out.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*output)), Some(&queue));
        session.addOutput(&out);
        session.commitConfiguration();
        // After the session has the device: a preset would otherwise override the format
        if let Some((format, fps)) = pick(&device, tier) {
            if device.lockForConfiguration().is_ok() {
                device.setActiveFormat(&format);
                let frame = CMTime::new(1000, (fps * 1000.0) as i32);
                device.setActiveVideoMinFrameDuration(frame);
                device.setActiveVideoMaxFrameDuration(frame);
                device.unlockForConfiguration();
            }
        }
        session.startRunning();
        let (cap, stop) = Capture::new();
        let hold = Hold(session, output);
        std::thread::Builder::new()
            .name("camera".into())
            .spawn(move || {
                let hold = hold;
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                hold.0.stopRunning();
                log!("camera stopped");
            })
            .map_err(|e| e.to_string())?;
        Ok(cap)
    }
}

struct Hold(Retained<AVCaptureSession>, #[allow(dead_code)] Retained<Output>);
// SAFETY: AVCaptureSession may be stopped from any thread; the delegate is only kept alive here
unsafe impl Send for Hold {}
