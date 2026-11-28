#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = dirname(fileURLToPath(import.meta.url));
const root = resolve(folder, '../..');
const output = resolve(process.argv[2] ?? resolve(root, 'test-results/blender-qualification'));
const blender = process.env.NH_BLENDER_PATH ?? 'blender';
await mkdir(output, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Qualification command failed (${result.status}): ${command}`);
}
run(process.execPath, [resolve(folder, 'create-qa-fixture.mjs'), output]);
run(blender, [
  '--background',
  '--factory-startup',
  '--python-exit-code',
  '1',
  '--python',
  resolve(folder, 'qualify.py'),
  '--',
  '--directory',
  output,
]);
const moved = [];
try {
  for (const format of ['raw32', 'raw16', 'png16']) {
    const source = resolve(output, `world-${format}.zip`);
    const offline = resolve(output, `world-${format}.zip.offline`);
    await rename(source, offline);
    moved.push([source, offline]);
  }
  run(blender, [
    '--background',
    resolve(output, 'qualified-world.blend'),
    '--python-exit-code',
    '1',
    '--python',
    resolve(folder, 'qualify.py'),
    '--',
    '--directory',
    output,
    '--reopen',
  ]);
} finally {
  for (const [source, offline] of moved) await rename(offline, source);
}
process.stdout.write(`Blender import and offline .blend reopen qualified. Evidence: ${output}\n`);
