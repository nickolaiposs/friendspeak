// End-to-end encryption of shared media (D70). The SFU forwards what it is given and never has the keys,
// so every encoded frame is encrypted by the sharer and decrypted by each viewer.
//
// Video is encrypted per NAL unit, not per frame: the SFU looks at NAL types to find keyframes when it
// moves a viewer between simulcast layers, and the browser's packetizer and depacketizer cut and parse
// at NAL boundaries. So, in an Annex B frame, the sharer sends:
//   - each slice (H.264 types 1 and 5) with its NAL header and the first CLEAR bytes of its payload in the
//     clear (the start of the slice header, which the receiver's depacketizer reads: first_mb_in_slice,
//     slice_type, pic_parameter_set_id), and the rest encrypted with AES-128-GCM;
//   - the parameter sets (SPS and PPS) in the clear, for the SFU, which finds keyframes by them; a copy of
//     them goes inside the first slice's ciphertext, and that copy is what the receiver gives its decoder;
//   - nothing else: SEI, access unit delimiters and the rest are left out.
// The receiver drops every NAL unit that isn't an authenticated slice, rebuilds the parameter sets from the
// authenticated copy, and drops the whole frame when any slice doesn't open, or none is there: nothing
// the server could have written or changed reaches a decoder (D70, format 2).
//
//   slice NAL = header ‖ escape( clear ‖ AES-GCM(plain) ‖ tag(16) ‖ iv(12) ‖ meta(1) ‖ keyIndex(1) )
//   plain     = [ count(1) ‖ ( length(2) ‖ parameter set NAL )* ]   (when meta has PARAMS)
//               ‖ the rest of the slice payload
//   meta      = clear length (0 to CLEAR, bits 0-2) | PARAMS (bit 3)
//   additional data = FORMAT ‖ kind ‖ meta ‖ header ‖ clear
//
// Payloads are handled unescaped (RBSP): unescape, split, encrypt, append the trailer, escape, so that no
// ciphertext looks like a start code. Audio (Opus) is encrypted whole: AES-GCM(frame) ‖ tag ‖ iv ‖ meta(0) ‖
// keyIndex, with FORMAT ‖ kind ‖ meta as additional data. `kind` is the stream's (screen, camera, shareAudio),
// so a frame of one can't be passed off as another.
//
// The IV is the encryptor's id (8 random bytes, one per Sealer) and its counter (4 bytes): never twice under
// a key. The receiver keeps a window of the counters it has seen per key and encryptor (Replay), so the server
// can't send a frame twice or bring an old one back. A key index is 1 to 255 (never 0, so an escaped payload
// never ends in a zero byte). The format, with test vectors (scripts/e2ee-vectors.json), is in
// docs/DECISIONS.md → D70; native/src/e2ee.rs is the same in Rust and must stay byte for byte the same.
//
// No DOM here: the page, the transform's worker and the Node check (scripts/check-e2ee.mjs) all import it.

export const CLEAR = 5; // slice payload bytes left in the clear
export const FORMAT = 2;
const TAG = 16;
const IV = 12;
const EID = 8; // bytes of the IV that name the encryptor; the other 4 count
export const TRAILER = TAG + IV + 2;
const PARAMS = 0x08; // meta: the plaintext starts with the frame's parameter sets
// What a stream is, in the additional data
export const KINDS = { screen: 1, camera: 2, shareAudio: 3 };

// Which codecs a frame can be: the RTP mime types, without "video/" or "audio/"
export const CODECS = ['H264', 'H265', 'opus'];

