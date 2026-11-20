// THE WORLD IN ONE DAY — Friday 20 November 2026 (v2)
// A smooth, anti-aliased newspaper front page drawn entirely in code.
// Rendered at 2048x2048 on an offscreen buffer, then box-downsampled to
// 1024x1024, so every edge — type and illustration — is smooth.
// Text uses a single-stroke vector font drawn as smooth stroked paths
// with round caps and joins. No bitmap/pixel font anywhere.
// Node 22, standard library only. Deterministic: seeded PRNG, no clock.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const S = 2; // supersample factor
const PW = 1024, PH = 1024; // page size in pixels
const W = PW * S, H = PH * S; // offscreen buffer size
const buf = new Uint8Array(W * H * 3);

// ---- seeded PRNG (deterministic) ----
let seed = 20261120;
function rnd(): number {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---- palette ----
const PAPER = [242, 234, 214];
const INK = [26, 23, 18];
const RED = [178, 39, 30];
const GREEN = [28, 122, 74];
const SAGE = [122, 154, 107];
const SAGE_D = [90, 122, 75];

// ---- low-level buffer primitives (buffer coordinates) ----
function fillPaper(r: number, g: number, b: number): void {
  for (let i = 0; i < W * H; i++) {
    const o = i * 3;
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
  }
}

function span(y: number, x0: number, x1: number, r: number, g: number, b: number, a: number): void {
  if (y < 0 || y >= H) return;
  let xa = Math.max(0, Math.ceil(x0));
  let xb = Math.min(W - 1, Math.floor(x1));
  if (xb < xa) return;
  let o = (y * W + xa) * 3;
  if (a >= 255) {
    for (let x = xa; x <= xb; x++) { buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; o += 3; }
    return;
  }
  const ia = 255 - a;
  for (let x = xa; x <= xb; x++) {
    buf[o] = (r * a + buf[o] * ia) / 255 | 0;
    buf[o + 1] = (g * a + buf[o + 1] * ia) / 255 | 0;
    buf[o + 2] = (b * a + buf[o + 2] * ia) / 255 | 0;
    o += 3;
  }
}

// Even-odd scanline polygon fill. pts: flat [x0,y0,x1,y1,...] in buffer coords.
function fillPoly(pts: number[], r: number, g: number, b: number, a = 255): void {
  const n = pts.length / 2;
  if (n < 3) return;
  let ymin = 1e9, ymax = -1e9;
  for (let i = 0; i < n; i++) {
    const y = pts[2 * i + 1];
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  ymin = Math.max(0, Math.floor(ymin));
  ymax = Math.min(H - 1, Math.ceil(ymax));
  const xs: number[] = [];
  for (let y = ymin; y <= ymax; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = pts[2 * i], y0 = pts[2 * i + 1];
      const x1 = pts[2 * j], y1 = pts[2 * j + 1];
      if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) {
        xs.push(x0 + (yc - y0) * (x1 - x0) / (y1 - y0));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) span(y, xs[k], xs[k + 1], r, g, b, a);
  }
}

// Filled disc (buffer coords).
function disc(cx: number, cy: number, rad: number, r: number, g: number, b: number, a = 255): void {
  if (rad <= 0) return;
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const dx = Math.sqrt(Math.max(0, rad * rad - dy * dy));
    span(y, cx - dx, cx + dx, r, g, b, a);
  }
}

// Stroked polyline with round caps and joins (buffer coords).
function stroke(pts: number[], w: number, r: number, g: number, b: number, a = 255): void {
  const n = pts.length / 2;
  if (n === 0) return;
  const hw = w / 2;
  if (n === 1) { disc(pts[0], pts[1], hw, r, g, b, a); return; }
  for (let i = 0; i + 1 < n; i++) {
    const x0 = pts[2 * i], y0 = pts[2 * i + 1];
    const x1 = pts[2 * i + 2], y1 = pts[2 * i + 3];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) { disc(x0, y0, hw, r, g, b, a); continue; }
    const nx = -dy / len * hw, ny = dx / len * hw;
    fillPoly([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny], r, g, b, a);
  }
  for (let i = 0; i < n; i++) disc(pts[2 * i], pts[2 * i + 1], hw, r, g, b, a);
}

