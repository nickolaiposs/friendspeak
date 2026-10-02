// Camera backgrounds (D35): what is behind you is replaced before the camera
// reaches anyone, on your own device. MediaPipe's selfie segmenter (a small
// model, run in WebAssembly with the GPU when there is one) marks which pixels
// are you. Each frame is then redrawn as "you" over a painted background: a
// blur of the room, or a picture (one that comes with the app, or your own).
//
//   camera track → MediaStreamTrackProcessor → segment → composite on a canvas
//                → MediaStreamTrackGenerator → the track VoiceClient sends
//
// The result is an ordinary video track, so the mesh, DM calls and viewers
// need to know nothing about it. Frames arrive from the track itself, not from
// requestAnimationFrame, so the effect keeps running while the window is hidden.
//
// The library and the model load on first use, from the app's own files.
import { settings, backgroundStore } from './store.js';
import { uid } from './util.js';

const WASM = {
  wasmLoaderPath: '/vendor/mediapipe/wasm/vision_wasm_internal.js',
  wasmBinaryPath: '/vendor/mediapipe/wasm/vision_wasm_internal.wasm',
};
const MODEL = '/models/selfie_segmenter.tflite';

// The segmenter and the compositing run on the UI thread for every frame, so
// a camera with a background is captured smaller and slower than a plain one
// (MEDIA.camera in voice.js).
export const CAPTURE = { width: 1280, height: 720, fps: 30 };

// The model works on a small copy of the frame (its own input is 256×256)
const MODEL_WIDTH = 256;
// Mask confidence below edge[0] is background, above edge[1] is you. A picture
// behind you is cut tighter than a blur: a rim of your real room shows against
// a picture, and is invisible against its own blur.
const EDGE = { soft: [0.35, 0.65], tight: [0.5, 0.8] };
// Soften the mask's outline (px at 720p), which hides its low resolution
const FEATHER = 3;
// Blur radius (px at 720p) at strength 0 and 1
const BLUR = [3, 28];
// The blurred background is drawn at 1/4 size and scaled up: same look, far cheaper
const BLUR_SCALE = 0.25;

const canvas2d = (w = 1, h = 1, opts) => new OffscreenCanvas(w, h).getContext('2d', opts);

// Everything that can stand in for the room behind you. `paint` fills the
// output canvas wherever the person isn't (the compositor has already set
// 'destination-over'). `p` is the pipeline: { ctx, w, h, scale, scratch }, and
// `opts` is the background in use (see loadBackground).
// To add a kind: add an entry here, its options to backgroundOf() and
// loadBackground(), and a choice in the UI (backgroundPicker in main.js).
export const BACKGROUNDS = {
  none: null, // the camera as it is: no pipeline at all
  image: {
    edge: EDGE.tight,
    // A picture, scaled to cover the frame
    paint({ ctx, w, h }, _frame, { image }) {
      const s = Math.max(w / image.width, h / image.height);
      const sw = w / s;
      const sh = h / s;
      ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, 0, 0, w, h);
    },
  },
  blur: {
    edge: EDGE.soft,
    paint(p, frame, opts) {
      const { ctx, w, h, scratch } = p;
      const sw = Math.max(1, Math.round(w * BLUR_SCALE));
      const sh = Math.max(1, Math.round(h * BLUR_SCALE));
      if (scratch.canvas.width !== sw || scratch.canvas.height !== sh) Object.assign(scratch.canvas, { width: sw, height: sh });
      const r = (BLUR[0] + (BLUR[1] - BLUR[0]) * opts.blur) * p.scale * BLUR_SCALE;
      // Overdraw past the edges: a blur fades to transparent where it has nothing to sample
      const m = Math.ceil(r * 2);
      scratch.filter = `blur(${r.toFixed(2)}px)`;
      scratch.drawImage(frame, -m, -m, sw + 2 * m, sh + 2 * m);
      scratch.filter = 'none';
      ctx.drawImage(scratch.canvas, 0, 0, w, h);
    },
  },
};

