// Cameras on Windows, through a Media Foundation source reader. The camera runs
// in the best mode it has at or below the tier (1440p60 by default); the reader
// converts whatever the camera sends (MJPEG, YUY2, ...) to NV12.
//
// Reading is synchronous, on a thread of its own, which also owns every Media
// Foundation object: they are created, used and released there.
use std::ffi::c_void;
use std::sync::atomic::Ordering;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::{
    IMF2DBuffer, IMFActivate, IMFAttributes, IMFMediaSource, IMFMediaType, IMFSourceReader, MFCreateAttributes, MFCreateMediaType, MFCreateSourceReaderFromMediaSource, MFEnumDeviceSources,
    MFMediaType_Video, MFShutdown, MFStartup, MFVideoFormat_MJPG, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFSTARTUP_FULL, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
    MF_MT_SUBTYPE, MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED, MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR, MF_SOURCE_READERF_NEWSTREAM, MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};

use super::{Capture, Sinks};
use crate::frame::{Frame, Pixels};
use crate::log;
use crate::proto::{Source, Tier};

// How long to keep trying a camera that is busy (a preview may have only just let go of it)
const BUSY_FOR: Duration = Duration::from_secs(2);

const STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

// An open camera: the reader, and what is needed to shut the device down
struct Camera {
    reader: IMFSourceReader,
    source: IMFMediaSource,
    activate: IMFActivate,
    w: usize,
    h: usize,
    stride: usize,
}

impl Drop for Camera {
    fn drop(&mut self) {
        // SAFETY: releases the device; failures on the way out don't matter. The reader is flushed first so no
        // read is left pending on the source.
        unsafe {
            let _ = self.reader.Flush(STREAM);
            let _ = self.source.Shutdown();
            let _ = self.activate.ShutdownObject();
        }
    }
}

fn pair(v: u64) -> (u32, u32) {
    ((v >> 32) as u32, v as u32)
}

// The device activation objects of all video capture devices, with their names
fn devices() -> Result<Vec<(IMFActivate, String)>, String> {
    let mut attrs: Option<IMFAttributes> = None;
    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: MFEnumDeviceSources fills `list` with `count` activation objects in memory we free with
    // CoTaskMemFree; taking each object out of its slot hands its reference to us. The names are CoTaskMem
    // strings, copied and freed.
    unsafe {
        MFCreateAttributes(&mut attrs, 1).map_err(|e| e.to_string())?;
        let attrs = attrs.ok_or("no attributes")?;
        attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID).map_err(|e| e.to_string())?;
        MFEnumDeviceSources(&attrs, &mut list, &mut count).map_err(|e| format!("can't list the cameras: {e}"))?;
        let mut out = Vec::new();
        if !list.is_null() {
            for i in 0..count as usize {
                let Some(act) = (*list.add(i)).take() else { continue };
                let (mut s, mut len) = (windows::core::PWSTR::null(), 0u32);
                let name = if act.GetAllocatedString(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &mut s, &mut len).is_ok() && !s.is_null() {
                    let n = s.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(s.0 as *const c_void));
                    n
                } else {
                    String::new()
                };
                out.push((act, name));
            }
            CoTaskMemFree(Some(list as *const c_void));
        }
        Ok(out)
    }
}

// The mode to run the camera in: the biggest picture within the tier that reaches the wanted frame rate, or
// failing that the fastest one; if nothing fits the tier, the smallest. Returns the native type's index.
fn pick(reader: &IMFSourceReader, tier: &Tier) -> Option<u32> {
    // (reaches the rate, pixels, rate, not MJPEG) of the best so far, and the smallest picture as a last resort
    let mut best: Option<((bool, u64, i64, bool), u32)> = None;
    let mut smallest: Option<(u64, u32)> = None;
    for i in 0.. {
        // SAFETY: reading attributes of the native types the reader lists, until it runs out of them
        let (w, h, fps, mjpeg) = unsafe {
            let Ok(t) = reader.GetNativeMediaType(STREAM, i) else { break };
            let Ok(size) = t.GetUINT64(&MF_MT_FRAME_SIZE) else { continue };
            let (num, den) = t.GetUINT64(&MF_MT_FRAME_RATE).map(pair).unwrap_or((0, 1));
            let fps = if den > 0 { num as f64 / den as f64 } else { 0.0 };
            let (w, h) = pair(size);
            (w as u64, h as u64, fps, t.GetGUID(&MF_MT_SUBTYPE).map(|g| g == MFVideoFormat_MJPG).unwrap_or(false))
        };
        if w == 0 || h == 0 {
            continue;
        }
        if smallest.map_or(true, |(a, _)| w * h < a) {
            smallest = Some((w * h, i));
        }
        if w as usize > tier.width.max(640) || h as usize > tier.height.max(480) {
            continue;
        }
        let score = (fps >= tier.fps as f64 - 0.5, w * h, fps as i64, !mjpeg);
        if best.map_or(true, |(b, _)| score > b) {
            best = Some((score, i));
        }
    }
    best.map(|(_, i)| i).or(smallest.map(|(_, i)| i))
}

