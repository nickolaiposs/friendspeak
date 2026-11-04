// The SPS made low-delay before it leaves (D70). A receiving WebRTC stack rewrites an incoming SPS whose VUI
// doesn't say "no frame reordering" (libwebrtc's SpsVuiRewriter, incoming direction): without that, a decoder of
// a High profile stream may hold back up to a whole DPB of frames before it shows one. The receiver now decodes
// with the authenticated copy of the SPS that travels inside the first slice (e2ee.rs), not the one its stack
// rewrote, so the rewrite has to be done here, the same way: a VUI with bitstream_restriction,
// max_num_reorder_frames 0 and max_dec_frame_buffering = max_num_ref_frames. An SPS that already says so is left
// as it is, which is also what libwebrtc does with ours.
use crate::e2ee::{escape, unescape, units};

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Bits<'_> {
    fn left(&self) -> usize {
        (self.data.len() * 8).saturating_sub(self.pos)
    }

    fn bit(&mut self) -> Option<u32> {
        let b = (*self.data.get(self.pos / 8)? >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Some(b as u32)
    }

    // n ≤ 32
    fn bits(&mut self, n: usize) -> Option<u32> {
        let mut v: u64 = 0;
        for _ in 0..n {
            v = v << 1 | self.bit()? as u64;
        }
        Some(v as u32)
    }

    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some(((1u64 << zeros) - 1 + self.bits(zeros)? as u64) as u32)
    }
}

#[derive(Default)]
struct Out {
    bytes: Vec<u8>,
    n: usize,
}

impl Out {
    fn put(&mut self, v: u64, n: usize) {
        for i in (0..n).rev() {
            if self.n % 8 == 0 {
                self.bytes.push(0);
            }
            if (v >> i) & 1 == 1 {
                *self.bytes.last_mut().unwrap() |= 1 << (7 - self.n % 8);
            }
            self.n += 1;
        }
    }

    fn ue(&mut self, v: u32) {
        let x = v as u64 + 1;
        let len = 64 - x.leading_zeros() as usize;
        self.put(0, len - 1);
        self.put(x, len);
    }
}

fn copy(r: &mut Bits, w: &mut Out, n: usize) -> Option<u32> {
    let v = r.bits(n)?;
    w.put(v as u64, n);
    Some(v)
}

fn copy_ue(r: &mut Bits, w: &mut Out) -> Option<u32> {
    let v = r.ue()?;
    w.ue(v);
    Some(v)
}

// Through the SPS up to vui_parameters_present_flag (ITU-T H.264 7.3.2.1.1, as libwebrtc's SpsParser):
// max_num_ref_frames, and the reader just before that flag
fn up_to_vui(r: &mut Bits) -> Option<u32> {
    let profile = r.bits(8)?;
    r.bits(16)?; // constraint flags, reserved bits, level_idc
    if r.ue()? > 31 {
        return None; // seq_parameter_set_id
    }
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134) {
        let chroma = r.ue()?;
        if chroma > 3 {
            return None;
        }
        if chroma == 3 {
            r.bit()?; // separate_colour_plane_flag
        }
        r.ue()?; // bit_depth_luma_minus8
        r.ue()?; // bit_depth_chroma_minus8
        r.bit()?; // qpprime_y_zero_transform_bypass_flag
        if r.bit()? == 1 {
            // seq_scaling_matrix_present_flag: skip the lists
            for i in 0..(if chroma == 3 { 12 } else { 8 }) {
                if r.bit()? == 1 {
                    let (mut last, mut next) = (8i32, 8i32);
                    for _ in 0..(if i < 6 { 16 } else { 64 }) {
                        if next != 0 {
                            let u = r.ue()?;
                            let delta = if u % 2 == 1 { u.div_ceil(2) as i32 } else { -((u / 2) as i32) };
                            if !(-128..=127).contains(&delta) {
                                return None;
                            }
                            next = (last + delta + 256) % 256;
                        }
                        if next != 0 {
                            last = next;
                        }
                    }
                }
            }
        }
    }
    if r.ue()? > 12 {
        return None; // log2_max_frame_num_minus4
    }
    match r.ue()? {
        0 => {
            if r.ue()? > 12 {
                return None; // log2_max_pic_order_cnt_lsb_minus4
            }
        }
        1 => {
            r.bit()?; // delta_pic_order_always_zero_flag
            r.ue()?; // offset_for_non_ref_pic (se, the same length)
            r.ue()?; // offset_for_top_to_bottom_field
            let cycle = r.ue()?;
            if cycle > 255 {
                return None;
            }
            for _ in 0..cycle {
                r.ue()?; // offset_for_ref_frame
            }
        }
        2 => {}
        _ => return None,
    }
    let refs = r.ue()?; // max_num_ref_frames
    r.bit()?; // gaps_in_frame_num_value_allowed_flag
    r.ue()?; // pic_width_in_mbs_minus1
    r.ue()?; // pic_height_in_map_units_minus1
    if r.bit()? == 0 {
        r.bit()?; // mb_adaptive_frame_field_flag
    }
    r.bit()?; // direct_8x8_inference_flag
    if r.bit()? == 1 {
        for _ in 0..4 {
            r.ue()?; // frame_crop_*_offset
        }
    }
    Some(refs)
}

