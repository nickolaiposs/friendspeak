// Screens and windows on macOS, through ScreenCaptureKit (macOS 13+).
//
// The stream is asked for NV12 at the size the tier allows, so the scaling and
// the color conversion happen on the GPU before a frame reaches us. A still
// screen delivers no frames at all (the engine repeats the last one when a
// viewer needs it).
//
// Audio: a window share carries that app's sound. A screen share carries
// everything the computer plays *except* the friendspeak app, which is
// excluded from the capture as an application (its windows stay in the
// picture), so friends in the call don't hear themselves back.
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_audio_types::kAudioFormatFlagIsNonInterleaved;
use objc2_core_foundation::CGSize;
use objc2_core_graphics::{CGDisplayCopyDisplayMode, CGDisplayMode};
use objc2_core_media::{CMAudioFormatDescriptionGetStreamBasicDescription, CMSampleBuffer, CMTime};
use objc2_core_video::{
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeight, CVPixelBufferGetHeightOfPlane,
    CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCRunningApplication, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
};

use super::{Capture, Sinks};
use crate::frame::{even, Frame, Pixels};
use crate::log;
use crate::proto::{Source, Tier};

struct Ivars {
    sinks: Sinks,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and Output implements no Drop
    #[unsafe(super(NSObject))]
    #[name = "FSScreenOutput"]
    #[ivars = Ivars]
    struct Output;

    unsafe impl NSObjectProtocol for Output {}

    unsafe impl SCStreamOutput for Output {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn output(&self, _stream: &SCStream, buf: &CMSampleBuffer, kind: SCStreamOutputType) {
            if kind == SCStreamOutputType::Screen {
                if let Some(frame) = video(buf) {
                    (self.ivars().sinks.video)(frame);
                }
            } else if kind == SCStreamOutputType::Audio {
                if let Some(pcm) = audio(buf) {
                    (self.ivars().sinks.audio)(pcm);
                }
            }
        }
    }

    unsafe impl SCStreamDelegate for Output {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stopped(&self, _stream: &SCStream, error: &NSError) {
            (self.ivars().sinks.ended)(error.localizedDescription().to_string());
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

// The picture of a sample buffer, copied out (None for the idle frames a still screen produces)
pub(super) unsafe fn video(buf: &CMSampleBuffer) -> Option<Frame> {
    let img = buf.image_buffer()?;
    if CVPixelBufferGetPixelFormatType(&img) != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange {
        return None;
    }
    let (w, h) = (CVPixelBufferGetWidth(&img), CVPixelBufferGetHeight(&img));
    if CVPixelBufferLockBaseAddress(&img, CVPixelBufferLockFlags::ReadOnly) != 0 {
        return None;
    }
    let plane = |i: usize| {
        let (base, stride, rows) = (CVPixelBufferGetBaseAddressOfPlane(&img, i) as *const u8, CVPixelBufferGetBytesPerRowOfPlane(&img, i), CVPixelBufferGetHeightOfPlane(&img, i));
        (!base.is_null()).then(|| (std::slice::from_raw_parts(base, stride * rows).to_vec(), stride))
    };
    let planes = plane(0).zip(plane(1));
    CVPixelBufferUnlockBaseAddress(&img, CVPixelBufferLockFlags::ReadOnly);
    let ((y, y_stride), (uv, uv_stride)) = planes?;
    Some(Frame { w, h, at: Instant::now(), px: Pixels::Nv12 { y, y_stride, uv, uv_stride } })
}

// The samples of an audio buffer as interleaved stereo. ScreenCaptureKit delivers 32-bit float, one plane per channel.
unsafe fn audio(buf: &CMSampleBuffer) -> Option<Vec<f32>> {
    let desc = buf.format_description()?;
    let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(&desc).as_ref()?;
    if asbd.mBitsPerChannel != 32 {
        return None;
    }
    let block = buf.data_buffer()?;
    let len = block.data_length();
    let mut bytes = vec![0u8; len];
    if len == 0 || block.copy_data_bytes(0, len, NonNull::new(bytes.as_mut_ptr() as *mut c_void)?) != 0 {
        return None;
    }
    let all: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]])).collect();
    let ch = (asbd.mChannelsPerFrame as usize).max(1);
    let n = all.len() / ch;
    let mut out = Vec::with_capacity(n * 2);
    let planar = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0;
    for i in 0..n {
        let at = |c: usize| if planar { all[c * n + i] } else { all[i * ch + c] };
        out.extend_from_slice(&[at(0), at(if ch > 1 { 1 } else { 0 })]);
    }
    Some(out)
}

// SAFETY wrapper: the objects only cross from the completion handler's queue to the capture thread
struct Sendable<T>(T);
unsafe impl<T> Send for Sendable<T> {}

fn content() -> Result<Retained<SCShareableContent>, String> {
    let (tx, rx) = mpsc::channel();
    let done = RcBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
        // SAFETY: the handler is given either a content object or an error
        let res = unsafe { Retained::retain(content).ok_or_else(|| err.as_ref().map_or("no shareable content".to_string(), |e| e.localizedDescription().to_string())) };
        let _ = tx.send(Sendable(res));
    });
    // SAFETY: the block outlives the call (the framework copies it)
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&done) };
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Sendable(res)) => res.map_err(|e| {
            // The system's wording for a missing permission isn't helpful; ours names the setting
            if e.contains("declined") || e.contains("TCC") {
                "friendspeak needs Screen Recording permission (System Settings → Privacy & Security → Screen & System Audio Recording)".to_string()
            } else {
                e
            }
        }),
        Err(_) => Err("the system didn't answer the screen capture request".into()),
    }
}

// Number from Electron's source id: "screen:<display id>:0", "window:<window id>:0"
fn id_of(source: &Source) -> Option<u32> {
    source.id.split(':').nth(1)?.parse().ok()
}

