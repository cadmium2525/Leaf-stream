import { describe, expect, test } from 'vitest';
import {
  LEAF_RULES, area, defaultLeaf, isSimple, normalizePolygon, shapeHash, signedArea, splitPolygon,
  splitPolygonByPath, validateLeaf, type Polygon,
} from '../../packages/sim-core/src/index.ts';
import { Rng } from '../../packages/sim-core/src/prng.ts';

const square: Polygon = [[-2, -2], [2, -2], [2, 2], [-2, 2]];

describe('基本図形', () => {
  test('初期の葉は登録可能', () => {
    const l = defaultLeaf();
    expect(validateLeaf(l)).toEqual({ ok: true, errors: [] });
    expect(signedArea(l)).toBeGreaterThan(0);
  });

  test('面積・反時計回り', () => {
    expect(area(square)).toBe(16);
    expect(signedArea(square)).toBe(16);
    expect(signedArea([...square].reverse())).toBe(-16);
  });

  test('正規化は時計回りを反時計回りにする', () => {
    const n = normalizePolygon([...square].reverse());
    expect(signedArea(n)).toBeGreaterThan(0);
  });

  test('正規化は共線点・重複点を除去する', () => {
    const p: Polygon = [[-2, -2], [0, -2], [2, -2], [2, -2], [2, 2], [-2, 2]];
    expect(normalizePolygon(p)).toHaveLength(4);
  });

  test('正規化は JSON 往復で不変、ハッシュも一致', () => {
    const n = normalizePolygon(defaultLeaf());
    const back = JSON.parse(JSON.stringify(n));
    expect(back).toEqual(n);
    expect(shapeHash(back)).toBe(shapeHash(n));
    expect(normalizePolygon(n)).toEqual(n);
  });

  test('正規化は冪等：量子化で間隔がちょうど 0.05 になる点があっても 2 回目で変わらない', () => {
    // 1.4100001 - 1.36 は 0.05 以上だが、量子化後の 1.41 - 1.36 は浮動小数で 0.0499… になる
    const p: Polygon = [[-2, -2], [2, -2], [2, 2], [0.76, 1.36], [0.74, 1.4100001], [-2, 2]];
    const n = normalizePolygon(p);
    expect(normalizePolygon(n)).toEqual(n);
    // 切った片はどれもサーバーの「正規化済み」チェック（再正規化と完全一致）を通る
    const rng = new Rng(3);
    for (let it = 0; it < 3000; it++) {
      const path: [number, number][] = [];
      for (let j = 0, m = rng.int(2, 4); j < m; j++) path.push([rng.range(-4, 4), rng.range(-6, 6)]);
      for (const piece of splitPolygonByPath(defaultLeaf(), path)) {
        const q = normalizePolygon(piece);
        expect(JSON.stringify(normalizePolygon(q))).toBe(JSON.stringify(q));
      }
    }
  });

  test('頂点数は上限まで削減される', () => {
    const p: Polygon = [];
    for (let i = 0; i < 200; i++) {
      const t = (i / 200) * 2 * Math.PI;
      p.push([2.5 * Math.cos(t), 3 * Math.sin(t)]);
    }
    expect(normalizePolygon(p).length).toBeLessThanOrEqual(LEAF_RULES.maxVertices);
  });
});

describe('切断', () => {
  test('直線で 2 つに分かれ、面積の和は保存', () => {
    const pieces = splitPolygon(square, [0, -5], [0, 5]);
    expect(pieces).toHaveLength(2);
    expect(area(pieces[0]) + area(pieces[1])).toBeCloseTo(16, 9);
  });

  test('ストロークが横切らなければ切れない', () => {
    expect(splitPolygon(square, [0, -5], [0, 0])).toEqual([square]);
    expect(splitPolygon(square, [5, -5], [5, 5])).toEqual([square]);
  });

  test('V 字の軌跡で切れ込みが入る', () => {
    const pieces = splitPolygonByPath(square, [[-3, 1], [0, 0], [-3, -1]]);
    expect(pieces).toHaveLength(2);
    const big = pieces.reduce((a, b) => (area(a) > area(b) ? a : b));
    const notched = normalizePolygon(big);
    expect(area(notched)).toBeCloseTo(16 - 4 / 3, 1);
    expect(isSimple(notched)).toBe(true);
  });

  test('凹形をまたぐ直線は 3 片に分かれる', () => {
    // U 字
    const u: Polygon = [[-3, -3], [3, -3], [3, 3], [1, 3], [1, -1], [-1, -1], [-1, 3], [-3, 3]];
    const pieces = splitPolygon(u, [-5, 1], [5, 1]);
    expect(pieces).toHaveLength(3);
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(u), 9);
    for (const p of pieces) expect(isSimple(normalizePolygon(p))).toBe(true);
  });

  test('ランダムな切断でも分割片は単純ポリゴンで面積保存', () => {
    const rng = new Rng(42);
    for (let k = 0; k < 300; k++) {
      let leaf = defaultLeaf();
      for (let c = 0; c < 3; c++) {
        const a: [number, number] = [rng.range(-5, 5), rng.range(-6, 6)];
        const b: [number, number] = [rng.range(-5, 5), rng.range(-6, 6)];
        const pieces = splitPolygonByPath(leaf, [a, b]);
        const total = pieces.reduce((s, p) => s + area(p), 0);
        expect(total).toBeCloseTo(area(leaf), 6);
        for (const p of pieces) expect(isSimple(p)).toBe(true);
        leaf = normalizePolygon(pieces.reduce((x, y) => (area(x) > area(y) ? x : y)));
        if (leaf.length < 3) break;
      }
    }
  });
});

