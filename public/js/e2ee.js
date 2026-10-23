// End-to-end encryption of shared media (D70). The SFU forwards what it is given and never has the keys,
// so every encoded frame is encrypted by the sharer and decrypted by each viewer.
//
// Video is encrypted per NAL unit, not per frame: the SFU looks at NAL types to find keyframes when it
// moves a viewer between simulcast layers, and the browser's packetizer and depacketizer cut and parse
// at NAL boundaries. So, in an Annex B frame:
//   - every NAL header stays in the clear (1 byte for H.264, 2 for H.265);
//   - parameter sets, SEI and the rest (anything that isn't a slice) stay in the clear;
//   - a slice keeps the first CLEAR bytes of its payload in the clear (the start of the slice header,
//     which the receiver's depacketizer reads: first_mb_in_slice, slice_type, pic_parameter_set_id) and
//     the rest is encrypted with AES-128-GCM;
//   - the encrypted payload is escaped like any NAL payload (0x03 after two zero bytes), so that no
//     ciphertext looks like a start code.
// Payloads are handled unescaped (RBSP): unescape, split, encrypt, append the trailer, escape.
//
//   slice NAL = header ‖ escape( clear(CLEAR) ‖ AES-GCM(rest) ‖ tag(16) ‖ iv(12) ‖ keyIndex(1) )
//   additional data = header ‖ clear(CLEAR)
//
// Audio (Opus) is encrypted whole: AES-GCM(frame) ‖ tag ‖ iv ‖ keyIndex, with no additional data.
// A key index is 1 to 255 (never 0, so an escaped payload never ends in a zero byte). The exact
// format, with test vectors (scripts/e2ee-vectors.json), is in docs/DECISIONS.md → D70; native/src/e2ee.rs
// is the same in Rust and must stay byte for byte the same.
//
// No DOM here: the page, the transform's worker and the Node check (scripts/check-e2ee.mjs) all import it.

export const CLEAR = 5; // slice payload bytes left in the clear
const TAG = 16;
const IV = 12;
export const TRAILER = TAG + IV + 1;

// Which codecs a frame can be: the RTP mime types, without "video/" or "audio/"
export const CODECS = ['H264', 'H265', 'opus'];

// The NAL header's length and whether a NAL unit of this type is a slice
const nal = {
  H264: { header: 1, slice: (b) => (b[0] & 0x1f) >= 1 && (b[0] & 0x1f) <= 5 },
  // H.265: types 0 to 31 are slices (VCL); VPS, SPS, PPS and SEI (32, 33, 34, 39, 40) and the rest are not
  H265: { header: 2, slice: (b) => ((b[0] >> 1) & 0x3f) <= 31 },
};

// Start of each NAL unit in an Annex B buffer: [{ at (first byte after the start code), code (3 or 4), end }]
export function nalUnits(data) {
  const out = [];
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const code = i > 0 && data[i - 1] === 0 ? 4 : 3;
      if (out.length) out[out.length - 1].end = i - (code - 3);
      out.push({ at: i + 3, code, end: data.length });
      i += 3;
    } else i++;
  }
  return out;
}

// Remove emulation prevention bytes (00 00 03 → 00 00)
export function unescapeRbsp(bytes) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  let zeros = 0;
  for (const b of bytes) {
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

// Insert emulation prevention bytes: after two zero bytes, a byte of 0 to 3 gets a 03 in front of it
export function escapeRbsp(bytes) {
  const out = new Uint8Array(bytes.length + Math.ceil(bytes.length / 2) + 1);
  let n = 0;
  let zeros = 0;
  for (const b of bytes) {
    if (zeros >= 2 && b <= 3) {
      out[n++] = 3;
      zeros = 0;
    }
    out[n++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let n = 0;
  for (const p of parts) (out.set(p, n), (n += p.length));
  return out;
};

const randomIv = () => crypto.getRandomValues(new Uint8Array(IV));

// `key` is an AES-GCM CryptoKey (128 bits), `index` its key index (1 to 255). `iv` makes the IVs (tests only:
// a fixed IV is what makes test vectors possible, and must never be used for real media).
export async function encryptFrame(codec, data, key, index, iv = randomIv) {
  if (!(index >= 1 && index <= 255)) throw new Error('key index out of range');
  const seal = async (plain, aad) => {
    const nonce = iv();
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, plain));
    return concat([ct, nonce, Uint8Array.of(index)]);
  };
  if (codec === 'opus') return seal(data, new Uint8Array(0));
  const kind = nal[codec];
  if (!kind) throw new Error('unknown codec ' + codec);
  const units = nalUnits(data);
  // Not Annex B (shouldn't happen): the whole frame is one NAL unit without a start code
  if (!units.length || units[0].at - units[0].code !== 0) units.splice(0, units.length, { at: 0, code: 0, end: data.length });
  const parts = [];
  for (const u of units) {
    parts.push(data.subarray(u.at - u.code, u.at)); // the start code, as it was
    const unit = data.subarray(u.at, u.end);
    const rbsp = unit.length > kind.header ? unescapeRbsp(unit.subarray(kind.header)) : null;
    if (!rbsp || !kind.slice(unit) || rbsp.length <= CLEAR) {
      parts.push(unit);
      continue;
    }
    const header = unit.subarray(0, kind.header);
    const clear = rbsp.subarray(0, CLEAR);
    const sealed = await seal(rbsp.subarray(CLEAR), concat([header, clear]));
    parts.push(header, escapeRbsp(concat([clear, sealed])));
  }
  return concat(parts);
}

// `keys`: Map of key index → CryptoKey. Null when a slice (or the audio frame) doesn't decrypt with the key
// it names: the frame is dropped, never shown as it arrived.
export async function decryptFrame(codec, data, keys) {
  const open = async (bytes, aad) => {
    if (bytes.length < TRAILER + 1) return null;
    const key = keys.get(bytes[bytes.length - 1]);
    if (!key) return null;
    const nonce = bytes.subarray(bytes.length - 1 - IV, bytes.length - 1);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 }, key, bytes.subarray(0, bytes.length - 1 - IV)));
    } catch {
      return null;
    }
  };
  if (codec === 'opus') return open(data, new Uint8Array(0));
  const kind = nal[codec];
  if (!kind) return null;
  const units = nalUnits(data);
  if (!units.length || units[0].at - units[0].code !== 0) units.splice(0, units.length, { at: 0, code: 0, end: data.length });
  const parts = [];
  for (const u of units) {
    parts.push(data.subarray(u.at - u.code, u.at));
    const unit = data.subarray(u.at, u.end);
    const rbsp = unit.length > kind.header ? unescapeRbsp(unit.subarray(kind.header)) : null;
    if (!rbsp || !kind.slice(unit) || rbsp.length <= CLEAR) {
      parts.push(unit);
      continue;
    }
    const header = unit.subarray(0, kind.header);
    const clear = rbsp.subarray(0, CLEAR);
    const plain = await open(rbsp.subarray(CLEAR), concat([header, clear]));
    if (!plain) return null;
    parts.push(header, escapeRbsp(concat([clear, plain])));
  }
  return concat(parts);
}

// A new media key: 16 random bytes, raw
export const newMediaKey = () => crypto.getRandomValues(new Uint8Array(16));
export const importMediaKey = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
