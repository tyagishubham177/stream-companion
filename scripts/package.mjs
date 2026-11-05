import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import path from 'node:path';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('releases', { recursive: true });
const destination = path.resolve(`releases/stream-companion-${version}.zip`);
const files = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), `${relative}/`);
    else if (entry.isFile()) files[relative] = new Uint8Array(await readFile(path.join(directory, entry.name)));
    else throw new Error(`Unexpected package entry: ${relative}`);
  }
}
await collect('dist');
await writeFile(destination, zipSync(files, { level: 9 }));
console.log(`Created ${destination}`);
