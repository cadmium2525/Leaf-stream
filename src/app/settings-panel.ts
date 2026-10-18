import { h } from './dom.ts';
import { settings, updateSettings, type Quality } from './state.ts';
import { ambience } from './context.ts';

export function setupSettingsPanel(): void {
  const panel = document.getElementById('settings')!;
  const btn = document.getElementById('settings-btn')!;
  const render = () => {
    const q = h('select', {
      id: 'set-quality',
      onchange: (e: Event) => updateSettings({ quality: (e.target as HTMLSelectElement).value as Quality }),
    });
    for (const [v, label] of [['auto', '自動（おすすめ）'], ['high', '高品質'], ['standard', '標準'], ['eco', '省電力']]) {
      q.append(h('option', { value: v, selected: settings.quality === v }, label));
    }
    const sound = h('input', {
      type: 'checkbox',
      id: 'set-sound',
      checked: settings.sound,
      onchange: (e: Event) => {
        const on = (e.target as HTMLInputElement).checked;
        updateSettings({ sound: on });
        if (on) {
          ambience.setVolume(settings.volume);
          void ambience.start();
        }
      },
    });
    const vol = h('input', {
      type: 'range', min: 0, max: 1, step: 0.05, value: settings.volume, id: 'set-volume', style: 'width:100%',
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        updateSettings({ volume: v });
        ambience.setVolume(v);
      },
    });
    panel.replaceChildren(
      h('h3', {}, '設定'),
      h('label', { for: 'set-quality' }, '画質'),
      q,
      h('label', { for: 'set-sound', style: 'display:flex;gap:8px;align-items:center;margin-top:14px' }, sound, '環境音（水音・鳥・虫）'),
      h('label', { for: 'set-volume' }, '音量'),
      vol,
      h('p', { class: 'muted', style: 'margin-top:12px' }, '設定はこの端末にだけ保存されます。'),
      h('div', { class: 'btn-row' }, h('a', { href: '/about', 'data-link': true, class: 'btn small' }, 'このゲームについて・規約'),
        h('button', { class: 'btn small', onclick: () => panel.classList.add('hidden') }, '閉じる')),
    );
  };
  btn.addEventListener('click', () => {
    render();
    panel.classList.toggle('hidden');
  });
  document.addEventListener('pointerdown', (e) => {
    if (!panel.contains(e.target as Node) && e.target !== btn) panel.classList.add('hidden');
  });
}