// The chosen background and its options, from settings
export function backgroundOf(st = settings.get()) {
  return {
    type: BACKGROUNDS[st.cameraBackground] ? st.cameraBackground : 'none',
    blur: Math.min(1, Math.max(0, +st.cameraBlur || 0)),
    imageId: String(st.cameraImage || ''),
  };
}

// ---------- pictures ----------

// Pictures that come with the app: gradients drawn here, so no image files ship
export const PRESETS = [
  { id: 'preset:dusk', name: 'Dusk', stops: ['#2b1b4f', '#8b4a8f', '#f0a36b'] },
  { id: 'preset:ocean', name: 'Ocean', stops: ['#0b2545', '#13678a', '#45c4b0'] },
  { id: 'preset:forest', name: 'Forest', stops: ['#10261c', '#2f6b47', '#b5c99a'] },
  { id: 'preset:slate', name: 'Slate', stops: ['#16181d', '#2c313a', '#5a6272'] },
];
// The same gradient for a tile in the picker
export const presetCss = (p) => `linear-gradient(160deg, ${p.stops.join(', ')})`;

function presetBitmap(p) {
  const c = canvas2d(CAPTURE.width, CAPTURE.height);
  const g = c.createLinearGradient(CAPTURE.width * 0.3, 0, CAPTURE.width * 0.7, CAPTURE.height);
  p.stops.forEach((color, i) => g.addColorStop(i / (p.stops.length - 1), color));
  c.fillStyle = g;
  c.fillRect(0, 0, CAPTURE.width, CAPTURE.height);
  return c.canvas.transferToImageBitmap();
}

