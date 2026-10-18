/**
 * 葉っぱの切断エディタ（Canvas 2D）。
 * 指／マウスでハサミの軌跡を描く → 分かれた片から「残す方」を選ぶ → 正規化。
 */
import {
  LEAF_RULES, area, getSpecies, normalizePolygon, pointInPolygon, splitPolygonByPath, validateLeaf, type SpeciesId,
  type Polygon, type Vec2,
} from '../../packages/sim-core/src/index.ts';
import { leafTexture, speciesColor } from '../render/textures.ts';

export interface EditorState {
  polygon: Polygon;
  cuts: number;
  species: SpeciesId;
}

type Mode = 'idle' | 'drawing' | 'choosing';

const PIECE_COLORS = ['rgba(79,138,46,0.55)', 'rgba(200,100,43,0.55)', 'rgba(44,91,110,0.55)', 'rgba(170,60,120,0.5)', 'rgba(210,170,40,0.55)'];
/** これより小さい切れ端は自動で捨てる（cm²） */
const CRUMB = 0.35;

/** 折れ線の簡略化（Ramer–Douglas–Peucker） */
export function simplifyPath(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = simplifyPath(pts.slice(0, idx + 1), eps);
  const right = simplifyPath(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

export class LeafEditor {
  onChange: ((s: EditorState) => void) | null = null;
  onMessage: ((msg: string) => void) | null = null;
  onModeChange: ((choosing: boolean) => void) | null = null;

  private ctx: CanvasRenderingContext2D;
  private history: EditorState[];
  private index: number;
  private mode: Mode = 'idle';
  private path: Vec2[] = [];
  private pieces: Polygon[] = [];
  private hoverPiece = -1;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private dpr = 1;
  private texCache = new Map<SpeciesId, HTMLCanvasElement>();
  private ro: ResizeObserver;
  private pointerId: number | null = null;

  constructor(private canvas: HTMLCanvasElement, initial: EditorState) {
    this.ctx = canvas.getContext('2d')!;
    this.history = [{ polygon: initial.polygon, cuts: initial.cuts, species: initial.species }];
    this.index = 0;
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.cancelPointer);
    canvas.addEventListener('pointerleave', this.leave);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  get state(): EditorState {
    return this.history[this.index];
  }

  get canUndo(): boolean {
    return this.index > 0 && this.mode !== 'choosing';
  }

  get canRedo(): boolean {
    return this.index < this.history.length - 1 && this.mode !== 'choosing';
  }

  get choosing(): boolean {
    return this.mode === 'choosing';
  }

  undo(): void {
    if (!this.canUndo) return;
    this.index--;
    this.emit();
  }

  redo(): void {
    if (!this.canRedo) return;
    this.index++;
    this.emit();
  }

  reset(): void {
    this.cancelChoice();
    this.push({ polygon: getSpecies(this.state.species).polygon, cuts: 0, species: this.state.species });
  }

  /** 葉の種類を変える（元の形からやり直し。元に戻すで戻せる） */
  setSpecies(species: SpeciesId): void {
    this.cancelChoice();
    this.push({ polygon: getSpecies(species).polygon, cuts: 0, species });
  }

  private get tex(): HTMLCanvasElement {
    const sp = this.state.species;
    let t = this.texCache.get(sp);
    if (!t) {
      t = leafTexture(sp, 'mine', 512).image as HTMLCanvasElement;
      this.texCache.set(sp, t);
    }
    return t;
  }

  /** 選択中の片のうち最大のものを残す */
  keepLargest(): void {
    if (this.mode !== 'choosing') return;
    let best = 0;
    for (let i = 1; i < this.pieces.length; i++) if (area(this.pieces[i]) > area(this.pieces[best])) best = i;
    this.keep(best);
  }

  cancelChoice(): void {
    if (this.mode !== 'choosing') return;
    this.mode = 'idle';
    this.pieces = [];
    this.onModeChange?.(false);
    this.draw();
  }

  destroy(): void {
    this.ro.disconnect();
    this.canvas.removeEventListener('pointerdown', this.down);
    this.canvas.removeEventListener('pointermove', this.move);
    this.canvas.removeEventListener('pointerup', this.up);
    this.canvas.removeEventListener('pointercancel', this.cancelPointer);
    this.canvas.removeEventListener('pointerleave', this.leave);
  }

  private push(s: EditorState): void {
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(s);
    if (this.history.length > 100) this.history.shift();
    this.index = this.history.length - 1;
    this.emit();
  }

  private emit(): void {
    this.draw();
    this.onChange?.(this.state);
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    // 葉の許容範囲の箱＋余白が収まるように
    const boxW = LEAF_RULES.maxAbsX * 2 + 2.4;
    const boxH = LEAF_RULES.maxAbsY * 2 + 2.4;
    this.scale = Math.min(r.width / boxW, r.height / boxH);
    this.ox = r.width / 2;
    this.oy = r.height / 2;
    this.draw();
  }

  /** 画面座標 → 葉ローカル座標（+y が葉先＝上） */
  private toLocal(e: PointerEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left - this.ox) / this.scale, -(e.clientY - r.top - this.oy) / this.scale];
  }

  private sx(x: number): number {
    return this.ox + x * this.scale;
  }

  private sy(y: number): number {
    return this.oy - y * this.scale;
  }

  private down = (e: PointerEvent) => {
    if (this.pointerId !== null) return;
    const p = this.toLocal(e);
    if (this.mode === 'choosing') {
      const i = this.pieceAt(p);
      if (i >= 0) this.keep(i);
      return;
    }
    if (this.state.cuts >= LEAF_RULES.maxCuts) {
      this.onMessage?.(`切れるのは ${LEAF_RULES.maxCuts} 回までです（元に戻すかリセット）`);
      return;
    }
    this.pointerId = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.mode = 'drawing';
    this.path = [p];
    this.draw();
  };

  private move = (e: PointerEvent) => {
    const p = this.toLocal(e);
    if (this.mode === 'choosing') {
      const i = this.pieceAt(p);
      if (i !== this.hoverPiece) {
        this.hoverPiece = i;
        this.draw();
      }
      return;
    }
    if (this.mode !== 'drawing' || e.pointerId !== this.pointerId) return;
    const last = this.path[this.path.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.06) {
      this.path.push(p);
      this.draw();
    }
  };

  private up = (e: PointerEvent) => {
    if (this.mode !== 'drawing' || e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.path.push(this.toLocal(e));
    this.finishCut();
  };

  private cancelPointer = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.mode = 'idle';
    this.path = [];
    this.draw();
  };

  private leave = () => {
    if (this.mode === 'choosing' && this.hoverPiece !== -1) {
      this.hoverPiece = -1;
      this.draw();
    }
  };

  private pieceAt(p: Vec2): number {
    for (let i = 0; i < this.pieces.length; i++) if (pointInPolygon(this.pieces[i], p[0], p[1])) return i;
    return -1;
  }

  private finishCut(): void {
    const path = simplifyPath(this.path, 0.04);
    this.path = [];
    this.mode = 'idle';
    if (path.length < 2) {
      this.draw();
      return;
    }
    const raw = splitPolygonByPath(this.state.polygon, path);
    const pieces = raw.map(normalizePolygon).filter((p) => p.length >= 3 && area(p) >= CRUMB);
    if (raw.length < 2) {
      this.onMessage?.('葉の外から入って、外まで切り抜けてください');
      this.draw();
      return;
    }
    if (pieces.length === 0) {
      this.draw();
      return;
    }
    if (pieces.length === 1) {
      // 切れ端だけ落ちた
      this.commit(pieces[0]);
      return;
    }
    this.pieces = pieces;
    this.mode = 'choosing';
    this.hoverPiece = -1;
    this.onModeChange?.(true);
    this.onMessage?.('残す方をタップしてください');
    this.draw();
  }

  private keep(i: number): void {
    const p = this.pieces[i];
    this.pieces = [];
    this.mode = 'idle';
    this.onModeChange?.(false);
    this.commit(p);
  }

  private commit(p: Polygon): void {
    const v = validateLeaf(p);
    if (v.errors.includes('self_intersection') || v.errors.includes('too_few_vertices')) {
      this.onMessage?.('この切り方は形が崩れるので使えません');
      this.draw();
      return;
    }
    this.push({ polygon: p, cuts: this.state.cuts + 1, species: this.state.species });
  }

  // ---------------------------------------------------------------- 描画

  private polyPath(p: Polygon): Path2D {
    const path = new Path2D();
    p.forEach(([x, y], i) => (i === 0 ? path.moveTo(this.sx(x), this.sy(y)) : path.lineTo(this.sx(x), this.sy(y))));
    path.closePath();
    return path;
  }

  draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // カッティングマット
    ctx.fillStyle = '#2f5a4a';
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1;
    const x0 = Math.floor(-this.ox / this.scale) - 1;
    const x1 = Math.ceil((w - this.ox) / this.scale) + 1;
    const y0 = Math.floor(-(h - this.oy) / this.scale) - 1;
    const y1 = Math.ceil(this.oy / this.scale) + 1;
    for (let x = x0; x <= x1; x++) {
      ctx.strokeStyle = x % 5 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(this.sx(x), 0);
      ctx.lineTo(this.sx(x), h);
      ctx.stroke();
    }
    for (let y = y0; y <= y1; y++) {
      ctx.strokeStyle = y % 5 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, this.sy(y));
      ctx.lineTo(w, this.sy(y));
      ctx.stroke();
    }
    // 流れの向き
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('▲ 下流（葉先の向き）', w / 2, 18);

    // 元の葉の輪郭
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.stroke(this.polyPath(getSpecies(this.state.species).polygon));
    ctx.setLineDash([]);

    const poly = this.state.polygon;
    if (this.mode === 'choosing') {
      this.pieces.forEach((p, i) => {
        const path = this.polyPath(p);
        this.fillLeaf(path, i === this.hoverPiece ? 1 : 0.55);
        ctx.fillStyle = PIECE_COLORS[i % PIECE_COLORS.length];
        ctx.fill(path);
        ctx.lineWidth = i === this.hoverPiece ? 3 : 1.5;
        ctx.strokeStyle = i === this.hoverPiece ? '#fff' : 'rgba(255,255,255,0.7)';
        ctx.stroke(path);
      });
    } else {
      const path = this.polyPath(poly);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = speciesColor(this.state.species);
      ctx.fill(path);
      ctx.restore();
      this.fillLeaf(path, 1);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(30,40,20,0.8)';
      ctx.stroke(path);
    }

    if (this.mode === 'drawing' && this.path.length > 1) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffd36b';
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      this.path.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(this.sx(x), this.sy(y)) : ctx.lineTo(this.sx(x), this.sy(y))));
      ctx.stroke();
      ctx.setLineDash([]);
      const [lx, ly] = this.path[this.path.length - 1];
      ctx.font = '20px sans-serif';
      ctx.fillText('✂', this.sx(lx) + 14, this.sy(ly) - 10);
    }
  }

  private fillLeaf(path: Path2D, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.clip(path);
    ctx.globalAlpha = alpha;
    ctx.drawImage(
      this.tex,
      this.sx(-LEAF_RULES.maxAbsX),
      this.sy(LEAF_RULES.maxAbsY),
      LEAF_RULES.maxAbsX * 2 * this.scale,
      LEAF_RULES.maxAbsY * 2 * this.scale,
    );
    ctx.restore();
  }
}
