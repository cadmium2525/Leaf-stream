import { getSpecies, isSpeciesId, isoWeekKey } from '../../../packages/sim-core/src/index.ts';
import { endlessLeaderboard, errorText, getSession, leaderboard, online, type EndlessRow, type LeaderRow } from '../../api/client.ts';
import { speciesColor } from '../../render/textures.ts';
import { h } from '../dom.ts';
import type { Page } from '../router.ts';

type Sort = 'best' | 'current' | 'weekly';
type EndlessScope = 'week' | 'all';
const TABS: [Sort, string][] = [['best', '最高連勝'], ['current', '現在の連勝'], ['weekly', '今週の最高連勝']];
const ENDLESS_TABS: [EndlessScope, string][] = [['week', '今週'], ['all', '歴代']];
const PAGE = 20;

/** /leaderboard：ランク戦（連勝）と、どこまでもモード（距離）のランキング */
export function leaderboardPage(): Page {
  return {
    paper: true,
    async mount(root, params) {
      let mode: 'ranked' | 'endless' = params.get('mode') === 'endless' ? 'endless' : 'ranked';
      let sort: Sort = 'best';
      let scope: EndlessScope = 'week';
      let page = 0;
      let me: string | null = null;
      const modes = h('div', { class: 'tabs' });
      const note = h('p', { class: 'muted' }, '');
      const tabs = h('div', { class: 'tabs' });
      const body = h('div', {});
      const pager = h('div', { class: 'btn-row', style: 'justify-content:space-between' });
      root.append(h('div', { class: 'page' },
        h('section', { class: 'panel' },
          h('h1', {}, 'ランキング'),
          modes, note,
          h('p', { class: 'muted' }, h('a', { href: '/account', 'data-link': true }, '自分の名前を変える')),
          tabs, body, pager,
        )));
      if (!online) {
        body.append(h('p', {}, 'サーバーが設定されていないため、ランキングは表示できません。'));
        return;
      }
      me = (await getSession())?.user.id ?? null;

      const load = async () => {
        modes.replaceChildren(...([['ranked', 'ランク戦'], ['endless', 'どこまでも']] as const).map(([k, label]) =>
          h('button', { class: `btn${k === mode ? ' primary' : ''}`, onclick: () => { mode = k; page = 0; void load(); } }, label)));
        const week = isoWeekKey(Date.now());
        note.textContent = mode === 'ranked'
          ? '連勝は自分から挑戦したレースだけで増えます。防衛（挑戦された側）の勝敗は連勝に影響しません。'
          : `詰まるまでに進んだ距離。今週（${week}）は全員が同じコースです。歴代は一人一件の最高記録。`;
        tabs.replaceChildren(...(mode === 'ranked'
          ? TABS.map(([k, label]) => h('button', { class: `btn small${k === sort ? ' active' : ''}`, onclick: () => { sort = k; page = 0; void load(); } }, label))
          : ENDLESS_TABS.map(([k, label]) => h('button', { class: `btn small${k === scope ? ' active' : ''}`, onclick: () => { scope = k; page = 0; void load(); } }, label))));
        body.replaceChildren(h('p', { class: 'muted' }, '読み込み中…'));
        let count: number;
        try {
          count = mode === 'ranked' ? await renderRanked() : await renderEndless(scope === 'all' ? 'all' : week);
        } catch (e) {
          body.replaceChildren(h('p', {}, errorText(e)));
          return;
        }
        pager.replaceChildren(
          h('button', { class: 'btn small', disabled: page === 0, onclick: () => { page--; void load(); } }, '← 前へ'),
          h('span', { class: 'muted' }, `${page + 1} ページ`),
          h('button', { class: 'btn small', disabled: count < PAGE, onclick: () => { page++; void load(); } }, '次へ →'),
        );
      };

      const empty = (text: string) => body.replaceChildren(h('p', {}, page === 0 ? text : 'これ以上はありません。'));

      async function renderRanked(): Promise<number> {
        const rows: LeaderRow[] = await leaderboard(sort, page, PAGE);
        if (rows.length === 0) {
          empty('まだ記録がありません。最初の挑戦者になりましょう。');
          return 0;
        }
        const key: keyof LeaderRow = sort === 'best' ? 'best_streak' : sort === 'current' ? 'current_streak' : 'weekly_best_streak';
        body.replaceChildren(h('table', { class: 'rank-table' },
          h('thead', {}, h('tr', {}, h('th', {}, '順位'), h('th', {}, '名前'), h('th', {}, TABS.find((t) => t[0] === sort)![1]),
            h('th', {}, '現在'), h('th', {}, '防衛 勝/敗'))),
          // rank はサーバーが付けた全体の順位（offset 込み）なので、ページ分は足さない
          h('tbody', {}, ...rows.map((r) => h('tr', { class: r.user_id === me ? 'me' : '' },
            h('td', {}, r.rank), h('td', {}, r.display_name), h('td', {}, h('b', {}, r[key] as number)),
            h('td', {}, r.current_streak), h('td', {}, `${r.defense_wins} / ${r.defense_losses}`)))),
        ));
        return rows.length;
      }

      async function renderEndless(week: string): Promise<number> {
        const rows: EndlessRow[] = await endlessLeaderboard(week, page, PAGE);
        if (rows.length === 0) {
          empty('まだ記録がありません。最初に流してみましょう。');
          return 0;
        }
        const all = week === 'all';
        body.replaceChildren(h('table', { class: 'rank-table' },
          h('thead', {}, h('tr', {}, h('th', {}, '順位'), h('th', {}, '名前'), h('th', {}, '距離'), h('th', {}, '葉'), all ? h('th', {}, '週') : null)),
          h('tbody', {}, ...rows.map((r) => {
            const sp = isSpeciesId(r.species) ? r.species : 'sakura';
            return h('tr', { class: r.user_id === me ? 'me' : '' },
              h('td', {}, r.rank), h('td', {}, r.display_name), h('td', {}, h('b', {}, `${(r.distance_cm / 100).toFixed(1)} m`)),
              h('td', {}, h('span', { class: 'species-dot', style: `background:${speciesColor(sp)}` }), getSpecies(sp).name),
              all ? h('td', {}, r.week_key) : null);
          })),
        ));
        return rows.length;
      }

      await load();
    },
  };
}