// ---- page-coordinate helpers (page coords are multiplied by S) ----
function P(pts: number[]): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i++) out[i] = pts[i] * S;
  return out;
}
function poly(pts: number[], c: number[], a = 255): void { fillPoly(P(pts), c[0], c[1], c[2], a); }
function rect(x: number, y: number, w: number, h: number, c: number[], a = 255): void {
  poly([x, y, x + w, y, x + w, y + h, x, y + h], c, a);
}
function ellipse(cx: number, cy: number, rx: number, ry: number, c: number[], a = 255): void {
  poly(arcPts(cx, cy, rx, ry, 0, 360, 40), c, a);
}
function circle(cx: number, cy: number, r: number, c: number[], a = 255): void {
  ellipse(cx, cy, r, r, c, a);
}
function line(pts: number[], w: number, c: number[], a = 255): void {
  stroke(P(pts), w * S, c[0], c[1], c[2], a);
}
// Vertical gradient rectangle (page coords).
function vgrad(x: number, y: number, w: number, h: number, c0: number[], c1: number[]): void {
  const y0 = Math.max(0, Math.round(y * S));
  const y1 = Math.min(H, Math.round((y + h) * S));
  const x0 = Math.round(x * S), x1 = Math.round((x + w) * S);
  for (let yy = y0; yy < y1; yy++) {
    const t = (yy / S - y) / h;
    const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
    const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
    const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
    span(yy, x0, x1, r, g, b, 255);
  }
}
// Soft radial glow (page coords). peak: 0..1 opacity at the centre.
function glow(cx: number, cy: number, rad: number, c: number[], peak: number): void {
  const bx = cx * S, by = cy * S, br = rad * S;
  const x0 = Math.max(0, Math.floor(bx - br)), x1 = Math.min(W - 1, Math.ceil(bx + br));
  const y0 = Math.max(0, Math.floor(by - br)), y1 = Math.min(H - 1, Math.ceil(by + br));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - bx) / br, dy = (y + 0.5 - by) / br;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      const f = 1 - d2;
      const ai = Math.round(peak * f * f * 255);
      if (ai <= 0) continue;
      const o = (y * W + x) * 3, ia = 255 - ai;
      buf[o] = (c[0] * ai + buf[o] * ia) / 255 | 0;
      buf[o + 1] = (c[1] * ai + buf[o + 1] * ia) / 255 | 0;
      buf[o + 2] = (c[2] * ai + buf[o + 2] * ia) / 255 | 0;
    }
  }
}

// ---- curve helpers (page coords, flat [x,y,...] arrays) ----
function arcPts(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, steps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (a0 + (a1 - a0) * i / steps) * Math.PI / 180;
    out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return out;
}
function cubic(p0: number[], p1: number[], p2: number[], p3: number[], steps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push(
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    );
  }
  return out;
}
function quad(p0: number[], p1: number[], p2: number[], steps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push(u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]);
  }
  return out;
}
// Closed Catmull-Rom spline through control points (smooth organic blob).
function smoothClosed(pts: number[], per = 14): number[] {
  const out: number[] = [];
  const n = pts.length / 2;
  const at = (i: number): [number, number] => {
    const k = ((i % n) + n) % n;
    return [pts[2 * k], pts[2 * k + 1]];
  };
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let j = 0; j < per; j++) {
      const t = j / per, t2 = t * t, t3 = t2 * t;
      out.push(
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
      );
    }
  }
  return out;
}