// Your own pictures live in IndexedDB (store.js), scaled down on the way in:
// they are drawn into every frame, and the camera is 720p.
const PICTURE_MAX = { width: 1920, height: 1080, bytes: 25 * 1024 * 1024 };
export const pictures = {
  all: () => backgroundStore.all(),
  async add(file) {
    if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');
    if (file.size > PICTURE_MAX.bytes) throw new Error('That image is too large (25 MB at most).');
    const src = await createImageBitmap(file).catch(() => {
      throw new Error('That image could not be read.');
    });
    const s = Math.min(1, PICTURE_MAX.width / src.width, PICTURE_MAX.height / src.height);
    const c = canvas2d(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
    c.drawImage(src, 0, 0, c.canvas.width, c.canvas.height);
    src.close();
    const blob = await c.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const pic = { id: uid(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 40), blob, created: Date.now() };
    await backgroundStore.put(pic);
    return pic;
  },
  async remove(id) {
    await backgroundStore.remove(id);
    bitmaps.get(id)?.then((b) => b?.close()).catch(() => {});
    bitmaps.delete(id);
  },
};

// id -> Promise<ImageBitmap | null>, decoded once
const bitmaps = new Map();
function bitmapOf(id) {
  if (!bitmaps.has(id)) {
    const preset = PRESETS.find((p) => p.id === id);
    bitmaps.set(
      id,
      (preset ? Promise.resolve(presetBitmap(preset)) : backgroundStore.get(id).then((pic) => (pic ? createImageBitmap(pic.blob) : null))).catch(() => null)
    );
  }
  return bitmaps.get(id);
}

// The background in settings, ready to paint: backgroundOf() plus what its
// kind needs loaded (`image` for a picture). A picture that is gone is 'none'.
export async function loadBackground(st = settings.get()) {
  const bg = backgroundOf(st);
  if (bg.type !== 'image') return bg;
  const image = bg.imageId ? await bitmapOf(bg.imageId) : null;
  return image ? { ...bg, image } : { ...bg, type: 'none' };
}

// Running pipelines read this on every frame, so a change of strength, of
// picture, or between blur and a picture applies at once. Changing to or from
// 'none' needs a new capture (see setCameraBackground in main.js).
let current = { type: 'none', blur: 0 };
export const setBackground = (bg) => (current = bg);
export const activeBackground = () => current;

export const backgroundsSupported = () => typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function';

// One segmenter for the app's lifetime: creating it compiles ~12 MB of WebAssembly
let segmenterPromise = null;
function segmenter() {
  return (segmenterPromise ||= (async () => {
    const { ImageSegmenter } = await import('/vendor/mediapipe/vision_bundle.mjs');
    const create = (delegate) =>
      ImageSegmenter.createFromOptions(WASM, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    try {
      return await create('GPU');
    } catch (e) {
      console.warn('camera background: no GPU segmenter, using the CPU', e);
      return create('CPU');
    }
  })().catch((e) => {
    segmenterPromise = null; // try again next time
    throw e;
  }));
}

// Returns a stream that shows `raw` (a camera stream) with the current
// background, or `raw` itself when there is none. Stopping the returned
// stream's track stops the camera. Throws if the effect can't start; the
// caller then stops `raw` (see openCamera in main.js).
export async function withBackground(raw) {
  if (!BACKGROUNDS[current.type]) return raw;
  const track = raw.getVideoTracks()[0];
  if (!track) return raw;
  if (!backgroundsSupported()) throw new Error('not supported on this device');
  const seg = await segmenter();
  if (track.readyState !== 'live') throw new Error('the camera stopped');

  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  const out = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = out.writable.getWriter();
  const p = { ctx: canvas2d(), scratch: canvas2d(), w: 0, h: 0, scale: 1 };
  const small = canvas2d(1, 1, { willReadFrequently: true }); // the model's input
  const mask = canvas2d();
  let maskPixels = null;

  const render = (frame) => {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (p.w !== w || p.h !== h) {
      Object.assign(p.ctx.canvas, { width: w, height: h });
      Object.assign(small.canvas, { width: MODEL_WIDTH, height: Math.max(1, Math.round((MODEL_WIDTH * h) / w)) });
      Object.assign(p, { w, h, scale: h / CAPTURE.height });
    }
    const { ctx } = p;
    const bg = BACKGROUNDS[current.type];
    if (!bg) {
      // Switched off while live: pass frames through until the capture is replaced
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(frame, 0, 0, w, h);
      return;
    }
    small.drawImage(frame, 0, 0, small.canvas.width, small.canvas.height);
    // The masks are only valid inside the callback, which runs before segmentForVideo returns
    seg.segmentForVideo(small.canvas, performance.now(), (res) => {
      const m = res.confidenceMasks[0];
      const conf = m.getAsFloat32Array();
      if (!maskPixels || maskPixels.width !== m.width || maskPixels.height !== m.height) {
        Object.assign(mask.canvas, { width: m.width, height: m.height });
        maskPixels = mask.createImageData(m.width, m.height);
      }
      const px = maskPixels.data;
      const [lo, hi] = bg.edge;
      const k = 255 / (hi - lo);
      for (let i = 0; i < conf.length; i++) px[i * 4 + 3] = (conf[i] - lo) * k; // clamped to 0..255
      mask.putImageData(maskPixels, 0, 0);
    });
    // The mask's alpha, then the frame only where the mask is, then the background behind both
    ctx.globalCompositeOperation = 'copy';
    ctx.filter = `blur(${(FEATHER * p.scale).toFixed(2)}px)`;
    ctx.drawImage(mask.canvas, 0, 0, w, h);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(frame, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-over';
    bg.paint(p, frame, current);
  };

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    reader.cancel().catch(() => {});
    track.stop();
    MediaStreamTrack.prototype.stop.call(out);
  };
  // Whoever holds the stream stops its tracks (VoiceClient.stopMedia); that has to release the camera too
  out.stop = stop;
  // Unplugged, or permission revoked: stop() fires no 'ended', so pass it on
  track.addEventListener('ended', () => {
    stop();
    out.dispatchEvent(new Event('ended'));
  });

  let first;
  const started = new Promise((resolve, reject) => (first = { resolve, reject }));
  (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        let next;
        try {
          render(frame);
          next = new VideoFrame(p.ctx.canvas, { timestamp: frame.timestamp, alpha: 'discard' });
        } finally {
          frame.close();
        }
        await writer.write(next);
        next.close();
        first.resolve();
      }
    } catch (e) {
      if (!stopped) console.warn('camera background', e);
      first.reject(e);
    } finally {
      first.reject(new Error('the camera stopped'));
      stop();
    }
  })();

  // Hand the stream over once it shows something, so its size is known (VoiceClient.encodingFor)
  await started;
  return new MediaStream([out]);
}