// The NAL header's length, a unit's type, and which types are slices and parameter sets
const nal = {
  H264: { header: 1, type: (b) => b[0] & 0x1f, slice: (t) => t === 1 || t === 5, param: (t) => t === 7 || t === 8 },
  // H.265: types 0 to 31 are slices (VCL); VPS, SPS and PPS are 32, 33 and 34
  H265: { header: 2, type: (b) => (b[0] >> 1) & 0x3f, slice: (t) => t <= 31, param: (t) => t >= 32 && t <= 34 },
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

// Each unit's start code (as it was) and bytes. Not Annex B (shouldn't happen): one unit without a start code.
function unitsOf(data) {
  const units = nalUnits(data);
  if (!units.length || units[0].at - units[0].code !== 0) return [{ code: data.subarray(0, 0), unit: data }];
  return units.map((u) => ({ code: data.subarray(u.at - u.code, u.at), unit: data.subarray(u.at, u.end) }));
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

const START = Uint8Array.of(0, 0, 0, 1);
const counterOf = (iv) => new DataView(iv.buffer, iv.byteOffset + EID, 4).getUint32(0);
const encryptorOf = (iv) => Array.from(iv.subarray(0, EID), (b) => b.toString(16).padStart(2, '0')).join('');

// The IVs of one encryptor (a transform, a sidecar layer): its id and a counter. `eid` and `ctr` are for the test
// vectors only; a real one is random and starts at 0. Past 2^32 it takes a new id.
export class Sealer {
  constructor(eid = null, ctr = 0) {
    this.eid = eid || crypto.getRandomValues(new Uint8Array(EID));
    this.ctr = ctr;
  }

  next() {
    if (this.ctr > 0xffffffff) (this.eid = crypto.getRandomValues(new Uint8Array(EID))), (this.ctr = 0);
    const iv = new Uint8Array(IV);
    iv.set(this.eid);
    new DataView(iv.buffer).setUint32(EID, this.ctr++);
    return iv;
  }
}

// What a receiver has seen of one sender: per key index and encryptor, the highest counter and which of the
// SIZE below it came. Older than that, or seen, is refused. Only frames that decrypted are counted, so the server
// can't fill it.
export class Replay {
  static SIZE = 4096;
  static MAX = 32; // windows kept; the oldest goes first

  constructor() {
    this.windows = new Map(); // "<index>|<encryptor>" -> { hi, seen: Uint8Array(SIZE) }
  }

  ok(index, iv) {
    const w = this.windows.get(`${index}|${encryptorOf(iv)}`);
    const c = counterOf(iv);
    if (!w || c > w.hi) return true;
    return w.hi - c < Replay.SIZE && !w.seen[c % Replay.SIZE];
  }

  mark(index, iv) {
    const id = `${index}|${encryptorOf(iv)}`;
    const c = counterOf(iv);
    let w = this.windows.get(id);
    if (!w) {
      if (this.windows.size >= Replay.MAX) this.windows.delete(this.windows.keys().next().value);
      this.windows.set(id, (w = { hi: c, seen: new Uint8Array(Replay.SIZE) }));
    } else if (c > w.hi) {
      if (c - w.hi >= Replay.SIZE) w.seen.fill(0);
      else for (let i = w.hi + 1; i <= c; i++) w.seen[i % Replay.SIZE] = 0;
      w.hi = c;
    }
    w.seen[c % Replay.SIZE] = 1;
  }

  // Keep only the windows of these key indexes
  forget(keep) {
    for (const id of [...this.windows.keys()]) if (!keep.includes(Number(id.split('|')[0]))) this.windows.delete(id);
  }
}

// The parameter sets that travel inside the first slice: count ‖ (length ‖ unit)*
function paramBlock(units) {
  const list = units.filter((u) => u.length <= 0xffff).slice(0, 255);
  const out = [Uint8Array.of(list.length)];
  for (const u of list) out.push(Uint8Array.of(u.length >> 8, u.length & 0xff), u);
  return concat(out);
}

// [units, rest of the plaintext], or null when the block is malformed or holds something that isn't a parameter set
function readParams(plain, c) {
  if (!plain.length) return null;
  const units = [];
  let i = 1;
  for (let n = plain[0]; n > 0; n--) {
    if (i + 2 > plain.length) return null;
    const len = (plain[i] << 8) | plain[i + 1];
    i += 2;
    if (len <= c.header || i + len > plain.length) return null;
    const unit = plain.subarray(i, i + len);
    if (!c.param(c.type(unit))) return null;
    units.push(unit);
    i += len;
  }
  return [units, plain.subarray(i)];
}

// `key` is an AES-GCM CryptoKey (128 bits), `index` its key index (1 to 255), `kind` the stream's (KINDS), `sealer`
// the encryptor's IVs (one per transform or layer, for as long as it runs). Null when there is nothing to send: a
// video frame without a slice.
export async function encryptFrame(codec, kind, data, key, index, sealer) {
  if (!(index >= 1 && index <= 255)) throw new Error('key index out of range');
  const k = KINDS[kind];
  if (!k) throw new Error('unknown stream kind ' + kind);
  const seal = async (plain, meta, aad) => {
    const iv = sealer.next();
    const additionalData = concat([Uint8Array.of(FORMAT, k, meta), aad]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, plain));
    return concat([ct, iv, Uint8Array.of(meta, index)]);
  };
  if (codec === 'opus') return seal(data, 0, new Uint8Array(0));
  const c = nal[codec];
  if (!c) throw new Error('unknown codec ' + codec);
  const units = unitsOf(data).filter((u) => u.unit.length > c.header);
  if (!units.some((u) => c.slice(c.type(u.unit)))) return null;
  const params = units.filter((u) => c.param(c.type(u.unit))).map((u) => u.unit);
  const parts = [];
  let first = true;
  for (const { code, unit } of units) {
    const t = c.type(unit);
    if (c.param(t)) {
      parts.push(code, unit); // in the clear, for the SFU; the receiver uses the copy in the first slice
      continue;
    }
    if (!c.slice(t)) continue; // SEI, AUD and the rest: never sent
    const header = unit.subarray(0, c.header);
    const rbsp = unescapeRbsp(unit.subarray(c.header));
    const clear = rbsp.subarray(0, CLEAR);
    let meta = clear.length;
    let plain = rbsp.subarray(clear.length);
    if (first && params.length) (meta |= PARAMS), (plain = concat([paramBlock(params), plain]));
    first = false;
    const sealed = await seal(plain, meta, concat([header, clear]));
    parts.push(code, header, escapeRbsp(concat([clear, sealed])));
  }
  return concat(parts);
}

// `keys`: Map of key index → CryptoKey. `replay`: the sender's Replay (none: not checked, the test vectors). Null
// when a slice (or the audio frame) doesn't decrypt with the key it names, was seen before, or there is no slice:
// the frame is dropped, never shown as it arrived.
export async function decryptFrame(codec, kind, data, keys, replay = null) {
  const k = KINDS[kind];
  if (!k) return null;
  const opened = []; // [index, iv] of each sealed unit, counted once the whole frame is good
  const open = async (bytes, meta, aad) => {
    const n = bytes.length;
    if (n < TRAILER || bytes[n - 2] !== meta) return null;
    const index = bytes[n - 1];
    const key = keys.get(index);
    if (!key) return null;
    const iv = bytes.slice(n - 2 - IV, n - 2);
    if ((replay && !replay.ok(index, iv)) || opened.some(([i, v]) => i === index && v.every((b, j) => b === iv[j]))) return null;
    try {
      const additionalData = concat([Uint8Array.of(FORMAT, k, meta), aad]);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, bytes.subarray(0, n - 2 - IV)));
      opened.push([index, iv]);
      return plain;
    } catch {
      return null;
    }
  };
  const done = (out) => {
    if (out && replay) for (const [index, iv] of opened) replay.mark(index, iv);
    return out;
  };
  if (codec === 'opus') return done(await open(data, 0, new Uint8Array(0)));
  const c = nal[codec];
  if (!c) return null;
  const parts = [];
  for (const { code, unit } of unitsOf(data)) {
    // Anything that isn't a slice is dropped: parameter sets come from inside the first slice
    if (unit.length <= c.header || !c.slice(c.type(unit))) continue;
    const header = unit.subarray(0, c.header);
    const rbsp = unescapeRbsp(unit.subarray(c.header));
    if (rbsp.length < TRAILER) return null;
    const meta = rbsp[rbsp.length - 2];
    const clearLen = meta & 0x07;
    if (meta & ~(0x07 | PARAMS) || clearLen > CLEAR || rbsp.length < clearLen + TRAILER) return null;
    const clear = rbsp.subarray(0, clearLen);
    let plain = await open(rbsp.subarray(clearLen), meta, concat([header, clear]));
    if (!plain) return null;
    if (meta & PARAMS) {
      const got = readParams(plain, c);
      if (!got) return null;
      for (const p of got[0]) parts.push(START, p);
      plain = got[1];
    }
    parts.push(code, header, escapeRbsp(concat([clear, plain])));
  }
  return done(parts.length ? concat(parts) : null);
}

// A new media key: 16 random bytes, raw
export const newMediaKey = () => crypto.getRandomValues(new Uint8Array(16));
export const importMediaKey = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
