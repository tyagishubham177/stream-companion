import { build, context } from 'esbuild';
import { cp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

await cp('public', 'dist', { recursive: true });
const common = { bundle: true, target: 'chrome120', sourcemap: false, minify: false, logLevel: 'info', legalComments: 'none' };
const configurations = [
  { ...common, entryPoints: ['src/background/index.ts'], outfile: 'dist/background.js', format: 'esm' },
  { ...common, entryPoints: ['src/content/index.ts'], outfile: 'dist/content.js', format: 'iife' },
  { ...common, entryPoints: { popup: 'src/pages/popup.ts', options: 'src/pages/options.ts', correction: 'src/pages/correction.ts', titles: 'src/pages/titles.ts' }, outdir: 'dist', format: 'iife' }
];
if (process.argv.includes('--watch')) {
  for (const config of configurations) { const ctx = await context(config); await ctx.watch(); }
  console.log('Watching TypeScript. Re-run npm run build after changing public HTML/CSS. Reload the extension in Chrome.');
} else {
  await Promise.all(configurations.map(config => build(config)));
  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, ...manifest.content_scripts.flatMap(c => c.js)])
    await readFile(path.join('dist', file));
  const entries = await readdir('dist');
  console.log(`Built ${manifest.name} ${manifest.version}: ${entries.length} top-level entries.`);
}
