import {
  LEAF_ERROR_MESSAGES, LEAF_RULES, area, perimeter, shapeHash, validateLeaf, type Polygon,
} from '../../../packages/sim-core/src/index.ts';
import { LeafEditor } from '../../editor/editor.ts';
import { PreviewChannel } from '../../editor/preview.ts';
import { errorText, getMyProfile, getSession, online, registerLeaf } from '../../api/client.ts';
import { h, toast } from '../dom.ts';
import { loadDraft, saveDraft } from '../state.ts';
import type { Page, Router } from '../router.ts';

/** /editor：切断・Undo/Redo・形状検証・プレビュー・練習レース・登録 */
export function editorPage(router: Router): Page {
  let editor: LeafEditor | null = null;
  let preview: PreviewChannel | null = null;
  let registeredHash: string | null = null;
  let registeredVersion: number | null = null;
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    if (e.shiftKey) editor?.redo();
    else editor?.undo();
  };

  return {
    paper: true,
    mount(root) {
      const draft = loadDraft();
      const canvas = h('canvas', { 'aria-label': '葉っぱの切断キャンバス。外から外へドラッグして切ります' });
      const tip = h('div', { class: 'tip' }, '葉の外から外へ、なぞって切る');
      const chooseRow = h('div', { class: 'btn-row hidden' },
        h('button', { class: 'btn small primary', onclick: () => editor?.keepLargest() }, '大きい方を残す'),
        h('button', { class: 'btn small', onclick: () => editor?.cancelChoice() }, 'やめる'),
      );
      const undoBtn = h('button', { class: 'btn small', onclick: () => editor?.undo(), title: 'Ctrl+Z' }, '↶ 元に戻す');
      const redoBtn = h('button', { class: 'btn small', onclick: () => editor?.redo(), title: 'Ctrl+Shift+Z' }, '↷ やり直す');
      const resetBtn = h('button', {
        class: 'btn small', onclick: () => {
          if (confirm('最初の葉っぱに戻しますか？（元に戻すで取り消せます）')) editor?.reset();
        },
      }, 'リセット');
      const metrics = h('dl', { class: 'metrics' });
      const status = h('div', { class: 'status' });
      const regInfo = h('p', { class: 'muted' });
      const registerBtn = h('button', { class: 'btn primary' }, 'この葉っぱを登録');
      const practiceBtn = h('button', { class: 'btn' }, 'この葉で練習レース');
      const previewCanvas = h('canvas', { class: 'preview-canvas', 'aria-label': 'プレビュー水路' });
      const previewInfo = h('p', { class: 'muted' }, 'プレビュー水路を流れています（白はそのままの葉）');

      root.append(
        h('div', { class: 'editor' },
          h('div', { class: 'editor-canvas-wrap' }, canvas, h('div', { class: 'editor-hint' }, tip, chooseRow)),
          h('aside', { class: 'editor-side' },
            h('section', { class: 'panel' },
              h('h2', {}, '葉っぱを切る'),
              h('p', { class: 'muted' }, '形が流れ方を変えます。細長い・幅広・切れ込み…いろいろ試してみてください。'),
              h('div', { class: 'btn-row' }, undoBtn, redoBtn, resetBtn),
            ),
            h('section', { class: 'panel' }, metrics, status),
            h('section', { class: 'panel' }, h('h3', {}, 'プレビュー水路'), previewCanvas, previewInfo),
            h('section', { class: 'panel' }, h('div', { class: 'btn-row' }, practiceBtn, registerBtn), regInfo),
          ),
        ),
      );

      const update = (p: Polygon, cuts: number) => {
        saveDraft({ polygon: p, cuts });
        const v = validateLeaf(p);
        const a = area(p);
        metrics.replaceChildren(
          h('dt', {}, '面積'), h('dd', {}, `${a.toFixed(1)} cm²`),
          h('dt', {}, '頂点'), h('dd', {}, `${p.length} / ${LEAF_RULES.maxVertices}`),
          h('dt', {}, '切った回数'), h('dd', {}, `${cuts} / ${LEAF_RULES.maxCuts}`),
          h('dt', {}, '太さの目安'), h('dd', {}, `${((2 * a) / perimeter(p)).toFixed(2)} cm`),
          h('dt', {}, '形状 ID'), h('dd', {}, shapeHash(p).slice(0, 8)),
        );
        status.className = `status ${v.ok ? 'ok' : 'ng'}`;
        status.textContent = v.ok ? '✓ 登録できる形です' : `登録できません：${v.errors.map((e) => LEAF_ERROR_MESSAGES[e]).join('／')}`;
        registerBtn.disabled = !v.ok;
        practiceBtn.disabled = !v.ok;
        undoBtn.disabled = !editor?.canUndo;
        redoBtn.disabled = !editor?.canRedo;
        const same = registeredHash === shapeHash(p);
        if (!online) regInfo.textContent = 'サーバー未設定のため、登録はできません（練習は遊べます）。';
        else if (registeredVersion === null) regInfo.textContent = 'まだ登録していません。登録するとランク戦で使われます。';
        else regInfo.textContent = same ? `登録中の葉っぱ（v${registeredVersion}）と同じ形です。` : `登録中は v${registeredVersion}。この形に更新できます。`;
        preview?.setLeaf(p);
      };

      editor = new LeafEditor(canvas, draft);
      editor.onChange = (s) => update(s.polygon, s.cuts);
      editor.onMessage = (m) => toast(m);
      editor.onModeChange = (c) => {
        chooseRow.classList.toggle('hidden', !c);
        tip.textContent = c ? '残す方をタップ' : '葉の外から外へ、なぞって切る';
        undoBtn.disabled = !editor?.canUndo;
        redoBtn.disabled = !editor?.canRedo;
      };
      preview = new PreviewChannel(previewCanvas);
      preview.onResult = (a, b) => {
        const f = (t: number | null) => (t === null ? 'ゴールできず' : `${(t / 60).toFixed(2)} 秒`);
        previewInfo.textContent = `あなた ${f(a)}／そのままの葉 ${f(b)}（1 走・参考記録）`;
      };
      preview.start();
      update(draft.polygon, draft.cuts);
      window.addEventListener('keydown', onKey);

      practiceBtn.addEventListener('click', () => router.go('/race?mode=practice'));
      registerBtn.addEventListener('click', async () => {
        if (!online) {
          toast(errorText(new Error('offline')));
          return;
        }
        if (!(await getSession())) {
          toast('登録にはサインインが必要です');
          router.go('/account?next=editor');
          return;
        }
        const p = editor!.state.polygon;
        registerBtn.disabled = true;
        try {
          const r = await registerLeaf(p);
          registeredHash = r.shape_hash;
          registeredVersion = r.version;
          toast(`登録しました（v${r.version}）`);
          update(p, editor!.state.cuts);
        } catch (e) {
          toast(errorText(e));
        } finally {
          registerBtn.disabled = !validateLeaf(editor!.state.polygon).ok;
        }
      });

      if (online) {
        void getMyProfile().then(({ leaf }) => {
          if (!leaf) return;
          registeredHash = leaf.shape_hash;
          registeredVersion = leaf.version;
          if (editor) update(editor.state.polygon, editor.state.cuts);
        }).catch(() => undefined);
      }
    },
    unmount() {
      window.removeEventListener('keydown', onKey);
      editor?.destroy();
      preview?.stop();
    },
  };
}