// ---- smooth single-stroke vector font ----
// Each glyph is a list of strokes; each stroke is a flat [x,y,...] polyline
// on a 9-wide x 12-tall grid (cap top y=0, baseline y=12). Advance is 10
// units. Rendered as smooth stroked paths with round caps/joins — never
// as a grid of square pixels.
const FONT: Record<string, number[][]> = {
  A: [[[0.5, 12], [4.5, 0], [8.5, 12]], [[2.8, 7.5], [6.2, 7.5]]],
  B: [[[0.5, 0], [0.5, 12]], [[0.5, 0], [5, 0], [7, 1.5], [7, 4], [5, 6], [0.5, 6]], [[0.5, 6], [5, 6], [7.5, 7.5], [7.5, 10], [5, 12], [0.5, 12]]],
  C: [arcPts(4.5, 6, 4, 6, 55, 305, 20)],
  D: [[[0.5, 0], [0.5, 12]], [[0.5, 0], [5, 0], [8, 3], [8, 9], [5, 12], [0.5, 12]]],
  E: [[[0.5, 0], [0.5, 12]], [[0.5, 0], [7.5, 0]], [[0.5, 6], [5.5, 6]], [[0.5, 12], [7.5, 12]]],
  F: [[[0.5, 0], [0.5, 12]], [[0.5, 0], [7.5, 0]], [[0.5, 6], [5.5, 6]]],
  G: [arcPts(4.5, 6, 4, 6, 45, 315, 20), [[8.5, 7], [5, 7]], [[8.5, 7], [8.5, 9.5], [7, 12], [4.5, 12]]],
  H: [[[0.5, 0], [0.5, 12]], [[8.5, 0], [8.5, 12]], [[0.5, 6], [8.5, 6]]],
  I: [[[4.5, 0], [4.5, 12]], [[1.5, 0], [7.5, 0]], [[1.5, 12], [7.5, 12]]],
  J: [[[8, 0], [8, 9.5], [6.5, 12], [2.5, 12], [1, 10]], [[4.5, 0], [8, 0]]],
  K: [[[0.5, 0], [0.5, 12]], [[7.5, 0], [1.5, 6.5]], [[3.5, 7.5], [8.5, 12]]],
  L: [[[0.5, 0], [0.5, 12]], [[0.5, 12], [7.5, 12]]],
  M: [[[0.5, 12], [0.5, 0], [4.5, 8], [8.5, 0], [8.5, 12]]],
  N: [[[0.5, 12], [0.5, 0], [8.5, 12], [8.5, 0]]],
  O: [arcPts(4.5, 6, 4, 6, 0, 360, 28)],
  P: [[[0.5, 0], [0.5, 12]], [[0.5, 0], [5, 0], [7, 1.5], [7, 4.5], [5, 6], [0.5, 6]]],
  Q: [arcPts(4.5, 6, 4, 6, 0, 360, 28), [[6, 8], [8.5, 12]]],
  R: [[[0.5, 0], [0.5, 12]], [[0.5, 0], [5, 0], [7, 1.5], [7, 4.5], [5, 6], [0.5, 6]], [[4, 6], [8.5, 12]]],
  S: [[[7.5, 2], [5.5, 0], [2.5, 0], [0.5, 2], [0.5, 4.5], [2, 6], [6.5, 6], [8.5, 7.5], [8.5, 10], [6.5, 12], [3.5, 12], [1.5, 10]]],
  T: [[[0.5, 0], [8.5, 0]], [[4.5, 0], [4.5, 12]]],
  U: [[[0.5, 0], [0.5, 9], [1.5, 11], [3.5, 12], [5.5, 12], [7.5, 11], [8.5, 9], [8.5, 0]]],
  V: [[[0.5, 0], [4.5, 12], [8.5, 0]]],
  W: [[[0.5, 0], [2.2, 12], [4.5, 6], [6.8, 12], [8.5, 0]]],
  X: [[[0.5, 0], [8.5, 12]], [[8.5, 0], [0.5, 12]]],
  Y: [[[0.5, 0], [4.5, 6], [8.5, 0]], [[4.5, 6], [4.5, 12]]],
  Z: [[[0.5, 0], [8.5, 0], [0.5, 12], [8.5, 12]]],
  "0": [arcPts(4.5, 6, 3.8, 6, 0, 360, 28)],
  "1": [[[2.5, 3], [4.5, 0], [4.5, 12]], [[1.5, 12], [7.5, 12]]],
  "2": [[[0.5, 3], [1.5, 1], [3.5, 0], [5.5, 0], [7.5, 1], [7.5, 3], [7.5, 5], [0.5, 12], [8.5, 12]]],
  "3": [[[0.5, 2], [2.5, 0], [5.5, 0], [7.5, 2], [7.5, 4], [5.5, 6], [3.5, 6]], [[5.5, 6], [7.5, 8], [7.5, 10], [5.5, 12], [2.5, 12], [0.5, 10]]],
  "4": [[[6.5, 0], [6.5, 12]], [[0.5, 9], [8.5, 9]], [[7.5, 0], [0.5, 9]]],
  "5": [[[7.5, 0], [0.5, 0], [0.5, 5], [2.5, 6], [5.5, 6], [7.5, 8], [7.5, 10], [5.5, 12], [2.5, 12], [0.5, 10]]],
  "6": [[[7.5, 1], [5.5, 0], [2.5, 0], [0.5, 2], [0.5, 9], [2, 11.5], [4.5, 12], [6.5, 11], [7.5, 9], [7, 7], [5, 6], [3, 6], [1.5, 7.5]]],
  "7": [[[0.5, 0], [8.5, 0], [3.5, 12]]],
  "8": [arcPts(4.5, 3.5, 3, 3, 0, 360, 20), arcPts(4.5, 8.5, 3.5, 3.5, 0, 360, 20)],
  "9": [arcPts(4.5, 4, 3.5, 3.5, 0, 360, 20), [[8, 4], [8, 9], [6.5, 12], [3.5, 12], [1, 10]]],
  ".": [[[4.5, 11], [4.5, 11]]],
  ",": [[[4.5, 11], [4.5, 11]], [[4.5, 11], [3, 13.5]]],
  ":": [[[4.5, 4.5], [4.5, 4.5]], [[4.5, 10.5], [4.5, 10.5]]],
  ";": [[[4.5, 4.5], [4.5, 4.5]], [[4.5, 10.5], [4.5, 10.5]], [[4.5, 10.5], [3, 13.5]]],
  "-": [[[1.5, 6], [7.5, 6]]],
  "–": [[[0.5, 6], [8.5, 6]]],
  "—": [[[0, 6], [9, 6]]],
  "+": [[[4.5, 2], [4.5, 10]], [[1, 6], [8, 6]]],
  "%": [[[1.8, 11], [7.2, 1]], [[2.5, 3], [2.5, 3]], [[6.5, 9], [6.5, 9]]],
  "$": [[[7, 2], [5, 0], [2, 0], [0.5, 2], [0.5, 4], [2, 5], [6, 6], [8, 8], [8, 10], [6, 12], [4, 12], [2, 11]], [[4.5, -1], [4.5, 13]]],
  "£": [[[7.5, 1], [5.5, 0], [2.5, 0], [0.5, 2], [0.5, 10], [2.5, 12], [5.5, 12]], [[0.5, 6], [6.5, 6]]],
  "'": [[[4.5, 0], [3.5, 3]]],
  "’": [[[4.5, 0], [3.5, 3]]],
  '"': [[[2.5, 0], [1.5, 3]], [[6.5, 0], [5.5, 3]]],
  "(": [[[7, 1], [5, 3], [4.5, 6], [5, 9], [7, 11]]],
  ")": [[[2, 1], [4, 3], [4.5, 6], [4, 9], [2, 11]]],
  "!": [[[4.5, 0], [4.5, 9]], [[4.5, 11], [4.5, 11]]],
  "?": [[[1.5, 3], [2.5, 1], [5, 0], [7, 1], [7, 3], [6, 5], [4.5, 6], [4.5, 8]], [[4.5, 11], [4.5, 11]]],
  "/": [[[1.5, 12], [7.5, 0]]],
  "*": [[[4.5, 1], [4.5, 11]], [[1, 4], [8, 8]], [[8, 4], [1, 8]]],
  "=": [[[1, 4], [8, 4]], [[1, 8], [8, 8]]],
  "·": [[[4.5, 6], [4.5, 6]]],
  "•": [[[4.5, 6], [4.5, 6]]],
};

