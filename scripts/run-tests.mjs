// Tiny portable test runner: walks the `test/` directory for `*.test.ts`
// files and invokes `node --test --import tsx` with the resolved paths.
//
// Node's `--test` runner only supports glob patterns natively from Node 22
// onward; this script lets us keep the matrix on Node 18 / 20 / 22 without
// relying on shell glob expansion (which differs across sh / bash / Windows).

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const s = statSync(path);
    if (s.isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const files = walk('test').sort();
if (files.length === 0) {
  console.error('No *.test.ts files found under test/');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--import', 'tsx', ...files],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exit(result.status ?? 0);
