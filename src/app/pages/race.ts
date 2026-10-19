import {
  BOT_LEAVES, COURSE_IDS, COURSE_PRESETS, SIM, generateCourse, isSpeciesId, shapeHash, simulateRace, windAt, type Course,
  type SpeciesId, ticksToSeconds, validateLeaf,
  type LeafRunResult, type Polygon, type RaceOutcome, type RaceResult,
} from '../../../packages/sim-core/src/index.ts';
import {
  ApiError, challenge, errorText, getMyProfile, getRaceDefender, online, rankedEnabled, registerLeaf,
  reportUser, resolveRace, updateDisplayName, type ResolvedRace,
} from '../../api/client.ts';
import { ambience, getScene } from '../context.ts';
import { h, toast } from '../dom.ts';
import { ReplayPlayer, type PlayerTick } from '../replay-player.ts';
import { loadDraft, settings } from '../state.ts';
import { nameInput, nameProblem } from '../name-field.ts';
import type { Page, Router } from '../router.ts';

interface RaceSetup {
  ranked: boolean;
  raceId?: string;
  courseId: string;
  seed: number;
  me: Polygon;
  opp: Polygon;
  meSpecies: SpeciesId;
  oppSpecies: SpeciesId;
  oppName: string;
}

const COLORS = ['#8fd14f', '#e39a3b'];

