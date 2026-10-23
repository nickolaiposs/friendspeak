// End-to-end encryption of what a share sends through the SFU (D70): the same format as the app's
// public/js/e2ee.js, byte for byte, checked by both against scripts/e2ee-vectors.json.
//
// Video per NAL unit: headers, parameter sets and SEI stay in the clear (the SFU finds keyframes by NAL
// type, and packetizers cut at NAL boundaries); a slice keeps the first CLEAR bytes of its payload in the
// clear (the start of the slice header, which receivers parse) and the rest is AES-128-GCM:
//
//   slice NAL = header ‖ escape( clear(CLEAR) ‖ AES-GCM(rest) ‖ tag(16) ‖ iv(12) ‖ keyIndex(1) )
//   additional data = header ‖ clear(CLEAR)
//
// with the payload handled unescaped (RBSP) and escaped again, so no ciphertext looks like a start code.
// Opus is encrypted whole: AES-GCM(frame) ‖ tag ‖ iv ‖ keyIndex. Key indexes are 1 to 255.
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};

pub const CLEAR: usize = 5;
#[cfg_attr(not(test), allow(dead_code))] // the sidecar only encrypts; decrypting is for the test vectors
const TAG: usize = 16;
const IV: usize = 12;

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

    fn slice(self, unit: &[u8]) -> bool {
        match self {
            Codec::H264 => (1..=5).contains(&(unit[0] & 0x1f)),
            Codec::H265 => ((unit[0] >> 1) & 0x3f) <= 31,
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

    fn seal(&self, plain: &[u8], aad: &[u8], iv: &mut dyn FnMut() -> [u8; IV], out: &mut Vec<u8>) {
        let nonce = iv();
        // Can't fail for a buffer this size (GCM's limit is 64 GB)
        let ct = self.cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad }).expect("AES-GCM");
        out.extend_from_slice(&ct);
        out.extend_from_slice(&nonce);
        out.push(self.index);
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn open(&self, bytes: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        let n = bytes.len();
        if n < TAG + IV + 2 {
            return None;
        }
        let nonce = &bytes[n - 1 - IV..n - 1];
        self.cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: &bytes[..n - 1 - IV], aad }).ok()
    }
}

pub fn random_iv() -> [u8; IV] {
    let mut iv = [0u8; IV];
    getrandom::fill(&mut iv).expect("the OS's random source");
    iv
}

// NAL units of an Annex B buffer: (start of the start code, start of the unit, end)
fn units(data: &[u8]) -> Vec<(usize, usize, usize)> {
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

// `iv` makes the IVs: random_iv, except in the test vectors
pub fn encrypt(codec: Codec, data: &[u8], key: &Key, iv: &mut dyn FnMut() -> [u8; IV]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 64);
    if codec == Codec::Opus {
        key.seal(data, &[], iv, &mut out);
        return out;
    }
    let h = codec.header();
    for (code, at, end) in units(data) {
        out.extend_from_slice(&data[code..at]);
        let unit = &data[at..end];
        let rbsp = if unit.len() > h { unescape(&unit[h..]) } else { Vec::new() };
        if unit.len() <= h || !codec.slice(unit) || rbsp.len() <= CLEAR {
            out.extend_from_slice(unit);
            continue;
        }
        let mut aad = unit[..h].to_vec();
        aad.extend_from_slice(&rbsp[..CLEAR]);
        let mut body = rbsp[..CLEAR].to_vec();
        key.seal(&rbsp[CLEAR..], &aad, iv, &mut body);
        out.extend_from_slice(&unit[..h]);
        escape(&body, &mut out);
    }
    out
}

// None when a slice (or the audio frame) doesn't open with the key it names
#[cfg_attr(not(test), allow(dead_code))]
pub fn decrypt(codec: Codec, data: &[u8], keys: &[Key]) -> Option<Vec<u8>> {
    let find = |b: &[u8]| b.last().and_then(|i| keys.iter().find(|k| k.index == *i));
    if codec == Codec::Opus {
        return find(data)?.open(data, &[]);
    }
    let h = codec.header();
    let mut out = Vec::with_capacity(data.len());
    for (code, at, end) in units(data) {
        out.extend_from_slice(&data[code..at]);
        let unit = &data[at..end];
        let rbsp = if unit.len() > h { unescape(&unit[h..]) } else { Vec::new() };
        if unit.len() <= h || !codec.slice(unit) || rbsp.len() <= CLEAR {
            out.extend_from_slice(unit);
            continue;
        }
        let mut aad = unit[..h].to_vec();
        aad.extend_from_slice(&rbsp[..CLEAR]);
        let plain = find(&rbsp[CLEAR..])?.open(&rbsp[CLEAR..], &aad)?;
        let mut body = rbsp[..CLEAR].to_vec();
        body.extend_from_slice(&plain);
        out.extend_from_slice(&unit[..h]);
        escape(&body, &mut out);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect()
    }

    // The same vectors the JS side checks (scripts/check-e2ee.mjs)
    #[test]
    fn vectors() {
        let all: Value = serde_json::from_str(include_str!("../../scripts/e2ee-vectors.json")).unwrap();
        for v in all["vectors"].as_array().unwrap() {
            let codec = match v["codec"].as_str().unwrap() {
                "H264" => Codec::H264,
                "H265" => Codec::H265,
                _ => Codec::Opus,
            };
            let key = Key::new(v["index"].as_u64().unwrap() as u8, &hex(v["key"].as_str().unwrap())).unwrap();
            let fixed: [u8; IV] = hex(v["iv"].as_str().unwrap()).try_into().unwrap();
            let input = hex(v["input"].as_str().unwrap());
            let output = hex(v["output"].as_str().unwrap());
            let name = v["name"].as_str().unwrap();
            assert_eq!(encrypt(codec, &input, &key, &mut || fixed), output, "{name}: encrypt");
            assert_eq!(decrypt(codec, &output, &[key.clone()]).as_deref(), Some(&input[..]), "{name}: decrypt");
            if output != input {
                let mut bad = output.clone();
                let at = bad.len() - 20;
                bad[at] ^= 1;
                assert!(decrypt(codec, &bad, &[key]).is_none(), "{name}: a changed byte must not decrypt");
            }
        }
    }

    #[test]
    fn no_start_codes_in_ciphertext() {
        let key = Key::new(1, &[7u8; 16]).unwrap();
        // A slice of zeros encrypts to random bytes; escaping must keep any 00 00 0x out
        let mut frame = vec![0, 0, 0, 1, 0x65];
        frame.extend(std::iter::repeat(0x11).take(5000));
        for _ in 0..50 {
            let out = encrypt(Codec::H264, &frame, &key, &mut random_iv);
            assert_eq!(units(&out).len(), 1);
            assert_eq!(decrypt(Codec::H264, &out, &[key.clone()]).unwrap(), frame);
        }
    }
}
