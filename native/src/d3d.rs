// Direct3D 11 on Windows: captured frames that stay on the GPU (D56).
//
// Windows Graphics Capture hands out a texture. Reading it back, converting it
// on the CPU and handing the result to a hardware encoder moves every frame
// off the GPU and back onto it. Instead:
//
//   capture: copy the frame into a texture of ours (Texture, pooled)
//   layer:   scale and convert it to NV12 with the GPU's video processor
//            (Converter), then either give that texture to the encoder as it
//            is, or read the small NV12 picture back for an encoder that wants
//            memory (Reader)
//
// Everything runs on the capture's device. Its immediate context is shared by
// the capture thread and every layer thread, so the device is switched to
// multithread protection once (Device::new).
use std::mem::ManuallyDrop;
use std::sync::{Arc, Mutex, OnceLock};

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoContext1, ID3D11VideoDevice, ID3D11VideoProcessor, ID3D11VideoProcessorEnumerator,
    ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
    D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_COLOR_SPACE,
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT, D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0, D3D11_VIDEO_PROCESSOR_STREAM, D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
    D3D11_VPIV_DIMENSION_TEXTURE2D, D3D11_VPOV_DIMENSION_TEXTURE2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709, DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;

const POOL: usize = 4; // captured textures kept for reuse: the slot, the engine's last frame, one per busy layer
const RING: usize = 4; // NV12 textures a converter cycles through, so one the encoder still reads isn't written

fn err(what: &'static str) -> impl Fn(windows::core::Error) -> String {
    move |e| format!("{what}: {e}")
}

fn texture(dev: &ID3D11Device, desc: &D3D11_TEXTURE2D_DESC, what: &'static str) -> Result<ID3D11Texture2D, String> {
    let mut tex = None;
    // SAFETY: a complete description, no initial data, and an out pointer that lives through the call
    unsafe { dev.CreateTexture2D(desc, None, Some(&mut tex)) }.map_err(err(what))?;
    tex.ok_or_else(|| format!("{what}: no texture"))
}

fn desc_of(tex: &ID3D11Texture2D) -> D3D11_TEXTURE2D_DESC {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: fills the struct
    unsafe { tex.GetDesc(&mut desc) };
    desc
}

// The capture's device, shared by the capture thread and the layers
pub struct Device {
    pub dev: ID3D11Device,
    ctx: ID3D11DeviceContext,
    pub vendor: u32, // PCI vendor of the adapter, to pair it with an encoder on the same GPU
    pool: Mutex<Vec<ID3D11Texture2D>>,
}

// SAFETY: Direct3D 11 devices are free-threaded, and the immediate context is too once the device is
// multithread protected, which new() does before the device is shared
unsafe impl Send for Device {}
unsafe impl Sync for Device {}

impl Device {
    pub fn new(dev: &ID3D11Device, ctx: &ID3D11DeviceContext) -> Result<Arc<Self>, String> {
        // SAFETY: interface queries and getters on a live device
        unsafe {
            let mt: ID3D11Multithread = dev.cast().map_err(err("no multithread protection"))?;
            let _ = mt.SetMultithreadProtected(true);
            let vendor = dev.cast::<IDXGIDevice>().and_then(|d| d.GetAdapter()).and_then(|a| a.GetDesc()).map(|d| d.VendorId).unwrap_or(0);
            Ok(Arc::new(Self { dev: dev.clone(), ctx: ctx.clone(), vendor, pool: Mutex::new(Vec::new()) }))
        }
    }

