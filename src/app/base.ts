/**
 * 配信パスの接頭辞。GitHub Pages（https://<user>.github.io/Leaf-stream/）では "/Leaf-stream"、
 * ルート配信では ""。アプリ内のパス（"/race" など）はこれを付けずに扱う。
 */
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

export function withBase(path: string): string {
  return BASE + path;
}

/** location.pathname からアプリ内のパスへ */
export function appPath(pathname: string): string {
  const p = BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return p.replace(/\/+$/, '') || '/';
}
