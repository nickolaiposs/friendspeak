// Checks public/js/e2ee.js against the shared test vectors of the media encryption (D70). native/src/e2ee.rs
// checks the same file (cargo test in native/), so the app and the sidecar agree byte for byte.
//
//   node scripts/check-e2ee.mjs           check
//   node scripts/check-e2ee.mjs --write   make scripts/e2ee-vectors.json again (only when the format changes on purpose)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The repo is CommonJS to Node, and the app's modules are ES modules: load this one as what it is
const source = fs.readFileSync(path.join(here, '..', 'public', 'js', 'e2ee.js'), 'utf8');
const { CLEAR, FORMAT, Replay, Sealer, decryptFrame, encryptFrame, importMediaKey, nalUnits } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const file = path.join(here, 'e2ee-vectors.json');
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const KEY = '000102030405060708090a0b0c0d0e0f';
const EID = 'a0a1a2a3a4a5a6a7';
const CTR = 7;

const SPS = '6764001facd9405005bb0110000003001000000303c0f1831960';
const PPS = '68ebe3cb22c0';
// Inputs. The slices carry bytes that need escaping (00 00 03 0x) so both sides unescape and escape alike.
// `decrypted`: what the receiver gets back, when it isn't the input (what isn't sent is gone; parameter sets come
// back from the copy in the first slice, with 4-byte start codes)
const INPUTS = [
  {
    name: 'H.264 keyframe: SPS and PPS in the clear and in the first slice, SEI and AUD left out, two slices encrypted',
    codec: 'H264',
    kind: 'screen',
    index: 1,
    input:
      '00000001' + '0910' + // AUD
      '00000001' + SPS +
      '00000001' + PPS +
      '00000001' + '0605ffff' + // SEI
      '00000001' + '65888400000300112233445566778899aabbccddeeff00000301020304' + // IDR slice
      '000001' + '658800c0ffee0000030000030100aa', // a second slice, 3-byte start code
    decrypted:
      '00000001' + SPS + '00000001' + PPS +
      '00000001' + '65888400000300112233445566778899aabbccddeeff00000301020304' +
      '000001' + '658800c0ffee0000030000030100aa',
  },
  { name: 'H.264 P slice shorter than the clear part: encrypted all the same', codec: 'H264', kind: 'camera', index: 2, input: '00000001419a0102' },
  { name: 'H.264 non-IDR slice with key index 255', codec: 'H264', kind: 'screen', index: 255, input: '00000001419a246c41300000030000030102030405060708' },
  {
    name: 'H.265 keyframe: VPS, SPS, PPS in the clear and in the slice; an IDR_W_RADL slice encrypted',
    codec: 'H265',
    kind: 'screen',
    index: 7,
    input: '00000001' + '40010c01ffff016000000300b0' + '00000001' + '420101016000000300b0000003005aa0' + '00000001' + '4401c172b46240' + '00000001' + '2601af0812345678000003000102030405060708090a0b0c0d0e0f',
  },
  { name: 'Opus frame, encrypted whole', codec: 'opus', kind: 'shareAudio', index: 3, input: 'fc8f3c5e2a9b' + '00'.repeat(20) + '0102030405' },
];

let failed = 0;
const check = (ok, what) => {
  if (!ok) (failed++, console.error('FAIL ' + what));
};
const sealer = (v) => new Sealer(unhex(v.eid), v.ctr);

if (process.argv.includes('--write')) {
  const key = await importMediaKey(unhex(KEY));
  const vectors = [];
  for (const v of INPUTS) {
    const w = { ...v, key: KEY, eid: EID, ctr: CTR };
    w.output = hex(await encryptFrame(v.codec, v.kind, unhex(v.input), key, v.index, sealer(w)));
    vectors.push(w);
  }
  fs.writeFileSync(file, JSON.stringify({ format: `D70 media encryption, format ${FORMAT}, see docs/DECISIONS.md`, clear: CLEAR, vectors }, null, 2) + '\n');
  console.log(`wrote ${vectors.length} vectors to ${path.relative(process.cwd(), file)}`);
}

