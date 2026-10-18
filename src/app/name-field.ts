/** ランキングに表示する名前の入力欄（登録不要。名前は自由、1〜16 文字） */
import { h } from './dom.ts';

export const NAME_MAX = 16;

/** DB の制約（1〜16 文字、< > と制御文字は不可）と同じ確認。問題なければ null */
export function nameProblem(name: string): string | null {
  const v = name.trim();
  if (v.length === 0) return '名前を入力してください';
  if ([...v].length > NAME_MAX) return `名前は ${NAME_MAX} 文字までです`;
  // eslint-disable-next-line no-control-regex
  if (/[<>\u0000-\u001f]/.test(v)) return '記号の < > は使えません';
  return null;
}

export function nameInput(initial: string, id = 'display-name'): HTMLInputElement {
  return h('input', {
    type: 'text', id, maxlength: NAME_MAX, value: initial, placeholder: '例：笹舟名人', autocomplete: 'nickname',
    enterkeyhint: 'done',
  });
}
