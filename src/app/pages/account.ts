import { deleteAccount, errorText, getMyProfile, online, updateDisplayName } from '../../api/client.ts';
import { drawLeafThumb } from '../context.ts';
import { speciesColor } from '../../render/textures.ts';
import { getSpecies } from '../../../packages/sim-core/src/index.ts';
import { h, toast } from '../dom.ts';
import { nameInput, nameProblem } from '../name-field.ts';
import type { Page, Router } from '../router.ts';

/** /account：ランキングの名前、戦績、登録中の葉っぱ、データ削除（ユーザー登録・メールは使わない） */
export function accountPage(router: Router): Page {
  return {
    paper: true,
    async mount(root) {
      const wrap = h('div', { class: 'page' });
      root.append(wrap);
      if (!online) {
        wrap.append(h('section', { class: 'panel' },
          h('h1', {}, 'プレイヤー'),
          h('p', {}, 'このサイトはサーバー未設定のため、オフライン（練習のみ）で動いています。'),
          h('p', { class: 'muted' }, '運営者向け：.env.production に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定するとランク戦が有効になります。')));
        return;
      }

      const { profile, stats, leaf } = await getMyProfile();
      const name = nameInput(profile?.display_name ?? '');
      const saveBtn = h('button', {
        class: 'btn primary', onclick: async () => {
          const problem = nameProblem(name.value);
          if (problem) {
            toast(problem);
            return;
          }
          saveBtn.disabled = true;
          try {
            await updateDisplayName(name.value.trim());
            toast('名前を保存しました');
            if (!profile) router.go('/account', true);
          } catch (e) {
            toast(errorText(e));
          } finally {
            saveBtn.disabled = false;
          }
        },
      }, '名前を保存');
      const thumb = h('canvas', { class: 'leaf-thumb' });

      wrap.append(
        h('section', { class: 'panel' },
          h('h1', {}, 'プレイヤー'),
          h('label', { for: 'display-name' }, 'ランキングに表示する名前（自由に付けられます・1〜16 文字）'),
          name,
          h('div', { class: 'btn-row', style: 'margin-top:10px' }, saveBtn),
          h('p', { class: 'muted', style: 'margin-top:10px' },
            'ユーザー登録はありません。記録はこのブラウザに保存されるので、ブラウザのデータを消したり別の端末で開いたりすると、新しいプレイヤーとして始まります。'),
        ),
      );
      if (!profile) {
        wrap.append(h('section', { class: 'panel' },
          h('p', {}, 'まだランク戦に参加していません。名前を保存するか、「あそぶ」から挑戦すると始まります。'),
          h('a', { href: '/race', 'data-link': true, class: 'btn' }, 'あそぶ')));
        return;
      }

      wrap.append(
        h('section', { class: 'panel' },
          h('h2', {}, '戦績'),
          h('div', { class: 'stat-grid' },
            ...([
              ['現在の連勝', stats?.current_streak], ['最高連勝', stats?.best_streak], ['今週の最高', stats?.weekly_best_streak],
              ['挑戦 勝/敗/分', stats ? `${stats.challenger_wins}/${stats.challenger_losses}/${stats.draws}` : '-'],
              ['防衛 勝/敗', stats ? `${stats.defense_wins}/${stats.defense_losses}` : '-'],
              ['防衛勝率', stats && stats.defense_wins + stats.defense_losses > 0
                ? `${Math.round((100 * stats.defense_wins) / (stats.defense_wins + stats.defense_losses))}%` : '-'],
            ] as [string, unknown][]).map(([k, v]) => h('div', { class: 'stat' }, h('b', {}, String(v ?? 0)), h('span', {}, k)))),
        ),
        h('section', { class: 'panel' },
          h('h2', {}, '登録中の葉っぱ'),
          leaf
            ? h('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap' }, thumb,
              h('div', {}, h('p', {}, `${getSpecies(leaf.species).name}・バージョン ${leaf.version}`), h('p', { class: 'muted' }, `更新：${new Date(leaf.updated_at).toLocaleString('ja-JP')}`),
                h('a', { href: '/editor', 'data-link': true, class: 'btn' }, '作り直す')))
            : h('div', {}, h('p', {}, 'まだ登録していません。'), h('a', { href: '/editor', 'data-link': true, class: 'btn primary' }, '葉っぱを作る')),
        ),
        h('section', { class: 'panel' },
          h('h2', {}, 'データの削除'),
          h('p', { class: 'muted' }, '名前・登録した葉っぱ・戦績・レース記録をすべて削除し、ランキングからも消えます。元に戻せません。'),
          h('button', {
            class: 'btn warn', onclick: async () => {
              const v = prompt('削除するには「削除」と入力してください');
              if (v !== '削除') return;
              try {
                await deleteAccount();
                toast('削除しました');
                router.go('/', true);
              } catch (e) {
                toast(errorText(e));
              }
            },
          }, 'データを削除'),
        ),
      );
      if (leaf) requestAnimationFrame(() => drawLeafThumb(thumb, leaf.polygon, speciesColor(leaf.species)));
    },
  };
}