    // A copy of `src` (a frame the capture is about to take back) that is ours to keep
    pub fn keep(self: &Arc<Self>, src: &ID3D11Texture2D) -> Result<Texture, String> {
        let from = desc_of(src);
        let want = D3D11_TEXTURE2D_DESC {
            Width: from.Width,
            Height: from.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: from.Format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            // What the video processor asks of its input
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let pooled = {
            let mut pool = self.pool.lock().unwrap();
            // A resized window leaves textures of the old size behind
            pool.retain(|t| desc_of(t) == want);
            pool.pop()
        };
        let tex = match pooled {
            Some(t) => t,
            None => texture(&self.dev, &want, "no texture for the frame")?,
        };
        // SAFETY: two live textures of the same size and format on this device. The flush sends the copy to
        // the GPU now, before the capture reuses `src` for its next frame.
        unsafe {
            self.ctx.CopyResource(&tex, src);
            self.ctx.Flush();
        }
        Ok(Texture { tex: ManuallyDrop::new(tex), dev: self.clone(), w: from.Width as usize, h: from.Height as usize, format: from.Format })
    }
}

// A captured frame on the GPU. It goes back to the device's pool when the last holder lets go.
pub struct Texture {
    tex: ManuallyDrop<ID3D11Texture2D>,
    pub dev: Arc<Device>,
    pub w: usize,
    pub h: usize,
    format: DXGI_FORMAT,
}

// SAFETY: a texture is a free-threaded object of a device that is (see Device); nothing writes to it after keep()
unsafe impl Send for Texture {}
unsafe impl Sync for Texture {}

impl Drop for Texture {
    fn drop(&mut self) {
        // SAFETY: the field isn't used again
        let tex = unsafe { ManuallyDrop::take(&mut self.tex) };
        let mut pool = self.dev.pool.lock().unwrap();
        if pool.len() < POOL {
            pool.push(tex);
        }
    }
}

// One pass of the video processor: a picture of one size in, one of another size (and maybe format) out
struct Stage {
    en: ID3D11VideoProcessorEnumerator,
    vp: ID3D11VideoProcessor,
    outs: Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
    next: usize,
}

// Scales a captured texture to a layer's size and converts it to NV12 (BT.709, video range), on the GPU.
//
// The video processor samples its input bilinearly, which is clean down to half the size and aliases below
// that (measured on NVIDIA's: text at a quarter of the screen's size came out broken, where the CPU's
// scaler, which averages, keeps it readable). So a picture is halved in passes of its own until the last
// pass has no more than a factor of two left to go, and that pass also converts.
pub struct Converter {
    dev: Arc<Device>,
    vd: ID3D11VideoDevice,
    vc: ID3D11VideoContext,
    src: (usize, usize),
    dst: (usize, usize),
    stages: Vec<Stage>,
    // Inputs of the first stage, by the captured texture's address; there are at most POOL of them
    views: Vec<(usize, ID3D11VideoProcessorInputView)>,
    // Inputs of the later stages: the texture the stage before writes
    links: Vec<ID3D11VideoProcessorInputView>,
}

// SAFETY: used by one layer thread; its objects belong to the multithread-protected device
unsafe impl Send for Converter {}

const INPUT_VIEW: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC =
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC { FourCC: 0, ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D, Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } } };

impl Converter {
    pub fn new(from: &Texture, w: usize, h: usize) -> Result<Self, String> {
        let dev = from.dev.clone();
        let vd: ID3D11VideoDevice = dev.dev.cast().map_err(err("no video device"))?;
        let vc: ID3D11VideoContext = dev.ctx.cast().map_err(err("no video context"))?;
        let mut me = Self { dev, vd, vc, src: (from.w, from.h), dst: (w, h), stages: Vec::new(), views: Vec::new(), links: Vec::new() };
        let (mut cw, mut ch) = (from.w, from.h);
        while cw > w * 2 || ch > h * 2 {
            let (nw, nh) = ((cw / 2).max(w), (ch / 2).max(h));
            me.stage((cw, ch), (nw, nh), from.format, from.format, 1)?;
            (cw, ch) = (nw, nh);
        }
        me.stage((cw, ch), (w, h), from.format, DXGI_FORMAT_NV12, RING)?;
        Ok(me)
    }

