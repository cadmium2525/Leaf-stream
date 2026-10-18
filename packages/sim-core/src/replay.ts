/**
 * 確定済み軌跡の再生（描画側が使う）。描画 fps に関係なく同じ軌跡を補間して返す。
 */
import { SIM, type RunTrace } from './sim.ts';

export interface LeafPose {
  x: number;
  y: number;
  /** 回転角の cos / sin */
  c: number;
  s: number;
  contact: number;
}

/** 走の経過秒 t における、レーン lane（0=左, 1=右）の葉の姿勢 */
export function samplePose(trace: RunTrace, lane: 0 | 1, t: number, out: LeafPose): LeafPose {
  const f = trace.frames;
  const pos = t / (SIM.dt * trace.every);
  let i = Math.floor(pos);
  if (i < 0) i = 0;
  const last = trace.frameCount - 1;
  if (i >= last) {
    const k = last * 10 + lane * 5;
    out.x = f[k];
    out.y = f[k + 1];
    out.c = f[k + 2];
    out.s = f[k + 3];
    out.contact = f[k + 4];
    return out;
  }
  const u = pos - i;
  const k0 = i * 10 + lane * 5;
  const k1 = k0 + 10;
  out.x = f[k0] + (f[k1] - f[k0]) * u;
  out.y = f[k0 + 1] + (f[k1 + 1] - f[k0 + 1]) * u;
  let c = f[k0 + 2] + (f[k1 + 2] - f[k0 + 2]) * u;
  let s = f[k0 + 3] + (f[k1 + 3] - f[k0 + 3]) * u;
  const n = Math.sqrt(c * c + s * s) || 1;
  c /= n;
  s /= n;
  out.c = c;
  out.s = s;
  out.contact = f[k0 + 4] + (f[k1 + 4] - f[k0 + 4]) * u;
  return out;
}

/** 走の長さ（秒） */
export function traceDuration(trace: RunTrace): number {
  return (trace.frameCount - 1) * trace.every * SIM.dt;
}
