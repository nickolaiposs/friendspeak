// Camera backgrounds (D35): what is behind you is replaced before the camera
// reaches anyone, on your own device. MediaPipe's selfie segmenter (a small
// model, run in WebAssembly with the GPU when there is one) marks which pixels
// are you. Each frame is then redrawn as "you" over a painted background.
//
//   camera track → MediaStreamTrackProcessor → segment → composite on a canvas
//                → MediaStreamTrackGenerator → the track VoiceClient sends
//
// The result is an ordinary video track, so the mesh, DM calls and viewers
// need to know nothing about it. Frames arrive from the track itself, not from
// requestAnimationFrame, so the effect keeps running while the window is hidden.
//
// The library and the model load on first use, from the app's own files.
import { settings } from './store.js';

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
// Mask confidence below EDGE[0] is background, above EDGE[1] is you
const EDGE = [0.35, 0.65];
// Soften the mask's outline (px at 720p), which hides its low resolution
const FEATHER = 3;
// Blur radius (px at 720p) at strength 0 and 1
const BLUR = [3, 28];
// The blurred background is drawn at 1/4 size and scaled up: same look, far cheaper
const BLUR_SCALE = 0.25;

// Everything that can stand in for the room behind you. `paint` fills the
// output canvas wherever the person isn't (the compositor has already set
// 'destination-over'). `p` is the pipeline: { ctx, w, h, scale, scratch }.
// To add a kind (e.g. a picture): add an entry here, its options to
// backgroundOf(), and a choice in the UI (BACKGROUND_CHOICES in main.js).
export const BACKGROUNDS = {
  none: null, // the camera as it is: no pipeline at all
  blur: {
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
  };
}

// Running pipelines read this on every frame, so options (blur strength)
// apply at once. Changing `type` to or from 'none' needs a new capture
// (see restartCamera in main.js).
let current = backgroundOf();
export const setBackground = (bg) => (current = bg);

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

const canvas2d = (w = 1, h = 1, opts) => new OffscreenCanvas(w, h).getContext('2d', opts);

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
      const k = 255 / (EDGE[1] - EDGE[0]);
      for (let i = 0; i < conf.length; i++) px[i * 4 + 3] = (conf[i] - EDGE[0]) * k; // clamped to 0..255
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