    // Adds a pass from one size to another, with `n` textures to write to in turn
    fn stage(&mut self, from: (usize, usize), to: (usize, usize), takes: DXGI_FORMAT, gives: DXGI_FORMAT, n: usize) -> Result<(), String> {
        let rate = DXGI_RATIONAL { Numerator: 60, Denominator: 1 };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: from.0 as u32,
            InputHeight: from.1 as u32,
            OutputFrameRate: rate,
            OutputWidth: to.0 as u32,
            OutputHeight: to.1 as u32,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_QUALITY,
        };
        let yuv = gives == DXGI_FORMAT_NV12;
        // SAFETY: creation calls with complete descriptions, and settings on the processor just created
        unsafe {
            let en = self.vd.CreateVideoProcessorEnumerator(&content).map_err(err("no video processor for this size"))?;
            let can_take = en.CheckVideoProcessorFormat(takes).map_err(err("video processor formats"))?;
            let can_give = en.CheckVideoProcessorFormat(gives).map_err(err("video processor formats"))?;
            if can_take & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32 == 0 || can_give & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 == 0 {
                return Err("the video processor doesn't scale and convert the screen's format".into());
            }
            let vp = self.vd.CreateVideoProcessor(&en, 0).map_err(err("no video processor"))?;
            self.vc.VideoProcessorSetStreamFrameFormat(&vp, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            // No "enhancements" from the driver's control panel (denoising, sharpening): the screen as it is
            self.vc.VideoProcessorSetStreamAutoProcessingMode(&vp, 0, false);
            // sRGB in; out the same, or BT.709 video range: what frame.rs makes on the CPU and what viewers take
            // an HD stream to be
            if let Ok(vc1) = self.vc.cast::<ID3D11VideoContext1>() {
                vc1.VideoProcessorSetStreamColorSpace1(&vp, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
                vc1.VideoProcessorSetOutputColorSpace1(&vp, if yuv { DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709 } else { DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 });
            } else {
                // Windows 8's way of saying the same. Bits: RGB_Range (1) 0 = full; YCbCr_Matrix (2) 1 = BT.709;
                // Nominal_Range (4-5) 1 = 16-235, 2 = 0-255.
                self.vc.VideoProcessorSetStreamColorSpace(&vp, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 });
                self.vc.VideoProcessorSetOutputColorSpace(&vp, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: if yuv { 1 << 2 | 1 << 4 } else { 0 } });
            }
            // What the stage before wrote is this one's input
            if let Some((tex, _)) = self.stages.last().and_then(|s| s.outs.first()) {
                let mut v = None;
                self.vd.CreateVideoProcessorInputView(tex, &en, &INPUT_VIEW, Some(&mut v)).map_err(err("no video processor input"))?;
                self.links.push(v.ok_or("no video processor input")?);
            }
            let desc = D3D11_TEXTURE2D_DESC {
                Width: to.0 as u32,
                Height: to.1 as u32,
                MipLevels: 1,
                ArraySize: 1,
                Format: gives,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: if yuv { D3D11_BIND_RENDER_TARGET.0 } else { D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0 } as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let view = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC { ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D, Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } } };
            let mut outs = Vec::new();
            for _ in 0..n {
                let tex = texture(&self.dev.dev, &desc, "no texture for the scaled frame")?;
                let mut out = None;
                self.vd.CreateVideoProcessorOutputView(&tex, &en, &view, Some(&mut out)).map_err(err("no video processor output"))?;
                outs.push((tex, out.ok_or("no video processor output")?));
            }
            self.stages.push(Stage { en, vp, outs, next: 0 });
            Ok(())
        }
    }

    pub fn fits(&self, from: &Texture, w: usize, h: usize) -> bool {
        Arc::ptr_eq(&self.dev, &from.dev) && self.src == (from.w, from.h) && self.dst == (w, h)
    }

    pub fn device(&self) -> &Arc<Device> {
        &self.dev
    }

    // The frame as NV12 at this converter's size. The texture is good until RING more frames were converted.
    pub fn convert(&mut self, from: &Texture) -> Result<&ID3D11Texture2D, String> {
        let key = from.tex.as_raw() as usize;
        let first = match self.views.iter().find(|(k, _)| *k == key) {
            Some((_, v)) => v.clone(),
            None => {
                let mut v = None;
                // SAFETY: a live texture of the size and format the first stage was made for
                unsafe { self.vd.CreateVideoProcessorInputView(&*from.tex, &self.stages[0].en, &INPUT_VIEW, Some(&mut v)) }.map_err(err("no video processor input"))?;
                let v = v.ok_or("no video processor input")?;
                // A view keeps its texture alive, so the cache stays as small as the pool it mirrors
                if self.views.len() >= POOL * 2 {
                    self.views.clear();
                }
                self.views.push((key, v.clone()));
                v
            }
        };
        for i in 0..self.stages.len() {
            let input = if i == 0 { first.clone() } else { self.links[i - 1].clone() };
            let stage = &mut self.stages[i];
            stage.next = (stage.next + 1) % stage.outs.len();
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                OutputIndex: 0,
                InputFrameOrField: 0,
                PastFrames: 0,
                FutureFrames: 0,
                ppPastSurfaces: std::ptr::null_mut(),
                pInputSurface: ManuallyDrop::new(Some(input)),
                ppFutureSurfaces: std::ptr::null_mut(),
                ppPastSurfacesRight: std::ptr::null_mut(),
                pInputSurfaceRight: ManuallyDrop::new(None),
                ppFutureSurfacesRight: std::ptr::null_mut(),
            };
            // SAFETY: one enabled stream with a live input view; the view is released again right after
            let res = unsafe {
                let res = self.vc.VideoProcessorBlt(&stage.vp, &stage.outs[stage.next].1, 0, std::slice::from_ref(&stream));
                ManuallyDrop::drop(&mut stream.pInputSurface);
                res
            };
            res.map_err(err("video processor"))?;
        }
        let last = self.stages.last().unwrap();
        Ok(&last.outs[last.next].0)
    }
}

