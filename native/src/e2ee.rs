// End-to-end encryption of what a share sends through the SFU (D70, format 2): the same format as the app's
// public/js/e2ee.js, byte for byte, checked by both against scripts/e2ee-vectors.json.
//
// Video per NAL unit. A slice (H.264 types 1 and 5) keeps its header and the first CLEAR bytes of its payload in
// the clear (the start of the slice header, which receivers parse) and the rest is AES-128-GCM. SPS and PPS go in
// the clear for the SFU (it finds keyframes by them), and a copy of them goes inside the first slice's ciphertext:
// that copy is what a receiver decodes with. Nothing else is sent (SEI, AUD, …).
//
//   slice NAL = header ‖ escape( clear ‖ AES-GCM(plain) ‖ tag(16) ‖ iv(12) ‖ meta(1) ‖ keyIndex(1) )
//   plain     = [ count(1) ‖ ( length(2) ‖ parameter set NAL )* ] (when meta has PARAMS) ‖ the rest of the payload
//   meta      = clear length (bits 0-2) | PARAMS (bit 3)
//   additional data = FORMAT ‖ kind ‖ meta ‖ header ‖ clear
//
// with the payload handled unescaped (RBSP) and escaped again, so no ciphertext looks like a start code.
// Opus is encrypted whole: AES-GCM(frame) ‖ tag ‖ iv ‖ meta(0) ‖ keyIndex, additional data FORMAT ‖ kind ‖ 0.
// The IV is the encryptor's random 8-byte id and a 4-byte counter (Sealer): one per layer and one for the sound,
// so it never repeats under a key. Key indexes are 1 to 255.
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};

pub const CLEAR: usize = 5;
pub const FORMAT: u8 = 2;
#[cfg_attr(not(test), allow(dead_code))] // the sidecar only encrypts; decrypting is for the test vectors
const TAG: usize = 16;
const IV: usize = 12;
const EID: usize = 8;
#[cfg_attr(not(test), allow(dead_code))]
const TRAILER: usize = TAG + IV + 2;
const PARAMS: u8 = 0x08;

// What a stream is, in the additional data (the app's KINDS)
pub const SCREEN: u8 = 1;
pub const CAMERA: u8 = 2;
pub const SHARE_AUDIO: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H264,
    #[allow(dead_code)] // the format is defined for it (D70); the SFU can't forward it yet
    H265,
    Opus,
}

impl Codec {
    fn header(self) -> usize {
        match self {
            Codec::H264 => 1,
            _ => 2,
        }
    }

    fn kind(self, unit: &[u8]) -> u8 {
        match self {
            Codec::H264 => unit[0] & 0x1f,
            _ => (unit[0] >> 1) & 0x3f,
        }
    }

    fn slice(self, unit: &[u8]) -> bool {
        match self {
            Codec::H264 => matches!(self.kind(unit), 1 | 5),
            Codec::H265 => self.kind(unit) <= 31,
            Codec::Opus => false,
        }
    }

    fn param(self, unit: &[u8]) -> bool {
        match self {
            Codec::H264 => matches!(self.kind(unit), 7 | 8),
            Codec::H265 => (32..=34).contains(&self.kind(unit)),
            Codec::Opus => false,
        }
    }
}

// A sender's key: AES-128 and its index
#[derive(Clone)]
pub struct Key {
    pub index: u8,
    cipher: Aes128Gcm,
}

impl Key {
    pub fn new(index: u8, raw: &[u8]) -> Result<Key, String> {
        if index == 0 {
            return Err("key index 0".into());
        }
        let cipher = Aes128Gcm::new_from_slice(raw).map_err(|_| "a media key is 16 bytes".to_string())?;
        Ok(Key { index, cipher })
    }

    // From the app's JSON: 32 hex characters
    pub fn from_hex(index: u8, hex: &str) -> Result<Key, String> {
        if hex.len() != 32 {
            return Err("a media key is 32 hex characters".into());
        }
        let raw: Result<Vec<u8>, _> = (0..16).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)).collect();
        Key::new(index, &raw.map_err(|_| "a media key is hex".to_string())?)
    }

    fn seal(&self, plain: &[u8], kind: u8, meta: u8, aad: &[u8], sealer: &mut Sealer, out: &mut Vec<u8>) {
        let nonce = sealer.next();
        let mut ad = vec![FORMAT, kind, meta];
        ad.extend_from_slice(aad);
        // Can't fail for a buffer this size (GCM's limit is 64 GB)
        let ct = self.cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: &ad }).expect("AES-GCM");
        out.extend_from_slice(&ct);
        out.extend_from_slice(&nonce);
        out.push(meta);
        out.push(self.index);
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn open(&self, bytes: &[u8], kind: u8, meta: u8, aad: &[u8]) -> Option<Vec<u8>> {
        let n = bytes.len();
        if n < TRAILER || bytes[n - 2] != meta {
            return None;
        }
        let nonce = &bytes[n - 2 - IV..n - 2];
        let mut ad = vec![FORMAT, kind, meta];
        ad.extend_from_slice(aad);
        self.cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: &bytes[..n - 2 - IV], aad: &ad }).ok()
    }
}

