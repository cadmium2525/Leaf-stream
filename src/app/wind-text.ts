import { windAt, type Course } from '../../packages/sim-core/src/index.ts';

/** いまの風を「追い風 1.2m/s ↓」のように表す（↓ が下流＝画面奥） */
export function windText(course: Course, t: number, out: [number, number]): string {
  windAt(course, t, out);
  const [x, y] = out;
  const sp = Math.sqrt(x * x + y * y) / 100;
  if (sp < 0.15) return '風：ほぼ無風';
  let kind: string;
  if (Math.abs(y) >= Math.abs(x) * 1.2) kind = y > 0 ? '追い風' : '向かい風';
  else if (Math.abs(x) >= Math.abs(y) * 1.2) kind = '横風';
  else kind = y > 0 ? '斜め追い風' : '斜め向かい風';
  return `風：${kind} ${sp.toFixed(1)}m/s`;
}