// Pixels per point of a display
fn scale_of(display: &SCDisplay) -> f64 {
    // SAFETY: plain getters
    unsafe {
        let mode = CGDisplayCopyDisplayMode(display.displayID());
        let px = CGDisplayMode::pixel_width(mode.as_deref()) as f64;
        let pt = display.width() as f64;
        if px > 0.0 && pt > 0.0 {
            px / pt
        } else {
            1.0
        }
    }
}

pub fn start(source: &Source, tier: &Tier, sinks: Sinks) -> Result<Capture, String> {
    let (source, tier) = (source.clone(), tier.clone());
    let (cap, stop) = Capture::new();
    let (ready_tx, ready) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("screencapturekit".into())
        .spawn(move || {
            // SAFETY: ScreenCaptureKit calls with the argument types it documents; `output` and `stream` live until the end of this thread
            let run = || -> Result<(Retained<SCStream>, Retained<Output>), String> {
                unsafe {
                    let content = content()?;
                    let displays = content.displays();
                    let windows = content.windows();
                    let want = id_of(&source);
                    let (filter, size): (Retained<SCContentFilter>, CGSize) = if source.kind == "window" {
                        let win: Retained<SCWindow> = windows.iter().find(|w| Some(w.windowID()) == want).ok_or("that window is gone")?;
                        let frame = win.frame();
                        // The display the window is (mostly) on decides how many pixels a point is
                        let scale = displays
                            .iter()
                            .find(|d| {
                                let f = d.frame();
                                frame.origin.x + frame.size.width / 2.0 >= f.origin.x && frame.origin.x + frame.size.width / 2.0 < f.origin.x + f.size.width
                            })
                            .or(displays.iter().next())
                            .map_or(1.0, |d| scale_of(&d));
                        (
                            SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &win),
                            CGSize { width: frame.size.width * scale, height: frame.size.height * scale },
                        )
                    } else {
                        let display: Retained<SCDisplay> = displays
                            .iter()
                            .find(|d| Some(d.displayID()) == want)
                            .or(displays.iter().find(|d| {
                                let f = d.frame();
                                source.width > 0 && f.origin.x as i32 == source.x && f.origin.y as i32 == source.y
                            }))
                            .or(displays.iter().next())
                            .ok_or("no display to capture")?;
                        let scale = scale_of(&display);
                        let size = CGSize { width: display.width() as f64 * scale, height: display.height() as f64 * scale };
                        // friendspeak itself: out of the audio, still in the picture
                        let pid = if source.exclude_pid > 0 { source.exclude_pid as i32 } else { std::os::unix::process::parent_id() as i32 };
                        let own: Vec<Retained<SCRunningApplication>> = content.applications().iter().filter(|a| a.processID() == pid).collect();
                        let filter = if source.audio && !own.is_empty() {
                            let keep: Vec<Retained<SCWindow>> = windows.iter().filter(|w| w.owningApplication().is_some_and(|a| a.processID() == pid)).collect();
                            SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                                SCContentFilter::alloc(),
                                &display,
                                &NSArray::from_retained_slice(&own),
                                &NSArray::from_retained_slice(&keep),
                            )
                        } else {
                            SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &NSArray::new())
                        };
                        (filter, size)
                    };
                    // No bigger than the tier, same shape as the source
                    let shrink = (size.width / tier.width as f64).max(size.height / tier.height as f64).max(1.0);
                    let cfg = SCStreamConfiguration::new();
                    cfg.setWidth(even((size.width / shrink) as usize));
                    cfg.setHeight(even((size.height / shrink) as usize));
                    cfg.setPixelFormat(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
                    cfg.setMinimumFrameInterval(CMTime::new(1, tier.fps.clamp(1.0, 120.0) as i32));
                    cfg.setShowsCursor(true);
                    cfg.setQueueDepth(4);
                    if source.audio {
                        cfg.setCapturesAudio(true);
                        cfg.setSampleRate(48_000);
                        cfg.setChannelCount(2);
                        // The sidecar plays nothing; this covers sound attributed to it as a child of the app
                        cfg.setExcludesCurrentProcessAudio(true);
                    }
                    let output = Output::new(sinks);
                    let stream = SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &cfg, Some(ProtocolObject::from_ref(&*output)));
                    let queue = DispatchQueue::new("friendspeak.capture", None);
                    let e = |e: Retained<NSError>| e.localizedDescription().to_string();
                    stream.addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*output), SCStreamOutputType::Screen, Some(&queue)).map_err(e)?;
                    if source.audio {
                        stream.addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*output), SCStreamOutputType::Audio, Some(&queue)).map_err(e)?;
                    }
                    let (tx, rx) = mpsc::channel();
                    let started = RcBlock::new(move |err: *mut NSError| {
                        let _ = tx.send(err.as_ref().map(|e| e.localizedDescription().to_string()));
                    });
                    stream.startCaptureWithCompletionHandler(Some(&started));
                    match rx.recv_timeout(Duration::from_secs(10)) {
                        Ok(None) => Ok((stream, output)),
                        Ok(Some(e)) => Err(e),
                        Err(_) => Err("screen capture didn't start".into()),
                    }
                }
            };
            match run() {
                Err(e) => drop(ready_tx.send(Err(e))),
                Ok((stream, _output)) => {
                    let _ = ready_tx.send(Ok(()));
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    // SAFETY: the stream is live; no completion handler needed
                    unsafe { stream.stopCaptureWithCompletionHandler(None) };
                    log!("screen capture stopped");
                }
            }
        })
        .map_err(|e| e.to_string())?;
    ready.recv_timeout(Duration::from_secs(25)).map_err(|_| "screen capture didn't start".to_string())??;
    Ok(cap)
}
