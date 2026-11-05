import { build, context } from 'esbuild';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// Bundled geometric mark. PNGs are generated locally with no runtime dependencies.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type); const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length); name.copy(out, 4); bytes.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, bytes])), bytes.length + 8); return out;
}
function icon(size) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * (size * 4 + 1) + 1 + x * 4;
    const nx = x / size, ny = y / size;
    const ring = Math.abs(Math.hypot(nx - .5, ny - .5) - .30) < .055;
    const play = nx > .44 && nx < .64 && Math.abs(ny - .5) < (nx - .44) * .7;
    const color = ring || play ? [245, 195, 91] : [23, 25, 30];
    for (let c = 0; c < 3; c++) data[i + c] = color[c]; data[i + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
await mkdir('dist/icons', { recursive: true });
await cp('public', 'dist', { recursive: true });
for (const size of [16, 32, 48, 128]) await writeFile(`dist/icons/icon${size}.png`, icon(size));
const common = { bundle: true, target: 'chrome120', sourcemap: false, minify: false, logLevel: 'info', legalComments: 'none' };
const configurations = [
  { ...common, entryPoints: ['src/background/index.ts'], outfile: 'dist/background.js', format: 'esm' },
  { ...common, entryPoints: ['src/content/index.ts'], outfile: 'dist/content.js', format: 'iife' },
  { ...common, entryPoints: { popup: 'src/pages/popup.ts', options: 'src/pages/options.ts', correction: 'src/pages/correction.ts' }, outdir: 'dist', format: 'iife' }
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
