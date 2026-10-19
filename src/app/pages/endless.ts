import {
  ENDLESS, ENDLESS_VERSION, EndlessCourse, centerAt, endlessSeed, getSpecies, halfWidthAt, isoWeekKey, simulateEndless,
  validateLeaf, type EndlessReason, type EndlessResult,
} from '../../../packages/sim-core/src/index.ts';
import { errorText, myEndless, online, submitEndless } from '../../api/client.ts';
import { speciesColor } from '../../render/textures.ts';
import { ambience, drawLeafThumb, getScene } from '../context.ts';
import { h, toast } from '../dom.ts';
import { EndlessPlayer, endlessLaneX, type EndlessTick } from '../endless-player.ts';
import { loadDraft, loadEndlessLocal, saveEndlessLocal, settings } from '../state.ts';
import type { Page, Router } from '../router.ts';
import { windText } from '../wind-text.ts';

export const REASON_TEXT: Record<EndlessReason, string> = {
  roller: '滝壺に飲み込まれて、ぐるぐる回り続けた',
  post: '杭に引っかかった',
  stone: '岩に引っかかった',
  bank: '岸に寄ったまま動けなくなった',
  eddy: 'よどみにつかまった',
  time: '制限時間まで流れ切った！',
};

export const meters = (cm: number) => `${(cm / 100).toFixed(1)} m`;