fn restriction(w: &mut Out, refs: u32) {
    w.put(1, 1); // motion_vectors_over_pic_boundaries_flag
    w.ue(2); // max_bytes_per_pic_denom
    w.ue(1); // max_bits_per_mb_denom
    w.ue(16); // log2_max_mv_length_horizontal
    w.ue(16); // log2_max_mv_length_vertical
    w.ue(0); // max_num_reorder_frames
    w.ue(refs); // max_dec_frame_buffering
}

fn hrd(r: &mut Bits, w: &mut Out) -> Option<()> {
    let count = copy_ue(r, w)?; // cpb_cnt_minus1
    if count > 31 {
        return None;
    }
    copy(r, w, 8)?; // bit_rate_scale, cpb_size_scale
    for _ in 0..=count {
        copy_ue(r, w)?; // bit_rate_value_minus1
        copy_ue(r, w)?; // cpb_size_value_minus1
        copy(r, w, 1)?; // cbr_flag
    }
    copy(r, w, 20)?; // the four delay lengths
    Some(())
}

// An SPS NAL unit (header included, escaped) with the low-delay VUI, or None when it already has one (or can't
// be parsed: it goes as it is, and the receiver's own stack judges it)
fn sps(unit: &[u8]) -> Option<Vec<u8>> {
    let rbsp = unescape(unit.get(1..)?);
    let mut r = Bits { data: &rbsp, pos: 0 };
    let refs = up_to_vui(&mut r)?;
    let mut w = Out::default();
    let mut head = Bits { data: &rbsp, pos: 0 };
    let mut n = r.pos;
    while n > 0 {
        let k = n.min(32);
        copy(&mut head, &mut w, k)?;
        n -= k;
    }
    let vui = r.bit()?;
    w.put(1, 1);
    let rewritten;
    if vui == 0 {
        w.put(0, 2); // aspect_ratio_info_present_flag, overscan_info_present_flag
        w.put(0, 1); // video_signal_type_present_flag
        w.put(0, 5); // chroma_loc, timing, nal_hrd, vcl_hrd, pic_struct
        w.put(1, 1); // bitstream_restriction_flag
        restriction(&mut w, refs);
        rewritten = true;
    } else {
        if copy(&mut r, &mut w, 1)? == 1 && copy(&mut r, &mut w, 8)? == 255 {
            copy(&mut r, &mut w, 32)?; // sar_width, sar_height
        }
        if copy(&mut r, &mut w, 1)? == 1 {
            copy(&mut r, &mut w, 1)?; // overscan_appropriate_flag
        }
        if copy(&mut r, &mut w, 1)? == 1 {
            copy(&mut r, &mut w, 4)?; // video_format, video_full_range_flag
            if copy(&mut r, &mut w, 1)? == 1 {
                copy(&mut r, &mut w, 24)?; // colour_primaries, transfer_characteristics, matrix_coefficients
            }
        }
        if copy(&mut r, &mut w, 1)? == 1 {
            copy_ue(&mut r, &mut w)?; // chroma_sample_loc_type_top_field
            copy_ue(&mut r, &mut w)?; // chroma_sample_loc_type_bottom_field
        }
        if copy(&mut r, &mut w, 1)? == 1 {
            copy(&mut r, &mut w, 32)?; // num_units_in_tick
            copy(&mut r, &mut w, 32)?; // time_scale
            copy(&mut r, &mut w, 1)?; // fixed_frame_rate_flag
        }
        let nal = copy(&mut r, &mut w, 1)?;
        if nal == 1 {
            hrd(&mut r, &mut w)?;
        }
        let vcl = copy(&mut r, &mut w, 1)?;
        if vcl == 1 {
            hrd(&mut r, &mut w)?;
        }
        if nal == 1 || vcl == 1 {
            copy(&mut r, &mut w, 1)?; // low_delay_hrd_flag
        }
        copy(&mut r, &mut w, 1)?; // pic_struct_present_flag
        let had = r.bit()?;
        w.put(1, 1);
        if had == 0 {
            restriction(&mut w, refs);
            rewritten = true;
        } else {
            copy(&mut r, &mut w, 1)?; // motion_vectors_over_pic_boundaries_flag
            for _ in 0..4 {
                copy_ue(&mut r, &mut w)?; // max_bytes_per_pic_denom, max_bits_per_mb_denom, log2_max_mv_length_*
            }
            let (reorder, buffering) = (r.ue()?, r.ue()?);
            w.ue(0);
            w.ue(refs);
            rewritten = reorder != 0 || buffering > refs;
        }
    }
    if !rewritten {
        return None;
    }
    // The rest as it was (rbsp_trailing_bits), then whole bytes
    while r.left() > 0 {
        let k = r.left().min(32);
        copy(&mut r, &mut w, k)?;
    }
    while w.n % 8 != 0 {
        w.put(0, 1);
    }
    let mut out = vec![unit[0]];
    escape(&w.bytes, &mut out);
    Some(out)
}

