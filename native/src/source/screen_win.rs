// Screens and windows on Windows, through Windows Graphics Capture (Windows 10 1903+).
//
// Frames come out as BGRA in system memory and are converted and scaled by the
// engine. The capture runs on the crate's own thread (it needs a message loop);
// ours only watches the stop flag and notices when that thread ends by itself,
// which is how a closed window shows up. A still screen delivers no frames
// (the engine repeats the last one when a viewer needs it).
//
// The cursor is captured. The yellow border is switched off where Windows
// allows it (Windows 11); on Windows 10 the options aren't there and the
// capture runs without asking for them.
//
// Audio is audio_win's: it runs beside the video and shares the sinks.
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::IsWindow;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame as GrabbedFrame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use super::{audio_win, Capture, Sinks};
use crate::frame::{Frame, Pixels};
use crate::log;
use crate::proto::{Source, Tier};

struct Grab {
    sinks: Arc<Sinks>,
    stop: Arc<AtomicBool>,
    failed: u32,
}

impl GraphicsCaptureApiHandler for Grab {
    type Flags = (Arc<Sinks>, Arc<AtomicBool>);
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, String> {
        let (sinks, stop) = ctx.flags;
        Ok(Self { sinks, stop, failed: 0 })
    }

    fn on_frame_arrived(&mut self, frame: &mut GrabbedFrame, _control: InternalCaptureControl) -> Result<(), String> {
        if self.stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        // One frame that can't be read (the GPU was busy, the window resized) isn't the end of the share; a
        // long run of them is.
        let mut buf = match frame.buffer() {
            Ok(b) => b,
            Err(e) => {
                self.failed += 1;
                return if self.failed > 60 { Err(format!("can't read the captured frames: {e}")) } else { Ok(()) };
            }
        };
        self.failed = 0;
        let (w, h, stride) = (buf.width() as usize, buf.height() as usize, buf.row_pitch() as usize);
        let raw = buf.as_raw_buffer();
        // The last row needs only its own pixels, not the padding after them
        if w == 0 || h == 0 || stride < w * 4 || raw.len() < stride * (h - 1) + w * 4 {
            return Ok(());
        }
        let data = raw[..raw.len().min(stride * h)].to_vec();
        (self.sinks.video)(Frame { w, h, at: Instant::now(), px: Pixels::Bgra { data, stride } });
        Ok(())
    }
}

// The monitor whose top-left corner is where the app says the screen is. Electron's ids number screens its
// own way, so the position is what identifies one.
fn monitor_at(x: i32, y: i32) -> Result<Monitor, String> {
    // Without this Windows hands a DPI-unaware process scaled coordinates, which don't match the app's
    // physical ones. Failing just means it was already set (by us earlier, or by a manifest).
    // SAFETY: a plain call with a constant context value
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let all = Monitor::enumerate().map_err(|e| format!("can't list the screens: {e}"))?;
    for m in &all {
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, rcMonitor: RECT::default(), rcWork: RECT::default(), dwFlags: 0 };
        // SAFETY: the handle comes from the enumeration just made and `info` has its size set
        let ok = unsafe { GetMonitorInfoW(HMONITOR(m.as_raw_hmonitor()), &mut info) }.as_bool();
        if ok && info.rcMonitor.left == x && info.rcMonitor.top == y {
            return Ok(*m);
        }
    }
    log!("no screen at {x},{y}; sharing the primary one");
    Monitor::primary().map_err(|e| format!("no screen to capture: {e}"))
}

// "window:<HWND>:0" → the window handle
fn hwnd_of(id: &str) -> Option<usize> {
    let mut parts = id.split(':');
    (parts.next()? == "window").then_some(())?;
    parts.next()?.parse::<usize>().ok().filter(|h| *h != 0)
}

// Starts WGC on its own thread; Ok once the session runs
fn begin<T>(item: T, fps: f32, flags: <Grab as GraphicsCaptureApiHandler>::Flags) -> Result<CaptureControl<Grab, String>, String>
where
    T: TryInto<GraphicsCaptureItemType> + Send + 'static,
{
    // Each of these is refused on Windows versions that lack it, so ask only where they exist
    let border = GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false);
    let interval = GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false);
    let settings = Settings::new(
        item,
        CursorCaptureSettings::WithCursor,
        if border { DrawBorderSettings::WithoutBorder } else { DrawBorderSettings::Default },
        SecondaryWindowSettings::Default,
        // A little under the frame interval, so the display's own rhythm doesn't push frames past it
        if interval { MinimumUpdateIntervalSettings::Custom(Duration::from_secs_f32(0.8 / fps.clamp(1.0, 240.0))) } else { MinimumUpdateIntervalSettings::Default },
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );
    Grab::start_free_threaded(settings).map_err(|e| format!("can't start screen capture: {e}"))
}

pub fn start(source: &Source, tier: &Tier, sinks: Sinks) -> Result<Capture, String> {
    let sinks = Arc::new(sinks);
    let (cap, stop) = Capture::new();
    let flags = (sinks.clone(), stop.clone());
    let window = source.kind == "window";
    let control = if window {
        let hwnd = hwnd_of(&source.id).ok_or_else(|| format!("not a window id: {}", source.id))?;
        // SAFETY: IsWindow accepts any handle value and only reports whether it is a window
        if !unsafe { IsWindow(Some(HWND(hwnd as *mut c_void))) }.as_bool() {
            return Err("that window is gone".into());
        }
        begin(Window::from_raw_hwnd(hwnd as *mut c_void), tier.fps, flags)?
    } else {
        begin(monitor_at(source.x, source.y)?, tier.fps, flags)?
    };
    if source.audio {
        audio_win::start(source, sinks.clone(), stop.clone());
    }
    let ended = sinks;
    let halt = stop.clone();
    std::thread::Builder::new()
        .name("screen".into())
        .spawn(move || {
            loop {
                if stop.load(Ordering::Relaxed) {
                    // Posts the quit message to the capture thread and waits for it
                    if let Err(e) = control.stop() {
                        log!("screen capture stop: {e}");
                    }
                    log!("screen capture stopped");
                    return;
                }
                if control.is_finished() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            // The thread ended on its own: the window closed, or capture failed. The audio thread follows `stop`.
            let reason = match control.wait() {
                Ok(()) if window => "the shared window was closed".to_string(),
                Ok(()) => "the shared screen is no longer available".to_string(),
                Err(e) => format!("screen capture failed: {e}"),
            };
            stop.store(true, Ordering::Relaxed);
            (ended.ended)(reason);
        })
        .map_err(|e| {
            // The capture thread can't be stopped without the control the closure took; tell its frames to stop
            // going anywhere at least
            halt.store(true, Ordering::Relaxed);
            e.to_string()
        })?;
    Ok(cap)
}