// Opens the camera named by `name` (the first one when empty) in its best mode, delivering NV12
fn open(name: &str, tier: &Tier) -> Result<Camera, String> {
    let all = devices()?;
    let name = name.trim();
    // The app knows the camera by the label Chromium gives it: the device's name, sometimes with "(vid:pid)" after it
    let (activate, _) = all
        .iter()
        .find(|(_, n)| !name.is_empty() && (n == name || name.starts_with(n.as_str())))
        .or_else(|| all.first())
        .cloned()
        .ok_or("no camera found")?;
    drop(all);
    let e = |what: &'static str| move |e: windows::core::Error| format!("{what}: {e}");
    // SAFETY: Media Foundation calls with the argument types it documents; every object created here is owned
    // by `Camera`, whose Drop shuts the device down, or released when this function returns early
    unsafe {
        let source: IMFMediaSource = activate.ActivateObject().map_err(e("can't open the camera"))?;
        let mut attrs: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attrs, 1).map_err(|e| e.to_string())?;
        let attrs = attrs.ok_or("no attributes")?;
        // Lets the reader convert MJPEG, YUY2 and the like to NV12 for us
        attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1).map_err(e("no video processing"))?;
        let reader = match MFCreateSourceReaderFromMediaSource(&source, &attrs) {
            Ok(r) => r,
            Err(err) => {
                let _ = source.Shutdown();
                let _ = activate.ShutdownObject();
                return Err(format!("can't read the camera: {err}"));
            }
        };
        let mut cam = Camera { reader, source, activate, w: 0, h: 0, stride: 0 };
        cam.reader.SetStreamSelection(STREAM, true).map_err(e("can't select the camera stream"))?;
        if let Some(i) = pick(&cam.reader, tier) {
            // The native mode first, so the camera runs at that size and rate; then the same picture as NV12
            let native: IMFMediaType = cam.reader.GetNativeMediaType(STREAM, i).map_err(e("camera mode"))?;
            cam.reader.SetCurrentMediaType(STREAM, None, &native).map_err(e("can't set the camera mode"))?;
            let nv12 = MFCreateMediaType().map_err(e("media type"))?;
            nv12.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(e("media type"))?;
            nv12.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(e("media type"))?;
            nv12.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(e("media type"))?;
            if let Ok(size) = native.GetUINT64(&MF_MT_FRAME_SIZE) {
                nv12.SetUINT64(&MF_MT_FRAME_SIZE, size).map_err(e("media type"))?;
            }
            if let Ok(rate) = native.GetUINT64(&MF_MT_FRAME_RATE) {
                nv12.SetUINT64(&MF_MT_FRAME_RATE, rate).map_err(e("media type"))?;
            }
            cam.reader.SetCurrentMediaType(STREAM, None, &nv12).map_err(e("the camera can't deliver NV12"))?;
        } else {
            let nv12 = MFCreateMediaType().map_err(e("media type"))?;
            nv12.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(e("media type"))?;
            nv12.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(e("media type"))?;
            cam.reader.SetCurrentMediaType(STREAM, None, &nv12).map_err(e("the camera can't deliver NV12"))?;
        }
        cam.read_type()?;
        Ok(cam)
    }
}

