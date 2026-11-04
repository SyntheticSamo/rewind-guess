import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = {};
for (const [name, type] of Object.entries({ 'index.html': 'text/html; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'core.js': 'text/javascript; charset=utf-8', 'config.js': 'text/javascript; charset=utf-8' })) assets['/' + name] = { body: await readFile(resolve(root, 'web', name), 'utf8'), type };
const worker = await readFile(resolve(root, 'worker/index.js'), 'utf8');
const marker = 'const ASSETS = {}; // BUILD_ASSETS';
if (!worker.includes(marker)) throw new Error('Missing asset marker');
await mkdir(resolve(root, 'dist/server'), { recursive: true });
await mkdir(resolve(root, 'dist/.openai'), { recursive: true });
await writeFile(resolve(root, 'dist/server/index.js'), worker.replace(marker, () => 'const ASSETS = ' + JSON.stringify(assets) + ';'));
try { await copyFile(resolve(root, '.openai/hosting.json'), resolve(root, 'dist/.openai/hosting.json')); }
catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(resolve(root, 'dist/.openai/hosting.json'), JSON.stringify({ d1: null, r2: null })); }
console.log('Built self-contained Worker and browser assets.');
