import { describe, expect, test } from 'vitest';
import {
  BOT_LEAVES, COURSE_IDS, RunSim, SIM, SIM_VERSION, defaultLeaf, generateCourse, prepareLeaf, samplePose,
  simulateRace, traceDuration, type LeafPose, type RaceInput,
} from '../../packages/sim-core/src/index.ts';

const input: RaceInput = {
  courseId: 'yamazato',
  seed: 20261018,
  challenger: BOT_LEAVES.find((b) => b.id === 'bot-notch')!.polygon,
  defender: BOT_LEAVES.find((b) => b.id === 'bot-slim')!.polygon,
};

describe('決定論性', () => {
  test('コース生成は同じ入力で同じ', () => {
    for (const id of COURSE_IDS) expect(generateCourse(id, 99)).toEqual(generateCourse(id, 99));
    expect(generateCourse('tanbo', 1)).not.toEqual(generateCourse('tanbo', 2));
  });

  test('T02: 同じ seed で 100 回再計算しても公式結果が一致', () => {
    const first = simulateRace(input).result;
    for (let i = 0; i < 99; i++) expect(simulateRace(input).result).toEqual(first);
  }, 120_000);

  test('JSON 往復した形状（サーバー受信相当）でも結果が一致', () => {
    const viaJson: RaceInput = JSON.parse(JSON.stringify(input));
    expect(simulateRace(viaJson).result).toEqual(simulateRace(input).result);
  });

  test('T03: step の刻み方（描画フレーム数）に依存しない', () => {
    const course = generateCourse(input.courseId, input.seed);
    const a = prepareLeaf(input.challenger);
    const b = prepareLeaf(input.defender);
    // 60fps 相当（1 フレーム 1 tick）と 30fps 相当（2 tick）と不規則な刻み
    const chunks = [() => 1, () => 2, (() => { let i = 0; return () => 1 + ((i++ * 7) % 5); })()];
    const results = chunks.map((next) => {
      const sim = new RunSim(course, a, b);
      while (!sim.done) sim.step(next());
      return { r: sim.results(), t: Array.from(sim.getTrace().frames) };
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  test('T03: 30fps / 60fps で再生しても終着姿勢と勝敗は同じ', () => {
    const { result, replay } = simulateRace(input, true);
    expect(simulateRace(input).result).toEqual(result);
    for (const tr of replay!.traces) {
      const end = traceDuration(tr);
      const poses = [30, 60].map((fps) => {
        const p: LeafPose = { x: 0, y: 0, c: 1, s: 0, contact: 0 };
        for (let t = 0; t <= end + 1 / fps; t += 1 / fps) samplePose(tr, 0, t, p);
        return { ...p };
      });
      expect(poses[0]).toEqual(poses[1]);
    }
  });

  test('ゴールデン値（変わったら SIM_VERSION を上げること）', () => {
    const r = simulateRace({ courseId: 'tanbo', seed: 1234, challenger: defaultLeaf(), defender: BOT_LEAVES[3].polygon }).result;
    expect(SIM_VERSION).toBe('1.1.0');
    expect({ outcome: r.outcome, timeA: r.timeA, timeB: r.timeB }).toMatchInlineSnapshot(`
      {
        "outcome": "defender_win",
        "timeA": 1907,
        "timeB": 1895,
      }
    `);
  });
});

describe('コース', () => {
  test('どのコースにも小さな滝があり、山里は蛇行する', () => {
    for (const id of COURSE_IDS) {
      for (let seed = 1; seed <= 20; seed++) {
        const c = generateCourse(id, seed);
        expect(c.drops.length).toBeGreaterThan(0);
        for (const d of c.drops) expect(d.y).toBeGreaterThan(c.startY + 100);
        // 石は滝のすぐそばに置かない
        for (const s of c.stones) for (const d of c.drops) expect(Math.abs(s.y - d.y)).toBeGreaterThan(30);
      }
    }
    expect(generateCourse('yamazato', 3).centers.some((x) => x !== 0)).toBe(true);
    expect(generateCourse('jutaku', 3).covers.length).toBeGreaterThan(0);
  });

  test('観戦用にゴール後も流し続けても、勝敗と時間は変わらない', () => {
    for (const id of COURSE_IDS) {
      const inp = { courseId: id, seed: 77, challenger: input.challenger, defender: input.defender };
      const a = simulateRace(inp).result;
      const b = simulateRace(inp, true);
      expect(b.result).toEqual(a);
      // 軌跡はゴールより先まで続いている
      const tr = b.replay!.traces[0];
      const lastY = tr.frames[(tr.frameCount - 1) * 10 + 1];
      if (a.runs[0][0].status === 'finished') expect(lastY).toBeGreaterThan(b.replay!.course.goalY + 30);
    }
  });
});

describe('ルール', () => {
  test('同じ葉同士は引き分け（左右入替で公平）', () => {
    for (const id of COURSE_IDS) {
      const r = simulateRace({ courseId: id, seed: 5, challenger: defaultLeaf(), defender: defaultLeaf() }).result;
      expect(r.outcome).toBe('draw');
      expect(r.timeA).toBe(r.timeB);
    }
  });

  test('結果は制限時間＋ペナルティ以内で、完走していれば実時間', () => {
    const r = simulateRace(input).result;
    for (const run of r.runs) {
      for (const leaf of run) {
        if (leaf.status === 'finished') expect(leaf.scoreTicks).toBe(leaf.finishTick);
        else expect(leaf.scoreTicks).toBe(SIM.timeLimitTicks + SIM.penaltyTicks);
        expect(leaf.scoreTicks).toBeLessThanOrEqual(SIM.timeLimitTicks + SIM.penaltyTicks);
      }
    }
    expect(r.timeA).toBe(r.runs[0][0].scoreTicks + r.runs[1][0].scoreTicks);
  });

  test('形状によって走りが変わる', () => {
    const times = new Set<number>();
    for (const b of BOT_LEAVES) {
      const r = simulateRace({ courseId: 'tanbo', seed: 2, challenger: b.polygon, defender: defaultLeaf() }).result;
      times.add(r.timeA);
    }
    expect(times.size).toBeGreaterThan(3);
  });

  test('1 レースの計算は軽い（サーバー CPU 上限の目安）', () => {
    const t0 = performance.now();
    simulateRace(input);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
