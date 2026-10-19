// 自動生成：packages/sim-core/src からコピー（npm run sync:sim）。直接編集しないこと。
/**
 * 葉っぱの外形ポリゴン処理。
 * 座標単位は cm、葉のローカル座標系は +y が葉先（流れ方向）、+x が右。
 * ここでも決定論性のため + - * / sqrt 以外の Math 関数を使わない。
 */

export type Vec2 = [number, number];
export type Polygon = Vec2[];

/** 葉っぱ形状のルール（サーバー・クライアント共通） */
export const LEAF_RULES = {
  minVertices: 3,
  maxVertices: 48,
  /** ローカル座標の許容範囲（初期葉が収まる箱） */
  maxAbsX: 3.5,
  maxAbsY: 5.5,
  minArea: 6,
  maxArea: 34,
  /** 2*面積/周長 の下限（おおよその「最小幅」） */
  minThickness: 0.9,
  maxCuts: 16,
  /** 正規化時の量子化（0.01cm） */
  quantum: 0.01,
} as const;

export function signedArea(p: Polygon): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function area(p: Polygon): number {
  return Math.abs(signedArea(p));
}

export function perimeter(p: Polygon): number {
  let s = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % n];
    s += Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  }
  return s;
}

export function centroid(p: Polygon): Vec2 {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % n];
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  if (a === 0) return [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** 重心まわりの極二次モーメント（単位面積密度あたり） */
export function polarMoment(p: Polygon): number {
  const [gx, gy] = centroid(p);
  let j = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const x0 = p[i][0] - gx;
    const y0 = p[i][1] - gy;
    const x1 = p[(i + 1) % n][0] - gx;
    const y1 = p[(i + 1) % n][1] - gy;
    const c = x0 * y1 - x1 * y0;
    j += c * (x0 * x0 + x0 * x1 + x1 * x1 + y0 * y0 + y0 * y1 + y1 * y1);
  }
  return Math.abs(j / 12);
}

export function bounds(p: Polygon): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of p) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

export function pointInPolygon(p: Polygon, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const onSeg = (p: Vec2, q: Vec2, r: Vec2) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  if (o1 === 0 && onSeg(a, b, c)) return true;
  if (o2 === 0 && onSeg(a, b, d)) return true;
  if (o3 === 0 && onSeg(c, d, a)) return true;
  if (o4 === 0 && onSeg(c, d, b)) return true;
  return false;
}

/** 隣接辺以外の辺同士が交差しない（単純ポリゴン）かを判定 */
export function isSimple(p: Polygon): boolean {
  const n = p.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // 隣接辺はスキップ
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsIntersect(a, b, p[j], p[(j + 1) % n])) return false;
    }
  }
  // 同一頂点の重複も不正
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (p[i][0] === p[j][0] && p[i][1] === p[j][1]) return false;
    }
  }
  return true;
}

const q = (v: number, quantum: number) => Math.round(v / quantum) * quantum;

/** 近接点・共線点の除去 */
function cleanup(p: Polygon, minDist: number): Polygon {
  const out: Polygon = [];
  for (const v of p) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - v[0]) < minDist && Math.abs(last[1] - v[1]) < minDist) continue;
    out.push([v[0], v[1]]);
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < minDist && Math.abs(a[1] - b[1]) < minDist) out.pop();
    else break;
  }
  // 共線（ほぼ面積ゼロの三角形）やトゲ状の折り返し頂点を除去
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const n = out.length;
      const a = out[(i - 1 + n) % n];
      const b = out[i];
      const c = out[(i + 1) % n];
      if (Math.abs(orient(a[0], a[1], b[0], b[1], c[0], c[1])) < 2e-6) {
        out.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return out;
}

/** Visvalingam 法で頂点数を maxVertices 以下に削減 */
export function simplify(p: Polygon, maxVertices: number): Polygon {
  const out = p.map((v) => [v[0], v[1]] as Vec2);
  while (out.length > maxVertices) {
    let best = 0;
    let bestArea = Infinity;
    for (let i = 0, n = out.length; i < n; i++) {
      const a = out[(i - 1 + n) % n];
      const b = out[i];
      const c = out[(i + 1) % n];
      const tri = Math.abs(orient(a[0], a[1], b[0], b[1], c[0], c[1]));
      if (tri < bestArea) {
        bestArea = tri;
        best = i;
      }
    }
    out.splice(best, 1);
  }
  return out;
}

/**
 * 外形を正規化する：近接・共線点の除去、反時計回り、頂点削減、量子化。
 * 結果は JSON 往復しても同じ値になり、もう一度正規化しても変わらない（冪等）。
 */
