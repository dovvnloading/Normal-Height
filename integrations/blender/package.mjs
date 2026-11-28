#!/usr/bin/env node
import { zipSync } from 'fflate';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const destination = resolve(
  process.argv[2] ?? resolve(directory, '../../dist/normal-height-blender.zip'),
);
const files = {};
for (const name of ['__init__.py', 'archive.py']) {
  files[`normal_height_world/${name}`] = [
    new Uint8Array(await readFile(resolve(directory, 'normal_height_world', name))),
    { mtime: new Date('2026-01-01T00:00:00Z') },
  ];
}
await mkdir(dirname(destination), { recursive: true });
const temporary = `${destination}.${randomUUID()}.tmp`;
await writeFile(temporary, zipSync(files, { level: 9 }));
await rename(temporary, destination);
process.stdout.write(`Installable Blender add-on: ${destination}\n`);
