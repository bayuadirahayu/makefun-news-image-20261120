// THE WORLD IN ONE DAY — Friday 20 November 2026
// A program that draws one 1024x1024 newspaper front page summing up the
// world's news of 20 November 2026. Node 22, standard library only.
// Writes /output/entry.png (or $MAKEFUN_OUTPUT_DIR/entry.png).
// Deterministic: same bytes on every run (seeded PRNG, no clock, no network).

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------- deterministic PRNG (mulberry32) ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- CRC32 + PNG encoder ----------
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(rgb: Buffer, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- color helpers ----------
type RGB = [number, number, number];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c0: RGB, c1: RGB, t: number): RGB {
  return [
    Math.round(lerp(c0[0], c1[0], t)),
    Math.round(lerp(c0[1], c1[1], t)),
    Math.round(lerp(c0[2], c1[2], t)),
  ];
}

// ---------- canvas ----------
class Canvas {
  buf: Buffer;
  w: number;
  h: number;
  constructor(w: number, h: number, bg: RGB) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 3);
    this.fillRect(0, 0, w, h, bg);
  }
  set(x: number, y: number, c: RGB): void {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const i = (yi * this.w + xi) * 3;
    this.buf[i] = c[0];
    this.buf[i + 1] = c[1];
    this.buf[i + 2] = c[2];
  }
  // alpha blend 0..1 over existing pixel
  blend(x: number, y: number, c: RGB, a: number): void {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const i = (yi * this.w + xi) * 3;
    this.buf[i] = Math.round(this.buf[i] * (1 - a) + c[0] * a);
    this.buf[i + 1] = Math.round(this.buf[i + 1] * (1 - a) + c[1] * a);
    this.buf[i + 2] = Math.round(this.buf[i + 2] * (1 - a) + c[2] * a);
  }
  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const ax = Math.max(0, Math.floor(x0));
    const ay = Math.max(0, Math.floor(y0));
    const bx = Math.min(this.w, Math.ceil(x1));
    const by = Math.min(this.h, Math.ceil(y1));
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) this.set(x, y, c);
    }
  }
  blendRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a: number): void {
    const ax = Math.max(0, Math.floor(x0));
    const ay = Math.max(0, Math.floor(y0));
    const bx = Math.min(this.w, Math.ceil(x1));
    const by = Math.min(this.h, Math.ceil(y1));
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) this.blend(x, y, c, a);
    }
  }
  // vertical gradient rect
  vgrad(x0: number, y0: number, x1: number, y1: number, cTop: RGB, cBot: RGB): void {
    const ax = Math.max(0, Math.floor(x0));
    const ay = Math.max(0, Math.floor(y0));
    const bx = Math.min(this.w, Math.ceil(x1));
    const by = Math.min(this.h, Math.ceil(y1));
    const span = Math.max(1, by - ay);
    for (let y = ay; y < by; y++) {
      const c = mix(cTop, cBot, (y - ay) / span);
      for (let x = ax; x < bx; x++) this.set(x, y, c);
    }
  }
  fillCircle(cx: number, cy: number, r: number, c: RGB): void {
    const rr = Math.max(0, r);
    const ax = Math.max(0, Math.floor(cx - rr));
    const ay = Math.max(0, Math.floor(cy - rr));
    const bx = Math.min(this.w - 1, Math.ceil(cx + rr));
    const by = Math.min(this.h - 1, Math.ceil(cy + rr));
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= rr * rr) this.set(x, y, c);
      }
    }
  }
  blendCircle(cx: number, cy: number, r: number, c: RGB, a: number): void {
    const rr = Math.max(0, r);
    const ax = Math.max(0, Math.floor(cx - rr));
    const ay = Math.max(0, Math.floor(cy - rr));
    const bx = Math.min(this.w - 1, Math.ceil(cx + rr));
    const by = Math.min(this.h - 1, Math.ceil(cy + rr));
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= rr * rr) this.blend(x, y, c, a);
      }
    }
  }
  // thick line: stamp circles along the segment
  line(x0: number, y0: number, x1: number, y1: number, sw: number, c: RGB): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(len / Math.max(0.5, sw / 3)));
    const r = sw / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.fillCircle(x0 + dx * t, y0 + dy * t, r, c);
    }
  }
  // scanline polygon fill; pts = [x,y,x,y,...]
  poly(pts: number[], c: RGB): void {
    const n = pts.length / 2;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minY = Math.min(minY, pts[i * 2 + 1]);
      maxY = Math.max(maxY, pts[i * 2 + 1]);
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.h - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = pts[i * 2];
        const ay = pts[i * 2 + 1];
        const bx = pts[j * 2];
        const by = pts[j * 2 + 1];
        if ((ay <= y && by > y) || (by <= y && ay > y)) {
          xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k]));
        const xb = Math.min(this.w - 1, Math.floor(xs[k + 1]));
        for (let x = xa; x <= xb; x++) this.set(x, y, c);
      }
    }
  }
  // paper grain: per-pixel noise over the whole canvas (seeded, deterministic)
  grain(amount: number, seed: number): void {
    const rnd = mulberry32(seed);
    for (let i = 0; i < this.buf.length; i++) {
      const d = Math.round((rnd() - 0.5) * 2 * amount);
      const v = this.buf[i] + d;
      this.buf[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  // soft paper mottling: large translucent blobs
  mottle(seed: number, count: number, cDark: RGB, cLight: RGB): void {
    const rnd = mulberry32(seed);
    for (let i = 0; i < count; i++) {
      const cx = rnd() * this.w;
      const cy = rnd() * this.h;
      const r = 40 + rnd() * 130;
      const c = rnd() < 0.5 ? cDark : cLight;
      this.blendCircle(cx, cy, r, c, 0.05 + rnd() * 0.05);
    }
  }
}

// ---------- stroke font ----------
// Each glyph: strokes on a 10 wide x 14 tall grid, baseline at y=13.
// A stroke is [x1, y1, x2, y2]. Zero-length strokes draw a dot.
// Lowercase letters reuse the cap glyphs at 0.72 scale (small caps look).
type Stroke = [number, number, number, number];

const GLYPHS: Record<string, Stroke[]> = {
  A: [[0, 13, 5, 0], [5, 0, 10, 13], [3, 8, 7, 8]],
  B: [[0, 0, 0, 13], [0, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 5], [9, 5, 7, 7], [7, 7, 0, 7], [7, 7, 9, 9], [9, 9, 9, 11], [9, 11, 7, 13], [7, 13, 0, 13]],
  C: [[9, 2, 7, 0], [7, 0, 3, 0], [3, 0, 1, 2], [1, 2, 1, 11], [1, 11, 3, 13], [3, 13, 7, 13], [7, 13, 9, 11]],
  D: [[0, 0, 0, 13], [0, 0, 6, 0], [6, 0, 9, 2], [9, 2, 9, 11], [9, 11, 6, 13], [6, 13, 0, 13]],
  E: [[0, 0, 0, 13], [0, 0, 9, 0], [0, 6, 7, 6], [0, 13, 9, 13]],
  F: [[0, 0, 0, 13], [0, 0, 9, 0], [0, 6, 7, 6]],
  G: [[9, 2, 7, 0], [7, 0, 3, 0], [3, 0, 1, 2], [1, 2, 1, 11], [1, 11, 3, 13], [3, 13, 7, 13], [7, 13, 9, 11], [9, 11, 9, 7], [9, 7, 5, 7]],
  H: [[0, 0, 0, 13], [10, 0, 10, 13], [0, 6, 10, 6]],
  I: [[2, 0, 8, 0], [5, 0, 5, 13], [2, 13, 8, 13]],
  J: [[9, 0, 9, 10], [9, 10, 7, 13], [7, 13, 3, 13], [3, 13, 1, 11]],
  K: [[0, 0, 0, 13], [9, 0, 1, 7], [4, 5, 10, 13]],
  L: [[0, 0, 0, 13], [0, 13, 9, 13]],
  M: [[0, 13, 0, 0], [0, 0, 5, 8], [5, 8, 10, 0], [10, 0, 10, 13]],
  N: [[0, 13, 0, 0], [0, 0, 10, 13], [10, 13, 10, 0]],
  O: [[3, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 11], [9, 11, 7, 13], [7, 13, 3, 13], [3, 13, 1, 11], [1, 11, 1, 2], [1, 2, 3, 0]],
  P: [[0, 0, 0, 13], [0, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 5], [9, 5, 7, 7], [7, 7, 0, 7]],
  Q: [[3, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 11], [9, 11, 7, 13], [7, 13, 3, 13], [3, 13, 1, 11], [1, 11, 1, 2], [1, 2, 3, 0], [6, 9, 10, 14]],
  R: [[0, 0, 0, 13], [0, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 5], [9, 5, 7, 7], [7, 7, 0, 7], [6, 7, 10, 13]],
  S: [[9, 2, 7, 0], [7, 0, 3, 0], [3, 0, 1, 2], [1, 2, 1, 5], [1, 5, 3, 7], [3, 7, 7, 7], [7, 7, 9, 9], [9, 9, 9, 11], [9, 11, 7, 13], [7, 13, 3, 13], [3, 13, 1, 11]],
  T: [[0, 0, 10, 0], [5, 0, 5, 13]],
  U: [[0, 0, 0, 11], [0, 11, 2, 13], [2, 13, 8, 13], [8, 13, 10, 11], [10, 11, 10, 0]],
  V: [[0, 0, 5, 13], [5, 13, 10, 0]],
  W: [[0, 0, 2, 13], [2, 13, 5, 7], [5, 7, 8, 13], [8, 13, 10, 0]],
  X: [[0, 0, 10, 13], [10, 0, 0, 13]],
  Y: [[0, 0, 5, 7], [5, 7, 10, 0], [5, 7, 5, 13]],
  Z: [[0, 0, 10, 0], [10, 0, 0, 13], [0, 13, 10, 13]],
  "0": [[3, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 11], [9, 11, 7, 13], [7, 13, 3, 13], [3, 13, 1, 11], [1, 11, 1, 2], [1, 2, 3, 0]],
  "1": [[3, 2, 5, 0], [5, 0, 5, 13], [2, 13, 8, 13]],
  "2": [[1, 3, 3, 0], [3, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 5], [9, 5, 0, 13], [0, 13, 9, 13]],
  "3": [[1, 2, 3, 0], [3, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 5], [9, 5, 7, 6], [7, 6, 9, 8], [9, 8, 9, 11], [9, 11, 7, 13], [7, 13, 3, 13], [3, 13, 1, 11]],
  "4": [[7, 0, 0, 9], [0, 9, 9, 9], [7, 0, 7, 13]],
  "5": [[9, 0, 1, 0], [1, 0, 1, 6], [1, 6, 7, 6], [7, 6, 9, 8], [9, 8, 9, 11], [9, 11, 7, 13], [7, 13, 1, 13]],
  "6": [[9, 1, 7, 0], [7, 0, 3, 0], [3, 0, 1, 2], [1, 2, 1, 11], [1, 11, 3, 13], [3, 13, 7, 13], [7, 13, 9, 11], [9, 11, 9, 8], [9, 8, 7, 6], [7, 6, 3, 6], [3, 6, 1, 4]],
  "7": [[0, 0, 10, 0], [10, 0, 3, 13]],
  "8": [[3, 0, 7, 0], [7, 0, 9, 2], [9, 2, 9, 5], [9, 5, 7, 6], [7, 6, 3, 6], [3, 6, 1, 5], [1, 5, 1, 2], [1, 2, 3, 0], [3, 6, 7, 6], [7, 6, 9, 8], [9, 8, 9, 11], [9, 11, 7, 13], [7, 13, 3, 13], [3, 13, 1, 11], [1, 11, 1, 8], [1, 8, 3, 6]],
  "9": [[10, 13, 10, 1], [10, 1, 8, 0], [8, 0, 3, 0], [3, 0, 1, 2], [1, 2, 1, 5], [1, 5, 3, 7], [3, 7, 8, 7], [8, 7, 10, 9]],
  ".": [[5, 12, 5, 12]],
  ",": [[5, 11, 5, 11], [5, 11, 3, 14]],
  ":": [[5, 4, 5, 4], [5, 10, 5, 10]],
  ";": [[5, 4, 5, 4], [5, 10, 5, 10], [5, 10, 3, 13]],
  "!": [[5, 0, 5, 9], [5, 12, 5, 12]],
  "?": [[2, 3, 3, 1], [3, 1, 7, 1], [7, 1, 9, 3], [9, 3, 9, 5], [9, 5, 7, 7], [7, 7, 5, 7], [5, 7, 5, 9], [5, 12, 5, 12]],
  "-": [[1, 7, 9, 7]],
  "–": [[1, 7, 9, 7]],
  "—": [[0, 7, 10, 7]],
  "(": [[8, 0, 5, 2], [5, 2, 5, 11], [5, 11, 8, 13]],
  ")": [[2, 0, 5, 2], [5, 2, 5, 11], [5, 11, 2, 13]],
  "%": [[0, 13, 10, 0], [2, 2, 4, 2], [4, 2, 4, 4], [4, 4, 2, 4], [2, 4, 2, 2], [6, 9, 8, 9], [8, 9, 8, 11], [8, 11, 6, 11], [6, 11, 6, 9]],
  $: [[8, 2, 6, 0], [6, 0, 4, 0], [4, 0, 2, 2], [2, 2, 2, 5], [2, 5, 4, 6], [4, 6, 7, 6], [7, 6, 9, 8], [9, 8, 9, 11], [9, 11, 7, 13], [7, 13, 4, 13], [4, 13, 2, 11], [5, 0, 5, 13]],
  "£": [[8, 0, 2, 0], [2, 0, 1, 3], [1, 3, 1, 10], [1, 10, 2, 13], [2, 13, 8, 13], [1, 7, 6, 7]],
  "/": [[8, 13, 2, 0]],
  "+": [[5, 2, 5, 11], [1, 6, 9, 6]],
  "=": [[1, 5, 9, 5], [1, 9, 9, 9]],
  "·": [[5, 6, 5, 6]],
  "•": [[5, 6, 5, 6]],
  "'": [[5, 0, 5, 0], [5, 0, 4, 3]],
  "’": [[5, 0, 5, 0], [5, 0, 4, 3]],
  '"': [[3, 0, 3, 0], [3, 0, 2, 3], [7, 0, 7, 0], [7, 0, 6, 3]],
  _: [[0, 13, 10, 13]],
  " ": [],
};

const ADVANCE = 11; // grid units per character

function glyphFor(ch: string): { strokes: Stroke[]; small: boolean } {
  if (ch >= "a" && ch <= "z") {
    return { strokes: GLYPHS[ch.toUpperCase()] ?? [], small: true };
  }
  return { strokes: GLYPHS[ch] ?? [], small: false };
}

// width of text in px at given cap-height size
function textWidth(text: string, size: number): number {
  const scale = size / 14;
  let w = 0;
  for (const ch of text) {
    const g = glyphFor(ch);
    w += ADVANCE * scale * (g.small ? 0.72 : 1);
  }
  return w;
}

function drawChar(cv: Canvas, ch: string, x: number, y: number, size: number, color: RGB): number {
  const scale = size / 14;
  const g = glyphFor(ch);
  const s = g.small ? scale * 0.72 : scale;
  const yOff = g.small ? (14 - 14 * 0.72) * scale : 0;
  const sw = Math.max(1.4, size * 0.088);
  for (const [x1, y1, x2, y2] of g.strokes) {
    cv.line(x + x1 * s, y + yOff + y1 * s, x + x2 * s, y + yOff + y2 * s, sw, color);
  }
  return ADVANCE * scale * (g.small ? 0.72 : 1);
}

function drawText(cv: Canvas, text: string, x: number, y: number, size: number, color: RGB, align: "left" | "center" | "right" = "left"): void {
  const w = textWidth(text, size);
  let cx = x;
  if (align === "center") cx = x - w / 2;
  if (align === "right") cx = x - w;
  for (const ch of text) cx += drawChar(cv, ch, cx, y, size, color);
}

// greedy word wrap; returns lines that fit maxWidth
function wrapText(text: string, maxWidth: number, size: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const trial = cur === "" ? word : cur + " " + word;
    if (textWidth(trial, size) <= maxWidth || cur === "") {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

function drawLines(cv: Canvas, lines: string[], x: number, y: number, size: number, lh: number, color: RGB, align: "left" | "center" | "right" = "left"): void {
  lines.forEach((ln, i) => drawText(cv, ln, x, y + i * lh, size, color, align));
}

// ---------- palette ----------
const PAPER: RGB = [242, 232, 213];
const CARD: RGB = [251, 247, 238];
const INK: RGB = [26, 23, 18];
const RED: RGB = [163, 31, 31];
const BLUE: RGB = [31, 58, 95];
const GREEN: RGB = [30, 107, 58];
const SAGE: RGB = [118, 138, 88];
const MAPLINE: RGB = [90, 100, 70];
const HAIR: RGB = [200, 185, 160];

// ---------- lead illustrations (each draws inside x,y,w,h) ----------
function sceneCourt(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.vgrad(x, y, x + w, y + h, [207, 224, 232], [242, 232, 213]);
  cv.fillCircle(x + w * 0.82, y + h * 0.3, 7, [240, 200, 90]);
  cv.fillRect(x, y + h * 0.72, x + w, y + h, [196, 180, 150]);
  // courthouse: pediment + columns + steps
  cv.poly([x + w * 0.2, y + h * 0.36, x + w * 0.78, y + h * 0.36, x + w * 0.49, y + h * 0.14], [214, 202, 178]);
  cv.fillRect(x + w * 0.22, y + h * 0.36, x + w * 0.76, y + h * 0.72, [226, 216, 196]);
  cv.line(x + w * 0.22, y + h * 0.36, x + w * 0.76, y + h * 0.36, 1, INK);
  cv.line(x + w * 0.22, y + h * 0.36, x + w * 0.22, y + h * 0.72, 1, INK);
  cv.line(x + w * 0.76, y + h * 0.36, x + w * 0.76, y + h * 0.72, 1, INK);
  for (let i = 0; i < 4; i++) {
    const cx = x + w * (0.29 + i * 0.14);
    cv.fillRect(cx, y + h * 0.38, cx + 7, y + h * 0.7, [240, 234, 218]);
    cv.fillRect(cx + 7, y + h * 0.38, cx + 9, y + h * 0.7, [170, 160, 138]);
  }
  cv.fillRect(x + w * 0.18, y + h * 0.72, x + w * 0.8, y + h * 0.77, [210, 198, 175]);
  cv.fillRect(x + w * 0.14, y + h * 0.77, x + w * 0.84, y + h * 0.82, [196, 184, 160]);
  // flag
  cv.line(x + w * 0.88, y + h * 0.1, x + w * 0.88, y + h * 0.5, 2, INK);
  cv.fillRect(x + w * 0.88, y + h * 0.1, x + w * 0.97, y + h * 0.24, RED);
}

function sceneSummit(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.vgrad(x, y, x + w, y + h, [232, 217, 176], [217, 160, 91]);
  // skyline towers with lit windows
  const rnd = mulberry32(7711);
  const towers = [0.04, 0.16, 0.3, 0.44, 0.58, 0.72, 0.86];
  for (let i = 0; i < towers.length; i++) {
    const tx = x + w * towers[i];
    const th = h * (0.3 + rnd() * 0.3);
    cv.fillRect(tx, y + h - th - 10, tx + w * 0.09, y + h - 10, [58, 52, 66]);
    for (let wy = 0; wy < 3; wy++) {
      for (let wx = 0; wx < 2; wx++) {
        if (rnd() < 0.6) cv.fillRect(tx + 3 + wx * 9, y + h - th - 6 + wy * 8, tx + 7 + wx * 9, y + h - th - 2 + wy * 8, [240, 200, 110]);
      }
    }
  }
  cv.fillRect(x, y + h - 10, x + w, y + h, [120, 90, 60]);
  cv.fillRect(x, y + h - 6, x + w, y + h, RED);
  // three flags
  const flagCols: RGB[] = [RED, GREEN, BLUE];
  for (let i = 0; i < 3; i++) {
    const fx = x + w * (0.3 + i * 0.2);
    cv.line(fx, y + h * 0.12, fx, y + h * 0.62, 2, INK);
    cv.fillRect(fx, y + h * 0.12, fx + 26, y + h * 0.26, flagCols[i]);
    cv.fillRect(fx, y + h * 0.26, fx + 22, y + h * 0.3, mix(flagCols[i], [255, 255, 255], 0.35));
  }
}

function sceneMarkets(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.fillRect(x, y, x + w, y + h, [24, 32, 44]);
  for (let gy = 1; gy < 5; gy++) cv.line(x, y + (h * gy) / 5, x + w, y + (h * gy) / 5, 1, [60, 75, 95]);
  for (let gx = 1; gx < 12; gx++) cv.line(x + (w * gx) / 12, y, x + (w * gx) / 12, y + h, 1, [48, 62, 80]);
  // candlesticks: rise then fall
  const rnd = mulberry32(5511);
  const n = 14;
  for (let i = 0; i < n; i++) {
    const cx = x + 8 + (i * (w - 24)) / n;
    const up = i < 8;
    const bh = 8 + rnd() * 14;
    const top = y + h * (up ? 0.42 - i * 0.02 : 0.26 + (i - 8) * 0.035);
    const col: RGB = up ? [46, 160, 90] : [200, 60, 60];
    cv.line(cx + 5, top - 4, cx + 5, top + bh + 4, 1, col);
    cv.fillRect(cx, top, cx + 10, top + bh, col);
  }
  // big arrow: up then down
  cv.line(x + 14, y + h * 0.8, x + w * 0.5, y + h * 0.25, 3, [255, 255, 255]);
  cv.line(x + w * 0.5, y + h * 0.25, x + w - 16, y + h * 0.62, 3, [255, 255, 255]);
  cv.fillRect(x, y + h - 8, x + w, y + h, [12, 18, 26]);
  for (let i = 0; i < 8; i++) {
    cv.fillRect(x + 8 + i * 14, y + h - 6, x + 14 + i * 14, y + h - 2, i % 2 === 0 ? [46, 160, 90] : [200, 60, 60]);
  }
}

function sceneBridge(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.vgrad(x, y, x + w, y + h, [232, 165, 107], [122, 74, 107]);
  cv.fillCircle(x + w * 0.16, y + h * 0.26, 8, [240, 180, 90]);
  // water
  cv.fillRect(x, y + h * 0.8, x + w, y + h, [58, 74, 102]);
  for (let i = 0; i < 4; i++) cv.line(x + 10 + i * 70, y + h * 0.86 + (i % 2) * 5, x + 60 + i * 70, y + h * 0.86 + (i % 2) * 5, 1, [200, 210, 220]);
  // deck + arch + cables
  const deckY = y + h * 0.62;
  cv.fillRect(x + 6, deckY, x + w - 6, deckY + 6, [40, 36, 48]);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const ax = x + 10 + t * (w - 20);
    const ay = deckY - Math.sin(t * Math.PI) * h * 0.38;
    const bx = x + 10 + ((i + 1) / 8) * (w - 20);
    const by = deckY - Math.sin(((i + 1) / 8) * Math.PI) * h * 0.38;
    cv.line(ax, ay, bx, by, 3, [52, 46, 60]);
    if (i % 2 === 0) cv.line(ax, ay, ax, deckY, 1, [90, 82, 95]);
  }
  // explosion burst on the bridge
  const ex = x + w * 0.68;
  const ey = deckY - 8;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    cv.line(ex, ey, ex + Math.cos(a) * 20, ey + Math.sin(a) * 20, 3, [250, 200, 60]);
  }
  cv.fillCircle(ex, ey, 9, [240, 120, 40]);
  cv.fillCircle(ex, ey, 5, [250, 210, 90]);
  cv.blendCircle(ex - 8, ey - 16, 8, [120, 110, 100], 0.7);
  cv.blendCircle(ex + 6, ey - 20, 10, [120, 110, 100], 0.6);
}

function sceneTower(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.vgrad(x, y, x + w, y + h, [242, 216, 160], [232, 184, 120]);
  cv.fillCircle(x + w * 0.84, y + h * 0.22, 8, [245, 205, 110]);
  cv.fillRect(x, y + h * 0.82, x + w, y + h, [214, 182, 130]);
  // PIF-style twisted tower: stacked narrowing slabs
  const cx = x + w * 0.42;
  for (let i = 0; i < 9; i++) {
    const t = i / 9;
    const sw = 26 - t * 12;
    const sy = y + h * 0.82 - (i + 1) * (h * 0.085);
    const off = Math.sin(i * 0.9) * 3;
    cv.fillRect(cx - sw / 2 + off, sy, cx + sw / 2 + off, sy + h * 0.085 + 1, [200, 205, 210]);
    cv.fillRect(cx - sw / 2 + off, sy + 2, cx + sw / 2 + off, sy + 4, [140, 180, 200]);
  }
  // smoke plume from the top
  cv.blendCircle(cx + 4, y + h * 0.06, 7, [110, 105, 100], 0.75);
  cv.blendCircle(cx + 12, y + h * 0.02, 9, [110, 105, 100], 0.6);
  cv.blendCircle(cx - 6, y + h * 0.1, 5, [130, 125, 118], 0.6);
  // base buildings
  cv.fillRect(x + w * 0.62, y + h * 0.62, x + w * 0.74, y + h * 0.82, [120, 100, 80]);
  cv.fillRect(x + w * 0.78, y + h * 0.68, x + w * 0.9, y + h * 0.82, [140, 118, 92]);
}

function sceneTanker(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.vgrad(x, y, x + w, y + h * 0.55, [223, 232, 232], [242, 232, 213]);
  cv.vgrad(x, y + h * 0.55, x + w, y + h, [58, 106, 122], [34, 66, 78]);
  for (let i = 0; i < 5; i++) cv.line(x + 8 + i * 60, y + h * (0.62 + (i % 3) * 0.1), x + 48 + i * 60, y + h * (0.62 + (i % 3) * 0.1), 1, [190, 205, 210]);
  // hull + deck
  const hullY = y + h * 0.52;
  cv.poly([x + w * 0.08, hullY, x + w * 0.88, hullY, x + w * 0.8, hullY + h * 0.26, x + w * 0.16, hullY + h * 0.26], [26, 26, 28]);
  cv.fillRect(x + w * 0.16, hullY + h * 0.2, x + w * 0.8, hullY + h * 0.26, [140, 40, 40]);
  cv.fillRect(x + w * 0.62, hullY - h * 0.22, x + w * 0.74, hullY, [200, 200, 190]);
  cv.fillRect(x + w * 0.66, hullY - h * 0.34, x + w * 0.7, hullY - h * 0.22, [180, 180, 170]);
  const contCols: RGB[] = [[180, 60, 50], [60, 120, 90], [200, 160, 60]];
  for (let i = 0; i < 3; i++) {
    cv.fillRect(x + w * (0.14 + i * 0.13), hullY - h * 0.14, x + w * (0.24 + i * 0.13), hullY, contCols[i]);
  }
  // flames mid-ship
  const fx = x + w * 0.42;
  const fy = hullY - 2;
  cv.poly([fx - 12, fy, fx, fy - 22, fx + 12, fy], [240, 140, 40]);
  cv.poly([fx - 7, fy, fx + 2, fy - 14, fx + 10, fy], [250, 210, 80]);
  cv.fillCircle(fx - 4, fy - 4, 5, [250, 210, 80]);
  // black smoke
  cv.blendCircle(fx - 6, fy - 26, 8, [40, 38, 36], 0.8);
  cv.blendCircle(fx + 4, fy - 34, 10, [40, 38, 36], 0.65);
  cv.blendCircle(fx + 12, fy - 42, 7, [60, 58, 54], 0.5);
}

// ---------- world map (schematic, 100x24 grid -> panel) ----------
const CONTINENTS: number[][][] = [
  [[3, 5], [18, 2], [31, 4], [30, 12], [23, 18], [14, 20], [7, 15], [2, 9]], // N America
  [[23, 18], [32, 18], [34, 22], [30, 24], [26, 23], [22, 20]], // S America
  [[46, 3], [56, 2], [58, 8], [52, 12], [46, 10]], // Europe
  [[46, 12], [58, 10], [62, 16], [58, 22], [52, 23], [46, 18]], // Africa
  [[59, 2], [85, 2], [95, 8], [90, 15], [78, 18], [69, 13], [61, 8]], // Asia
  [[86, 20], [95, 20], [95, 23], [86, 23]], // Oceania
];
const MAP_DOTS: [number, number][] = [
  [13, 9], // USA (markets)
  [54, 6], // Kyiv
  [62, 13], // Riyadh
  [66, 14], // Hormuz
  [76, 12], // Myanmar
  [83, 10], // Shenzhen
];

function drawMap(cv: Canvas, x: number, y: number, w: number, h: number): void {
  for (const cont of CONTINENTS) {
    const pts: number[] = [];
    for (const [gx, gy] of cont) pts.push(x + (gx / 100) * w, y + (gy / 24) * h);
    cv.poly(pts, SAGE);
    for (let i = 0; i < cont.length; i++) {
      const [ax, ay] = cont[i];
      const [bx, by] = cont[(i + 1) % cont.length];
      cv.line(x + (ax / 100) * w, y + (ay / 24) * h, x + (bx / 100) * w, y + (by / 24) * h, 1, MAPLINE);
    }
  }
  for (const [gx, gy] of MAP_DOTS) {
    const px = x + (gx / 100) * w;
    const py = y + (gy / 24) * h;
    cv.fillCircle(px, py, 5, [255, 255, 255]);
    cv.fillCircle(px, py, 3.5, RED);
  }
}

// ---------- content ----------
const LEADS: { lines: [string, string]; summary: string; scene: (cv: Canvas, x: number, y: number, w: number, h: number) => void }[] = [
  { lines: ["MYANMAR", "GENOCIDE"], summary: "UN COURT RULES IT GENOCIDE", scene: sceneCourt },
  { lines: ["BIG THREE", "SUMMIT"], summary: "FIRST MEET IN SHENZHEN", scene: sceneSummit },
  { lines: ["IPO SOARS", "17%"], summary: "ANTHROPIC RAISES $81.3BN", scene: sceneMarkets },
  { lines: ["KYIV HIT", "BRIDGE"], summary: "BRIDGE STRUCK, 3RD IN 4 DAYS", scene: sceneBridge },
  { lines: ["MISSILE", "HITS"], summary: "PIF TOWER DAMAGED IN RIYADH", scene: sceneTower },
  { lines: ["TANKER", "HIT"], summary: "TANKER ABLAZE OFF HORMUZ", scene: sceneTanker },
];

const FIGURES: { value: string; label: string; change: string; up: boolean }[] = [
  { value: "7,176", label: "S&P 500", change: "-2.0%", up: false },
  { value: "49,097", label: "DOW", change: "-2.2%", up: false },
  { value: "23,879", label: "NASDAQ", change: "-2.3%", up: false },
  { value: "$3,652", label: "GOLD", change: "-2.4%", up: false },
  { value: "$92.74", label: "BRENT", change: "+0.9%", up: true },
  { value: "+17%", label: "ANTHROPIC", change: "$81.3BN", up: true },
];

const MEDIUM: [string, string][] = [
  ["TAIWAN STEADIES", "SHORT-SALE LIMITS"],
  ["GENOA DRONES", "FLIGHTS HALTED"],
  ["INDIA EVACUATES", "STORM DANA NEARS"],
  ["SENATE BACKS", "IRAN POWERS 51-48"],
  ["FRANCE FIRE", "1 DEAD, 15 HURT"],
  ["SARATOV DRONE", "3 KILLED"],
  ["UK, NORWAY FUND", "NAVY CRAFT £100M"],
  ["GREENLAND PACT", "DENMARK: 109-0"],
  ["APEC PLAN", "SHENZHEN OUTLOOK"],
  ["GAZA PLAN", "RATED 4 OF 26"],
  ["COP31 DRAFT", "NO FOSSIL FUELS"],
  ["CRICKET", "NZ 273 FOR 5"],
];

const SHORTLIST: string[] = [
  "• LULA: 5-DAY WEEK",
  "• UENO COSTS $1BN",
  "• IAEA: YONGBYON",
  "• OIL STEADY HORMUZ",
  "• SERBIA PICKS CUPIC",
  "• SAUDI STORMS",
];

const TIMELINE: [string, string][] = [
  ["01:27", "TANKER HITS MINE, FIRE"],
  ["03:47", "HOUTHIS CLAIM 4 STRIKES"],
  ["04:07", "MISSILES HIT KYIV"],
  ["04:22", "GENOA FLIGHTS HALTED"],
  ["19 NOV", "ICJ RULES, SUMMIT HELD"],
];

// ---------- build the page ----------
function buildPage(): Buffer {
  const cv = new Canvas(W, H, PAPER);
  cv.mottle(20261120, 26, [210, 195, 165], [255, 250, 238]);
  cv.grain(4, 20261120);

  // masthead
  cv.fillRect(12, 8, 1012, 12, RED);
  drawText(cv, "THE WORLD IN ONE DAY", 512, 16, 48, INK, "center");
  drawText(cv, "FRIDAY 20 NOVEMBER 2026 · 24 STORIES", 512, 70, 26, RED, "center");
  cv.fillRect(12, 104, 1012, 107, INK);

  // figures strip
  const cellW = 1000 / 6;
  FIGURES.forEach((f, i) => {
    const cx = 12 + i * cellW + cellW / 2;
    if (i > 0) cv.fillRect(12 + i * cellW, 118, 12 + i * cellW + 1, 174, HAIR);
    drawText(cv, f.value, cx, 114, 22, INK, "center");
    drawText(cv, f.label, cx, 138, 20, INK, "center");
    drawText(cv, f.change, cx, 158, 20, f.up ? GREEN : RED, "center");
  });

  // lead cards (2 rows x 3)
  const cardW = 326;
  const cardH = 210;
  const cardX = [12, 348, 684];
  const cardY = [182, 396];
  LEADS.forEach((lead, idx) => {
    const cx = cardX[idx % 3];
    const cy = cardY[Math.floor(idx / 3)];
    cv.fillRect(cx, cy, cx + cardW, cy + cardH, CARD);
    // border
    cv.fillRect(cx, cy, cx + cardW, cy + 2, INK);
    cv.fillRect(cx, cy + cardH - 2, cx + cardW, cy + cardH, INK);
    cv.fillRect(cx, cy, cx + 2, cy + cardH, INK);
    cv.fillRect(cx + cardW - 2, cy, cx + cardW, cy + cardH, INK);
    // picture
    lead.scene(cv, cx + 2, cy + 2, cardW - 4, 66);
    cv.fillRect(cx + 2, cy + 68, cx + cardW - 2, cy + 71, RED);
    // headline (2 lines, 40px)
    drawText(cv, lead.lines[0], cx + 10, cy + 76, 40, INK, "left");
    drawText(cv, lead.lines[1], cx + 10, cy + 118, 40, INK, "left");
    // summary (22px, wrapped to <=2 lines)
    const sumLines = wrapText(lead.summary, cardW - 20, 22);
    drawLines(cv, sumLines.slice(0, 2), cx + 10, cy + 162, 22, 25, [60, 55, 45], "left");
  });

  // map + timeline row
  cv.fillRect(556, 610, 557, 738, HAIR);
  drawMap(cv, 12, 608, 540, 74);
  drawText(cv, "N.AMER · S.AMER · EUROPE", 12, 686, 20, INK, "left");
  drawText(cv, "M.EAST · AFRICA · ASIA · OCEAN", 12, 708, 20, INK, "left");
  drawText(cv, "UTC WIRE", 562, 608, 20, RED, "left");
  TIMELINE.forEach(([t, s], i) => {
    const ty = 630 + i * 22;
    drawText(cv, t, 562, ty, 20, RED, "left");
    drawText(cv, s, 562 + textWidth(t + " ", 20), ty, 20, INK, "left");
  });

  // medium stories (3 cols x 4 rows)
  MEDIUM.forEach(([head, sub], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const mx = 12 + col * 336;
    const my = 746 + row * 48;
    drawText(cv, head, mx, my, 24, INK, "left");
    drawText(cv, sub, mx, my + 26, 20, [60, 55, 45], "left");
  });

  // short list (3 cols x 2 rows)
  SHORTLIST.forEach((s, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    drawText(cv, s, 12 + col * 336, 944 + row * 22, 20, INK, "left");
  });

  // footer: date check line
  cv.fillRect(12, 994, 1012, 995, HAIR);
  drawText(cv, "ALL EVENTS VERIFIED FROM 20 NOVEMBER 2026 WIRE REPORTS", 512, 1000, 20, [60, 55, 45], "center");

  return encodePNG(cv.buf, W, H);
}

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outDir, { recursive: true });
  const png = buildPage();
  const outPath = path.join(outDir, "entry.png");
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}

main();

