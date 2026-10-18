import './style.css';
import { Router } from './app/router.ts';
import { homePage } from './app/pages/home.ts';
import { editorPage } from './app/pages/editor.ts';
import { racePage } from './app/pages/race.ts';
import { leaderboardPage } from './app/pages/leaderboard.ts';
import { accountPage } from './app/pages/account.ts';
import { aboutPage } from './app/pages/about.ts';
import { setupSettingsPanel } from './app/settings-panel.ts';
import { armAudio, getScene } from './app/context.ts';

import { appPath, withBase } from './app/base.ts';

// index.html のナビゲーションにも配信パスを付ける
document.querySelectorAll<HTMLAnchorElement>('a[data-link]').forEach((a) => {
  const href = a.getAttribute('href');
  if (href?.startsWith('/')) a.setAttribute('href', withBase(href));
});

const view = document.getElementById('view')!;
const router = new Router(view);
router
  .add('/', homePage)
  .add('/editor', () => editorPage(router))
  .add('/race', () => racePage(router))
  .add('/leaderboard', leaderboardPage)
  .add('/account', () => accountPage(router))
  .add('/about', aboutPage)
  .changed((path, page) => {
    document.querySelectorAll<HTMLAnchorElement>('#topbar nav a').forEach((a) => {
      a.classList.toggle('active', appPath(new URL(a.href).pathname) === path);
    });
    // 3D を使わない画面では描画ループを止めて電池を節約
    const scene = getScene();
    if (page.paper) scene?.stop();
    else scene?.start();
  });

setupSettingsPanel();
armAudio();
void router.render();
