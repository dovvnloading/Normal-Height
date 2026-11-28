import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { runCLI } from '../src/cli/main';
import { verifyWorldArchive } from '../src/cli/archive';
import { createProject } from '../src/model/presets';
import { createNode } from '../src/model/registry';
import { STUDIO_DEFAULTS } from '../src/model/noiseStudio';
import { createWorldDefinition } from '../src/model/world';
import { serializeProjectFile } from '../src/model/projectStorage';

let directory: string;
let projectPath: string;
let archivePath: string;
const execute = promisify(execFile);
async function invoke(args: string[], signal?: AbortSignal) {
  let stdout = '';
  let stderr = '';
  const code = await runCLI(args, {
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
    signal,
  });
  return { code, stdout, stderr, result: JSON.parse(stdout) };
}

beforeAll(async () => {
  await mkdir(resolve('test-results'), { recursive: true });
  directory = await mkdtemp(resolve('test-results/cli-'));
  projectPath = join(directory, 'project.nhterrain.json');
  archivePath = join(directory, 'world.zip');
  const project = createProject('studio-ridges');
  project.resolution = 64;
  const source = createNode('noise', { x: 0, y: 0 }, 'source');
  source.params = {
    ...STUDIO_DEFAULTS,
    noiseModel: 'v3',
    kernel: 'perlin',
    fractal: 'none',
    octaves: 1,
  };
  const output = createNode('output', { x: 200, y: 0 }, 'output');
  project.graph = {
    nodes: [source, output],
    edges: [{ id: 'edge', source: source.id, target: output.id }],
  };
  const world = createWorldDefinition(project);
  world.globalResolution = 64;
  world.tileCells = 32;
  world.domain.width = 1400;
  world.domain.depth = 800;
  world.domain.cellsX = 64;
  world.domain.cellsZ = 48;
  await writeFile(projectPath, serializeProjectFile({ ...project, version: 2, world }));
  const built = await invoke([
    'build',
    projectPath,
    '--out',
    archivePath,
    '--samples',
    '33x25',
    '--format',
    'raw32',
    '--tile-intervals',
    '16',
    '--json',
  ]);
  if (built.code !== 0) throw new Error(built.stdout);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('production CLI', () => {
  it('validates and inspects project contracts without terrain allocation', async () => {
    const validation = await invoke(['validate', projectPath, '--json']);
    expect(validation.code).toBe(0);
    expect(validation.result).toMatchObject({ ok: true, schemaVersion: 1, command: 'validate' });
    expect(validation.result.result).toMatchObject({ buildable: true, projectSchemaVersion: 2 });
    const inspection = await invoke(['inspect', projectPath, '--json']);
    expect(inspection.code).toBe(0);
    expect(inspection.result.result.world.domain).toMatchObject({ width: 1400, depth: 800 });
    expect(inspection.result.result.stages.length).toBeGreaterThan(0);
    expect(inspection.stderr).toBe('');
  });

  it('honors cancellation received while validate or inspect is reading the project', async () => {
    for (const command of ['validate', 'inspect']) {
      const controller = new AbortController();
      const pending = invoke([command, projectPath, '--json'], controller.signal);
      controller.abort(new DOMException('Cancelled during project read.', 'AbortError'));
      const response = await pending;
      expect(response.code).toBe(130);
      expect(response.result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(response.result.result).toBeUndefined();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects POSIX FIFO inputs without leaving a blocked CLI process',
    async () => {
      const fifo = join(directory, 'special-input.fifo');
      await execute('mkfifo', [fifo], { timeout: 5000, killSignal: 'SIGKILL' });
      try {
        for (const command of ['validate', 'inspect', 'verify']) {
          // A regression must be killed in an isolated child, never leave an
          // uninterruptible fs.open in this test runner's thread pool.
          const result = await execute(
            process.execPath,
            [resolve('scripts/nh.mjs'), command, fifo, '--json'],
            { timeout: 5000, killSignal: 'SIGKILL' },
          ).then(
            ({ stdout }) => ({ code: 0, killed: false, signal: null, stdout }),
            (error) => ({
              code: error.code,
              killed: error.killed,
              signal: error.signal,
              stdout: error.stdout,
            }),
          );
          expect(result.killed, `${command} blocked on a FIFO`).toBe(false);
          expect(result.signal).toBeNull();
          expect(result.code).toBe(1);
          expect(JSON.parse(result.stdout)).toMatchObject({
            ok: false,
            error: { code: 'FAILED', message: expect.stringMatching(/regular file/) },
          });
        }
      } finally {
        await rm(fifo, { force: true });
      }
    },
  );

  it('runs the public launcher from another directory and reports actual Git provenance', async () => {
    const { stdout, stderr } = await execute(
      process.execPath,
      [resolve('scripts/nh.mjs'), 'validate', projectPath, '--json'],
      { cwd: directory, timeout: 15000 },
    );
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    const response = JSON.parse(stdout);
    expect(response.ok).toBe(true);
    expect(response.build.source).toBe('git');
    expect(response.build.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof response.build.dirty).toBe('boolean');
  });

  it('streams, verifies and atomically publishes a rectangular world with no temporary files left', async () => {
    const builtPath = join(directory, 'built.zip');
    const response = await invoke([
      'build',
      projectPath,
      '--out',
      builtPath,
      '--samples',
      '33x25',
      '--format',
      'raw32',
      '--maps',
      'normalGL,slope',
      '--tile-intervals',
      '16',
      '--json',
    ]);
    expect(response.code, response.stdout).toBe(0);
    expect(response.result.result.verification).toMatchObject({
      tiles: 4,
      verifiedMapFiles: 12,
      dimensions: [33, 25],
      profile: 'generic',
    });
    expect(response.result.result.manifest.dimensions).toMatchObject({
      widthMeters: 1400,
      depthMeters: 800,
    });
    expect(response.result.result.manifest.backend).toBe('cpu-reference');
    expect((await readdir(directory)).some((name) => name.endsWith('.partial'))).toBe(false);
    const verified = await invoke(['verify', builtPath, '--json']);
    expect(verified.code, verified.stdout).toBe(0);
    expect(verified.result.result.verifiedMapFiles).toBe(12);
  });

  it('refuses output overwrite and source replacement, then honors an explicit atomic replacement', async () => {
    const prior = await readFile(archivePath);
    const overwritePath = join(directory, 'overwrite.zip');
    await writeFile(overwritePath, prior);
    const args = ['build', projectPath, '--out', overwritePath, '--samples', '17x17', '--json'];
    const refusal = await invoke(args);
    expect(refusal.code).toBe(1);
    expect(refusal.result.error.message).toMatch(/already exists/);
    expect(await readFile(overwritePath)).toEqual(prior);
    const sourceRefusal = await invoke([
      'build',
      projectPath,
      '--out',
      projectPath,
      '--samples',
      '17',
      '--force',
      '--json',
    ]);
    expect(sourceRefusal.code).toBe(1);
    expect(sourceRefusal.result.error.message).toMatch(/source project/);
    const replaced = await invoke([...args, '--force']);
    expect(replaced.code, replaced.stdout).toBe(0);
    expect(replaced.result.result.verification.dimensions).toEqual([17, 17]);
  });

  it('rejects invalid flags, duplicate arguments and incompatible profiles before creating output', async () => {
    for (const args of [
      ['toString', projectPath],
      ['constructor', projectPath],
      ['__proto__', projectPath],
      ['validate', projectPath, '--unknown'],
      ['inspect', projectPath, '--json', '--json'],
      ['build', projectPath, '--out', join(directory, 'bad.zip'), '--samples', 'oops'],
    ]) {
      const result = await invoke([...args, ...(args.includes('--json') ? [] : ['--json'])]);
      expect(result.code).toBe(2);
      expect(result.result.error.code).toBe('USAGE');
    }
    const invalidUnity = await invoke([
      'build',
      projectPath,
      '--out',
      join(directory, 'bad.zip'),
      '--samples',
      '64',
      '--profile',
      'unity',
      '--json',
    ]);
    expect(invalidUnity.code).toBe(1);
    expect(invalidUnity.result.error.message).toMatch(/Unity/);
    expect(await readdir(directory)).not.toContain('bad.zip');
  });

  it('cleans up an opened temporary output when cancellation interrupts generation', async () => {
    const controller = new AbortController();
    let stdout = '';
    const out = join(directory, 'cancelled.zip');
    const code = await runCLI(['build', projectPath, '--out', out, '--samples', '4096'], {
      signal: controller.signal,
      stdout: (message) => {
        stdout += message;
      },
      stderr: (message) => {
        if (/Compiling world graph/.test(message)) controller.abort();
      },
    });
    expect(code).toBe(130);
    expect(stdout).toBe('');
    const names = await readdir(directory);
    expect(names).not.toContain('cancelled.zip');
    expect(names.some((name) => name.endsWith('.partial'))).toBe(false);
  });

  it('handles a real SIGINT without publishing an incomplete archive', async () => {
    const out = join(directory, 'interrupted.zip');
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolveResult, reject) => {
        const child = spawn(
          process.execPath,
          [
            resolve('scripts/nh.mjs'),
            'build',
            projectPath,
            '--out',
            out,
            '--samples',
            '8192',
            '--tile-intervals',
            '256',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stderr = '';
        let interrupted = false;
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('CLI cancellation timed out.'));
        }, 15000);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
          if (!interrupted && stderr.includes('Compiling world graph')) {
            interrupted = true;
            child.kill('SIGINT');
          }
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolveResult({ code, stderr });
        });
      },
    );
    expect(result.code, result.stderr).toBe(130);
    expect(result.stderr).toMatch(/cancelled/);
    const names = await readdir(directory);
    expect(names).not.toContain('interrupted.zip');
    expect(names.some((name) => name.endsWith('.partial'))).toBe(false);
  });
});

