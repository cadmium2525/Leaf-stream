/** 小さな DOM ヘルパー。文字列はすべて textContent で入れる（XSS 対策） */
import { withBase } from './base.ts';

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    // アプリ内リンクは配信パスを付ける
    else if (k === 'href' && 'data-link' in attrs && String(v).startsWith('/')) el.setAttribute(k, withBase(String(v)));
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer = 0;
export function toast(msg: string, ms = 2600): void {
  const el = document.getElementById('toast')!;
  el.textContent = msg;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

export function hideToast(): void {
  window.clearTimeout(toastTimer);
  document.getElementById('toast')?.classList.remove('show');
}

export function fmtTime(ticks: number): string {
  const s = ticks / 60;
  return `${s.toFixed(2)} 秒`;
}
