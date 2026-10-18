import {
  deleteAccount, errorText, getMyProfile, getSession, online, signInWithEmail, signOut, updateDisplayName,
} from '../../api/client.ts';
import { drawLeafThumb } from '../context.ts';
import { h, toast } from '../dom.ts';
import type { Page, Router } from '../router.ts';

/** /account：サインイン、公開名、葉っぱ確認、戦績、データ削除 */
export function accountPage(router: Router): Page {
  return {
    paper: true,
    async mount(root, params) {
      const wrap = h('div', { class: 'page' });
      root.append(wrap);
      if (!online) {
        wrap.append(h('section', { class: 'panel' },
          h('h1', {}, 'アカウント'),
          h('p', {}, 'このサイトはサーバー未設定のため、オフライン（練習のみ）で動いています。'),
          h('p', { class: 'muted' }, '運営者向け：.env に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定するとランク戦が有効になります。')));
        return;
      }
      const session = await getSession();
      if (!session) {
        const email = h('input', { type: 'email', id: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true });
        const sent = h('p', { class: 'muted' }, '');
        const form = h('form', {
          onsubmit: async (e: Event) => {
            e.preventDefault();
            const v = (email as HTMLInputElement).value.trim();
            if (!v) return;
            try {
              await signInWithEmail(v);
              sent.textContent = `${v} にサインイン用のリンクを送りました。メールを開いてリンクを押してください。`;
            } catch (err) {
              sent.textContent = errorText(err);
            }
          },
        }, h('label', { for: 'email' }, 'メールアドレス'), email,
        h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('button', { class: 'btn primary', type: 'submit' }, 'サインイン用リンクを送る')), sent);
        wrap.append(h('section', { class: 'panel' },
          h('h1', {}, 'サインイン'),
          h('p', {}, '葉っぱの登録とランク戦にはサインインが必要です。パスワードは不要で、メールに届くリンクから入れます。'),
          form,
          h('p', { class: 'muted' }, h('a', { href: '/about#privacy', 'data-link': true }, 'プライバシーポリシー'), 'に同意のうえご利用ください。')));
        return;
      }

      const { profile, stats, leaf } = await getMyProfile();
      const name = h('input', { type: 'text', id: 'name', maxlength: 16, value: profile?.display_name ?? '' });
      const thumb = h('canvas', { class: 'leaf-thumb' });
      wrap.append(
        h('section', { class: 'panel' },
          h('h1', {}, 'アカウント'),
          h('label', { for: 'name' }, '公開する名前（1〜16 文字）'),
          name,
          h('div', { class: 'btn-row', style: 'margin-top:10px' },
            h('button', {
              class: 'btn primary', onclick: async () => {
                try {
                  await updateDisplayName((name as HTMLInputElement).value.trim());
                  toast('名前を変更しました');
                } catch (e) {
                  toast(errorText(e));
                }
              },
            }, '名前を保存'),
            h('button', { class: 'btn', onclick: async () => { await signOut(); router.go('/', true); } }, 'サインアウト')),
        ),
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
              h('div', {}, h('p', {}, `バージョン ${leaf.version}`), h('p', { class: 'muted' }, `更新：${new Date(leaf.updated_at).toLocaleString('ja-JP')}`),
                h('a', { href: '/editor', 'data-link': true, class: 'btn' }, '作り直す')))
            : h('div', {}, h('p', {}, 'まだ登録していません。'), h('a', { href: '/editor', 'data-link': true, class: 'btn primary' }, '葉っぱを作る')),
        ),
        h('section', { class: 'panel' },
          h('h2', {}, 'データの削除'),
          h('p', { class: 'muted' }, 'アカウントと、登録した葉っぱ・戦績・レース記録をすべて削除します。元に戻せません。'),
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
      if (leaf) requestAnimationFrame(() => drawLeafThumb(thumb, leaf.polygon));
      if (params.get('next') === 'editor') toast('サインインしました。葉っぱを登録できます');
    },
  };
}
