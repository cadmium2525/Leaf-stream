import { errorText, getSession, leaderboard, online, type LeaderRow } from '../../api/client.ts';
import { h } from '../dom.ts';
import type { Page } from '../router.ts';

type Sort = 'best' | 'current' | 'weekly';
const TABS: [Sort, string][] = [['best', '最高連勝'], ['current', '現在の連勝'], ['weekly', '今週の最高連勝']];
const PAGE = 20;

/** /leaderboard：現在・最高・週間の連勝、表示名、順位、ページ切替 */
export function leaderboardPage(): Page {
  return {
    paper: true,
    async mount(root) {
      let sort: Sort = 'best';
      let page = 0;
      let me: string | null = null;
      const tabs = h('div', { class: 'tabs' });
      const body = h('div', {});
      const pager = h('div', { class: 'btn-row', style: 'justify-content:space-between' });
      root.append(h('div', { class: 'page' },
        h('section', { class: 'panel' },
          h('h1', {}, 'ランキング'),
          h('p', { class: 'muted' }, '連勝は自分から挑戦したレースだけで増えます。防衛（挑戦された側）の勝敗は連勝に影響しません。'),
          tabs, body, pager,
        )));
      if (!online) {
        body.append(h('p', {}, 'サーバーが設定されていないため、ランキングは表示できません。'));
        return;
      }
      me = (await getSession())?.user.id ?? null;

      const load = async () => {
        tabs.replaceChildren(...TABS.map(([k, label]) =>
          h('button', { class: `btn small${k === sort ? ' active' : ''}`, onclick: () => { sort = k; page = 0; void load(); } }, label)));
        body.replaceChildren(h('p', { class: 'muted' }, '読み込み中…'));
        let rows: LeaderRow[];
        try {
          rows = await leaderboard(sort, page, PAGE);
        } catch (e) {
          body.replaceChildren(h('p', {}, errorText(e)));
          return;
        }
        if (rows.length === 0) {
          body.replaceChildren(h('p', {}, page === 0 ? 'まだ記録がありません。最初の挑戦者になりましょう。' : 'これ以上はありません。'));
        } else {
          const key: keyof LeaderRow = sort === 'best' ? 'best_streak' : sort === 'current' ? 'current_streak' : 'weekly_best_streak';
          body.replaceChildren(h('table', { class: 'rank-table' },
            h('thead', {}, h('tr', {}, h('th', {}, '順位'), h('th', {}, '名前'), h('th', {}, TABS.find((t) => t[0] === sort)![1]),
              h('th', {}, '現在'), h('th', {}, '防衛 勝/敗'))),
            h('tbody', {}, ...rows.map((r) => h('tr', { class: r.user_id === me ? 'me' : '' },
              h('td', {}, r.rank + page * PAGE), h('td', {}, r.display_name), h('td', {}, h('b', {}, r[key] as number)),
              h('td', {}, r.current_streak), h('td', {}, `${r.defense_wins} / ${r.defense_losses}`)))),
          ));
        }
        pager.replaceChildren(
          h('button', { class: 'btn small', disabled: page === 0, onclick: () => { page--; void load(); } }, '← 前へ'),
          h('span', { class: 'muted' }, `${page + 1} ページ`),
          h('button', { class: 'btn small', disabled: rows.length < PAGE, onclick: () => { page++; void load(); } }, '次へ →'),
        );
      };
      await load();
    },
  };
}
