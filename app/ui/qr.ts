// A QR code encoder: text → a square of modules (true = dark). Byte mode (UTF-8), error correction level M,
// the smallest version (1 to 20) the text fits, the mask with the lowest penalty. Written from ISO/IEC 18004 for the
// sign-in link (a few dozen bytes); no dependency.

/** Error-correction codewords per block, and [blocks, data codewords per block] groups, level M, by version. */
const M: Array<[number, Array<[number, number]>]> = [
  [0, []],
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
  [30, [[1, 50], [4, 51]]],
  [22, [[6, 36], [2, 37]]],
  [22, [[8, 37], [1, 38]]],
  [24, [[4, 40], [5, 41]]],
  [24, [[5, 41], [5, 42]]],
  [28, [[7, 45], [3, 46]]],
  [28, [[10, 46], [1, 47]]],
  [26, [[9, 43], [4, 44]]],
  [26, [[3, 44], [11, 45]]],
  [26, [[3, 41], [13, 42]]],
];

/** Alignment pattern centers by version. */
const ALIGN: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

const dataCodewords = (v: number) => M[v][1].reduce((n, [b, d]) => n + b * d, 0);

// GF(256) with the polynomial 0x11d
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** The Reed-Solomon error-correction codewords of `data`. */
function ecc(data: number[], n: number): number[] {
  // generator: (x - α^0)(x - α^1)…(x - α^(n-1)), highest power first, leading 1 dropped
  let gen = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= mul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rest = new Array<number>(n).fill(0);
  for (const d of data) {
    const f = d ^ rest[0];
    rest.shift();
    rest.push(0);
    for (let j = 0; j < n; j++) rest[j] ^= mul(gen[j + 1], f);
  }
  return rest;
}

/** The final codeword sequence: data with its padding, split in blocks, interleaved, then the ECC interleaved. */
function codewords(bytes: number[], v: number): number[] {
  const cap = dataCodewords(v);
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4); // byte mode
  put(bytes.length, v < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

  const [eccLen, groups] = M[v];
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, len] of groups) for (let i = 0; i < count; i++) { blocks.push(data.slice(at, at + len)); at += len; }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  const eccs = blocks.map((b) => ecc(b, eccLen));
  for (let i = 0; i < eccLen; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

/** BCH code of the 5 format bits (level M = 00) and the mask, XOR-ed with 0x5412. */
function formatBits(mask: number): number {
  const d = (0b00 << 3) | mask;
  let r = d << 10;
  for (let i = 14; i >= 10; i--) if ((r >>> i) & 1) r ^= 0x537 << (i - 10);
  return ((d << 10) | r) ^ 0x5412;
}

/** BCH code of the version (7 and up). */
function versionBits(v: number): number {
  let r = v << 12;
  for (let i = 17; i >= 12; i--) if ((r >>> i) & 1) r ^= 0x1f25 << (i - 12);
  return (v << 12) | r;
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function build(v: number, words: number[], mask: number): boolean[][] {
  const n = v * 4 + 17;
  const dark: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fixed: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (r: number, c: number, d: boolean) => { dark[r][c] = d; fixed[r][c] = true; };

  // finders and their separators
  for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = fr + r, cc = fc + c;
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(rr, cc, ring !== 2 && ring !== 4);
    }
  }
  // timing
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // alignment
  const al = ALIGN[v];
  const last = al.length - 1;
  al.forEach((r, i) => al.forEach((c, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return; // the finders' corners
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }));
  // format (bit i, LSB first) around the top-left finder, and split between the other two
  const f = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit = ((f >>> i) & 1) === 1;
    // around the top-left finder
    if (i < 6) set(i, 8, bit);
    else if (i < 8) set(i + 1, 8, bit);
    else if (i === 8) set(8, 7, bit);
    else set(8, 14 - i, bit);
    // the copy
    if (i < 8) set(8, n - 1 - i, bit);
    else set(n - 15 + i, 8, bit);
  }
  set(n - 8, 8, true); // the dark module
  // version
  if (v >= 7) {
    const vb = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const bit = ((vb >>> i) & 1) === 1;
      const a = Math.floor(i / 3), b = n - 11 + (i % 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
  // data, in two-column zigzags from the bottom right
  let k = 0;
  const total = words.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let j = 0; j < n; j++) {
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? n - 1 - j : j;
        if (fixed[r][c]) continue;
        const bit = k < total && ((words[k >>> 3] >>> (7 - (k & 7))) & 1) === 1;
        k++;
        dark[r][c] = bit !== MASKS[mask](r, c);
      }
    }
  }
  return dark;
}

/** The penalty score of a symbol (lower scans better). */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let p = 0;
  const lines = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      for (let j = 0; j + 11 <= n; j++) {
        const s = Array.from({ length: 11 }, (_, x) => (get(i, j + x) ? "1" : "0")).join("");
        if (s === "10111010000" || s === "00001011101") p += 40;
      }
    }
  };
  lines((i, j) => m[i][j]);
  lines((i, j) => m[j][i]);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const d = m[r][c];
    if (m[r][c + 1] === d && m[r + 1][c] === d && m[r + 1][c + 1] === d) p += 3;
  }
  const darkCount = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  p += Math.floor(Math.abs(darkCount * 20 - n * n * 10) / (n * n)) * 10;
  return p;
}

/** The QR code of `text` as rows of modules (true = dark), no quiet zone; null when it's too long (over ~330 bytes). */
export function qrModules(text: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  let v = 1;
  // mode (4 bits) + length (8 or 16) + the data, in whole codewords
  while (v < M.length && Math.ceil((4 + (v < 10 ? 8 : 16) + bytes.length * 8) / 8) > dataCodewords(v)) v++;
  if (v >= M.length) return null;
  const words = codewords(bytes, v);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(v, words, mask);
    const s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}
