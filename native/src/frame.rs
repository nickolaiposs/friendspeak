// Captured frames, and turning them into what the encoders eat: NV12 at the
// size of a layer. Captures deliver whatever the OS hands out (NV12 from
// ScreenCaptureKit and cameras, a texture from Windows Graphics Capture, BGRA
// from PipeWire one day); every encoder takes NV12.
//
// A Windows screen's frame is a texture on the GPU (d3d.rs, D56). A hardware
// encoder on that GPU takes it without coming here. For the others the GPU
// scales and converts it and only the NV12 picture is read back; with hardware
// acceleration off, the frame is read back as it is and converted here.
use std::time::Instant;

use fast_image_resize as fir;
use yuv::{BufferStoreMut, YuvBiPlanarImageMut, YuvConversionMode, YuvRange, YuvStandardMatrix};

#[cfg(target_os = "windows")]
use crate::d3d;

pub enum Pixels {
    Nv12 { y: Vec<u8>, y_stride: usize, uv: Vec<u8>, uv_stride: usize },
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    Bgra { data: Vec<u8>, stride: usize },
    Rgb { data: Vec<u8> },
    #[cfg(target_os = "windows")]
    D3d11(d3d::Texture),
}

pub struct Frame {
    pub w: usize,
    pub h: usize,
    pub at: Instant,
    pub px: Pixels,
}

// Tightly packed NV12 (stride == width); width and height are even
#[derive(Default)]
pub struct Nv12 {
    pub w: usize,
    pub h: usize,
    pub y: Vec<u8>,
    pub uv: Vec<u8>,
}

impl Nv12 {
    fn size(&mut self, w: usize, h: usize) {
        self.w = w;
        self.h = h;
        self.y.resize(w * h, 0);
        self.uv.resize(w * h / 2, 128);
    }
}

pub const fn even(n: usize) -> usize {
    let n = n & !1;
    if n < 2 {
        2
    } else {
        n
    }
}

// Rows of `stride` bytes with `row` bytes used, packed into `out`
fn pack(src: &[u8], stride: usize, row: usize, rows: usize, out: &mut Vec<u8>) {
    out.clear();
    out.reserve(row * rows);
    for r in 0..rows {
        out.extend_from_slice(&src[r * stride..r * stride + row]);
    }
}

// One per layer: holds the resizer's tables and the scratch buffers
#[derive(Default)]
pub struct Scaler {
    resizer: fir::Resizer,
    a: Vec<u8>,
    b: Vec<u8>,
    #[cfg(target_os = "windows")]
    gpu: bool, // let the GPU scale and convert a frame that is a texture
    #[cfg(target_os = "windows")]
    conv: Option<d3d::Converter>,
    #[cfg(target_os = "windows")]
    reader: d3d::Reader,
}

// Bilinear for speed. Streams are scaled down by small factors, where it holds up.
fn bilinear() -> fir::ResizeOptions {
    fir::ResizeOptions::new().resize_alg(fir::ResizeAlg::Convolution(fir::FilterType::Bilinear))
}

impl Scaler {
    // `hw`: hardware acceleration is on (D46). Off, nothing but the capture itself is left to the GPU.
    pub fn new(hw: bool) -> Self {
        #[cfg(target_os = "windows")]
        return Self { gpu: hw && d3d::mode() != d3d::Mode::Cpu, ..Self::default() };
        #[cfg(not(target_os = "windows"))]
        {
            let _ = hw;
            Self::default()
        }
    }

    // BGRA rows of `stride` bytes, fw×fh, as NV12 of w×h in `out` (already sized)
    fn bgra(&mut self, data: &[u8], stride: usize, fw: usize, fh: usize, w: usize, h: usize, out: &mut Nv12) -> Result<(), String> {
        if fw == w && fh == h {
            return convert(data, stride, true, out);
        }
        // Scale first: fewer pixels to convert
        let src: &[u8] = if stride == fw * 4 {
            data
        } else {
            pack(data, stride, fw * 4, fh, &mut self.a);
            &self.a
        };
        self.b.resize(w * h * 4, 0);
        let e = |e: &dyn std::fmt::Display| e.to_string();
        let src = fir::images::ImageRef::new(fw as u32, fh as u32, src, fir::PixelType::U8x4).map_err(|x| e(&x))?;
        let mut dst = fir::images::Image::from_slice_u8(w as u32, h as u32, &mut self.b, fir::PixelType::U8x4).map_err(|x| e(&x))?;
        self.resizer.resize(&src, &mut dst, &bilinear()).map_err(|x| e(&x))?;
        convert(&self.b, w * 4, true, out)
    }

