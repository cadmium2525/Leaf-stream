import { describe, expect, it } from 'vitest';
import {
  ENDLESS, EndlessCourse, centerAt, endlessSeed, getSpecies, halfWidthAt, isLane, normalizePolygon, simulateEndless, type Polygon,
} from '../../packages/sim-core/src/index.ts';

const seed = endlessSeed('2026-W43');

describe('どこまでもモード', () => {
  it('同じ入力なら同じ結果（ゴールデン）', () => {
    const r = simulateEndless({ seed, polygon: getSpecies('sakura').polygon, lane: 3 }).result;
    expect(r).toEqual({ version: 'E1.0', status: 'stuck', reason: 'post', distance: 8358, ticks: 11796, chunk: 10 });
  });

  it('観戦用の軌跡を付けても記録は変わらない', () => {
    const input = { seed, polygon: getSpecies('momiji').polygon, lane: -4 };
    const a = simulateEndless(input).result;
    const b = simulateEndless(input, true);
    expect(b.result).toEqual(a);
    expect(b.trace!.frameCount).toBeGreaterThan(b.trace!.stopFrame);
  });

  it('区間の継ぎ目は同じ幅・中心 0 でつながる', () => {
    const c = new EndlessCourse(seed);
    for (let i = 0; i < 6; i++) {
      const k = c.chunk(i);
      expect(halfWidthAt(k, 0)).toBe(ENDLESS.joint);
      expect(halfWidthAt(k, k.length)).toBe(ENDLESS.joint);
      expect(centerAt(k, 0)).toBe(0);
      expect(centerAt(k, k.length)).toBe(0);
      if (i > 0) expect(c.style(i)).not.toBe(c.style(i - 1));
    }
  });

  it('遠くほど仕掛けが増える', () => {
    const c = new EndlessCourse(seed);
    const posts = (i: number) => c.chunk(i).stones.filter((s) => s.post).length;
    const rollers = (i: number) => c.chunk(i).drops.filter((d) => d.roll).length;
    let near = 0;
    let far = 0;
    for (let i = 1; i <= 4; i++) near += posts(i) + rollers(i);
    for (let i = 16; i <= 19; i++) far += posts(i) + rollers(i);
    expect(c.chunk(0).stones.some((s) => s.post)).toBe(false);
    expect(far).toBeGreaterThan(near);
  });

  it('小さすぎる葉は滝壺に飲まれやすい', () => {
    const small: Polygon = normalizePolygon(getSpecies('sakura').polygon.map(([x, y]) => [x * 0.5, y * 0.5]));
    let roller = 0;
    for (const wk of ['2026-W43', '2026-W44', '2026-W45', '2026-W46']) {
      for (const lane of [-6, 0, 6]) {
        if (simulateEndless({ seed: endlessSeed(wk), polygon: small, lane }).result.reason === 'roller') roller++;
      }
    }
    expect(roller).toBeGreaterThanOrEqual(6);
  });

  it('流す位置は -10..10 の整数だけ', () => {
    expect(isLane(0)).toBe(true);
    expect(isLane(10)).toBe(true);
    expect(isLane(11)).toBe(false);
    expect(isLane(0.5)).toBe(false);
    expect(isLane('3')).toBe(false);
  });
});