const json = JSON.parse(fs.readFileSync(file, 'utf8'));
check(json.format.includes(`format ${FORMAT}`), 'vectors are of this format');
const { vectors } = json;
for (const v of vectors) {
  const key = await importMediaKey(unhex(v.key));
  const keys = new Map([[v.index, key]]);
  const input = unhex(v.input);
  const out = await encryptFrame(v.codec, v.kind, input, key, v.index, sealer(v));
  check(hex(out) === v.output, `${v.name}: encrypt`);
  const want = v.decrypted || v.input;
  const back = await decryptFrame(v.codec, v.kind, unhex(v.output), keys);
  check(back && hex(back) === want, `${v.name}: decrypt`);
  check(v.output !== v.input, `${v.name}: something is encrypted`);
  const bad = unhex(v.output);
  bad[bad.length - 20] ^= 1;
  check((await decryptFrame(v.codec, v.kind, bad, keys)) === null, `${v.name}: a changed byte must not decrypt`);
  check((await decryptFrame(v.codec, v.kind, unhex(v.output), new Map())) === null, `${v.name}: no key, no frame`);
  const other = v.kind === 'screen' ? 'camera' : 'screen';
  check((await decryptFrame(v.codec, other, unhex(v.output), keys)) === null, `${v.name}: not as another kind of stream`);
  // The same frame twice, through one receiver: the second is a replay
  const replay = new Replay();
  check((await decryptFrame(v.codec, v.kind, unhex(v.output), keys, replay)) !== null, `${v.name}: first time through a replay window`);
  check((await decryptFrame(v.codec, v.kind, unhex(v.output), keys, replay)) === null, `${v.name}: a replay is refused`);
  if (v.codec !== 'opus') {
    // Whatever the server puts in the clear is dropped: an SEI, an SPS of its own, a slice without encryption
    const extra = v.codec === 'H264' ? ['0605ffeeddcc80', '6742001fffff', '419a0102'] : ['4e01ffeeddcc80', '420101ffff'];
    for (const x of extra) {
      const tampered = unhex('00000001' + x + v.output);
      const got = await decryptFrame(v.codec, v.kind, tampered, keys);
      if (v.codec === 'H264' && x === '419a0102') check(got === null, `${v.name}: a clear slice spoils the frame`);
      else check(got && hex(got) === want, `${v.name}: a clear ${x.slice(0, 4)} unit is dropped`);
    }
    // A frame of clear units alone is no frame
    check((await decryptFrame(v.codec, v.kind, unhex('00000001' + (v.codec === 'H264' ? SPS : '420101ffff')), keys)) === null, `${v.name}: no slice, no frame`);
    check((await encryptFrame(v.codec, v.kind, unhex('00000001' + (v.codec === 'H264' ? SPS : '420101ffff')), key, v.index, new Sealer())) === null, `${v.name}: nothing to send without a slice`);
    // No ciphertext forms a start code: as many units as went in, less the ones left out
    const sent = nalUnits(unhex(v.output)).length;
    const kept = nalUnits(unhex(want)).length;
    check(sent === kept, `${v.name}: no new start codes (${sent} units sent, ${kept} given back)`);
  }
}

// Random IVs and keys, many times over: ciphertext must never make a start code; counters move on
{
  const key = await importMediaKey(crypto.getRandomValues(new Uint8Array(16)));
  const keys = new Map([[9, key]]);
  const frame = unhex('0000000165' + '11'.repeat(4000));
  const s = new Sealer();
  const replay = new Replay();
  const outs = [];
  for (let i = 0; i < 200; i++) {
    const out = await encryptFrame('H264', 'camera', frame, key, 9, s);
    check(nalUnits(out).length === 1, 'random: one NAL unit stays one');
    outs.push(out);
  }
  check(s.ctr === 200, 'random: one IV per slice');
  // Out of order within the window is fine, each once
  for (const i of [5, 3, 4, 199, 0, 100]) {
    const back = await decryptFrame('H264', 'camera', outs[i], keys, replay);
    check(back && hex(back) === hex(frame), `random: frame ${i} in its own order`);
  }
  check((await decryptFrame('H264', 'camera', outs[3], keys, replay)) === null, 'random: frame 3 again is refused');
  // Past the window: too old
  const late = new Sealer(s.eid, 50); // a frame never received
  const old = await encryptFrame('H264', 'camera', frame, key, 9, late);
  s.ctr = Replay.SIZE + 500;
  check((await decryptFrame('H264', 'camera', await encryptFrame('H264', 'camera', frame, key, 9, s), keys, replay)) !== null, 'random: far ahead is fine');
  check((await decryptFrame('H264', 'camera', old, keys, replay)) === null, 'random: older than the window is refused');
}
if (failed) process.exit(1);
console.log(`e2ee: format ${FORMAT}, ${vectors.length} vectors and 200 random frames OK`);
