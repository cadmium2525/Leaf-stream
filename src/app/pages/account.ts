import {
  deleteAccount, ensureSession, errorText, getMyProfile, getSession, isGuest, linkEmail, online, signInWithEmail, signOut,
  updateDisplayName,
} from '../../api/client.ts';
import { drawLeafThumb } from '../context.ts';
import { h, toast } from '../dom.ts';
import type { Page, Router } from '../router.ts';

/** /account：サインイン、公開名、葉っぱ確認、戦績、データ削除 */
export function accountPage(router: Router): Page {
  return {
    paper: true,
    async mount(root) {
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
        const sent = h('p', { class: 'muted' }, '');
        wrap.append(
          h('section', { class: 'panel' },
            h('h1', {}, 'はじめる'),
            h('p', {}, 'ユーザー登録なしで、すぐにランク戦に参加できます。記録はこの端末（ブラウザ）に紐づきます。'),
            h('div', { class: 'btn-row' }, h('button', {
              class: 'btn primary', onclick: async () => {
                try {
                  await ensureSession();
                  toast('ゲストとして始めました');
                  router.go('/account', true);
                } catch (e) {
                  toast(errorText(e), 5000);
                }
              },
            }, 'ゲストで始める')),
            h('p', { class: 'muted' }, h('a', { href: '/about#privacy', 'data-link': true }, 'プライバシーポリシー'), 'に同意のうえご利用ください。'),
          ),
          h('section', { class: 'panel' },
            h('h2', {}, 'メールで続きから'),
            h('p', { class: 'muted' }, '以前メールアドレスを登録した人は、ここからサインインすると別の端末でも続きから遊べます。'),
            emailForm('サインイン用リンクを送る', async (v) => {
              await signInWithEmail(v);
              sent.textContent = `${v} にサインイン用のリンクを送りました。メールを開いてリンクを押してください。`;
            }, sent),
          ),
        );
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
            isGuest(session)
              ? ''
              : h('button', { class: 'btn', onclick: async () => { await signOut(); router.go('/', true); } }, 'サインアウト')),
        ),
        isGuest(session) ? guestPanel() : '',
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

      function guestPanel(): HTMLElement {
        const msg = h('p', { class: 'muted' }, '');
        return h('section', { class: 'panel' },
          h('h2', {}, 'ゲストで遊んでいます'),
          h('p', {}, 'ブラウザのデータを消したり別の端末に変えたりすると、この記録には戻れません。メールアドレスを登録すると、どの端末からでも続きから遊べます。'),
          emailForm('メールアドレスを登録', async (v) => {
            await linkEmail(v);
            msg.textContent = `${v} に確認メールを送りました。メールのリンクを押すと登録が完了します。`;
          }, msg),
        );
      }
    },
  };
}

function emailForm(label: string, submit: (email: string) => Promise<void>, msg: HTMLElement): HTMLFormElement {
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true, 'aria-label': 'メールアドレス' });
  return h('form', {
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const v = email.value.trim();
      if (!v) return;
      try {
        await submit(v);
      } catch (err) {
        msg.textContent = errorText(err);
      }
    },
  }, email, h('div', { class: 'btn-row', style: 'margin-top:12px' }, h('button', { class: 'btn primary', type: 'submit' }, label)), msg);
}