// Reads a texture back into memory through a staging texture it keeps
#[derive(Default)]
pub struct Reader {
    staging: Option<(ID3D11Texture2D, D3D11_TEXTURE2D_DESC)>,
}

// SAFETY: used by one layer thread; the texture belongs to the multithread-protected device
unsafe impl Send for Reader {}

impl Reader {
    // Calls `f` with the mapped bytes and their row pitch. For NV12 the chroma rows follow the luma rows.
    fn read<R>(&mut self, dev: &Device, tex: &ID3D11Texture2D, f: impl FnOnce(&[u8], usize) -> Result<R, String>) -> Result<R, String> {
        let from = desc_of(tex);
        let want = D3D11_TEXTURE2D_DESC { Usage: D3D11_USAGE_STAGING, BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0, ..from };
        if self.staging.as_ref().map_or(true, |(_, d)| *d != want) {
            self.staging = Some((texture(&dev.dev, &want, "no texture to read the frame back")?, want));
        }
        let (staging, _) = self.staging.as_ref().unwrap();
        let nv12 = from.Format == DXGI_FORMAT_NV12;
        let (rows, row) = if nv12 { (from.Height as usize * 3 / 2, from.Width as usize) } else { (from.Height as usize, from.Width as usize * 4) };
        // SAFETY: the staging texture has the size and format of `tex`. Map waits for the copy; the mapped
        // memory holds `rows` rows of RowPitch bytes (the last needs only its own pixels) until Unmap.
        unsafe {
            dev.ctx.CopyResource(staging, tex);
            let mut map = D3D11_MAPPED_SUBRESOURCE::default();
            dev.ctx.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut map)).map_err(err("can't read the frame back"))?;
            let pitch = map.RowPitch as usize;
            let res = if map.pData.is_null() || pitch < row || rows == 0 {
                Err("can't read the frame back".to_string())
            } else {
                f(std::slice::from_raw_parts(map.pData as *const u8, pitch * (rows - 1) + row), pitch)
            };
            dev.ctx.Unmap(staging, 0);
            res
        }
    }

    // A captured frame's pixels as they are (BGRA)
    pub fn bgra<R>(&mut self, from: &Texture, f: impl FnOnce(&[u8], usize) -> Result<R, String>) -> Result<R, String> {
        if from.format != DXGI_FORMAT_B8G8R8A8_UNORM {
            return Err("the captured frame isn't BGRA".into());
        }
        self.read(&from.dev, &from.tex, f)
    }

    // A converter's NV12 picture, packed into `y` and `uv`
    pub fn nv12(&mut self, dev: &Device, tex: &ID3D11Texture2D, w: usize, h: usize, y: &mut [u8], uv: &mut [u8]) -> Result<(), String> {
        self.read(dev, tex, |data, pitch| {
            for (r, row) in y.chunks_exact_mut(w).take(h).enumerate() {
                row.copy_from_slice(&data[r * pitch..r * pitch + w]);
            }
            for (r, row) in uv.chunks_exact_mut(w).take(h / 2).enumerate() {
                row.copy_from_slice(&data[(h + r) * pitch..(h + r) * pitch + w]);
            }
            Ok(())
        })
    }
}

// How far a screen's frames stay on the GPU. FRIENDSPEAK_MEDIA_FRAMES steps down from the default, for
// telling a driver's fault from ours.
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Direct,   // converted on the GPU and given to the encoder as textures
    Readback, // converted on the GPU, read back for the encoder ("readback")
    Cpu,      // read back as captured, converted on the CPU ("cpu")
}

pub fn mode() -> Mode {
    static MODE: OnceLock<Mode> = OnceLock::new();
    *MODE.get_or_init(|| match std::env::var("FRIENDSPEAK_MEDIA_FRAMES").as_deref() {
        Ok("cpu") => Mode::Cpu,
        Ok("readback") => Mode::Readback,
        _ => Mode::Direct,
    })
}
