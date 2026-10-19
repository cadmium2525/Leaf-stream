/** アプリ全体で共有する 3D ステージと環境音 */
import { CanalScene, type EffectiveQuality } from '../render/scene.ts';
import { Ambience } from '../audio/ambience.ts';
import { isMobile, onSettingsChange, settings } from './state.ts';
import { toast } from './dom.ts';
import type { Polygon } from '../../packages/sim-core/src/index.ts';

let scene: CanalScene | null = null;
let webglFailed = false;
export const ambience = new Ambience();

export function effectiveQuality(): EffectiveQuality {
  if (settings.quality !== 'auto') return settings.quality;
  return isMobile() ? 'standard' : 'high';
}

/** WebGL が使えなければ null */
export function getScene(): CanalScene | null {
  if (scene || webglFailed) return scene;
  try {
    const stage = document.getElementById('stage')!;
    scene = new CanalScene(stage, effectiveQuality());
    scene.autoQuality = settings.quality === 'auto';
    scene.onAutoDowngrade = (q) => toast(q === 'eco' ? '動作が重いため省電力画質に切り替えました' : '動作が重いため標準画質に切り替えました');
  } catch (e) {
    console.error(e);
    webglFailed = true;
    toast('3D 表示に対応していない環境です。簡易表示で動作します');
  }
  return scene;
}

onSettingsChange(() => {
  if (scene) {
    scene.autoQuality = settings.quality === 'auto';
    scene.setQuality(effectiveQuality());
  }
  if (settings.sound) {
    if (ambience.running) ambience.setVolume(settings.volume);
  } else ambience.stop();
});

/**
 * ユーザー操作で環境音を始める（自動再生ポリシー対策）。
 * iOS ではブラウザを離れて戻ると音が止まったままになるので、操作のたびに再開を試みる
 */
export function armAudio(): void {
  const go = () => {
    if (!settings.sound || ambience.running) return;
    ambience.setVolume(settings.volume);
    void ambience.start();
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(ev, go, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && settings.sound) ambience.resume();
  });
}

/** 葉っぱのサムネイルを canvas に描く */
export function drawLeafThumb(canvas: HTMLCanvasElement, polygon: Polygon, color = '#5f9a35'): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 120;
  const h = canvas.clientHeight || 150;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const sc = Math.min(w / 8, h / 12);
  ctx.beginPath();
  polygon.forEach(([x, y], i) => (i ? ctx.lineTo(w / 2 + x * sc, h / 2 - y * sc) : ctx.moveTo(w / 2 + x * sc, h / 2 - y * sc)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(w / 2, h / 2 + 4.6 * sc);
  ctx.lineTo(w / 2, h / 2 - 4.6 * sc);
  ctx.stroke();
  ctx.restore();
}