// An Annex B access unit with each SPS in it made low-delay, or None when none needed it
pub fn low_delay(data: &[u8]) -> Option<Vec<u8>> {
    let all = units(data);
    let fixed: Vec<Option<Vec<u8>>> = all.iter().map(|&(_, at, end)| if end > at && data[at] & 0x1f == 7 { sps(&data[at..end]) } else { None }).collect();
    if fixed.iter().all(Option::is_none) {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() + 16);
    for (&(code, at, end), f) in all.iter().zip(fixed) {
        out.extend_from_slice(&data[code..at]);
        out.extend_from_slice(f.as_deref().unwrap_or(&data[at..end]));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect()
    }

    // The fields before the VUI, to compare an SPS with its rewrite
    fn head(unit: &[u8]) -> (u32, Vec<u8>) {
        let rbsp = unescape(&unit[1..]);
        let mut r = Bits { data: &rbsp, pos: 0 };
        let refs = up_to_vui(&mut r).unwrap();
        let mut h = Bits { data: &rbsp, pos: 0 };
        (refs, (0..r.pos).map(|_| h.bit().unwrap() as u8).collect())
    }

    // Parsed again after the rewrite: a VUI that says no reordering, so nothing more to do (libwebrtc: kVuiOk)
    fn settled(unit: &[u8]) {
        assert!(sps(unit).is_none(), "a rewritten SPS needs no second rewrite");
    }

    // A High profile SPS with a VUI (colour, timing) and the given bitstream_restriction (reorder, buffering)
    fn made(restriction: Option<(u32, u32)>) -> Vec<u8> {
        let mut w = Out::default();
        w.put(100, 8); // profile_idc
        w.put(0, 8);
        w.put(31, 8); // level
        w.ue(0); // sps id
        w.ue(1); // chroma_format_idc
        w.ue(0);
        w.ue(0);
        w.put(0, 2); // qpprime, no scaling matrix
        w.ue(0); // log2_max_frame_num_minus4
        w.ue(0); // pic_order_cnt_type
        w.ue(2);
        w.ue(3); // max_num_ref_frames
        w.put(0, 1);
        w.ue(79); // 1280
        w.ue(44); // 720
        w.put(0b110, 3); // frame_mbs_only, direct_8x8, no cropping
        w.put(1, 1); // vui
        w.put(0, 2);
        w.put(1, 1); // video signal type
        w.put(5, 3);
        w.put(0, 1);
        w.put(1, 1); // colour description
        w.put(0x010101, 24);
        w.put(0, 1);
        w.put(1, 1); // timing
        w.put(1001, 32);
        w.put(60000, 32);
        w.put(0, 1);
        w.put(0, 3); // no HRD, no pic_struct
        match restriction {
            None => w.put(0, 1),
            Some((reorder, buffering)) => {
                w.put(1, 1);
                w.put(1, 1);
                w.ue(2);
                w.ue(1);
                w.ue(16);
                w.ue(16);
                w.ue(reorder);
                w.ue(buffering);
            }
        }
        w.put(1, 1); // rbsp_stop_one_bit
        while w.n % 8 != 0 {
            w.put(0, 1);
        }
        let mut out = vec![0x67];
        escape(&w.bytes, &mut out);
        out
    }

    #[test]
    fn rewrites_what_reorders() {
        for (given, rewrite) in [(None, true), (Some((2, 4)), true), (Some((0, 5)), true), (Some((0, 3)), false), (Some((0, 1)), false)] {
            let unit = made(given);
            match sps(&unit) {
                Some(out) => {
                    assert!(rewrite, "{given:?} needed no rewrite");
                    assert_eq!(head(&out), head(&unit), "{given:?}: everything before the VUI stays");
                    assert_eq!(out, made(Some((0, 3))), "{given:?}: the VUI as it was, with no reordering");
                    settled(&out);
                }
                None => assert!(!rewrite, "{given:?} wasn't rewritten"),
            }
        }
    }

    #[test]
    fn adds_a_vui() {
        // Constrained Baseline 3.1, 1280x720, no VUI
        let unit = hex("6742c01f8c8d40500179602220");
        let out = sps(&unit).expect("an SPS without a VUI is rewritten");
        assert_eq!(head(&out), head(&unit), "everything before the VUI stays");
        settled(&out);
    }

    #[test]
    fn keeps_a_good_one() {
        let unit = hex("6742c01f8c8d40500179602220");
        let good = sps(&unit).unwrap();
        let au = [&[0, 0, 0, 1][..], &good, &[0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]].concat();
        assert!(low_delay(&au).is_none());
    }

    #[test]
    fn the_test_vectors_sps() {
        // High 3.1 with a VUI (timing info) and no bitstream_restriction
        let unit = hex("6764001facd9405005bb0110000003001000000303c0f1831960");
        if let Some(out) = sps(&unit) {
            assert_eq!(head(&out), head(&unit));
            settled(&out);
        }
    }

    // What this machine's encoders make, and that it comes out low-delay. `cargo test vui -- --nocapture` shows
    // which needed it.
    #[cfg(feature = "software")]
    #[test]
    fn openh264() {
        encoder_check(false);
    }

    // The hardware encoder (Media Foundation, VideoToolbox): not on every machine, so by hand
    #[test]
    #[ignore]
    fn hardware() {
        encoder_check(true);
    }

    fn encoder_check(hw: bool) {
        use crate::encode::{open, Config};
        use crate::frame::Nv12;
        for high in [false, true] {
            let cfg = Config { w: 640, h: 360, fps: 30.0, bps: 1_000_000, max_bps: 2_000_000, high, sharp: false };
            let Ok((mut enc, _)) = open(cfg, hw, None) else { return eprintln!("no encoder") };
            if hw && !enc.hardware() {
                return eprintln!("no hardware encoder here");
            }
            let frame = Nv12 { w: 640, h: 360, y: vec![80; 640 * 360], uv: vec![128; 640 * 180] };
            let mut unit = None;
            for seq in 1..30 {
                if let Ok(Some(u)) = enc.encode(&frame, seq == 1, seq) {
                    unit = Some(u);
                    break;
                }
                while let Ok(Some(u)) = enc.poll() {
                    unit = Some(u);
                }
                if unit.is_some() {
                    break;
                }
            }
            let Some(unit) = unit else { return eprintln!("{}: no unit out", enc.name()) };
            let fixed = low_delay(&unit.data);
            eprintln!("{} {}: SPS {}", enc.name(), crate::encode::sps_profile(&unit.data).unwrap_or_default(), if fixed.is_some() { "rewritten for low delay" } else { "already low-delay" });
            let after = fixed.unwrap_or(unit.data);
            assert!(low_delay(&after).is_none(), "{}: settled after one rewrite", enc.name());
        }
    }
}
