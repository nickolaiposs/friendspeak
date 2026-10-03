// The sound of a share on Windows, through WASAPI process loopback (Windows 10 2004+).
//
// Process loopback captures what a process tree plays instead of what the
// speakers play, which is what lets a screen share leave out the friendspeak
// app (so friends in the call don't hear themselves back) and a window share
// carry only that app's sound.
//
// Audio never fails a share: when anything here goes wrong (an older Windows,
// no audio device) it is logged and the share goes on with video only.
use std::ffi::c_void;
use std::mem::{size_of, ManuallyDrop};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::core::{implement, Interface, Ref, HRESULT};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use super::Sinks;
use crate::log;
use crate::proto::Source;

const RATE: u32 = 48_000;

// Told by Windows when the audio interface is ready (on one of its own threads), which hands over to ours
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Ready(Mutex<Sender<()>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Ready_Impl {
    fn ActivateCompleted(&self, _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        if let Ok(tx) = self.0.lock() {
            let _ = tx.send(());
        }
        Ok(())
    }
}

// The process that started the sidecar (the app), when the source doesn't name one
fn parent_pid() -> Option<u32> {
    // SAFETY: a process snapshot is read with the structure's size set, and the handle is closed after
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let me = GetCurrentProcessId();
        let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = None;
        let mut more = Process32FirstW(snap, &mut entry).is_ok();
        while more {
            if entry.th32ProcessID == me {
                found = Some(entry.th32ParentProcessID).filter(|p| *p != 0);
                break;
            }
            more = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
        found
    }
}

// Which process tree to capture, and whether to take it or leave it out
fn target(source: &Source) -> Result<(u32, bool), String> {
    if source.kind == "window" {
        let hwnd = source.id.split(':').nth(1).and_then(|h| h.parse::<usize>().ok()).ok_or("no window handle in the source id")?;
        let mut pid = 0u32;
        // SAFETY: the handle value is only looked up; `pid` is a valid out pointer
        unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut c_void), Some(&mut pid)) };
        if pid == 0 {
            return Err("the window has no process".into());
        }
        Ok((pid, true))
    } else {
        let pid = if source.exclude_pid != 0 { source.exclude_pid } else { parent_pid().ok_or("can't tell which process to leave out")? };
        Ok((pid, false))
    }
}

// The audio client for a process tree. Activation is asynchronous: ask, then wait for the callback.
fn activate(pid: u32, include: bool) -> Result<IAudioClient, String> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: if include { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE } else { PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE },
            },
        },
    };
    // The parameters travel as a blob inside a PROPVARIANT. The blob points at our stack, so the variant must
    // never be cleared (that would free it): ManuallyDrop keeps it from being.
    let mut pv = PROPVARIANT::default();
    pv.Anonymous.Anonymous = ManuallyDrop::new(PROPVARIANT_0_0 {
        vt: VT_BLOB,
        wReserved1: 0,
        wReserved2: 0,
        wReserved3: 0,
        Anonymous: PROPVARIANT_0_0_0 { blob: BLOB { cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 } },
    });
    let pv = ManuallyDrop::new(pv);
    let (tx, rx) = channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Ready(Mutex::new(tx)).into();
    // SAFETY: `params` and `pv` outlive the call (Windows copies the blob before returning), and the riid is
    // IAudioClient's
    let op = unsafe { ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*pv as *const PROPVARIANT), &handler) }
        .map_err(|e| format!("can't ask for process loopback: {e}"))?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Windows didn't answer the audio activation".to_string())?;
    let mut hr = HRESULT(0);
    let mut unknown = None;
    // SAFETY: valid out pointers, called after the completion callback ran
    unsafe { op.GetActivateResult(&mut hr, &mut unknown) }.map_err(|e| format!("no activation result: {e}"))?;
    hr.ok().map_err(|e| format!("process loopback isn't available (needs Windows 10 2004 or later): {e}"))?;
    unknown.ok_or("no audio client")?.cast::<IAudioClient>().map_err(|e| e.to_string())
}

struct Event(HANDLE);
impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: the handle was created by CreateEventW and is closed only here
        let _ = unsafe { CloseHandle(self.0) };
    }
}

// Captures until `stop`, handing interleaved stereo float chunks to the sinks
fn run(source: &Source, sinks: &Sinks, stop: &AtomicBool) -> Result<(), String> {
    let (pid, include) = target(source)?;
    let client = activate(pid, include)?;
    // Process loopback has no mix format to ask for: the format is ours to name, and Windows converts to it
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: 2,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * 4,
        nBlockAlign: 4,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    // SAFETY: `format` is a valid PCM description that lives through the call
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                200_000, // 20 ms, in 100 ns units
                0,
                &format,
                None,
            )
            .map_err(|e| format!("can't set up the audio stream: {e}"))?;
    }
    // SAFETY: plain object creation and calls on the client made above
    let (event, capture) = unsafe {
        let event = Event(CreateEventW(None, false, false, None).map_err(|e| e.to_string())?);
        client.SetEventHandle(event.0).map_err(|e| format!("can't wait on the audio stream: {e}"))?;
        let capture = client.GetService::<IAudioCaptureClient>().map_err(|e| e.to_string())?;
        client.Start().map_err(|e| format!("can't start the audio stream: {e}"))?;
        (event, capture)
    };
    log!("share audio started ({} pid {pid})", if include { "only" } else { "all but" });
    while !stop.load(Ordering::Relaxed) {
        // Wakes when a packet is ready; the timeout is how the stop flag gets noticed
        // SAFETY: the event handle is alive until `event` drops
        if unsafe { WaitForSingleObject(event.0, 100) } != WAIT_OBJECT_0 {
            continue;
        }
        // SAFETY: the buffer GetBuffer returns holds `frames` frames of 16-bit stereo until ReleaseBuffer
        unsafe {
            while capture.GetNextPacketSize().map_err(|e| e.to_string())? > 0 {
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut::<u8>(), 0u32, 0u32);
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None).map_err(|e| e.to_string())?;
                let n = frames as usize * 2;
                let pcm = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                    vec![0.0f32; n]
                } else {
                    // The buffer is only 2-byte aligned in general, so read it as bytes
                    std::slice::from_raw_parts(data, n * 2).chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect()
                };
                capture.ReleaseBuffer(frames).map_err(|e| e.to_string())?;
                if n > 0 {
                    (sinks.audio)(pcm);
                }
            }
        }
    }
    // SAFETY: the client was started above
    let _ = unsafe { client.Stop() };
    Ok(())
}

// Starts capturing on its own thread, until `stop` is set. Never fails the caller.
pub fn start(source: &Source, sinks: Arc<Sinks>, stop: Arc<AtomicBool>) {
    let source = source.clone();
    let res = std::thread::Builder::new().name("share-audio".into()).spawn(move || {
        // SAFETY: balanced with CoUninitialize below. A failure (the thread already has another model) is
        // survivable: COM calls below then report their own errors.
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        if let Err(e) = run(&source, &sinks, &stop) {
            log!("share audio: {e}; continuing without it");
        } else {
            log!("share audio stopped");
        }
        if com {
            // SAFETY: CoInitializeEx succeeded on this thread
            unsafe { CoUninitialize() };
        }
    });
    if let Err(e) = res {
        log!("share audio: can't start its thread: {e}");
    }
}