export function normalizePolygon(p: Polygon): Polygon {
  let out = normalizeOnce(p);
  // 量子化で 2 点の間隔がちょうど 0.05cm（浮動小数では 0.0499…）になると、
  // 2 回目の正規化でその点が消える。サーバーは「正規化済み」を厳密に比べるので、変わらなくなるまで繰り返す。
  // 繰り返すたびに頂点は減るだけなので必ず止まる
  for (let i = 0; i < LEAF_RULES.maxVertices && out.length >= 3; i++) {
    const next = normalizeOnce(out);
    if (next.length === out.length && next.every((v, k) => v[0] === out[k][0] && v[1] === out[k][1])) break;
    out = next;
  }
  return out;
}

function normalizeOnce(p: Polygon): Polygon {
  let out = cleanup(p, 0.05);
  if (out.length < 3) return out;
  if (signedArea(out) < 0) out.reverse();
  out = simplify(out, LEAF_RULES.maxVertices);
  out = out.map(([x, y]) => [q(x, LEAF_RULES.quantum), q(y, LEAF_RULES.quantum)] as Vec2);
  // 量子化で生じた -0 を 0 に
  out = out.map(([x, y]) => [x === 0 ? 0 : x, y === 0 ? 0 : y] as Vec2);
  out = cleanup(out, 0.005);
  if (out.length >= 3 && signedArea(out) < 0) out.reverse();
  return out;
}

export type LeafErrorCode =
  | 'not_array'
  | 'bad_point'
  | 'too_few_vertices'
  | 'too_many_vertices'
  | 'out_of_range'
  | 'self_intersection'
  | 'not_ccw'
  | 'too_small'
  | 'too_large'
  | 'too_thin';

export const LEAF_ERROR_MESSAGES: Record<LeafErrorCode, string> = {
  not_array: '形状データが配列ではありません',
  bad_point: '座標に不正な値が含まれています',
  too_few_vertices: '頂点が少なすぎます',
  too_many_vertices: `頂点が多すぎます（上限 ${LEAF_RULES.maxVertices}）`,
  out_of_range: '葉の外形が許容範囲を超えています',
  self_intersection: '外形が自己交差しています',
  not_ccw: '外形の向きが正規化されていません',
  too_small: `面積が小さすぎます（${LEAF_RULES.minArea}cm² 以上）`,
  too_large: '面積が大きすぎます',
  too_thin: '細すぎる部分があります（もう少し太く残してください）',
};

export interface LeafValidation {
  ok: boolean;
  errors: LeafErrorCode[];
}

/**
 * 登録可能な葉っぱかを厳密に検証する。サーバーでも同じ関数を使う。
 * 入力は信用できない JSON を想定する。
 */
export function validateLeaf(input: unknown): LeafValidation {
  const errors: LeafErrorCode[] = [];
  if (!Array.isArray(input)) return { ok: false, errors: ['not_array'] };
  for (const v of input) {
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number' ||
      !Number.isFinite(v[0]) || !Number.isFinite(v[1])) {
      return { ok: false, errors: ['bad_point'] };
    }
  }
  const p = input as Polygon;
  if (p.length < LEAF_RULES.minVertices) return { ok: false, errors: ['too_few_vertices'] };
  if (p.length > LEAF_RULES.maxVertices) errors.push('too_many_vertices');
  for (const [x, y] of p) {
    if (Math.abs(x) > LEAF_RULES.maxAbsX || Math.abs(y) > LEAF_RULES.maxAbsY) {
      errors.push('out_of_range');
      break;
    }
  }
  if (p.length <= 256 && !isSimple(p)) errors.push('self_intersection');
  const sa = signedArea(p);
  if (sa < 0) errors.push('not_ccw');
  const a = Math.abs(sa);
  if (a < LEAF_RULES.minArea) errors.push('too_small');
  if (a > LEAF_RULES.maxArea) errors.push('too_large');
  if (a > 0 && (2 * a) / perimeter(p) < LEAF_RULES.minThickness) errors.push('too_thin');
  return { ok: errors.length === 0, errors };
}

/** 形状ハッシュ（FNV-1a 64bit 相当を 2 つの 32bit で計算し 16 進文字列） */
export function shapeHash(p: Polygon): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const [x, y] of p) {
    for (const v of [Math.round(x * 100), Math.round(y * 100)]) {
      const s = String(v) + ',';
      for (let i = 0; i < s.length; i++) {
        h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x5bd1e995) >>> 0;
      }
    }
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * ハサミの軌跡（折れ線）でポリゴンを切断し、分割された各片を返す。
 * 軌跡が「外→内→外」と完全に横切った区間（弦）だけで切るので、
 * V 字に切り込みを入れたり、くぼみの一部だけを切り落としたりできる。
 * 切れなければ [元の形] を返す。軌跡が自己交差していると結果は不正になり得るので、
 * 呼び出し側で validateLeaf / isSimple を確認すること。
 */