const ADV = 10; // advance width in font units
function glyphAdvance(ch: string): number { return ch === " " ? 6 : ADV; }
function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += glyphAdvance(ch);
  return (w * size) / 12;
}

function drawGlyph(ch: string, x: number, y: number, size: number, w: number, c: number[]): void {
  const g = FONT[ch];
  if (!g) return;
  const k = size / 12;
  for (const st of g) {
    const pts: number[] = [];
    if (Array.isArray(st[0])) {
      // Stroke stored as nested [x, y] point pairs.
      for (const p of st as unknown as number[][]) pts.push((x + p[0] * k) * S, (y + p[1] * k) * S);
    } else {
      // Stroke stored as a flat [x, y, ...] array (arcPts output).
      for (let i = 0; i < st.length; i += 2) pts.push((x + (st[i] as number) * k) * S, (y + (st[i + 1] as number) * k) * S);
    }
    stroke(pts, w * S, c[0], c[1], c[2], 255);
  }
}

// Draw one line of text. x,y = top-left of the cap-height box (page coords).
// align: 'l' | 'c' | 'r' — for 'c'/'r', x is the centre / right edge.
function drawText(text: string, x: number, y: number, size: number, c: number[], weight = 0.11, align: "l" | "c" | "r" = "l"): void {
  const wpx = textWidth(text, size);
  let sx = x;
  if (align === "c") sx = x - wpx / 2;
  if (align === "r") sx = x - wpx;
  const sw = size * weight;
  let cx = sx;
  for (const ch of text) {
    if (ch !== " ") drawGlyph(ch, cx, y, size, sw, c);
    cx += (glyphAdvance(ch) * size) / 12;
  }
}