// The IVs of one encryptor: a random id and a counter. Past 2^32 it takes a new id.
pub struct Sealer {
    eid: [u8; EID],
    ctr: u64,
}

impl Sealer {
    pub fn new() -> Sealer {
        Sealer { eid: random_eid(), ctr: 0 }
    }

    #[cfg(test)]
    fn fixed(eid: [u8; EID], ctr: u64) -> Sealer {
        Sealer { eid, ctr }
    }

    fn next(&mut self) -> [u8; IV] {
        if self.ctr > u32::MAX as u64 {
            (self.eid, self.ctr) = (random_eid(), 0);
        }
        let mut iv = [0u8; IV];
        iv[..EID].copy_from_slice(&self.eid);
        iv[EID..].copy_from_slice(&(self.ctr as u32).to_be_bytes());
        self.ctr += 1;
        iv
    }
}

fn random_eid() -> [u8; EID] {
    let mut eid = [0u8; EID];
    getrandom::fill(&mut eid).expect("the OS's random source");
    eid
}

// NAL units of an Annex B buffer: (start of the start code, start of the unit, end)
pub(crate) fn units(data: &[u8]) -> Vec<(usize, usize, usize)> {
    let mut out: Vec<(usize, usize, usize)> = Vec::new();
    let mut i = 0;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            let code = if i > 0 && data[i - 1] == 0 { 4 } else { 3 };
            if let Some(last) = out.last_mut() {
                last.2 = i + 3 - code;
            }
            out.push((i + 3 - code, i + 3, data.len()));
            i += 3;
        } else {
            i += 1;
        }
    }
    if out.first().map_or(true, |u| u.0 != 0) {
        // Not Annex B: one unit without a start code
        out = vec![(0, 0, data.len())];
    }
    out
}