/** /endless：どこまでもモード。流す位置を決めて、詰まるまで見守る */
export function endlessPage(router: Router): Page {
  let player: EndlessPlayer | null = null;
  let ui: HTMLElement | null = null;
  let disposed = false;
  const week = isoWeekKey(Date.now());
  const course = new EndlessCourse(endlessSeed(week));
  /** サーバーにある今週の自己ベスト（cm）。未取得・未参加は null */
  let serverBest: number | null = null;

  const cleanupScene = () => {
    const scene = getScene();
    if (scene) {
      scene.onFrame = null;
      scene.setLeaves([]);
    }
  };

  return {
    mount(root) {
      ui = h('div', { class: 'race-ui' });
      root.append(ui);
      getScene()?.start();
      showSetup();
    },
    unmount() {
      disposed = true;
      player = null;
      cleanupScene();
    },
  };

  // ---------------------------------------------------------------- 準備

  function showSetup(): void {
    if (!ui || disposed) return;
    player = null;
    const scene = getScene();
    const draft = loadDraft('endless');
    const ok = validateLeaf(draft.polygon).ok;
    const local = loadEndlessLocal();
    let lane = local.lane;
    const c0 = course.chunk(0);
    if (scene) {
      scene.onFrame = null;
      scene.setCourse(c0);
      scene.setLeaves([{ polygon: draft.polygon, species: draft.species, tone: 'mine' }]);
      scene.setCameraMode('overhead');
    }
    const preview = h('canvas', { class: 'lane-preview', 'aria-hidden': 'true' });
    const place = () => {
      const x = centerAt(c0, c0.startY) + endlessLaneX(lane, halfWidthAt(c0, c0.startY));
      scene?.setPose(0, { x, y: c0.startY, c: 1, s: 0, contact: 0 });
      laneText.textContent = lane === 0 ? 'まんなか' : `${lane < 0 ? '左' : '右'}へ ${Math.abs(lane)}`;
      drawLanePreview(preview, halfWidthAt(c0, c0.startY), x - centerAt(c0, c0.startY), draft.polygon, speciesColor(draft.species));
    };

    const thumb = h('canvas', { class: 'leaf-thumb small' });
    const laneText = h('b', {}, '');
    const slider = h('input', {
      type: 'range', min: String(-ENDLESS.laneSteps), max: String(ENDLESS.laneSteps), step: '1', value: String(lane),
      'aria-label': '流す位置（左右）',
      oninput: (e: Event) => {
        lane = Number((e.target as HTMLInputElement).value);
        saveEndlessLocal({ ...loadEndlessLocal(), lane });
        place();
      },
    });
    const bestLine = h('p', { class: 'muted' }, '');
    const showBest = () => {
      const l = loadEndlessLocal();
      const localBest = l.week === week ? l.best : 0;
      const best = Math.max(localBest, serverBest ?? 0);
      bestLine.textContent = best > 0 ? `今週の自己ベスト ${meters(best)}` : 'まだ今週の記録はありません';
    };
    const goBtn = h('button', { class: 'btn primary', disabled: !ok, onclick: () => void startRun(lane) }, '流す');
    ui.replaceChildren(h('div', { class: 'endless-setup glass' },
      h('div', { class: 'endless-head' },
        h('h2', {}, 'どこまでも'),
        h('span', { class: 'muted' }, `今週のコース（${week}）`)),
      h('p', { class: 'muted' }, '詰まるまで流して、進んだ距離を競います。決められるのは流す位置だけ。コースは全員同じで毎週月曜に変わります。'),
      h('div', { class: 'endless-leaf' },
        thumb,
        h('div', {},
          h('p', {}, `${getSpecies(draft.species).name}（どこまでも用の葉）`),
          ok ? null : h('p', { class: 'muted' }, '形が登録条件を満たしていません'),
          h('a', { href: '/editor?for=endless', 'data-link': true, class: 'btn small' }, '形を変える'))),
      preview,
      h('div', { class: 'lane-row' }, h('span', { class: 'muted' }, '左岸'), slider, h('span', { class: 'muted' }, '右岸')),
      h('p', { style: 'text-align:center' }, '流す位置：', laneText),
      bestLine,
      h('div', { class: 'btn-row' }, goBtn,
        h('a', { href: '/leaderboard?mode=endless', 'data-link': true, class: 'btn' }, 'ランキング')),
    ));
    requestAnimationFrame(() => {
      drawLeafThumb(thumb, draft.polygon, speciesColor(draft.species));
      place();
    });
    place();
    showBest();
    if (online) {
      void myEndless(week).then((r) => {
        serverBest = r.week;
        if (!disposed) showBest();
      }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- 観戦

  async function startRun(lane: number): Promise<void> {
    if (!ui || disposed) return;
    const draft = loadDraft('endless');
    if (!validateLeaf(draft.polygon).ok) {
      toast('葉っぱの形が登録条件を満たしていません');
      router.go('/editor?for=endless');
      return;
    }
    ui.replaceChildren(h('div', { class: 'race-center' }, h('div', { class: 'panel' }, h('p', {}, '流れを計算しています…'))));
    // 計算の前に表示を更新する
    await new Promise((r) => setTimeout(r, 30));
    if (disposed) return;
    const { result, trace } = simulateEndless({ seed: course.seed, polygon: draft.polygon, lane }, true);
    const scene = getScene();
    if (!scene) {
      void showResult(result, lane);
      return;
    }
    scene.setLeaves([{ polygon: draft.polygon, species: draft.species, tone: 'mine' }]);
    scene.setCameraMode('follow');
    const p = new EndlessPlayer(scene, course, trace!, result.distance);
    player = p;

    const dist = h('div', { class: 'race-clock' }, '0.0 m');
    const section = h('div', { class: 'muted', style: 'text-align:center' }, '');
    const windLabel = h('div', { class: 'muted', style: 'text-align:center;font-size:12px' }, '');
    const countdown = h('div', { class: 'countdown' }, '');
    const banner = h('div', { class: 'glass banner hidden' }, '');
    const flash = h('div', { class: 'chunk-flash' });
    const camBtn = h('button', { class: 'btn small' }, '視点：追従');
    const speedBtn = h('button', { class: 'btn small' }, '×1');
    const skipBtn = h('button', { class: 'btn small' }, '詰まるところまで');
    const resultBtn = h('button', { class: 'btn small' }, '結果へ');
    ui.replaceChildren(
      flash,
      h('div', { class: 'race-top' }, h('div', { class: 'glass' }, dist, section, windLabel)),
      countdown, banner,
      h('div', { class: 'race-bottom glass' }, camBtn, speedBtn, skipBtn, resultBtn),
    );
    let cam = 0;
    camBtn.addEventListener('click', () => {
      cam = 1 - cam;
      scene.setCameraMode(cam ? 'overhead' : 'follow');
      camBtn.textContent = cam ? '視点：俯瞰' : '視点：追従';
    });
    speedBtn.addEventListener('click', () => {
      p.speed = p.speed === 1 ? 2 : p.speed === 2 ? 4 : 1;
      speedBtn.textContent = `×${p.speed}`;
    });
    skipBtn.addEventListener('click', () => {
      p.skipToStop();
      countdown.textContent = '';
    });
    resultBtn.addEventListener('click', () => p.skipAll());

    let bannerTimer = 0;
    const showBanner = (text: string, ms: number) => {
      banner.textContent = text;
      banner.classList.remove('hidden');
      window.clearTimeout(bannerTimer);
      if (ms > 0) bannerTimer = window.setTimeout(() => banner.classList.add('hidden'), ms);
    };
    let countTimer = 0;
    p.onCount = (n) => {
      countdown.classList.remove('pop', 'go');
      void countdown.offsetWidth;
      countdown.textContent = n > 0 ? String(n) : 'スタート！';
      countdown.classList.add(n > 0 ? 'pop' : 'go');
      if (settings.sound) ambience.beep(n);
      window.clearTimeout(countTimer);
      if (n === 0) countTimer = window.setTimeout(() => { countdown.textContent = ''; }, 900);
    };
    p.onChunk = (i) => {
      const c = course.chunk(i);
      section.textContent = `区間 ${i + 1}・${c.name}`;
      if (i > 0 && p.phase === 'running') {
        // 区間の切り替わりは白く光らせて、見た目の継ぎ目を隠す
        flash.classList.remove('go');
        void flash.offsetWidth;
        flash.classList.add('go');
        showBanner(`区間 ${i + 1}：${c.name}`, 1800);
      }
    };
    p.onPhase = (ph) => {
      if (ph === 'stopped') {
        showBanner(result.status === 'timeout' ? '制限時間！' : `詰まった！ ${REASON_TEXT[result.reason]}`, 0);
      } else if (ph === 'done') {
        player = null;
        void showResult(result, lane);
      }
    };
    const windNow: [number, number] = [0, 0];
    p.onTick = (s: EndlessTick) => {
      dist.textContent = meters(s.distance);
      const c = course.chunk(s.chunk);
      windLabel.textContent = windText(c, s.t, windNow);
      const near = c.drops.reduce((m, d) => Math.max(m, 1 - Math.min(1, Math.abs(s.pose.y - d.y) / 80)), 0);
      ambience.setWaterIntensity(c.baseSpeed / 50 + near * 0.8);
    };
    section.textContent = `区間 1・${course.chunk(0).name}`;
    scene.onFrame = (dt) => player?.update(dt);
  }

  // ---------------------------------------------------------------- 結果

  async function showResult(result: EndlessResult, lane: number): Promise<void> {
    if (!ui || disposed) return;
    getScene()?.setCameraMode('overhead');
    const local = loadEndlessLocal();
    const prevLocal = local.week === week ? local.best : 0;
    const prevBest = Math.max(prevLocal, serverBest ?? 0);
    const newBest = result.distance > prevBest;
    if (result.distance > prevLocal) saveEndlessLocal({ ...loadEndlessLocal(), week, best: result.distance });

    const status = h('p', { class: 'muted' }, '');
    const box = h('div', { class: 'panel' },
      h('p', { class: 'muted' }, `どこまでも・${week}`),
      h('div', { class: `outcome${newBest ? ' win' : ''}` }, meters(result.distance)),
      h('p', {}, REASON_TEXT[result.reason]),
      h('p', { class: 'muted' }, `区間 ${result.chunk + 1}（${course.chunk(result.chunk).name}）・${(result.ticks / 60).toFixed(0)} 秒`),
      h('p', {}, newBest ? (prevBest > 0 ? `自己ベスト更新！（これまで ${meters(prevBest)}）` : '今週はじめての記録！') : `今週の自己ベスト ${meters(prevBest)}`),
      status,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => showSetup() }, 'もう一度'),
        h('a', { href: '/editor?for=endless', 'data-link': true, class: 'btn' }, '形を変える'),
        h('a', { href: '/leaderboard?mode=endless', 'data-link': true, class: 'btn' }, 'ランキング')),
    );
    ui.replaceChildren(h('div', { class: 'race-center' }, box));

    // ランキングへの登録：自己ベストを超えたときだけ送る（距離はサーバーが計算し直す）
    if (!online) {
      status.textContent = 'サーバー未設定のため、記録はこの端末にだけ残ります。';
      return;
    }
    if (!newBest) return;
    status.textContent = 'ランキングに登録しています…';
    try {
      const d = loadDraft('endless');
      const r = await submitEndless(d.polygon, d.species, lane, week, ENDLESS_VERSION);
      serverBest = r.best;
      if (disposed) return;
      status.textContent = r.distance !== result.distance
        ? `※ サーバーの計算では ${meters(r.distance)} でした。今週 ${r.rank} 位`
        : `ランキングに登録しました。今週 ${r.rank} 位`;
    } catch (e) {
      status.textContent = `登録できませんでした：${errorText(e)}`;
    }
  }
}

