// A small QR code encoder for the 2-step setup (D52): byte mode, error
// correction level L, versions 1 to 20 (up to 858 bytes). No dependencies,
// because the dashboard has no build step and its CSP allows no other origin.

// Per version, level L: [error correction bytes per block, blocks, data bytes per block, longer blocks (one more data byte)]
const BLOCKS = [null, [7, 1, 19, 0], [10, 1, 34, 0], [15, 1, 55, 0], [20, 1, 80, 0], [26, 1, 108, 0], [18, 2, 68, 0], [20, 2, 78, 0], [24, 2, 97, 0], [30, 2, 116, 0], [18, 2, 68, 2],
  [20, 4, 81, 0], [24, 2, 92, 2], [26, 4, 107, 0], [30, 3, 115, 1], [22, 5, 87, 1], [24, 5, 98, 1], [28, 1, 107, 5], [30, 5, 120, 1], [28, 3, 113, 4], [28, 3, 107, 5]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]];
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Reed-Solomon over GF(256), polynomial 0x11D
function gfMul(a, b) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z;
}
function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 2);
  }
  return out;
}
function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((c, i) => (out[i] ^= gfMul(c, factor)));
  }
  return out;
}

// The data codewords for `bytes`, padded for `version`, then split into blocks with their error correction and interleaved
function codewords(bytes, version) {
  const [ecLen, short, shortLen, long] = BLOCKS[version];
  const capacity = short * shortLen + long * (shortLen + 1);
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(4, 4); // byte mode
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));

  const divisor = rsDivisor(ecLen);
  const blocks = [];
  for (let i = 0, at = 0; i < short + long; i++) {
    const d = data.slice(at, (at += shortLen + (i < short ? 0 : 1)));
    blocks.push({ d, ec: rsRemainder(d, divisor) });
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

function penalty(m) {
  const n = m.length;
  let score = 0;
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0, runX = 0, runY = 0; x < n; x++) {
      if (m[y][x]) dark++;
      // runs of five or more of one color, along the row and along the column
      runX = x && m[y][x] === m[y][x - 1] ? runX + 1 : 1;
      if (runX === 5) score += 3;
      else if (runX > 5) score++;
      runY = x && m[x][y] === m[x - 1][y] ? runY + 1 : 1;
      if (runY === 5) score += 3;
      else if (runY > 5) score++;
      if (x && y && m[y][x] === m[y][x - 1] && m[y][x] === m[y - 1][x] && m[y][x] === m[y - 1][x - 1]) score += 3; // 2×2 blocks
    }
  }
  return score + Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10; // far from half dark
}

// The modules of a QR code for `text` as rows of booleans (true = dark), or null when it is too long.
// `forceMask` (0 to 7) is for tests.
export function qrMatrix(text, forceMask) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 20 && bytes.length > BLOCKS[version][1] * BLOCKS[version][2] + BLOCKS[version][3] * (BLOCKS[version][2] + 1) - (version < 10 ? 2 : 3)) version++;
  if (version > 20) return null;

  const n = version * 4 + 17;
  const mod = Array.from({ length: n }, () => new Array(n).fill(false));
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false)); // finder, timing, alignment, format and version modules
  const set = (x, y, dark) => {
    mod[y][x] = dark;
    fixed[y][x] = true;
  };

  for (let i = 0; i < n; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (cx + dx >= 0 && cx + dx < n && cy + dy >= 0 && cy + dy < n) set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
    }
  }
  const al = ALIGN[version];
  for (const cy of al) {
    for (const cx of al) {
      const corner = (cx === 6 && cy === 6) || (cx === 6 && cy === al[al.length - 1]) || (cx === al[al.length - 1] && cy === 6);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const format = (mask) => {
    const data = (1 << 3) | mask; // level L
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
    set(8, n - 8, true);
  };
  format(0); // reserves the modules; the real bits follow the mask
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // The codewords, in two-module columns from the bottom right, going up and down in turn
  const data = codewords(bytes, version);
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (fixed[y][x]) continue;
        if (i < data.length * 8) mod[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }

  const flip = (mask) => {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fixed[y][x] && MASKS[mask](x, y)) mod[y][x] = !mod[y][x];
  };
  let best = forceMask;
  if (best === undefined) {
    let low = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      flip(mask);
      format(mask);
      const p = penalty(mod);
      if (p < low) [low, best] = [p, mask];
      flip(mask); // flipping twice undoes it
    }
  }
  flip(best);
  format(best);
  return mod;
}

// The code drawn on a canvas, with the quiet border scanners need
export function qrCanvas(text, scale = 4) {
  const m = qrMatrix(text);
  if (!m) return null;
  const quiet = 4;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (m.length + quiet * 2) * scale;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  m.forEach((row, y) => row.forEach((dark, x) => dark && g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)));
  return canvas;
}
