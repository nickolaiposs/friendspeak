// The encoded-frame transforms of shared media (D70), on a worker of their own: every frame a share sends
// through the SFU is encrypted here, and every frame received from it decrypted (e2ee.js does the work).
//
// The page owns the keys and posts them here; nothing here is ever sent anywhere else.
//   { t: 'key', sender, index, raw }   a key (raw: 16 bytes) for frames from `sender` ('self': what we send)
//   { t: 'use', index }                 our frames are encrypted with this key from now on
//   { t: 'forget', sender, keep }       drop a sender's keys, all but the indexes in `keep`
// A transform is made with { role: 'send' | 'recv', sender, codec }; `codec` is the fallback when a frame
// doesn't say its own. Back to the page: { t: 'fail', sender } now and then while frames can't be decrypted.
import { decryptFrame, encryptFrame, importMediaKey } from './e2ee.js';

const keys = new Map(); // sender -> Map(index -> CryptoKey)
let sendIndex = 0;
const failed = new Map(); // sender -> when we last told the page

const keysOf = (sender) => keys.get(sender) || keys.set(sender, new Map()).get(sender);

self.onmessage = async ({ data: m }) => {
  if (m?.t === 'key' && m.index >= 1 && m.index <= 255 && m.raw?.length === 16) keysOf(String(m.sender)).set(m.index, await importMediaKey(m.raw));
  else if (m?.t === 'use') sendIndex = m.index;
  else if (m?.t === 'forget') {
    const have = keys.get(String(m.sender));
    if (!have) return;
    for (const i of [...have.keys()]) if (!m.keep?.includes(i)) have.delete(i);
    if (!have.size) keys.delete(String(m.sender));
  }
};

const codecOf = (frame, fallback) => {
  const mime = frame.getMetadata?.().mimeType;
  const name = typeof mime === 'string' ? mime.split('/')[1] : fallback;
  return /^opus$/i.test(name || '') ? 'opus' : name ? name.toUpperCase() : fallback;
};

self.onrtctransform = ({ transformer }) => {
  const { role, sender, codec } = transformer.options || {};
  const send = role === 'send';
  const from = send ? 'self' : String(sender);
  transformer.readable
    .pipeThrough(
      new TransformStream({
        async transform(frame, out) {
          const c = codecOf(frame, codec);
          const data = new Uint8Array(frame.data);
          if (send) {
            const key = keys.get('self')?.get(sendIndex);
            if (!key) return; // no key yet: nothing leaves unencrypted
            frame.data = (await encryptFrame(c, data, key, sendIndex)).buffer;
            return out.enqueue(frame);
          }
          const plain = await decryptFrame(c, data, keys.get(from) || new Map());
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
