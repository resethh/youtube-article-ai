import { build, context } from 'esbuild';
import { rmSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

rmSync(join(root, 'dist'), { recursive: true, force: true });
mkdirSync(join(root, 'dist/public'), { recursive: true });

const shared = {
  bundle: true,
  sourcemap: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'info',
};

const worker = {
  ...shared,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'dist/worker.js'),
  external: ['cloudflare:workers', 'cloudflare:sockets'],
};

const frontend = {
  ...shared,
  entryPoints: [join(root, 'public/app.js')],
  outfile: join(root, 'dist/public/app.js'),
  format: 'iife',
  sourcemap: false,
  target: 'es2020',
};

/** 拷贝静态资源（index.html / style.css） */
function copyStatic() {
  for (const f of ['index.html', 'style.css']) {
    cpSync(join(root, 'public', f), join(root, 'dist/public', f));
  }
  console.log('static copied');
}

if (watch) {
  const wctx = await context(worker);
  const fctx = await context(frontend);
  await Promise.all([wctx.watch(), fctx.watch()]);
  copyStatic();
  console.log('watching…');
} else {
  await Promise.all([build(worker), build(frontend)]);
  copyStatic();
  console.log('build done');
}