describe('検証（T01 ほか異常入力）', () => {
  test('T01: 自己交差（蝶ネクタイ形）を拒否し理由を返す', () => {
    const bow: Polygon = [[-2, -3], [2, 3], [2, -3], [-2, 3]];
    const v = validateLeaf(bow);
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('self_intersection');
  });

  const bad: [string, unknown][] = [
    ['null', null], ['数値', 1], ['文字列', 'leaf'], ['オブジェクト', { a: 1 }], ['空配列', []],
    ['1 点', [[0, 0]]], ['2 点', [[0, 0], [1, 1]]], ['NaN', [[0, 0], [NaN, 1], [1, 0]]],
    ['Infinity', [[0, 0], [Infinity, 1], [1, 0]]], ['文字列座標', [['0', 0], [1, 1], [1, 0]]],
    ['3 要素の点', [[0, 0, 0], [1, 1], [1, 0]]], ['null 点', [null, [1, 1], [1, 0]]],
    ['範囲外', [[-10, -10], [10, -10], [10, 10], [-10, 10]]],
    ['時計回り', [...square].reverse()],
    ['極小', [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]],
    ['細長い', [[-0.2, -5], [0.2, -5], [0.2, 5], [-0.2, 5]]],
    ['重複頂点', [[-2, -2], [2, -2], [2, 2], [2, -2], [-2, 2]]],
  ];
  for (const [name, input] of bad) {
    test(`拒否: ${name}`, () => {
      expect(validateLeaf(input).ok).toBe(false);
    });
  }

  test('頂点が多すぎる形は拒否', () => {
    const p: Polygon = [];
    for (let i = 0; i < 100; i++) {
      const t = (i / 100) * 2 * Math.PI;
      p.push([2.5 * Math.cos(t), 3 * Math.sin(t)]);
    }
    expect(validateLeaf(p).errors).toContain('too_many_vertices');
  });

  test('ランダムな異常入力 200 件はすべて例外なく判定され、不正形状は拒否', () => {
    const rng = new Rng(7);
    for (let k = 0; k < 200; k++) {
      const n = rng.int(0, 60);
      const p: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const r = rng.next();
        if (r < 0.03) p.push([NaN, 0]);
        else if (r < 0.05) p.push('x');
        else p.push([rng.range(-8, 8), rng.range(-8, 8)]);
      }
      const v = validateLeaf(p);
      if (v.ok) {
        // 合格したものは本当に単純で範囲内・正の面積
        const poly = p as Polygon;
        expect(isSimple(poly)).toBe(true);
        expect(signedArea(poly)).toBeGreaterThanOrEqual(LEAF_RULES.minArea);
      }
    }
  });
});

describe('葉っぱの種類', () => {
  test('どの種類の元の形も登録できる形で、切って使える', async () => {
    const { SPECIES } = await import('../../packages/sim-core/src/index.ts');
    expect(SPECIES.map((s) => s.id)).toEqual(['sakura', 'yanagi', 'nasturtium', 'momiji']);
    for (const sp of SPECIES) {
      expect(validateLeaf(sp.polygon), sp.id).toEqual({ ok: true, errors: [] });
      // 正規化済み（サーバーが受け付ける形）
      expect(normalizePolygon(sp.polygon)).toEqual(sp.polygon);
      const pieces = splitPolygon(sp.polygon, [-5, 0.3], [5, 0.3]);
      expect(pieces.length).toBeGreaterThanOrEqual(2);
    }
  });
});