impl Camera {
    // The size and row pitch of what the reader delivers now
    fn read_type(&mut self) -> Result<(), String> {
        // SAFETY: attribute reads on the reader's current media type
        unsafe {
            let t = self.reader.GetCurrentMediaType(STREAM).map_err(|e| format!("no camera format: {e}"))?;
            let (w, h) = t.GetUINT64(&MF_MT_FRAME_SIZE).map(pair).map_err(|_| "the camera reports no size".to_string())?;
            self.w = w as usize;
            self.h = h as usize;
            // Negative means bottom-up and zero or missing means unknown; a plain NV12 row is the width
            let stride = t.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|s| s as i32).unwrap_or(0);
            self.stride = if stride > 0 && stride as usize >= self.w { stride as usize } else { self.w };
        }
        if self.w < 2 || self.h < 2 {
            return Err("the camera reports no picture size".into());
        }
        Ok(())
    }

    // Blocks for the next frame. Ok(None): the reader had nothing to give this time.
    fn read(&mut self) -> Result<Option<Frame>, String> {
        let (mut flags, mut sample) = (0u32, None);
        // SAFETY: valid out pointers for a synchronous read
        unsafe { self.reader.ReadSample(STREAM, 0, None, Some(&mut flags), None, Some(&mut sample)) }.map_err(|e| format!("the camera stopped: {e}"))?;
        if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
            return Err("the camera reported an error".into());
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            return Err("the camera was disconnected".into());
        }
        if flags & (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 | MF_SOURCE_READERF_NEWSTREAM.0) as u32 != 0 {
            self.read_type()?;
        }
        let Some(sample) = sample else { return Ok(None) };
        let (w, h, stride) = (self.w, self.h, self.stride);
        // SAFETY: the buffer is locked (as 2-D when it can be, which reports the real pitch) only while the planes
        // are copied out, and no read goes past `need` bytes after checking the buffer is that long
        let planes = unsafe {
            let buf = sample.ConvertToContiguousBuffer().map_err(|e| e.to_string())?;
            let (mut p, mut pitch, mut len) = (std::ptr::null_mut::<u8>(), 0i32, 0u32);
            let twod = buf.cast::<IMF2DBuffer>().ok();
            let (locked2d, stride) = match &twod {
                Some(b) if b.Lock2D(&mut p, &mut pitch).is_ok() => (true, if pitch > 0 && pitch as usize >= w { pitch as usize } else { stride }),
                _ => {
                    p = std::ptr::null_mut();
                    (false, stride)
                }
            };
            if !locked2d && buf.Lock(&mut p, None, Some(&mut len)).is_err() {
                return Err("can't read the camera frame".into());
            }
            // A 2-D lock doesn't report a length, but the buffer was created for this size
            let have = if locked2d { stride * h * 3 / 2 } else { len as usize };
            let need = stride * h * 3 / 2;
            let out = if p.is_null() || have < need {
                None
            } else {
                let all = std::slice::from_raw_parts(p, need);
                Some((all[..stride * h].to_vec(), all[stride * h..].to_vec(), stride))
            };
            if locked2d {
                if let Some(b) = &twod {
                    let _ = b.Unlock2D();
                }
            } else {
                let _ = buf.Unlock();
            }
            out
        };
        Ok(planes.map(|(y, uv, stride)| Frame { w, h, at: Instant::now(), px: Pixels::Nv12 { y, y_stride: stride, uv, uv_stride: stride } }))
    }
}

pub fn start(source: &Source, tier: &Tier, sinks: Sinks) -> Result<Capture, String> {
    let (cap, stop) = Capture::new();
    let (name, tier) = (source.name.clone(), tier.clone());
    let (tx, rx) = channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("camera".into())
        .spawn(move || {
            // SAFETY: balanced with the shutdown calls below. A thread that is already apartment-threaded refuses
            // MTA; Media Foundation works there too, and then we don't uninitialize what we didn't initialize.
            let (com, mf) = unsafe { (CoInitializeEx(None, COINIT_MULTITHREADED).is_ok(), MFStartup(MF_VERSION, MFSTARTUP_FULL)) };
            let started = mf.is_ok();
            let cam = match mf {
                Ok(()) => {
                    // A camera another part of the app has only just let go of can still be busy for a moment
                    let t0 = Instant::now();
                    loop {
                        match open(&name, &tier) {
                            Ok(c) => break Ok(c),
                            Err(e) if t0.elapsed() >= BUSY_FOR || stop.load(Ordering::Relaxed) || e == "no camera found" => break Err(e),
                            Err(_) => std::thread::sleep(Duration::from_millis(150)),
                        }
                    }
                }
                Err(e) => Err(format!("Media Foundation won't start: {e}")),
            };
            match cam {
                Ok(mut cam) => {
                    let _ = tx.send(Ok(()));
                    while !stop.load(Ordering::Relaxed) {
                        match cam.read() {
                            Ok(Some(frame)) => (sinks.video)(frame),
                            Ok(None) => {}
                            Err(e) => {
                                if !stop.load(Ordering::Relaxed) {
                                    (sinks.ended)(e);
                                }
                                break;
                            }
                        }
                    }
                    drop(cam);
                    log!("camera stopped");
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                }
            }
            // SAFETY: balances the startup calls at the top of this thread
            unsafe {
                if started {
                    let _ = MFShutdown();
                }
                if com {
                    CoUninitialize();
                }
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "the camera didn't open in time".to_string())??;
    Ok(cap)
}
