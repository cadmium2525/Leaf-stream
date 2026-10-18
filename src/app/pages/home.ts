import { BOT_LEAVES, COURSE_IDS, simulateRace } from '../../../packages/sim-core/src/index.ts';
import { getScene } from '../context.ts';
import { h } from '../dom.ts';
import { ReplayPlayer } from '../replay-player.ts';
import { loadDraft } from '../state.ts';
import type { Page } from '../router.ts';

/** トップ：用水路のデモ（ボット同士のレースをゆっくり眺める） */
export function homePage(): Page {
  let player: ReplayPlayer | null = null;
  let demoIndex = Math.floor(Math.random() * 1000);

  const nextDemo = () => {
    const scene = getScene();
    if (!scene) return;
    demoIndex++;
    const courseId = COURSE_IDS[demoIndex % COURSE_IDS.length];
    const seed = (demoIndex * 2654435761) >>> 0;
    const a = demoIndex % 2 === 0 ? loadDraft().polygon : BOT_LEAVES[demoIndex % BOT_LEAVES.length].polygon;
    const b = BOT_LEAVES[(demoIndex * 7 + 3) % BOT_LEAVES.length].polygon;
    const { result, replay } = simulateRace({ courseId, seed, challenger: a, defender: b }, true);
    scene.setCourse(replay!.course);
    scene.setLeaves([{ polygon: a, tone: 'fresh' }, { polygon: b, tone: 'autumn' }]);
    scene.setCameraMode('orbit');
    player = new ReplayPlayer(scene, replay!, result, { countdown: false });
    player.speed = 0.8;
    player.onPhase = (p) => {
      if (p === 'done') nextDemo();
    };
  };

  return {
    mount(root) {
      const scene = getScene();
      if (scene) {
        nextDemo();
        scene.onFrame = (dt) => player?.update(dt);
        scene.start();
      }
      root.append(
        h('section', { class: 'home' },
          h('div', { class: 'home-title' },
            h('div', { class: 'sub' }, 'LEAF STREAM'),
            h('h1', {}, '葉っぱ流し'),
            h('p', {}, '田舎の細い用水路に、自分で切った葉っぱを流して競う。形を変えて、もう一度。相手がオンラインでなくても、誰かの葉っぱと勝負できます。'),
          ),
          h('div', { class: 'btn-row' },
            h('a', { href: '/race', 'data-link': true, class: 'btn primary' }, 'あそぶ'),
            h('a', { href: '/editor', 'data-link': true, class: 'btn' }, '葉っぱを切る'),
            h('a', { href: '/leaderboard', 'data-link': true, class: 'btn' }, 'ランキング'),
          ),
          scene ? null : h('p', { class: 'glass' }, 'この端末では 3D 表示が使えません。葉っぱの編集と練習レースの結果は利用できます。'),
        ),
      );
    },
    unmount() {
      const scene = getScene();
      if (scene) scene.onFrame = null;
    },
  };
}