describe('bounded archive verification', () => {
  async function changed(name: string, transform: (files: Record<string, Uint8Array>) => void) {
    const files = unzipSync(await readFile(archivePath));
    transform(files);
    const path = join(directory, name);
    await writeFile(path, zipSync(files, { level: 6 }));
    return path;
  }

  it('detects modified tile content even when the ZIP container checksum has been recomputed', async () => {
    const path = await changed('modified.zip', (files) => {
      const name = Object.keys(files).find((entry) => entry.startsWith('tiles/'))!;
      files[name][files[name].length - 1] ^= 1;
    });
    await expect(verifyWorldArchive(path)).rejects.toThrow(/CRC32 disagrees/);
  });

  it('rejects extra entries and manifest/project disagreement', async () => {
    const extra = await changed('extra.zip', (files) => {
      files['extra.bin'] = new Uint8Array([1]);
    });
    await expect(verifyWorldArchive(extra)).rejects.toThrow(/exactly match/);
    const mismatch = await changed('mismatch.zip', (files) => {
      const project = JSON.parse(new TextDecoder().decode(files['project.nhterrain.json']));
      project.seed++;
      files['project.nhterrain.json'] = strToU8(JSON.stringify(project));
    });
    await expect(verifyWorldArchive(mismatch)).rejects.toThrow(/world or seed/);
  });

  it('rejects path traversal and decompression bombs before reading their payload', async () => {
    const unsafe = join(directory, 'unsafe.zip');
    await writeFile(unsafe, zipSync({ '../escape.bin': new Uint8Array([1]) }));
    await expect(verifyWorldArchive(unsafe)).rejects.toThrow(/unsafe or duplicate/);
    const bomb = join(directory, 'bomb.zip');
    await writeFile(bomb, zipSync({ 'bomb.bin': new Uint8Array(2 * 1024 * 1024) }, { level: 9 }));
    await expect(verifyWorldArchive(bomb, { maxExpandedBytes: 1024 * 1024 })).rejects.toThrow(
      /budget/,
    );
  });

  it('stops expansion when the ZIP lies about its declared uncompressed size', async () => {
    const files = unzipSync(await readFile(archivePath));
    files['project.nhterrain.json'] = strToU8(
      ' '.repeat(2 * 1024 * 1024) + new TextDecoder().decode(files['project.nhterrain.json']),
    );
    const bytes = Buffer.from(zipSync(files, { level: 9 }));
    let cursor = bytes.readUInt32LE(bytes.length - 6);
    while (bytes.readUInt32LE(cursor) === 0x02014b50) {
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if (name === 'project.nhterrain.json') {
        const localOffset = bytes.readUInt32LE(cursor + 42);
        bytes.writeUInt32LE(1, cursor + 24);
        bytes.writeUInt32LE(1, localOffset + 22);
        break;
      }
      cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    }
    const path = join(directory, 'lying-size.zip');
    await writeFile(path, bytes);
    await expect(verifyWorldArchive(path)).rejects.toThrow(/decompressed size exceeds/);
  });

  it('checks the actual bytes of metadata that are outside tile CRC records', async () => {
    const files = unzipSync(await readFile(archivePath));
    const bytes = Buffer.from(zipSync(files, { level: 0 }));
    let cursor = bytes.readUInt32LE(bytes.length - 6);
    while (bytes.readUInt32LE(cursor) === 0x02014b50) {
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if (name === 'README.txt') {
        const localOffset = bytes.readUInt32LE(cursor + 42);
        const dataOffset =
          localOffset +
          30 +
          bytes.readUInt16LE(localOffset + 26) +
          bytes.readUInt16LE(localOffset + 28);
        bytes[dataOffset] ^= 1;
        break;
      }
      cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    }
    const path = join(directory, 'corrupt-readme.zip');
    await writeFile(path, bytes);
    await expect(verifyWorldArchive(path)).rejects.toThrow(/CRC32 mismatch/);
  });

  it('rejects truncated archives and missing tile coverage', async () => {
    const truncated = join(directory, 'truncated.zip');
    const bytes = await readFile(archivePath);
    await writeFile(truncated, bytes.subarray(0, bytes.length - 1));
    await expect(verifyWorldArchive(truncated)).rejects.toThrow(/end-of-directory/);
    const hole = await changed('hole.zip', (files) => {
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
      for (const tile of manifest.tiles) if (tile.x === 0) tile.sampleOffset[0] = 1;
      manifest.dimensions.samples[0]++;
      files['manifest.json'] = strToU8(JSON.stringify(manifest));
    });
    await expect(verifyWorldArchive(hole)).rejects.toThrow(/coverage/);
  });
});
