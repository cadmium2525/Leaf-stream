/** History API ベースの最小ルーター */
import { appPath, withBase } from './base.ts';
export interface Page {
  /** body に paper クラスを付けて 3D 背景を止める */
  paper?: boolean;
  mount(root: HTMLElement, params: URLSearchParams): void | Promise<void>;
  unmount?(): void;
}

type PageFactory = () => Page;

export class Router {
  private routes = new Map<string, PageFactory>();
  private current: Page | null = null;
  private onChange: ((path: string, page: Page) => void) | null = null;

  constructor(private root: HTMLElement) {
    window.addEventListener('popstate', () => this.render());
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[data-link]') as HTMLAnchorElement | null;
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
      const url = new URL(a.href);
      if (url.origin !== location.origin) return;
      e.preventDefault();
      this.go(appPath(url.pathname) + url.search + url.hash);
    });
  }

  add(path: string, factory: PageFactory): this {
    this.routes.set(path, factory);
    return this;
  }

  changed(fn: (path: string, page: Page) => void): this {
    this.onChange = fn;
    return this;
  }

  /** to はアプリ内のパス（"/race?mode=practice" など） */
  go(to: string, replace = false): void {
    const url = withBase(to);
    if (url === location.pathname + location.search && !replace) return;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    void this.render();
  }

  async render(): Promise<void> {
    const path = appPath(location.pathname);
    const factory = this.routes.get(path) ?? this.routes.get('/')!;
    this.current?.unmount?.();
    this.root.replaceChildren();
    const page = factory();
    this.current = page;
    document.body.classList.toggle('paper', !!page.paper);
    this.onChange?.(path, page);
    window.scrollTo(0, 0);
    await page.mount(this.root, new URLSearchParams(location.search));
  }
}