    // A texture as NV12 of w×h in `out`: scaled and converted where it is, then read back
    #[cfg(target_os = "windows")]
    fn texture(&mut self, tex: &d3d::Texture, w: usize, h: usize, out: &mut Nv12) -> Result<(), String> {
        if !self.conv.as_ref().is_some_and(|c| c.fits(tex, w, h)) {
            self.conv = Some(d3d::Converter::new(tex, w, h)?);
        }
        let conv = self.conv.as_mut().unwrap();
        let dev = conv.device().clone();
        let nv12 = conv.convert(tex)?;
        self.reader.nv12(&dev, nv12, w, h, &mut out.y, &mut out.uv)
    }

    // `frame` as NV12 of w×h (both even) in `out`
    pub fn nv12(&mut self, frame: &Frame, w: usize, h: usize, out: &mut Nv12) -> Result<(), String> {
        out.size(w, h);
        let same = frame.w == w && frame.h == h;
        let opts = bilinear();
        match &frame.px {
            #[cfg(target_os = "windows")]
            Pixels::D3d11(tex) => {
                if self.gpu {
                    match self.texture(tex, w, h, out) {
                        Ok(()) => return Ok(()),
                        Err(e) => {
                            // A GPU without a video processor (a virtual machine's, a remote session's)
                            crate::log!("{w}x{h}: the GPU can't convert the frames ({e}); converting on the CPU");
                            self.gpu = false;
                            self.conv = None;
                        }
                    }
                }
                let mut reader = std::mem::take(&mut self.reader);
                let res = reader.bgra(tex, |data, stride| self.bgra(data, stride, tex.w, tex.h, w, h, out));
                self.reader = reader;
                res
            }
            Pixels::Nv12 { y, y_stride, uv, uv_stride } => {
                let (fw, fh) = (frame.w & !1, frame.h & !1);
                if same {
                    pack(y, *y_stride, w, h, &mut out.y);
                    pack(uv, *uv_stride, w, h / 2, &mut out.uv);
                    return Ok(());
                }
                let (ys, uvs): (&[u8], &[u8]) = if *y_stride == fw && *uv_stride == fw {
                    (y, uv)
                } else {
                    pack(y, *y_stride, fw, fh, &mut self.a);
                    pack(uv, *uv_stride, fw, fh / 2, &mut self.b);
                    (&self.a, &self.b)
                };
                let e = |e: &dyn std::fmt::Display| e.to_string();
                let src = fir::images::ImageRef::new(fw as u32, fh as u32, ys, fir::PixelType::U8).map_err(|x| e(&x))?;
                let mut dst = fir::images::Image::from_slice_u8(w as u32, h as u32, &mut out.y, fir::PixelType::U8).map_err(|x| e(&x))?;
                self.resizer.resize(&src, &mut dst, &opts).map_err(|x| e(&x))?;
                let src = fir::images::ImageRef::new(fw as u32 / 2, fh as u32 / 2, uvs, fir::PixelType::U8x2).map_err(|x| e(&x))?;
                let mut dst = fir::images::Image::from_slice_u8(w as u32 / 2, h as u32 / 2, &mut out.uv, fir::PixelType::U8x2).map_err(|x| e(&x))?;
                self.resizer.resize(&src, &mut dst, &opts).map_err(|x| e(&x))?;
                Ok(())
            }
            Pixels::Bgra { data, stride } => self.bgra(data, *stride, frame.w, frame.h, w, h, out),
            Pixels::Rgb { data } => {
                if same {
                    return convert(data, frame.w * 3, false, out);
                }
                self.b.resize(w * h * 3, 0);
                let e = |e: &dyn std::fmt::Display| e.to_string();
                let src = fir::images::ImageRef::new(frame.w as u32, frame.h as u32, data, fir::PixelType::U8x3).map_err(|x| e(&x))?;
                let mut dst = fir::images::Image::from_slice_u8(w as u32, h as u32, &mut self.b, fir::PixelType::U8x3).map_err(|x| e(&x))?;
                self.resizer.resize(&src, &mut dst, &opts).map_err(|x| e(&x))?;
                convert(&self.b, w * 3, false, out)
            }
        }
    }
}

// BGRA or RGB into `out` (already sized). BT.709, video range: what the SDP-less H.264 default is taken to be for HD.
fn convert(src: &[u8], stride: usize, bgra: bool, out: &mut Nv12) -> Result<(), String> {
    let (w, h) = (out.w as u32, out.h as u32);
    let mut img = YuvBiPlanarImageMut {
        y_plane: BufferStoreMut::Borrowed(&mut out.y),
        y_stride: w,
        uv_plane: BufferStoreMut::Borrowed(&mut out.uv),
        uv_stride: w,
        width: w,
        height: h,
    };
    let r = if bgra {
        yuv::bgra_to_yuv_nv12(&mut img, src, stride as u32, YuvRange::Limited, YuvStandardMatrix::Bt709, YuvConversionMode::Balanced)
    } else {
        yuv::rgb_to_yuv_nv12(&mut img, src, stride as u32, YuvRange::Limited, YuvStandardMatrix::Bt709, YuvConversionMode::Balanced)
    };
    r.map_err(|e| e.to_string())
}
