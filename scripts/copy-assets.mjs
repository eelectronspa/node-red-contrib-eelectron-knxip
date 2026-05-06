import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'src';
const DIST = 'dist';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

const files = await walk(SRC);
const assets = files.filter((f) => f.endsWith('.html') || f.endsWith('.svg'));

for (const src of assets) {
  const dest = src.replace(SRC, DIST);
  await cp(src, dest);
  console.log(`copied ${src} -> ${dest}`);
}

// Node-RED resolves a node's `icon: 'foo.svg'` by looking for `icons/foo.svg`
// next to the node's .js file. Mirror src/icons/ into each node's dist
// subdirectory so icons resolve regardless of how the package is loaded.
const iconFiles = (await readdir(join(SRC, 'icons'), { withFileTypes: true }))
  .filter((d) => d.isFile() && d.name.endsWith('.svg'))
  .map((d) => d.name);

const nodeDirs = (await readdir(join(SRC, 'nodes'), { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name !== 'shared')
  .map((d) => d.name);

for (const nodeDir of nodeDirs) {
  const targetDir = join(DIST, 'nodes', nodeDir, 'icons');
  await mkdir(targetDir, { recursive: true });
  for (const icon of iconFiles) {
    const src = join(SRC, 'icons', icon);
    const dest = join(targetDir, icon);
    await cp(src, dest);
    console.log(`mirrored ${src} -> ${dest}`);
  }
}

if (assets.length === 0) console.log('no assets to copy');
