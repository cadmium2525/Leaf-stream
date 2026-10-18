/**
 * 手続き的に生成するテクスチャ（外部素材を使わないので権利面の確認が不要）。
 * 描画専用。ここでの乱数は勝敗に影響しない。
 */
import * as THREE from 'three';
import { LEAF_RULES, type SpeciesId } from '../../packages/sim-core/src/index.ts';

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

/** 再現可能な描画用乱数 */
function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toTexture(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** 高さ（輝度）から法線マップを作る */
function normalFromHeight(src: HTMLCanvasElement, strength: number): THREE.CanvasTexture {
  const w = src.width;
  const h = src.height;
  const sd = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  const [c, ctx] = canvas(w, h);
  const out = ctx.createImageData(w, h);
  const H = (x: number, y: number) => sd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return toTexture(c, true, false);
}

/** 細かいノイズを重ねる */
function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, r: () => number, n: number, alpha: number, light = false): void {
  for (let i = 0; i < n; i++) {
    const v = light ? 200 + r() * 55 : r() * 60;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * r()})`;
    const s = 1 + r() * 2.5;
    ctx.fillRect(r() * w, r() * h, s, s);
  }
}

export interface MaterialMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
}

/** コンクリート（経年の汚れ・縦の雨だれ・苔） */
export function concreteMaps(size: number): MaterialMaps {
  const r = rand(11);
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#8f8b80';
  ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#808080';
  hctx.fillRect(0, 0, size, size);
  // ムラ
  for (let i = 0; i < 90; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = size * (0.05 + r() * 0.18);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const t = r() < 0.5 ? '70,66,58' : '170,165,150';
    g.addColorStop(0, `rgba(${t},${0.08 + r() * 0.1})`);
    g.addColorStop(1, `rgba(${t},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // 雨だれ（縦の汚れ）
  for (let i = 0; i < 40; i++) {
    const x = r() * size;
    const len = size * (0.2 + r() * 0.8);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, 'rgba(50,48,40,0.18)');
    g.addColorStop(1, 'rgba(50,48,40,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 2 + r() * 6, len);
  }
  speckle(ctx, size, size, r, size * 30, 0.25);
  speckle(ctx, size, size, r, size * 10, 0.2, true);
  // 気泡跡（高さにも反映）
  for (let i = 0; i < size * 0.6; i++) {
    const x = r() * size;
    const y = r() * size;
    const s = 0.8 + r() * 2.2;
    ctx.fillStyle = 'rgba(40,38,34,0.45)';
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
    hctx.fillStyle = '#303030';
    hctx.beginPath();
    hctx.arc(x, y, s, 0, Math.PI * 2);
    hctx.fill();
  }
  // ひび
  ctx.strokeStyle = 'rgba(35,32,28,0.5)';
  hctx.strokeStyle = '#202020';
  for (let i = 0; i < 6; i++) {
    let x = r() * size;
    let y = r() * size;
    ctx.beginPath();
    hctx.beginPath();
    ctx.moveTo(x, y);
    hctx.moveTo(x, y);
    for (let k = 0; k < 12; k++) {
      x += (r() - 0.5) * size * 0.06;
      y += r() * size * 0.04;
      ctx.lineTo(x, y);
      hctx.lineTo(x, y);
    }
    ctx.lineWidth = hctx.lineWidth = 1;
    ctx.stroke();
    hctx.stroke();
  }
  speckle(hctx, size, size, r, size * 40, 0.5);
  speckle(hctx, size, size, r, size * 20, 0.4, true);
  return { map: toTexture(c), normalMap: normalFromHeight(hc, 2.5) };
}