// Greedy word wrap, at most maxLines lines.
function wrapText(text: string, size: number, maxW: number, maxLines: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const wd of words) {
    const t = cur ? cur + " " + wd : wd;
    if (textWidth(t, size) <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = wd; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

// ---- the six lead illustrations (page coords; box x,y,w,h) ----
function flame(fx: number, fy: number, s: number): void {
  // Layered teardrop flame, base at (fx, fy), height ~ s.
  const outer = cubic([fx - 0.32 * s, fy], [fx - 0.38 * s, fy - 0.45 * s], [fx - 0.12 * s, fy - 0.75 * s], [fx, fy - s])
    .concat(cubic([fx, fy - s], [fx + 0.12 * s, fy - 0.75 * s], [fx + 0.38 * s, fy - 0.45 * s], [fx + 0.32 * s, fy]).slice(2));
  poly(outer, [255, 122, 42]);
  const mid = cubic([fx - 0.2 * s, fy], [fx - 0.24 * s, fy - 0.35 * s], [fx - 0.08 * s, fy - 0.55 * s], [fx, fy - 0.72 * s])
    .concat(cubic([fx, fy - 0.72 * s], [fx + 0.08 * s, fy - 0.55 * s], [fx + 0.24 * s, fy - 0.35 * s], [fx + 0.2 * s, fy]).slice(2));
  poly(mid, [255, 190, 60]);
  const inner = cubic([fx - 0.1 * s, fy], [fx - 0.12 * s, fy - 0.2 * s], [fx - 0.04 * s, fy - 0.32 * s], [fx, fy - 0.45 * s])
    .concat(cubic([fx, fy - 0.45 * s], [fx + 0.04 * s, fy - 0.32 * s], [fx + 0.12 * s, fy - 0.2 * s], [fx + 0.1 * s, fy]).slice(2));
  poly(inner, [255, 233, 168]);
}

// (a) Courthouse in warm light.
function sceneCourt(x: number, y: number, w: number, h: number): void {
  vgrad(x, y, w, h, [249, 227, 184], [232, 184, 120]);
  glow(x + w * 0.84, y + 20, 24, [255, 233, 168], 0.6);
  circle(x + w * 0.84, y + 20, 8, [255, 215, 106]);
  rect(x, y + h - 16, w, 16, [201, 168, 106]);
  rect(x, y + h - 8, w, 8, [185, 151, 92]);
  rect(x + 52, y + 72, 220, 5, [120, 90, 50], 70);
  const cx = x + w / 2;
  poly([cx - 100, y + 50, cx + 100, y + 50, cx, y + 26], [232, 217, 184]);
  rect(cx - 100, y + 50, 200, 7, [217, 196, 154]);
  line([cx, y + 26, cx, y + 12], 2, [90, 70, 45]);
  poly([cx, y + 12, cx + 18, y + 16, cx, y + 20], RED);
  for (let i = 0; i < 5; i++) {
    const colx = cx - 80 + i * 40;
    rect(colx - 5, y + 57, 10, 29, [242, 230, 200]);
    rect(colx + 2, y + 57, 3, 29, [201, 184, 140]);
    rect(colx - 7, y + 57, 14, 3, [232, 217, 184]);
    rect(colx - 7, y + 83, 14, 3, [217, 196, 154]);
  }
  rect(cx - 6, y + 68, 12, 18, [96, 74, 48]);
  rect(cx - 110, y + 86, 220, 3, [185, 155, 98]);
  rect(cx - 116, y + 89, 232, 3, [169, 139, 87]);
}

// (b) Summit skyline at dusk with three flags.
function sceneSkyline(x: number, y: number, w: number, h: number): void {
  vgrad(x, y, w, h, [46, 58, 94], [232, 151, 106]);
  for (let i = 0; i < 12; i++) circle(x + rnd() * w, y + rnd() * h * 0.35, 1.2, [255, 255, 255], 150);
  for (let i = 0; i < 10; i++) {
    const bx = x + i * 34 + rnd() * 10, bw = 22 + rnd() * 14, bh = 18 + rnd() * 22;
    rect(bx, y + h - 26 - bh, bw, bh, [107, 90, 126]);
  }
  for (let i = 0; i < 7; i++) {
    const bx = x + i * 48 + rnd() * 8, bw = 26 + rnd() * 16, bh = 30 + rnd() * 26;
    const top = y + h - 26 - bh;
    rect(bx, top, bw, bh, [35, 39, 65]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) {
      if (rnd() < 0.6) circle(bx + 7 + c * 12, top + 8 + r * 10, 1.4, [255, 201, 120], 200);
    }
  }
  const flags: number[][] = [RED, [47, 90, 200], [47, 138, 79]];
  for (let i = 0; i < 3; i++) {
    const px = x + 48 + i * 114;
    line([px, y + 10, px, y + 44], 2, [30, 32, 50]);
    poly([px, y + 10, px + 20, y + 12, px + 26, y + 16, px + 20, y + 20, px, y + 18], flags[i]);
  }
  rect(x, y + h - 12, w, 12, [27, 30, 51]);
}

// (c) Market candlestick chart with depth and glow.
function sceneChart(x: number, y: number, w: number, h: number): void {
  vgrad(x, y, w, h, [18, 35, 63], [11, 22, 38]);
  for (let gy = y + 18; gy < y + h - 4; gy += 18) line([x + 6, gy, x + w - 6, gy], 1, [255, 255, 255], 26);
  for (let gx = x + 27; gx < x + w - 4; gx += 27) line([gx, y + 6, gx, y + h - 4], 1, [255, 255, 255], 18);
  const tops: number[] = [];
  for (let i = 0; i < 13; i++) {
    const cx = x + 14 + i * 23;
    const bh = 14 + rnd() * 28;
    const top = y + 22 + rnd() * 34;
    const up = rnd() > 0.45;
    const c = up ? [47, 191, 113] : [232, 74, 74];
    line([cx + 5, top - 6, cx + 5, top + bh + 6], 1.5, c);
    rect(cx, top, 10, bh, c);
    tops.push(top + (up ? 2 : bh - 2));
  }
  const tp: number[] = [];
  for (let i = 0; i < tops.length; i++) tp.push(x + 19 + i * 23, tops[i]);
  const linePts = cubic([tp[0], tp[1]], [tp[0] + 60, tp[1] - 16], [tp[tp.length - 2] - 60, tp[tp.length - 1] - 10], [tp[tp.length - 2], tp[tp.length - 1]], 40);
  const area = linePts.concat([tp[tp.length - 2], y + h - 4, tp[0], y + h - 4]);
  poly(area, [255, 255, 255], 18);
  line(linePts, 9, [255, 255, 255], 50);
  line(linePts, 3, [255, 255, 255]);
  circle(tp[tp.length - 2], tp[tp.length - 1], 3.5, [255, 255, 255]);
}

// (d) Bridge over a strait at night, fire glow on the water.
function sceneBridge(x: number, y: number, w: number, h: number): void {
  vgrad(x, y, w, h, [26, 34, 66], [107, 58, 82]);
  for (let i = 0; i < 10; i++) circle(x + rnd() * w, y + rnd() * h * 0.4, 1.1, [255, 255, 255], 140);
  glow(x + 40, y + 16, 18, [242, 233, 200], 0.5);
  circle(x + 40, y + 16, 7, [242, 233, 200]);
  const arcY = (t: number): number => y + 52 - 38 * 4 * t * (1 - t);
  const arcPts2 = cubic([x, y + 52], [x + 80, y + 14], [x + w - 80, y + 14], [x + w, y + 52], 40);
  line(arcPts2, 3.5, [42, 47, 69]);
  for (let i = 1; i < 12; i++) {
    const t = i / 12, px = x + t * w;
    line([px, arcY(t), px, y + 52], 1, [120, 130, 170], 130);
  }
  rect(x, y + 52, w, 6, [20, 24, 36]);
  vgrad(x, y + 58, w, h - 58, [30, 46, 74], [14, 22, 38]);
  for (let i = 0; i < 6; i++) {
    const yy = y + 64 + i * 4.5;
    line([x + 12 + rnd() * 40, yy, x + 150 + rnd() * 120, yy], 1.5, [140, 170, 210], 70);
  }
  const fx = x + w * 0.8;
  glow(fx, y + 66, 30, [255, 122, 42], 0.75);
  flame(fx, y + 70, 20);
  for (let i = 0; i < 4; i++) rect(fx - 14 + i * 8, y + 72 + i * 3, 22 - i * 4, 2, [255, 140, 60], 120 - i * 20);
  for (let i = 0; i < 8; i++) circle(x + 20 + rnd() * 90, y + 46 + rnd() * 6, 1.3, [255, 201, 120], 170);
}

// (e) Glass tower with reflections and thin smoke wisps.
function sceneTower(x: number, y: number, w: number, h: number): void {
  vgrad(x, y, w, h, [232, 168, 124], [126, 143, 181]);
  glow(x + 40, y + 70, 26, [255, 200, 140], 0.5);
  const cx = x + w / 2, top = y + 4, bot = y + h;
  const hwAt = (yy: number): number => 32 + (56 - 32) * ((yy - y) / h);
  for (let i = 0; i < 10; i++) {
    const y0 = top + (i * (bot - top)) / 10, y1 = top + ((i + 1) * (bot - top)) / 10;
    const t = i / 10;
    const c = [Math.round(191 + (62 - 191) * t), Math.round(212 + (90 - 212) * t), Math.round(232 + (132 - 232) * t)];
    poly([cx - hwAt(y0), y0, cx + hwAt(y0), y0, cx + hwAt(y1), y1, cx - hwAt(y1), y1], c);
  }
  for (let r = 0; r < 9; r++) {
    const wy = top + 8 + r * 9;
    const hw = hwAt(wy) - 8;
    for (let c = 0; c < 5; c++) {
      const wx = cx - hw + (c * 2 * hw) / 5 + 3;
      const lit = rnd() < 0.35;
      rect(wx, wy, 7, 4, lit ? [255, 217, 138] : [42, 62, 94], lit ? 230 : 200);
    }
  }
  poly([cx - 6, top + 6, cx + 14, top + 6, cx - 16, bot - 6, cx - 36, bot - 6], [255, 255, 255], 34);
  poly([cx + 26, top + 6, cx + 38, top + 6, cx + 8, bot - 6, cx - 4, bot - 6], [255, 255, 255], 26);
  line(cubic([cx + 6, top + 2], [cx + 26, top + 8], [cx + 44, top + 4], [cx + 62, top + 12], 20), 4, [205, 205, 210], 80);
  line(cubic([cx - 8, top + 6], [cx - 24, top + 12], [cx - 40, top + 8], [cx - 56, top + 16], 20), 3.5, [205, 205, 210], 70);
  rect(x, y + h - 8, w, 8, [42, 46, 62]);
}

// (f) Tanker at sea with waves and a warm fire glow.
function sceneTanker(x: number, y: number, w: number, h: number): void {
  vgrad(x, y, w, h, [207, 224, 234], [242, 217, 168]);
  ellipse(x + 60, y + 14, 26, 6, [255, 255, 255], 70);
  ellipse(x + 250, y + 10, 30, 5, [255, 255, 255], 60);
  vgrad(x, y + 52, w, h - 52, [46, 107, 122], [18, 48, 62]);
  line(cubic([x, y + 60], [x + 80, y + 56], [x + 170, y + 64], [x + w, y + 58], 24), 2.5, [127, 179, 196], 150);
  line(cubic([x, y + 72], [x + 90, y + 68], [x + 180, y + 76], [x + w, y + 70], 24), 2.5, [90, 147, 168], 140);
  line(cubic([x, y + 84], [x + 100, y + 80], [x + 190, y + 88], [x + w, y + 82], 24), 2.5, [62, 114, 134], 130);
  const cont: number[][] = [[200, 74, 58], [58, 122, 200], [58, 168, 90], [200, 168, 58], [122, 90, 200]];
  for (let i = 0; i < 5; i++) rect(x + 50 + i * 36, y + 38 + (i % 2) * 2, 32, 14 - (i % 2) * 2, cont[i]);
  rect(x + 246, y + 30, 40, 22, [232, 232, 226]);
  for (let i = 0; i < 3; i++) rect(x + 252 + i * 11, y + 36, 7, 5, [42, 62, 94]);
  rect(x + 232, y + 36, 12, 16, [200, 74, 58]);
  poly([[x + 28, y + 52], [x + 296, y + 52], [x + 288, y + 68], [x + 36, y + 68]], [28, 34, 43]);
  rect(x + 30, y + 64, 262, 4, [168, 58, 46]);
  const fx = x + 150;
  glow(fx, y + 48, 28, [255, 122, 42], 0.8);
  flame(fx, y + 50, 20);
  line(cubic([fx + 4, y + 34], [fx + 16, y + 26], [fx + 28, y + 30], [fx + 40, y + 20], 16), 3.5, [205, 205, 210], 90);
  line(cubic([fx - 6, y + 32], [fx - 18, y + 24], [fx - 30, y + 28], [fx - 42, y + 18], 16), 3, [205, 205, 210], 80);
  rect(fx - 20, y + 70, 44, 2, [255, 140, 60], 130);
  rect(fx - 14, y + 76, 32, 2, [255, 140, 60], 100);
  rect(fx - 8, y + 82, 20, 2, [255, 140, 60], 80);
}

// ---- world map (box x=14, y=650, w=406, h=82) ----
const MAP_X = 14, MAP_Y = 636;
function mapPoly(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(MAP_X + pts[i], MAP_Y + pts[i + 1]);
  return out;
}
const CONTINENTS: number[][] = [
  [18, 14, 48, 6, 86, 8, 118, 16, 128, 30, 112, 44, 84, 52, 52, 50, 28, 38, 12, 26],
  [128, 40, 148, 36, 162, 46, 158, 64, 142, 78, 130, 66, 124, 52],
  [146, 8, 164, 4, 172, 12, 158, 18, 144, 14],
  [196, 14, 214, 8, 232, 12, 236, 24, 224, 32, 204, 30, 192, 22],
  [196, 36, 214, 32, 238, 38, 244, 52, 232, 72, 214, 78, 198, 62, 192, 48],
  [248, 10, 290, 6, 330, 10, 362, 20, 356, 38, 330, 52, 296, 54, 262, 44, 246, 28],
  [322, 62, 348, 56, 372, 62, 366, 74, 338, 76, 324, 70],
];
const MAP_DOTS: number[][] = [
  [95, 32], [212, 20], [228, 24], [245, 40], [258, 44], [320, 38],
];

// ---- content (verified facts only) ----
const FIGURES: [string, string, string, number[]][] = [
  ["7,176", "S&P 500", "-2.0%", RED],
  ["49,097", "DOW", "-2.2%", RED],
  ["23,879", "NASDAQ", "-2.3%", RED],
  ["$3,652", "GOLD", "-2.4%", RED],
  ["$92.74", "BRENT", "+0.9%", GREEN],
  ["+17%", "ANTHROPIC", "$81.3BN", GREEN],
];
const CARDS: [string, string, (x: number, y: number, w: number, h: number) => void][] = [
  ["MYANMAR GENOCIDE", "UN COURT RULES IT GENOCIDE", sceneCourt],
  ["BIG THREE SUMMIT", "FIRST MEET IN SHENZHEN", sceneSkyline],
  ["IPO SOARS 17%", "ANTHROPIC RAISES $81.3BN", sceneChart],
  ["KYIV HIT BRIDGE", "BRIDGE STRUCK, 3RD IN 4 DAYS", sceneBridge],
  ["MISSILE STRIKE", "PIF TOWER DAMAGED IN RIYADH", sceneTower],
  ["TANKER HIT", "TANKER ABLAZE OFF HORMUZ", sceneTanker],
];
const WIRE: [string, string][] = [
  ["01:27", "TANKER HITS MINE, FIRE"],
  ["03:47", "HOUTHIS CLAIM 4 STRIKES"],
  ["04:07", "FOUR MISSILES HIT KYIV"],
  ["04:22", "GENOA AIRPORT HALTS FLIGHTS"],
  ["19 NOV", "ICJ: MYANMAR GENOCIDE"],
  ["19 NOV", "TRUMP–XI–PUTIN SUMMIT"],
];
const MEDIUM: [string, string][][] = [
  [["TAIWAN STEADIES", "SHORT-SALE LIMITS"], ["GENOA DRONES", "FLIGHTS HALTED"], ["INDIA EVACUATES", "STORM DANA NEARS"], ["SENATE 51–48", "IRAN POWERS STAND"]],
  [["FRANCE FIRE", "1 DEAD · 15 HURT"], ["UK, NORWAY FUND", "NAVY CRAFT £100M"], ["GREENLAND PACT", "DENMARK: 109–0"], ["GAZA PLAN", "RATED 4 OF 26"]],
  [["FAITH SHIFT", "TOP FAITH BY 2035"], ["COP31 DRAFT", "NO FOSSIL FUELS"], ["SENEGAL BOAT", "DOZENS MISSING"], ["CRICKET", "NZ 273 FOR 5"]],
];
const SHORT: string[][] = [
  ["LULA: 5-DAY WEEK", "UENO COSTS $1BN", "IAEA: YONGBYON"],
  ["OIL STEADY HORMUZ", "SERBIA PICKS CUPIC", "SAUDI STORMS"],
];

// ---- page layout ----
function drawPage(): void {
  fillPaper(PAPER[0], PAPER[1], PAPER[2]);
  rect(14, 6, 996, 3, RED);
  rect(14, 12, 996, 1, INK);
  drawText("THE WORLD IN ONE DAY", 512, 16, 52, INK, 0.13, "c");
  drawText("FRIDAY 20 NOVEMBER 2026 · 24 STORIES · VERIFIED", 512, 72, 24, RED, 0.12, "c");
  rect(14, 100, 996, 1, INK);
  // Figures strip.
  for (let i = 0; i < 6; i++) {
    const cx = 14 + i * (996 / 6) + 996 / 12;
    if (i > 0) line([14 + i * (996 / 6), 106, 14 + i * (996 / 6), 172], 1, INK, 70);
    drawText(FIGURES[i][0], cx, 104, 26, INK, 0.13, "c");
    drawText(FIGURES[i][1], cx, 132, 20, INK, 0.11, "c");
    drawText(FIGURES[i][2], cx, 154, 20, FIGURES[i][3], 0.11, "c");
  }
  // Six lead cards.
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const k = r * 3 + c;
      const cx = 14 + c * 336, cy = 178 + r * 229;
      CARDS[k][2](cx + 1, cy + 1, 322, 85);
      const hl = wrapText(CARDS[k][0], 40, 312, 2);
      for (let i = 0; i < hl.length; i++) drawText(hl[i], cx + 162, cy + 89 + i * 42, 40, INK, 0.13, "c");
      const sm = wrapText(CARDS[k][1], 22, 312, 2);
      for (let i = 0; i < sm.length; i++) drawText(sm[i], cx + 162, cy + 177 + i * 22, 22, INK, 0.11, "c");
      line([cx, cy, cx + 324, cy, cx + 324, cy + 225, cx, cy + 225, cx, cy], 1.5, INK);
    }
  }
  // World map + region labels.
  for (const cont of CONTINENTS) {
    const sm = smoothClosed(mapPoly(cont), 12);
    poly(sm, SAGE);
    const closed = sm.concat([sm[0], sm[1]]);
    line(closed, 1.5, SAGE_D);
  }
  for (const d of MAP_DOTS) {
    circle(MAP_X + d[0], MAP_Y + d[1], 5, [255, 255, 255]);
    circle(MAP_X + d[0], MAP_Y + d[1], 3.5, RED);
  }
  drawText("N.AMER S.AMER EUROPE", MAP_X + 203, 720, 20, INK, 0.11, "c");
  drawText("M.EAST AFRICA ASIA OCEAN", MAP_X + 203, 742, 20, INK, 0.11, "c");
  // UTC wire.
  drawText("UTC WIRE", 430, 636, 20, RED, 0.12, "l");
  for (let i = 0; i < WIRE.length; i++) {
    const y = 657 + i * 21;
    drawText(WIRE[i][0], 430, y, 20, RED, 0.12, "l");
    drawText(WIRE[i][1], 535, y, 20, INK, 0.11, "l");
  }
  // Medium stories.
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 4; r++) {
      const y = 786 + r * 48;
      const x = 14 + c * 336;
      drawText(MEDIUM[c][r][0], x, y, 24, INK, 0.12, "l");
      drawText(MEDIUM[c][r][1], x, y + 24, 20, INK, 0.11, "l");
    }
  }
  // Short list.
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      drawText(SHORT[r][c], 14 + c * 336, 982 + r * 21, 20, INK, 0.11, "l");
    }
  }
}

// ---- PNG encode + 2x box downsample ----
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)])), 8 + data.length);
  return out;
}
function encodePNG(rgb: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}
function downsample(): Uint8Array {
  const out = new Uint8Array(PW * PH * 3);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < S; dy++) {
        for (let dx = 0; dx < S; dx++) {
          const o = ((y * S + dy) * W + x * S + dx) * 3;
          r += buf[o]; g += buf[o + 1]; b += buf[o + 2];
        }
      }
      const oo = (y * PW + x) * 3;
      out[oo] = r >> 2; out[oo + 1] = g >> 2; out[oo + 2] = b >> 2;
    }
  }
  return out;
}

function main(): void {
  drawPage();
  const rgb = downsample();
  const png = encodePNG(rgb, PW, PH);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "out";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outDir + "/entry.png", png);
  console.log(`wrote ${outDir}/entry.png (${png.length} bytes)`);
}
main();
