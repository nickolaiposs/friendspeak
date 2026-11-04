// The encoded-frame transforms of shared media (D70): every frame a share sends through the SFU is encrypted
// here, and every frame received from it decrypted (e2ee.js does the work).
//
// The page owns the keys and posts them here; nothing here is ever sent anywhere else.
//   { t: 'key', sender, index, raw }   a key (raw: 16 bytes) for frames from `sender` ('self': what we send)
//   { t: 'use', index }                 our frames are encrypted with this key from now on
//   { t: 'forget', sender, keep }       drop a sender's keys, all but the indexes in `keep`
// A transform is made with { role: 'send' | 'recv', sender, codec, kind }; `codec` is the fallback when a frame
// doesn't say its own, `kind` the stream's (screen, camera, shareAudio). Each send transform has IVs of its own
// (a Sealer), and each sender a replay window (Replay). Back to the page: { t: 'fail', sender } now and then while
// frames can't be decrypted.
import { Replay, Sealer, decryptFrame, encryptFrame, importMediaKey } from './e2ee.js';

const keys = new Map(); // sender -> Map(index -> CryptoKey)
const replays = new Map(); // sender -> Replay
let sendIndex = 0;
const failed = new Map(); // sender -> when we last told the page

const keysOf = (sender) => keys.get(sender) || keys.set(sender, new Map()).get(sender);
const replayOf = (sender) => replays.get(sender) || replays.set(sender, new Replay()).get(sender);

self.onmessage = async ({ data: m }) => {
  if (m?.t === 'key' && m.index >= 1 && m.index <= 255 && m.raw?.length === 16) {
    const key = await importMediaKey(m.raw);
    keysOf(String(m.sender)).set(m.index, key);
    // A key index used again (they wrap at 255) is another key: what was seen under the old one says nothing
    replays.get(String(m.sender))?.forget([...keysOf(String(m.sender)).keys()].filter((i) => i !== m.index));
  } else if (m?.t === 'use') sendIndex = m.index;
  else if (m?.t === 'forget') {
    const sender = String(m.sender);
    const have = keys.get(sender);
    if (!have) return;
    for (const i of [...have.keys()]) if (!m.keep?.includes(i)) have.delete(i);
    replays.get(sender)?.forget([...have.keys()]);
    if (!have.size) (keys.delete(sender), replays.delete(sender));
  }
};

const codecOf = (frame, fallback) => {
  const mime = frame.getMetadata?.().mimeType;
  const name = typeof mime === 'string' ? mime.split('/')[1] : fallback;
  return /^opus$/i.test(name || '') ? 'opus' : name ? name.toUpperCase() : fallback;
};

self.onrtctransform = ({ transformer }) => {
  const { role, sender, codec, kind } = transformer.options || {};
  const send = role === 'send';
  const from = send ? 'self' : String(sender);
  const sealer = send ? new Sealer() : null;
  transformer.readable
    .pipeThrough(
      new TransformStream({
        async transform(frame, out) {
          const c = codecOf(frame, codec);
          const data = new Uint8Array(frame.data);
          if (send) {
            const key = keys.get('self')?.get(sendIndex);
            if (!key) return; // no key yet: nothing leaves unencrypted
            const sealed = await encryptFrame(c, kind, data, key, sendIndex, sealer);
            if (!sealed) return; // nothing in it to send (no slice)
            frame.data = sealed.buffer;
            return out.enqueue(frame);
          }
          const plain = await decryptFrame(c, kind, data, keys.get(from) || new Map(), replayOf(from));
          if (!plain) {
            const now = Date.now();
            if (now - (failed.get(from) || 0) > 2000) (failed.set(from, now), self.postMessage({ t: 'fail', sender: from }));
            return;
          }
          frame.data = plain.buffer;
          out.enqueue(frame);
        },
      })
    )
    .pipeTo(transformer.writable)
    .catch(() => {}); // the sender or receiver went away
};