/** 水底の小石・砂・藻 */
export function pebbleMaps(size: number): MaterialMaps {
  const r = rand(23);
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#6d604b';
  ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#202020';
  hctx.fillRect(0, 0, size, size);
  speckle(ctx, size, size, r, size * 50, 0.35);
  speckle(ctx, size, size, r, size * 20, 0.25, true);
  const palette = ['#8a8178', '#6f6a63', '#9b8e7a', '#5d5850', '#a39a8c', '#7a6a55', '#4f4b45', '#b2a796', '#836f5a'];
  const n = Math.floor(size * size / 900);
  for (let i = 0; i < n; i++) {
    const x = r() * size;
    const y = r() * size;
    const rx = size * (0.006 + r() * r() * 0.03);
    const ry = rx * (0.55 + r() * 0.45);
    const rot = r() * Math.PI;
    const col = palette[Math.floor(r() * palette.length)];
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      if (x + ox < -rx * 2 || x + ox > size + rx * 2 || y + oy < -rx * 2 || y + oy > size + rx * 2) continue;
      ctx.save();
      ctx.translate(x + ox, y + oy);
      ctx.rotate(rot);
      // 影
      ctx.fillStyle = 'rgba(20,16,10,0.35)';
      ctx.beginPath();
      ctx.ellipse(rx * 0.12, ry * 0.15, rx * 1.05, ry * 1.05, 0, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createRadialGradient(-rx * 0.3, -ry * 0.35, 0, 0, 0, rx);
      g.addColorStop(0, '#d6cfc2');
      g.addColorStop(0.25, col);
      g.addColorStop(1, '#3a352e');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      hctx.save();
      hctx.translate(x + ox, y + oy);
      hctx.rotate(rot);
      const hg = hctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      hg.addColorStop(0, '#ffffff');
      hg.addColorStop(1, '#303030');
      hctx.fillStyle = hg;
      hctx.beginPath();
      hctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      hctx.fill();
      hctx.restore();
    }
  }
  // 藻の斑
  for (let i = 0; i < 26; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = size * (0.04 + r() * 0.1);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(70,98,40,0.45)');
    g.addColorStop(1, 'rgba(70,98,40,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return { map: toTexture(c), normalMap: normalFromHeight(hc, 4) };
}

/** 土手の草地 */
export function grassMaps(size: number): MaterialMaps {
  const r = rand(37);
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#4d6a2c';
  ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#404040';
  hctx.fillRect(0, 0, size, size);
  const cols = ['#5e7f33', '#3f5a22', '#6f8e3c', '#7b8f45', '#4a6428', '#8a9a52', '#384d1d'];
  for (let i = 0; i < size * 40; i++) {
    const x = r() * size;
    const y = r() * size;
    const len = 3 + r() * 9;
    const a = -Math.PI / 2 + (r() - 0.5) * 1.2;
    ctx.strokeStyle = cols[Math.floor(r() * cols.length)];
    ctx.lineWidth = 0.8 + r();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
    hctx.strokeStyle = `rgb(${120 + r() * 135},${120 + r() * 135},${120 + r() * 135})`;
    hctx.beginPath();
    hctx.moveTo(x, y);
    hctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    hctx.stroke();
  }
  // 土の見える部分
  for (let i = 0; i < 30; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = size * (0.02 + r() * 0.05);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(105,86,58,0.5)');
    g.addColorStop(1, 'rgba(105,86,58,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return { map: toTexture(c), normalMap: normalFromHeight(hc, 1.5) };
}

/** 自然の土手（湿った土・小石・苔） */
export function earthMaps(size: number): MaterialMaps {
  const r = rand(61);
  const [c, ctx] = canvas(size);
  const [hc, hctx] = canvas(size);
  ctx.fillStyle = '#6b5a43';
  ctx.fillRect(0, 0, size, size);
  hctx.fillStyle = '#505050';
  hctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 70; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = size * (0.04 + r() * 0.14);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const col = r() < 0.45 ? '74,96,44' : r() < 0.5 ? '52,42,30' : '120,104,80';
    g.addColorStop(0, `rgba(${col},${0.25 + r() * 0.3})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  speckle(ctx, size, size, r, size * 40, 0.35);
  // 小石
  for (let i = 0; i < size * 0.8; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = 1 + r() * r() * size * 0.012;
    const v = 90 + r() * 90;
    ctx.fillStyle = `rgb(${v},${v * 0.95},${v * 0.85})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rad, rad * 0.7, r() * 3, 0, Math.PI * 2);
    ctx.fill();
    hctx.fillStyle = '#e0e0e0';
    hctx.beginPath();
    hctx.ellipse(x, y, rad, rad * 0.7, 0, 0, Math.PI * 2);
    hctx.fill();
  }
  speckle(hctx, size, size, r, size * 30, 0.5);
  return { map: toTexture(c), normalMap: normalFromHeight(hc, 3) };
}

/** アスファルト（道路） */
export function asphaltMap(size: number): THREE.Texture {
  const r = rand(71);
  const [c, ctx] = canvas(size);
  ctx.fillStyle = '#4a4a48';
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, size, r, size * 60, 0.45);
  speckle(ctx, size, size, r, size * 30, 0.25, true);
  for (let i = 0; i < 20; i++) {
    const x = r() * size;
    const y = r() * size;
    const rad = size * (0.05 + r() * 0.15);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(30,30,28,${0.15 + r() * 0.15})`);
    g.addColorStop(1, 'rgba(30,30,28,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return toTexture(c);
}

/** コンクリートブロック塀 */
export function blockMap(size: number): THREE.Texture {
  const r = rand(81);
  const [c, ctx] = canvas(size);
  ctx.fillStyle = '#9d9a92';
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, size, r, size * 30, 0.3);
  const rows = 4;
  const bh = size / rows;
  ctx.strokeStyle = 'rgba(60,58,54,0.8)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= rows; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * bh);
    ctx.lineTo(size, i * bh);
    ctx.stroke();
    const off = i % 2 === 0 ? 0 : size / 4;
    for (let x = off; x <= size; x += size / 2) {
      ctx.beginPath();
      ctx.moveTo(x, i * bh);
      ctx.lineTo(x, (i + 1) * bh);
      ctx.stroke();
    }
  }
  // 雨だれ
  for (let i = 0; i < 25; i++) {
    const x = r() * size;
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, 'rgba(50,48,40,0.25)');
    g.addColorStop(1, 'rgba(50,48,40,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 3 + r() * 6, size * (0.3 + r() * 0.7));
  }
  return toTexture(c);
}

/** 田んぼ（稲の列） */
export function paddyMap(size: number): THREE.Texture {
  const r = rand(51);
  const [c, ctx] = canvas(size);
  ctx.fillStyle = '#5c7a35';
  ctx.fillRect(0, 0, size, size);
  const rows = 24;
  for (let i = 0; i < rows; i++) {
    const y = (i + 0.5) * (size / rows);
    for (let x = 0; x < size; x += 3) {
      const g = 90 + r() * 70;
      ctx.fillStyle = `rgba(${g * 0.75},${g + 30},${g * 0.4},0.8)`;
      ctx.fillRect(x, y - 2 - r() * 3, 2, 4 + r() * 4);
    }
  }
  return toTexture(c);
}

export type LeafTone = 'mine' | 'rival';

interface LeafPalette { base: string; edge: string; vein: string; tip: string }

/** 種類ごとの色。rival は相手の葉（同じ種類でも見分けがつくよう秋色寄り） */
const PALETTES: Record<SpeciesId, Record<LeafTone, LeafPalette>> = {
  sakura: {
    mine: { base: '#5f9a35', edge: '#3d6e22', vein: '#b9d98c', tip: '#79ae45' },
    rival: { base: '#c98a2e', edge: '#94471b', vein: '#f0cf86', tip: '#d75f22' },
  },
  yanagi: {
    mine: { base: '#93b94a', edge: '#5f8a2c', vein: '#e3f0b0', tip: '#b2c95c' },
    rival: { base: '#d6b54a', edge: '#a07a22', vein: '#f6e3a0', tip: '#e2c255' },
  },
  nasturtium: {
    mine: { base: '#6fb04c', edge: '#4c8a33', vein: '#e2f2c8', tip: '#86c25e' },
    rival: { base: '#b9b54a', edge: '#8a7e2a', vein: '#f2edb8', tip: '#cdbf55' },
  },
  momiji: {
    mine: { base: '#c8402a', edge: '#8e2416', vein: '#f0a07a', tip: '#e0582f' },
    rival: { base: '#e8a42c', edge: '#b0661a', vein: '#f8dc90', tip: '#f0bb3a' },
  },
};

/**
 * 葉っぱのテクスチャ。UV は葉のローカル座標の許容範囲（LEAF_RULES の箱）に合わせるので、
 * どんな切り方をしても葉脈の位置は元の葉のまま残る。
 */
export function leafTexture(species: SpeciesId, tone: LeafTone, size = 512): THREE.CanvasTexture {
  const t = PALETTES[species][tone];
  const r = rand(species.length * 7 + (tone === 'mine' ? 3 : 5));
  const w = size;
  const hgt = Math.round((size * LEAF_RULES.maxAbsY) / LEAF_RULES.maxAbsX);
  const [c, ctx] = canvas(w, hgt);
  // 座標変換：ローカル (x, y) → キャンバス
  const sx = (x: number) => ((x + LEAF_RULES.maxAbsX) / (2 * LEAF_RULES.maxAbsX)) * w;
  const sy = (y: number) => ((LEAF_RULES.maxAbsY - y) / (2 * LEAF_RULES.maxAbsY)) * hgt;
  const unit = w / (2 * LEAF_RULES.maxAbsX);
  const g = ctx.createRadialGradient(sx(0), sy(0), 0, sx(0), sy(0), w * 0.6);
  g.addColorStop(0, t.base);
  g.addColorStop(0.7, t.base);
  g.addColorStop(1, t.edge);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, hgt);
  // 細かい斑点
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = `rgba(${r() < 0.5 ? '255,255,220' : '20,40,10'},${0.04 + r() * 0.05})`;
    ctx.fillRect(r() * w, r() * hgt, 2, 2);
  }
  ctx.strokeStyle = t.vein;
  ctx.lineCap = 'round';
  const line = (x0: number, y0: number, x1: number, y1: number, width: number, alpha: number, cx?: number, cy?: number) => {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width * unit;
    ctx.beginPath();
    ctx.moveTo(sx(x0), sy(y0));
    if (cx !== undefined && cy !== undefined) ctx.quadraticCurveTo(sx(cx), sy(cy), sx(x1), sy(y1));
    else ctx.lineTo(sx(x1), sy(y1));
    ctx.stroke();
  };
  if (species === 'nasturtium' || species === 'momiji') {
    // 掌状・盾状：中心（葉柄のつけ根）から放射状に葉脈が広がる
    const ox = 0;
    const oy = species === 'momiji' ? -0.3 : 0.1;
    const n = species === 'momiji' ? 7 : 9;
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 + (i / n) * 2 * Math.PI;
      const len = species === 'momiji' ? 3.3 : 3.0;
      const ex = ox + Math.cos(a) * len;
      const ey = oy + Math.sin(a) * len;
      line(ox, oy, ex, ey, 0.09, 0.85, ox + Math.cos(a + 0.12) * len * 0.5, oy + Math.sin(a + 0.12) * len * 0.5);
      // 細脈
      for (let k = 1; k <= 3; k++) {
        const f = k / 4;
        const px = ox + Math.cos(a) * len * f;
        const py = oy + Math.sin(a) * len * f;
        for (const side of [-1, 1]) {
          const b = a + side * 0.9;
          line(px, py, px + Math.cos(b) * 0.55, py + Math.sin(b) * 0.55, 0.03, 0.35);
        }
      }
    }
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = t.vein;
    ctx.beginPath();
    ctx.arc(sx(ox), sy(oy), 0.12 * unit, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // 羽状：主脈と側脈
    const tip = species === 'yanagi' ? 5.3 : 4.6;
    const base = species === 'yanagi' ? -5.3 : -5.4;
    const tipG = ctx.createLinearGradient(0, sy(tip), 0, sy(tip * 0.2));
    tipG.addColorStop(0, t.tip);
    tipG.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = tipG;
    ctx.fillRect(0, 0, w, hgt);
    line(0, base, 0, tip, species === 'yanagi' ? 0.08 : 0.1, 1);
    const count = species === 'yanagi' ? 16 : 9;
    const reach = species === 'yanagi' ? 0.9 : 2.6;
    for (let i = 0; i < count; i++) {
      const y0 = base + 1.2 + (i * (tip - base - 2)) / count;
      for (const side of [-1, 1]) {
        line(0, y0, side * reach, y0 + reach * 0.6 + 0.4, 0.045, 0.75, side * reach * 0.45, y0 + reach * 0.35);
      }
    }
  }
  ctx.globalAlpha = 1;
  return toTexture(c, false);
}

/** 種類のおおよその色（サムネイルや 2D 表示用） */
export function speciesColor(species: SpeciesId, tone: LeafTone = 'mine'): string {
  return PALETTES[species][tone].base;
}

/** 空のグラデーション用の色 */
export const SKY = {
  top: new THREE.Color('#5d8fc7'),
  horizon: new THREE.Color('#dfe8e6'),
  sun: new THREE.Vector3(-0.35, 0.72, -0.6).normalize(),
};
