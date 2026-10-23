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
const { CLEAR, decryptFrame, encryptFrame, importMediaKey, nalUnits } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const file = path.join(here, 'e2ee-vectors.json');
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const KEY = '000102030405060708090a0b0c0d0e0f';
const IV = 'a0a1a2a3a4a5a6a7a8a9aaab';

// Inputs. The slices carry bytes that need escaping (00 00 03 0x) so both sides unescape and escape alike.
const INPUTS = [
  {
    name: 'H.264 keyframe: SPS, PPS, SEI in the clear; an IDR slice and a second slice encrypted',
    codec: 'H264',
    index: 1,
    input:
      '00000001' + '6764001facd9405005bb0110000003001000000303c0f183196' + '0' + // SPS (padded to even length below)
      '00000001' + '68ebe3cb22c0' + // PPS
      '00000001' + '0605ffff' + // SEI
      '00000001' + '65888400000300112233445566778899aabbccddeeff00000301020304' + // IDR slice
      '000001' + '658800c0ffee0000030000030100aa', // a second slice, 3-byte start code
  },
  { name: 'H.264 P slice shorter than the clear part: unchanged', codec: 'H264', index: 2, input: '00000001419a0102' },
  { name: 'H.264 non-IDR slice with key index 255', codec: 'H264', index: 255, input: '00000001419a246c41300000030000030102030405060708' },
  {
    name: 'H.265 keyframe: VPS, SPS, PPS in the clear; an IDR_W_RADL slice encrypted',
    codec: 'H265',
    index: 7,
    input: '00000001' + '40010c01ffff016000000300b0' + '00000001' + '420101016000000300b0000003005aa0' + '00000001' + '4401c172b46240' + '00000001' + '2601af0812345678000003000102030405060708090a0b0c0d0e0f',
  },
  { name: 'Opus frame, encrypted whole', codec: 'opus', index: 3, input: 'fc8f3c5e2a9b' + '00'.repeat(20) + '0102030405' },
];
for (const v of INPUTS) if (v.input.length % 2) v.input = v.input.slice(0, -1);

const fixedIv = () => unhex(IV);
let failed = 0;
const check = (ok, what) => {
  if (!ok) (failed++, console.error('FAIL ' + what));
};

if (process.argv.includes('--write')) {
  const key = await importMediaKey(unhex(KEY));
  const vectors = [];
  for (const v of INPUTS) vectors.push({ ...v, key: KEY, iv: IV, output: hex(await encryptFrame(v.codec, unhex(v.input), key, v.index, fixedIv)) });
  fs.writeFileSync(file, JSON.stringify({ format: 'D70 media encryption, see docs/DECISIONS.md', clear: CLEAR, vectors }, null, 2) + '\n');
  console.log(`wrote ${vectors.length} vectors to ${path.relative(process.cwd(), file)}`);
}

const { vectors } = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const v of vectors) {
  const key = await importMediaKey(unhex(v.key));
  const input = unhex(v.input);
  const out = await encryptFrame(v.codec, input, key, v.index, () => unhex(v.iv));
  check(hex(out) === v.output, `${v.name}: encrypt`);
  const back = await decryptFrame(v.codec, unhex(v.output), new Map([[v.index, key]]));
  check(back && hex(back) === v.input, `${v.name}: decrypt`);
  if (v.output !== v.input) {
    const bad = unhex(v.output);
    bad[bad.length - 20] ^= 1;
    check((await decryptFrame(v.codec, bad, new Map([[v.index, key]]))) === null, `${v.name}: a changed byte must not decrypt`);
    check((await decryptFrame(v.codec, unhex(v.output), new Map())) === null, `${v.name}: no key, no frame`);
  }
  if (v.codec !== 'opus') check(nalUnits(unhex(v.output)).length === nalUnits(input).length, `${v.name}: no new start codes`);
}
// Random IVs, many times over: ciphertext must never make a start code
{
  const key = await importMediaKey(crypto.getRandomValues(new Uint8Array(16)));
  const frame = unhex('0000000165' + '11'.repeat(4000));
  for (let i = 0; i < 200; i++) {
    const out = await encryptFrame('H264', frame, key, 9);
    check(nalUnits(out).length === 1, 'random: one NAL unit stays one');
    const back = await decryptFrame('H264', out, new Map([[9, key]]));
    check(back && hex(back) === hex(frame), 'random: round trip');
  }
}
if (failed) process.exit(1);
console.log(`e2ee: ${vectors.length} vectors and 200 random frames OK`);
