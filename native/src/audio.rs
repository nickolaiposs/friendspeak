// A share's audio: Opus, stereo, tuned for music and game sound rather than speech.
use unsafe_libopus::{opus_encode_float, opus_encoder_create, opus_encoder_ctl, opus_encoder_destroy, OpusEncoder, OPUS_APPLICATION_AUDIO, OPUS_SET_BITRATE_REQUEST};

pub const RATE: u32 = 48_000;
pub const FRAME: usize = 960; // 20 ms
const BITRATE: i32 = 160_000;

pub struct Opus {
    enc: *mut OpusEncoder,
    pcm: Vec<f32>, // interleaved stereo waiting for a full frame
    out: Vec<u8>,
}

// SAFETY: the encoder is only used from the engine thread that owns it
unsafe impl Send for Opus {}

impl Opus {
    pub fn new() -> Result<Self, String> {
        let mut err = 0;
        // SAFETY: plain libopus calls
        let enc = unsafe { opus_encoder_create(RATE as i32, 2, OPUS_APPLICATION_AUDIO, &mut err) };
        if enc.is_null() || err != 0 {
            return Err(format!("opus error {err}"));
        }
        unsafe { opus_encoder_ctl!(enc, OPUS_SET_BITRATE_REQUEST, BITRATE) };
        Ok(Self { enc, pcm: Vec::new(), out: vec![0; 4000] })
    }

    // Add samples; `packet` is called for every 20 ms that became complete
    pub fn push(&mut self, pcm: &[f32], mut packet: impl FnMut(&[u8])) {
        self.pcm.extend_from_slice(pcm);
        // Never more than half a second behind: after a stall, the old sound is dropped
        if self.pcm.len() > RATE as usize {
            let keep = self.pcm.len() - FRAME * 2 * 5;
            self.pcm.drain(..keep - keep % 2);
        }
        let mut at = 0;
        while self.pcm.len() - at >= FRAME * 2 {
            // SAFETY: `at` leaves FRAME stereo samples to read, and `out` has room for the largest packet
            let n = unsafe { opus_encode_float(self.enc, self.pcm[at..].as_ptr(), FRAME as i32, self.out.as_mut_ptr(), self.out.len() as i32) };
            at += FRAME * 2;
            if n > 0 {
                packet(&self.out[..n as usize]);
            }
        }
        self.pcm.drain(..at);
    }
}

impl Drop for Opus {
    fn drop(&mut self) {
        // SAFETY: created by opus_encoder_create, destroyed once
        unsafe { opus_encoder_destroy(self.enc) };
    }
}