/** /race：対戦相手・コース表示、開始、観戦（追従／俯瞰）、結果表示 */
export function racePage(router: Router): Page {
  let player: ReplayPlayer | null = null;
  let ui: HTMLElement | null = null;
  let disposed = false;
  let labels: HTMLElement[] = [];

  const cleanupScene = () => {
    const scene = getScene();
    if (scene) {
      scene.onFrame = null;
      scene.setLeaves([]);
    }
  };

  return {
    mount(root, params) {
      ui = h('div', { class: 'race-ui' });
      root.append(ui);
      const scene = getScene();
      scene?.start();
      if (scene) scene.onFrame = null;
      if (params.get('mode') === 'practice') void startPractice(params.get('bot'), params.get('course') ?? 'random');
      else void showSelect();
    },
    unmount() {
      disposed = true;
      player = null;
      cleanupScene();
    },
  };

  // ---------------------------------------------------------------- 選択画面

  async function showSelect(): Promise<void> {
    if (!ui) return;
    cleanupScene();
    const scene = getScene();
    if (scene && !scene.hasCourse) scene.setCourse(generateCourse('tanbo', 1));
    scene?.setCameraMode('orbit');
    const rankedCard = h('div', { class: 'glass mode-card' },
      h('h2', {}, 'ランク戦'),
      h('p', { class: 'muted' }, '登録した葉っぱで、誰かの登録葉っぱにランダムに挑戦。勝つと連勝が伸びます。'),
    );
    const draft = loadDraft().polygon;
    const draftOk = validateLeaf(draft).ok;
    let botId = 'random';
    let courseId = 'random';
    const botRow = h('div', { class: 'bot-list' });
    const renderBots = () => {
      botRow.replaceChildren(...[{ id: 'random', name: 'おまかせ' }, ...BOT_LEAVES].map((b) =>
        h('button', { class: `btn small${botId === b.id ? ' primary' : ''}`, onclick: () => { botId = b.id; renderBots(); } }, b.name)));
    };
    renderBots();
    const courseSel = h('select', { onchange: (e: Event) => { courseId = (e.target as HTMLSelectElement).value; } },
      h('option', { value: 'random' }, 'コース：おまかせ'),
      ...COURSE_PRESETS.map((c) => h('option', { value: c.id }, `${c.name} — ${c.description}`)));
    const practiceCard = h('div', { class: 'glass mode-card' },
      h('h2', {}, '練習'),
      h('p', { class: 'muted' }, '編集中の葉っぱで、練習用の相手と対戦します（戦績には残りません）。'),
      h('label', { style: 'color:inherit' }, '相手'),
      botRow,
      courseSel,
      h('div', { class: 'btn-row' },
        h('button', {
          class: 'btn primary', disabled: !draftOk,
          onclick: () => void startPractice(botId, courseId),
        }, '練習スタート'),
        h('a', { href: '/editor', 'data-link': true, class: 'btn' }, '葉っぱを編集'),
      ),
      draftOk ? null : h('p', { class: 'muted' }, '編集中の葉っぱが登録条件を満たしていません。'),
    );
    ui.replaceChildren(h('div', { class: 'race-center' }, h('div', { class: 'mode-cards' }, rankedCard, practiceCard)));

    // ランク戦の状態を確認
    if (!online) {
      rankedCard.append(h('p', {}, 'サーバーが設定されていないため、ランク戦は利用できません。'));
      return;
    }
    const status = h('p', { class: 'muted' }, '確認中…');
    rankedCard.append(status);
    try {
      const [{ profile, leaf, stats }, enabled] = await Promise.all([getMyProfile(), rankedEnabled()]);
      if (!enabled) {
        status.textContent = 'ただいまランク戦の受付を停止しています。練習は遊べます。';
        return;
      }
      // ランキングに載る名前。初めての人もここで決めてそのまま挑戦できる
      const name = nameInput(profile?.display_name ?? '', 'ranked-name');
      const nameRow = h('div', {},
        h('label', { for: 'ranked-name', style: 'color:inherit' }, 'ランキングに表示する名前'),
        name);
      const challengeBtn = (label: string, registerDraft: boolean, primary = true) => h('button', {
        class: `btn${primary ? ' primary' : ''}`,
        disabled: registerDraft && !draftOk,
        onclick: (e: Event) => void startRanked(e.currentTarget as HTMLButtonElement, registerDraft, name.value.trim(), profile?.display_name ?? null),
      }, label);
      if (!leaf) {
        status.replaceWith(
          h('p', {}, '登録不要で参加できます。名前を決めて、いま編集中の葉っぱで挑戦しましょう。'),
          nameRow,
          h('div', { class: 'btn-row' }, challengeBtn('この葉っぱで挑戦', true), h('a', { href: '/editor', 'data-link': true, class: 'btn' }, '先に形を変える')),
          h('p', { class: 'muted' }, '記録はこのブラウザに保存されます。'),
        );
        return;
      }
      const draftDiffers = shapeHash(draft) !== leaf.shape_hash;
      status.replaceWith(
        h('p', {}, `現在 ${stats?.current_streak ?? 0} 連勝（最高 ${stats?.best_streak ?? 0}）・登録中の葉 v${leaf.version}`),
        nameRow,
        h('div', { class: 'btn-row' },
          challengeBtn('ランダムな相手に挑戦', false),
          draftDiffers && draftOk ? challengeBtn('編集中の形に更新して挑戦', true, false) : ''),
      );
    } catch (e) {
      status.textContent = errorText(e);
    }
  }

  // ---------------------------------------------------------------- 開始

  async function startPractice(botId: string | null, courseId = 'random'): Promise<void> {
    const draft = loadDraft();
    const me = draft.polygon;
    if (!validateLeaf(me).ok) {
      toast('編集中の葉っぱが登録条件を満たしていません');
      router.go('/editor', true);
      return;
    }
    const bot = !botId || botId === 'random'
      ? BOT_LEAVES[Math.floor(Math.random() * BOT_LEAVES.length)]
      : BOT_LEAVES.find((b) => b.id === botId) ?? BOT_LEAVES[0];
    const cid = !courseId || courseId === 'random' ? COURSE_IDS[Math.floor(Math.random() * COURSE_IDS.length)] : courseId;
    await play({
      ranked: false, courseId: cid, seed: (Math.random() * 4294967296) >>> 0,
      me, opp: bot.polygon, meSpecies: draft.species, oppSpecies: bot.species, oppName: `${bot.name}（練習）`,
    }, null);
  }

  async function startRanked(btn: HTMLButtonElement, registerDraft: boolean, name: string, currentName: string | null): Promise<void> {
    // 名前が空ならそのまま（自動の名前）。入力があれば確認してから保存
    if (name && name !== currentName) {
      const problem = nameProblem(name);
      if (problem) {
        toast(problem);
        return;
      }
    }
    const label = btn.textContent ?? '';
    btn.disabled = true;
    btn.textContent = registerDraft ? '葉っぱを登録しています…' : '相手を探しています…';
    try {
      if (name && name !== currentName) await updateDisplayName(name);
      if (registerDraft) {
        const d = loadDraft();
        await registerLeaf(d.polygon, d.species);
        btn.textContent = '相手を探しています…';
      }
      const key = crypto.randomUUID();
      const { race } = await challenge(key);
      if (!race) {
        toast('まだ相手がいないので、練習用の相手と対戦します（ランク戦の対象外）', 4000);
        const { leaf } = await getMyProfile();
        const bot = BOT_LEAVES[Math.floor(Math.random() * BOT_LEAVES.length)];
        await play({
          ranked: false, courseId: COURSE_IDS[Math.floor(Math.random() * COURSE_IDS.length)], seed: (Math.random() * 4294967296) >>> 0,
          me: leaf?.polygon ?? loadDraft().polygon, opp: bot.polygon,
          meSpecies: leaf?.species ?? loadDraft().species, oppSpecies: bot.species, oppName: `${bot.name}（練習）`,
        }, null);
        return;
      }
      // 公式結果はサーバーで確定。観戦と並行して確定を依頼する
      const official = resolveWithRetry(race.id);
      // 観戦中（または途中で画面を離れたあと）に失敗しても未処理の拒否にしない。失敗は結果画面で表示する
      official.catch(() => undefined);
      await play({
        ranked: true, raceId: race.id, courseId: race.course_id, seed: race.seed,
        me: race.challenger_shape, opp: race.defender_shape, oppName: race.defender_name,
        meSpecies: isSpeciesId(race.challenger_species) ? race.challenger_species : 'sakura',
        oppSpecies: isSpeciesId(race.defender_species) ? race.defender_species : 'sakura',
      }, official);
    } catch (e) {
      toast(errorText(e), 4000);
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function resolveWithRetry(raceId: string): Promise<ResolvedRace> {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        return await resolveRace(raceId);
      } catch (e) {
        last = e;
        // 確定済み・不正などは再試行しない
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) break;
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    throw last;
  }

  // ---------------------------------------------------------------- 観戦

  async function play(setup: RaceSetup, official: Promise<ResolvedRace> | null): Promise<void> {
    if (!ui || disposed) return;
    const scene = getScene();
    // 観戦用の軌跡は同じ決定論的シミュレータでこの端末で計算する
    const { result, replay } = simulateRace({ courseId: setup.courseId, seed: setup.seed, challenger: setup.me, defender: setup.opp }, true);
    const course = replay!.course;

    if (!scene) {
      // 3D なし：結果だけ表示
      await showResult(setup, result, official);
      return;
    }
    scene.setCourse(course);
    scene.setLeaves([
      { polygon: setup.me, species: setup.meSpecies, tone: 'mine' },
      { polygon: setup.opp, species: setup.oppSpecies, tone: 'rival' },
    ]);
    scene.setCameraMode('follow');
    player = new ReplayPlayer(scene, replay!, result);

    const clock = h('div', { class: 'race-clock' }, '0.00');
    const runLabel = h('div', { class: 'muted', style: 'text-align:center' }, `1 走目 / ${course.name}`);
    const windLabel = h('div', { class: 'muted', style: 'text-align:center;font-size:12px' }, '');
    const windNow: [number, number] = [0, 0];
    const prog = h('div', { class: 'progress-track' },
      h('span', { style: `background:${COLORS[0]};left:0%` }), h('span', { style: `background:${COLORS[1]};left:0%` }));
    const chipA = h('div', { class: 'glass racer-chip' }, h('span', { class: 'dot', style: `background:${COLORS[0]}` }), h('span', {}, 'あなた'), h('b', {}, ''));
    const chipB = h('div', { class: 'glass racer-chip' }, h('span', { class: 'dot', style: `background:${COLORS[1]}` }), h('span', {}, setup.oppName), h('b', {}, ''));
    const countdown = h('div', { class: 'countdown' }, '');
    const banner = h('div', { class: 'glass banner hidden' }, '');
    const camBtn = h('button', { class: 'btn small' }, '視点：追従');
    const speedBtn = h('button', { class: 'btn small' }, '×1');
    const skipBtn = h('button', { class: 'btn small' }, 'この走を飛ばす');
    const resultBtn = h('button', { class: 'btn small' }, '結果へ');
    labels = [h('div', { class: 'label3d' }, 'あなた'), h('div', { class: 'label3d' }, setup.oppName)];
    ui.replaceChildren(
      h('div', { class: 'race-top' }, chipA, h('div', { class: 'glass' }, clock, runLabel, windLabel, prog), chipB),
      countdown, banner, ...labels,
      h('div', { class: 'race-bottom glass' }, camBtn, speedBtn, skipBtn, resultBtn),
    );

    const modes = ['follow', 'overhead'] as const;
    let mi = 0;
    camBtn.addEventListener('click', () => {
      mi = (mi + 1) % modes.length;
      scene.setCameraMode(modes[mi]);
      camBtn.textContent = mi === 0 ? '視点：追従' : '視点：俯瞰';
    });
    speedBtn.addEventListener('click', () => {
      if (!player) return;
      player.speed = player.speed === 1 ? 2 : player.speed === 2 ? 4 : 1;
      speedBtn.textContent = `×${player.speed}`;
    });
    skipBtn.addEventListener('click', () => {
      player?.skipRun();
      // カウントダウン中に飛ばしたとき、数字が残らないように消す
      window.clearTimeout(countTimer);
      countdown.textContent = '';
    });
    resultBtn.addEventListener('click', () => player?.skipAll());

    const runTimes = (r: LeafRunResult) => (r.status === 'finished' ? ticksToSeconds(r.finishTick).toFixed(2) : statusText(r));
    let countTimer = 0;
    player.onCount = (n) => {
      // アニメーションを毎回やり直す
      countdown.classList.remove('pop', 'go');
      void countdown.offsetWidth;
      countdown.textContent = n > 0 ? String(n) : 'スタート！';
      countdown.classList.add(n > 0 ? 'pop' : 'go');
      if (settings.sound) ambience.beep(n);
      window.clearTimeout(countTimer);
      if (n === 0) countTimer = window.setTimeout(() => { countdown.textContent = ''; }, 900);
    };
    player.onPhase = (p, run) => {
      if (p === 'interlude') {
        banner.textContent = '2 走目：スタート位置を左右入れ替えます';
        banner.classList.remove('hidden');
      } else if (p === 'running') {
        banner.classList.add('hidden');
        runLabel.textContent = `${run + 1} 走目 / ${course.name}`;
      } else if (p === 'done') {
        player = null;
        void showResult(setup, result, official);
      }
    };
    player.onTick = (s: PlayerTick) => {
      const res = result.runs[s.run];
      windLabel.textContent = windText(course, s.t, windNow);
      // 2 枚ともゴールしたら時計は止める（葉はそのまま流れ続ける）
      const allIn = res[0].status === 'finished' && res[1].status === 'finished' && s.finished[0] && s.finished[1];
      clock.textContent = (allIn ? Math.max(res[0].finishTick, res[1].finishTick) / 60 : s.t).toFixed(2);
      // 滝の近くでは水音を大きく
      const lead = Math.max(s.poses[0].y, s.poses[1].y);
      const near = course.drops.reduce((m, d) => Math.max(m, 1 - Math.min(1, Math.abs(lead - d.y) / 80)), 0);
      ambience.setWaterIntensity(course.baseSpeed / 50 + near * 0.8);
      (chipA.lastChild as HTMLElement).textContent = s.finished[0] ? ` ${runTimes(res[0])}` : '';
      (chipB.lastChild as HTMLElement).textContent = s.finished[1] ? ` ${runTimes(res[1])}` : '';
      const dots = prog.children;
      for (let i = 0; i < 2; i++) {
        const k = Math.max(0, Math.min(1, (s.poses[i].y - course.startY) / (course.goalY - course.startY)));
        (dots[i] as HTMLElement).style.left = `${k * 100}%`;
        const pr = scene.project(i);
        const l = labels[i];
        if (pr && pr.visible) {
          l.style.display = '';
          l.style.left = `${pr.x}px`;
          l.style.top = `${pr.y - 14}px`;
        } else l.style.display = 'none';
      }
    };
    scene.onFrame = (dt) => player?.update(dt);
    ambience.setWaterIntensity(course.baseSpeed / 50);
  }

  // ---------------------------------------------------------------- 結果

  async function showResult(setup: RaceSetup, local: RaceResult, official: Promise<ResolvedRace> | null): Promise<void> {
    if (!ui || disposed) return;
    for (const l of labels) l.remove();
    const scene = getScene();
    scene?.setCameraMode('overhead');
    const box = h('div', { class: 'panel' }, h('p', { class: 'muted' }, setup.ranked ? '公式結果を確定しています…' : ''));
    ui.replaceChildren(h('div', { class: 'race-center' }, box));

    let outcome: RaceOutcome = local.outcome;
    let timeA = local.timeA;
    let timeB = local.timeB;
    let streak: { current_streak: number; best_streak: number } | undefined;
    let note = '';
    if (official) {
      try {
        const r = await official;
        outcome = r.race.result;
        timeA = r.race.time_a;
        timeB = r.race.time_b;
        streak = r.stats;
        if (outcome !== local.outcome || timeA !== local.timeA || timeB !== local.timeB) {
          note = '※ この端末の再生とサーバーの公式計算に差がありました。公式結果を表示しています。';
        }
      } catch (e) {
        box.replaceChildren(
          h('h2', {}, '結果を確定できませんでした'),
          h('p', {}, errorText(e)),
          h('p', { class: 'muted' }, '戦績には反映されていません。'),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn primary', onclick: () => void showResult(setup, local, resolveWithRetry(setup.raceId!)) }, 'もう一度確定する'),
            h('button', { class: 'btn', onclick: () => void showSelect() }, '戻る')),
        );
        return;
      }
    }
    if (disposed) return;

    const title = outcome === 'challenger_win' ? '勝ち！' : outcome === 'defender_win' ? '負け' : '引き分け';
    const cls = outcome === 'challenger_win' ? 'win' : outcome === 'defender_win' ? 'lose' : '';
    const cell = (r: LeafRunResult) => (r.status === 'finished' ? `${ticksToSeconds(r.finishTick).toFixed(2)}` : statusText(r));
    const table = h('table', { class: 'result-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'あなた'), h('th', {}, setup.oppName))),
      h('tbody', {},
        ...local.runs.map((r, i) => h('tr', {}, h('td', {}, `${i + 1} 走目${i === 0 ? '（左）' : '（右）'}`), h('td', {}, cell(r[0])), h('td', {}, cell(r[1])))),
        h('tr', {}, h('td', {}, h('b', {}, '合計（秒）')), h('td', {}, h('b', {}, ticksToSeconds(timeA).toFixed(2))), h('td', {}, h('b', {}, ticksToSeconds(timeB).toFixed(2)))),
      ),
    );
    const actions = h('div', { class: 'btn-row' });
    if (setup.ranked) {
      actions.append(
        h('button', { class: 'btn primary', onclick: () => void showSelect() }, 'もう一度挑戦'),
        h('a', { href: '/editor', 'data-link': true, class: 'btn' }, '葉っぱを編集'),
        h('a', { href: '/leaderboard', 'data-link': true, class: 'btn' }, 'ランキング'),
        h('button', { class: 'btn small warn', onclick: () => void report(setup.raceId!) }, '相手を通報'),
      );
    } else {
      actions.append(
        h('button', { class: 'btn primary', onclick: () => void startPractice('random') }, 'もう一度（練習）'),
        h('a', { href: '/editor', 'data-link': true, class: 'btn' }, '葉っぱを編集'),
        h('button', { class: 'btn', onclick: () => void showSelect() }, 'モード選択へ'),
      );
    }
    box.replaceChildren(...([
      h('p', { class: 'muted' }, setup.ranked ? 'ランク戦' : '練習（戦績に残りません）'),
      h('div', { class: `outcome ${cls}` }, title),
      h('p', { class: 'muted' }, `${COURSE_PRESETS.find((c) => c.id === setup.courseId)?.name ?? ''}・左右入れ替えの 2 走合計で判定`),
      table,
      streak ? h('p', {}, `現在 ${streak.current_streak} 連勝（最高 ${streak.best_streak}）`) : null,
      note ? h('p', { class: 'muted' }, note) : null,
      actions,
    ] as (HTMLElement | null)[]).filter((x): x is HTMLElement => x !== null));
  }

  async function report(raceId: string): Promise<void> {
    const reason = prompt('通報の理由を入力してください（例：不適切な表示名）');
    if (!reason) return;
    try {
      const target = await getRaceDefender(raceId);
      if (!target) throw new ApiError('race_not_found');
      await reportUser(target, reason.slice(0, 200));
      toast('通報しました。ご協力ありがとうございます');
    } catch (e) {
      toast(errorText(e));
    }
  }
}

function statusText(r: LeafRunResult): string {
  const pen = `+${SIM.penaltyTicks / 60}秒`;
  return r.status === 'stuck' ? `詰まり（${pen}）` : `時間切れ（${pen}）`;
}

/** いまの風を「追い風 1.2m/s ↓」のように表す（↓ が下流＝画面奥） */
function windText(course: Course, t: number, out: [number, number]): string {
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
