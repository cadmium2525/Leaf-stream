/**
 * 編集中の葉を、上から見たプレビュー水路でその場で流してみる（練習用・非公式）。
 * 比較用に「そのままの葉」をゴーストで同時に流す。
 */
import {
  RunSim, SIM, centerAt, defaultLeaf, generateCourse, halfWidthAt, prepareLeaf, type Course, type Polygon,
} from '../../packages/sim-core/src/index.ts';

export class PreviewChannel {
  private ctx: CanvasRenderingContext2D;
  private course: Course;
  private sim: RunSim | null = null;
  private polygon: Polygon | null = null;
  private ghostBody = prepareLeaf(defaultLeaf());
  private acc = 0;
  private raf = 0;
  private last = 0;
  private hold = 0;
  onResult: ((ticks: number | null, ghostTicks: number | null) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, courseId = 'tanbo', seed = 7) {
    this.ctx = canvas.getContext('2d')!;
    this.course = generateCourse(courseId, seed);
  }

  setLeaf(p: Polygon): void {
    this.polygon = p;
    this.restart();
  }

  setCourse(courseId: string, seed: number): void {
    this.course = generateCourse(courseId, seed);
    this.restart();
  }

  private restart(): void {
    if (!this.polygon) return;
    this.sim = new RunSim(this.course, prepareLeaf(this.polygon), this.ghostBody);
    this.acc = 0;
    this.hold = 0;
  }

  start(): void {
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.update(dt);
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  private update(dt: number): void {
    const sim = this.sim;
    if (!sim) return;
    if (sim.done) {
      this.hold += dt;
      if (this.hold > 2) this.restart();
      return;
    }
    // 2 倍速で流す
    this.acc += dt * 2;
    const n = Math.floor(this.acc / SIM.dt);
    if (n > 0) {
      this.acc -= n * SIM.dt;
      sim.step(n);
      if (sim.done) {
        const [a, b] = sim.results();
        this.onResult?.(a.status === 'finished' ? a.finishTick : null, b.status === 'finished' ? b.finishTick : null);
      }
    }
  }

  private draw(): void {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(r.width * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const ctx = this.ctx;
    const w = r.width;
    const h = r.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const course = this.course;
    // 横向き：左→右が下流。全長を幅に収める
    const sc = w / course.length;
    const maxHw = Math.max(...course.halfWidths) + Math.max(...course.centers.map(Math.abs));
    // 細長い水路なので横方向を強調して描く
    const k = Math.max(1, (h * 0.7) / (2 * maxHw * sc));
    const cy = h / 2;
    const px = (y: number) => y * sc;
    const py = (x: number) => cy + x * sc * k;
    ctx.fillStyle = '#5a7a3a';
    ctx.fillRect(0, 0, w, h);
    // 水路
    ctx.beginPath();
    for (let y = 0; y <= course.length; y += 10) ctx.lineTo(px(y), py(centerAt(course, y) - halfWidthAt(course, y)));
    for (let y = course.length; y >= 0; y -= 10) ctx.lineTo(px(y), py(centerAt(course, y) + halfWidthAt(course, y)));
    ctx.closePath();
    ctx.fillStyle = '#2c5b6e';
    ctx.fill();
    ctx.strokeStyle = '#9a968a';
    ctx.lineWidth = 2;
    ctx.stroke();
    // 小さな滝（白い線、切り欠きは太く）
    for (const d of course.drops) {
      const c = centerAt(course, d.y);
      const w = halfWidthAt(course, d.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px(d.y), py(c - w));
      ctx.lineTo(px(d.y), py(c + w));
      ctx.stroke();
      if (d.notchW > 0) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(px(d.y), py(d.notchX - d.notchW / 2));
        ctx.lineTo(px(d.y), py(d.notchX + d.notchW / 2));
        ctx.stroke();
      }
    }
    // 石・渦
    for (const s of course.stones) {
      ctx.fillStyle = '#8b8780';
      ctx.beginPath();
      ctx.ellipse(px(s.y), py(s.x), s.r * sc, s.r * sc * k, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const e of course.eddies) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.ellipse(px(e.y), py(e.x), e.r * sc, e.r * sc * k, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // ゴール
    ctx.strokeStyle = '#f4e7c0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const gc = centerAt(course, course.goalY);
    ctx.moveTo(px(course.goalY), py(gc - halfWidthAt(course, course.goalY)));
    ctx.lineTo(px(course.goalY), py(gc + halfWidthAt(course, course.goalY)));
    ctx.stroke();
    if (!this.sim) return;
    for (const lane of [1, 0] as const) {
      const p = this.sim.pose(lane);
      const size = Math.max(5, 9 * sc * 1.3);
      ctx.save();
      ctx.translate(px(p.y), py(p.x));
      ctx.rotate(Math.atan2(-p.s * k, p.c));
      ctx.fillStyle = lane === 0 ? '#a7e06a' : 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.ellipse(0, 0, size / 2, size * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}
