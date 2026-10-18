// packages/sim-core を Supabase Edge Functions（Deno）用にコピーする。
// --check のときは差分があれば失敗する（CI 用）。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const src = 'packages/sim-core/src';
const dst = 'supabase/functions/_shared/sim-core';
const check = process.argv.includes('--check');
const header = '// 自動生成：packages/sim-core/src からコピー（npm run sync:sim）。直接編集しないこと。\n';

const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
let dirty = false;
if (!check) {
  if (existsSync(dst)) rmSync(dst, { recursive: true });
  mkdirSync(dst, { recursive: true });
}
for (const f of files) {
  const body = header + readFileSync(join(src, f), 'utf8');
  const out = join(dst, f);
  if (check) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== body) {
      console.error(`out of sync: ${out}`);
      dirty = true;
    }
  } else {
    writeFileSync(out, body);
  }
}
if (check) {
  const extra = existsSync(dst) ? readdirSync(dst).filter((f) => !files.includes(f)) : [];
  for (const f of extra) {
    console.error(`stale file: ${join(dst, f)}`);
    dirty = true;
  }
  if (dirty) {
    console.error('npm run sync:sim を実行してください');
    process.exit(1);
  }
  console.log('sim-core is in sync');
} else {
  console.log(`copied ${files.length} files to ${dst}`);
}