export function splitPolygonByPath(p: Polygon, path: Vec2[]): Polygon[] {
  const n = p.length;
  if (n < 3 || path.length < 2) return [p];

  interface Crossing { pathPos: number; edge: number; edgePos: number; pt: Vec2; ringIdx: number }
  const crossings: Crossing[] = [];
  for (let j = 0; j + 1 < path.length; j++) {
    const [ax, ay] = path[j];
    const [bx, by] = path[j + 1];
    const rx = bx - ax;
    const ry = by - ay;
    for (let i = 0; i < n; i++) {
      const [cx, cy] = p[i];
      const [dx, dy] = p[(i + 1) % n];
      const sx = dx - cx;
      const sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (den === 0) continue;
      const u = ((cx - ax) * sy - (cy - ay) * sx) / den; // 軌跡側
      const v = ((cx - ax) * ry - (cy - ay) * rx) / den; // 辺側
      // 端点ちょうどの交差は重複を避けるため半開区間で扱う
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      crossings.push({ pathPos: j + u, edge: i, edgePos: v, pt: [cx + sx * v, cy + sy * v], ringIdx: -1 });
    }
  }
  if (crossings.length < 2) return [p];
  crossings.sort((a, b) => a.pathPos - b.pathPos);

  // 弦（入る交点 → 次の出る交点）を作る
  let inside = pointInPolygon(p, path[0][0], path[0][1]);
  const chords: { from: Crossing; to: Crossing; mid: Vec2[] }[] = [];
  for (let k = 0; k < crossings.length; k++) {
    const c = crossings[k];
    if (!inside && k + 1 < crossings.length) {
      const d = crossings[k + 1];
      const mid: Vec2[] = [];
      for (let j = Math.floor(c.pathPos) + 1; j <= Math.floor(d.pathPos); j++) mid.push([path[j][0], path[j][1]]);
      chords.push({ from: c, to: d, mid });
    }
    inside = !inside;
  }
  if (chords.length === 0) return [p];

  // 元の頂点と交点を外周順に並べたリング
  const byEdge = new Map<number, Crossing[]>();
  for (const ch of chords) {
    for (const c of [ch.from, ch.to]) {
      const list = byEdge.get(c.edge) ?? [];
      list.push(c);
      byEdge.set(c.edge, list);
    }
  }
  const ring: { pt: Vec2; isCross: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    ring.push({ pt: [p[i][0], p[i][1]], isCross: false });
    const list = byEdge.get(i);
    if (!list) continue;
    list.sort((a, b) => a.edgePos - b.edgePos);
    for (const c of list) {
      c.ringIdx = ring.length;
      ring.push({ pt: c.pt, isCross: true });
    }
  }
  const jump = new Map<number, { to: number; mid: Vec2[] }>();
  for (const ch of chords) {
    jump.set(ch.from.ringIdx, { to: ch.to.ringIdx, mid: ch.mid });
    jump.set(ch.to.ringIdx, { to: ch.from.ringIdx, mid: ch.mid.slice().reverse() });
  }

  const m = ring.length;
  const stepVisited = new Array<boolean>(m).fill(false);
  const pieces: Polygon[] = [];
  for (let k0 = 0; k0 < m; k0++) {
    // 交点から始める片は「弦を渡ってきた直後」とみなす（弦の両端が同じ辺にある三角片など）
    if (stepVisited[k0]) continue;
    const piece: Polygon = [];
    let k = k0;
    let guard = 0;
    for (;;) {
      if (guard++ > m * 4) return [p];
      piece.push(ring[k].pt);
      stepVisited[k] = true;
      k = (k + 1) % m;
      if (k === k0) break;
      const jp = jump.get(k);
      if (jp) {
        piece.push(ring[k].pt);
        for (const q of jp.mid) piece.push(q);
        k = jp.to;
        if (k === k0) break;
      }
    }
    if (piece.length >= 3) pieces.push(piece);
  }
  return pieces.length > 0 ? pieces : [p];
}

/** 直線（A→B）での切断。splitPolygonByPath の特殊形 */
export function splitPolygon(p: Polygon, a: Vec2, b: Vec2): Polygon[] {
  return splitPolygonByPath(p, [a, b]);
}

/** 初期の葉っぱ形状（左右対称の葉形、反時計回り） */
export function defaultLeaf(): Polygon {
  const pts: Polygon = [];
  const n = 20;
  const halfLen = 4.6;
  const halfW = 2.6;
  // 右側（葉元→葉先）
  for (let i = 0; i <= n; i++) {
    const t = i / n; // 0..1
    const y = -halfLen + 2 * halfLen * t;
    // 葉らしく葉先側を尖らせ、葉元を丸める
    const u = t * (1 - t);
    const w = halfW * 4 * u * (1.15 - 0.3 * t) * (t < 0.08 ? 0.6 + 5 * t : 1);
    pts.push([w, y]);
  }
  // 左側（葉先→葉元）
  for (let i = n - 1; i >= 1; i--) {
    const [x, y] = pts[i];
    pts.push([-x, y]);
  }
  return normalizePolygon(pts);
}