/** 流す位置の見取り図：スタート地点を真上から見た水路と葉（上が下流） */
function drawLanePreview(canvas: HTMLCanvasElement, halfWidth: number, offsetX: number, polygon: [number, number][], color: string): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 300;
  const hgt = canvas.clientHeight || 110;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = w / (halfWidth * 2 + 14);
  const cx = w / 2;
  g.fillStyle = '#7f9a62';
  g.fillRect(0, 0, w, hgt);
  g.fillStyle = '#9c9a90';
  g.fillRect(cx - (halfWidth + 2) * s, 0, (halfWidth + 2) * 2 * s, hgt);
  const water = g.createLinearGradient(cx - halfWidth * s, 0, cx + halfWidth * s, 0);
  water.addColorStop(0, '#5f8f95');
  water.addColorStop(0.5, '#7fb3b5');
  water.addColorStop(1, '#5f8f95');
  g.fillStyle = water;
  g.fillRect(cx - halfWidth * s, 0, halfWidth * 2 * s, hgt);
  // 流れの筋
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 1;
  for (let i = -3; i <= 3; i++) {
    const x = cx + i * halfWidth * 0.28 * s;
    g.beginPath();
    g.moveTo(x, hgt - 8);
    g.lineTo(x, 10);
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.font = '12px sans-serif';
  g.fillText('↑ 下流', cx + halfWidth * s - 46, 16);
  // 葉（ローカルの +y が下流＝上）
  const ly = hgt * 0.62;
  g.beginPath();
  polygon.forEach(([px, py], i) => {
    const X = cx + (offsetX + px) * s;
    const Y = ly - py * s;
    if (i === 0) g.moveTo(X, Y);
    else g.lineTo(X, Y);
  });
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.stroke();
}