pub fn unescape(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut zeros = 0;
    for &b in bytes {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    out
}

pub fn escape(bytes: &[u8], out: &mut Vec<u8>) {
    let mut zeros = 0;
    for &b in bytes {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
}

// `kind`: SCREEN, CAMERA or SHARE_AUDIO. `sealer`: this encryptor's, for as long as it runs. None when there is
// nothing to send: a video unit without a slice.
pub fn encrypt(codec: Codec, kind: u8, data: &[u8], key: &Key, sealer: &mut Sealer) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(data.len() + 64);
    if codec == Codec::Opus {
        key.seal(data, kind, 0, &[], sealer, &mut out);
        return Some(out);
    }
    let h = codec.header();
    let all: Vec<_> = units(data).into_iter().filter(|&(_, at, end)| end - at > h).collect();
    if !all.iter().any(|&(_, at, end)| codec.slice(&data[at..end])) {
        return None;
    }
    let params: Vec<&[u8]> = all.iter().map(|&(_, at, end)| &data[at..end]).filter(|u| codec.param(u) && u.len() <= 0xffff).take(255).collect();
    let mut first = true;
    for (code, at, end) in all {
        let unit = &data[at..end];
        if codec.param(unit) {
            // In the clear, for the SFU; receivers use the copy in the first slice
            out.extend_from_slice(&data[code..end]);
            continue;
        }
        if !codec.slice(unit) {
            continue; // SEI, AUD and the rest: never sent
        }
        let rbsp = unescape(&unit[h..]);
        let n = rbsp.len().min(CLEAR);
        let mut meta = n as u8;
        let mut plain = Vec::with_capacity(rbsp.len() + 64);
        if first && !params.is_empty() {
            meta |= PARAMS;
            plain.push(params.len() as u8);
            for p in &params {
                plain.extend_from_slice(&(p.len() as u16).to_be_bytes());
                plain.extend_from_slice(p);
            }
        }
        first = false;
        plain.extend_from_slice(&rbsp[n..]);
        let mut aad = unit[..h].to_vec();
        aad.extend_from_slice(&rbsp[..n]);
        let mut body = rbsp[..n].to_vec();
        key.seal(&plain, kind, meta, &aad, sealer, &mut body);
        out.extend_from_slice(&data[code..at + h]);
        escape(&body, &mut out);
    }
    Some(out)
}

// What a receiver gives its decoder, or None (as the app's decryptFrame, without the replay window): every unit
// that isn't a slice dropped, parameter sets from the first slice's copy
#[cfg_attr(not(test), allow(dead_code))]
pub fn decrypt(codec: Codec, kind: u8, data: &[u8], keys: &[Key]) -> Option<Vec<u8>> {
    let find = |b: &[u8]| b.last().and_then(|i| keys.iter().find(|k| k.index == *i));
    if codec == Codec::Opus {
        return find(data)?.open(data, kind, 0, &[]);
    }
    let h = codec.header();
    let mut out = Vec::with_capacity(data.len());
    for (code, at, end) in units(data) {
        let unit = &data[at..end];
        if unit.len() <= h || !codec.slice(unit) {
            continue;
        }
        let rbsp = unescape(&unit[h..]);
        if rbsp.len() < TRAILER {
            return None;
        }
        let meta = rbsp[rbsp.len() - 2];
        let n = (meta & 0x07) as usize;
        if meta & !(0x07 | PARAMS) != 0 || n > CLEAR || rbsp.len() < n + TRAILER {
            return None;
        }
        let mut aad = unit[..h].to_vec();
        aad.extend_from_slice(&rbsp[..n]);
        let plain = find(&rbsp[n..])?.open(&rbsp[n..], kind, meta, &aad)?;
        let mut rest = &plain[..];
        if meta & PARAMS != 0 {
            let (&count, mut more) = rest.split_first()?;
            for _ in 0..count {
                let len = u16::from_be_bytes([*more.first()?, *more.get(1)?]) as usize;
                let p = more.get(2..2 + len)?;
                if len <= h || !codec.param(p) {
                    return None;
                }
                out.extend_from_slice(&[0, 0, 0, 1]);
                out.extend_from_slice(p);
                more = &more[2 + len..];
            }
            rest = more;
        }
        let mut body = rbsp[..n].to_vec();
        body.extend_from_slice(rest);
        out.extend_from_slice(&data[code..at + h]);
        escape(&body, &mut out);
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect()
    }

    fn kind(name: &str) -> u8 {
        match name {
            "screen" => SCREEN,
            "camera" => CAMERA,
            _ => SHARE_AUDIO,
        }
    }

    // The same vectors the JS side checks (scripts/check-e2ee.mjs)
    #[test]
    fn vectors() {
        let all: Value = serde_json::from_str(include_str!("../../scripts/e2ee-vectors.json")).unwrap();
        assert!(all["format"].as_str().unwrap().contains(&format!("format {FORMAT}")), "vectors of another format");
        for v in all["vectors"].as_array().unwrap() {
            let codec = match v["codec"].as_str().unwrap() {
                "H264" => Codec::H264,
                "H265" => Codec::H265,
                _ => Codec::Opus,
            };
            let k = kind(v["kind"].as_str().unwrap());
            let key = Key::new(v["index"].as_u64().unwrap() as u8, &hex(v["key"].as_str().unwrap())).unwrap();
            let eid: [u8; EID] = hex(v["eid"].as_str().unwrap()).try_into().unwrap();
            let mut sealer = Sealer::fixed(eid, v["ctr"].as_u64().unwrap());
            let input = hex(v["input"].as_str().unwrap());
            let output = hex(v["output"].as_str().unwrap());
            let back = hex(v["decrypted"].as_str().or(v["input"].as_str()).unwrap());
            let name = v["name"].as_str().unwrap();
            assert_eq!(encrypt(codec, k, &input, &key, &mut sealer).as_deref(), Some(&output[..]), "{name}: encrypt");
            assert_eq!(decrypt(codec, k, &output, &[key.clone()]).as_deref(), Some(&back[..]), "{name}: decrypt");
            let mut bad = output.clone();
            let at = bad.len() - 20;
            bad[at] ^= 1;
            assert!(decrypt(codec, k, &bad, &[key.clone()]).is_none(), "{name}: a changed byte must not decrypt");
            let other = if k == SCREEN { CAMERA } else { SCREEN };
            assert!(decrypt(codec, other, &output, &[key]).is_none(), "{name}: not as another kind of stream");
        }
    }

    #[test]
    fn no_start_codes_in_ciphertext() {
        let key = Key::new(1, &[7u8; 16]).unwrap();
        let mut sealer = Sealer::new();
        // A slice of zeros encrypts to random bytes; escaping must keep any 00 00 0x out
        let mut frame = vec![0, 0, 0, 1, 0x65];
        frame.extend(std::iter::repeat(0x11).take(5000));
        for _ in 0..50 {
            let out = encrypt(Codec::H264, CAMERA, &frame, &key, &mut sealer).unwrap();
            assert_eq!(units(&out).len(), 1);
            assert_eq!(decrypt(Codec::H264, CAMERA, &out, &[key.clone()]).unwrap(), frame);
        }
        assert_eq!(sealer.ctr, 50, "one IV per slice");
    }

    #[test]
    fn nothing_without_a_slice() {
        let key = Key::new(1, &[7u8; 16]).unwrap();
        let sps = hex("000000016764001facd9405005bb0110000003001000000303c0f1831960");
        assert!(encrypt(Codec::H264, SCREEN, &sps, &key, &mut Sealer::new()).is_none());
        assert!(decrypt(Codec::H264, SCREEN, &sps, &[key]).is_none());
    }
}
