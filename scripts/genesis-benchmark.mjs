#!/usr/bin/env node
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { cpus, endianness, platform, release, arch, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const usage = `Usage: node scripts/genesis-benchmark.mjs PROJECT.nhterrain.json
  [--resolution 64..1024] [--samples 17..1024] [--out REPORT.json]
  [--fields DIRECTORY]

Runs one cold prepared World evaluation and one complete-world region sample.
The saved project must have Genesis enabled. Optional --resolution changes the
formation reference; --samples sets the longest output axis (default: 257).
Without --out, writes JSON to stdout. Output paths must not already exist.
Run separate processes for independent process peak-RSS measurements.
--fields saves raw before/after fields and metadata for independent visual QA.
The before field is evaluated after the measured run; it does not affect timings.
`;
const args = process.argv.slice(2);
const controller = new AbortController();
const cancel = () => controller.abort(new DOMException('Cancelled.', 'AbortError'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
let server;
let prepared;
try {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(usage);
  } else {
    const input = resolve(args[0]);
    const values = new Map();
    for (let i = 1; i < args.length; i += 2) {
      const name = args[i];
      if (
        !['--resolution', '--samples', '--out', '--fields'].includes(name) ||
        values.has(name) ||
        !args[i + 1]
      )
        throw new Error(usage);
      values.set(name, args[i + 1]);
    }
    const integer = (key, fallback, min, max) => {
      const value = values.has(key) ? Number(values.get(key)) : fallback;
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${key} must be an integer from ${min} to ${max}.`);
      return value;
    };
    const samples = integer('--samples', 257, 17, 1024);
    const inputStat = await stat(input);
    if (!inputStat.isFile() || inputStat.size > 64 * 1024 * 1024)
      throw new Error('Choose a regular project file below 64 MiB.');
    const bytes = await readFile(input);
    const sha256 = (data) => createHash('sha256').update(data).digest('hex');
    const git = (command) =>
      execFileSync('git', command, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    let source = { revision: 'unknown', dirty: null, source: 'unknown' };
    try {
      source = {
        revision: git(['rev-parse', 'HEAD']),
        dirty: git(['status', '--porcelain', '--untracked-files=normal']).length > 0,
        source: 'git',
      };
    } catch {
      /* Source archives retain explicit unknown provenance. */
    }
    // A dirty checkout's HEAD is insufficient provenance: include the exact
    // bytes of tracked and new runtime sources, including uncommitted solvers.
    const codeSnapshot = async () => {
      const paths = [
        ...new Set(
          git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
            .split('\0')
            .filter(
              (path) =>
                path &&
                (path.startsWith('src/') ||
                  path.startsWith('scripts/') ||
                  ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'].includes(
                    path,
                  )),
            ),
        ),
      ].sort();
      const codeFiles = [];
      for (const path of paths) {
        try {
          const contents = await readFile(resolve(root, path));
          codeFiles.push({ path, bytes: contents.length, sha256: sha256(contents) });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          codeFiles.push({ path, deleted: true });
        }
      }
      return { codeFiles, codeSHA256: sha256(JSON.stringify(codeFiles)) };
    };
    if (source.source === 'git') {
      Object.assign(source, await codeSnapshot());
      source.codeHashScope =
        'Tracked and untracked src/, scripts/, package manifests, TypeScript and Vite configuration; deleted tracked paths are recorded.';
    }
    server = await createServer({
      root,
      configFile: false,
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      define: {
        __NH_BUILD_INFO__: JSON.stringify({
          revision: source.revision,
          dirty: source.dirty,
          source: source.source,
        }),
      },
    });
    const { parseProject } = await server.ssrLoadModule('/src/model/project.ts');
    const { prepareWorldEvaluation } = await server.ssrLoadModule('/src/engine/world/index.ts');
    const project = parseProject(JSON.parse(bytes.toString('utf8')));
    if (!project.world?.genesis?.enabled)
      throw new Error('The benchmark project must contain enabled World Genesis settings.');
    const world = structuredClone(project.world);
    world.backend = 'cpu-reference';
    world.globalResolution = integer('--resolution', world.globalResolution, 64, 1024);
    const longest = Math.max(world.domain.width, world.domain.depth);
    const grid = {
      startX: 0,
      startZ: 0,
      cellsX: world.domain.cellsX,
      cellsZ: world.domain.cellsZ,
      samplesX: Math.max(2, Math.round(((samples - 1) * world.domain.width) / longest) + 1),
      samplesZ: Math.max(2, Math.round(((samples - 1) * world.domain.depth) / longest) + 1),
    };
    const started = performance.now();
    prepared = await prepareWorldEvaluation(project, world, { signal: controller.signal });
    const preparedAt = performance.now();
    const result = await prepared.sampleRegion(grid, { signal: controller.signal });
    const sampledAt = performance.now();
    const processPeakRSSBytes = process.resourceUsage().maxRSS * 1024;
    const processRSSAfterSamplingBytes = process.memoryUsage().rss;
    if (source.source === 'git') {
      const endSource = await codeSnapshot();
      source.codeSHA256AtEnd = endSource.codeSHA256;
      source.changedDuringRun = source.codeSHA256 !== endSource.codeSHA256;
    }
    const hashes = {};
    for (const name of ['heights', 'flow', 'wear', 'deposition']) {
      const data = result[name];
      hashes[name] = sha256(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    if (result.genesis)
      for (const name of [
        'hardness',
        'lithology',
        'uplift',
        'incision',
        'drainageArea',
        'channel',
      ]) {
        const data = result.genesis[name];
        hashes[name] = sha256(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
    const report = {
      schemaVersion: 1,
      scenario: 'cold-world-genesis-prepare-and-sample',
      measuredAt: new Date().toISOString(),
      source,
      input: { path: relative(root, input), sha256: sha256(bytes), bytes: bytes.length },
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        architecture: arch(),
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCPUs: cpus().length,
        hostMemoryBytes: totalmem(),
        typedArrayByteOrder: endianness(),
      },
      world,
      outputGrid: grid,
      measurements: {
        prepareMs: preparedAt - started,
        sampleMs: sampledAt - preparedAt,
        totalMeasuredMs: sampledAt - started,
        processPeakRSSBytes,
        processRSSAfterSamplingBytes,
        estimatedPeakLiveDataBytes: result.estimatedPeakBytes,
      },
      result: {
        heightRangeAuthored: [result.min, result.max],
        stages: result.stages,
        genesis: result.genesis?.report,
        transport: result.transportBudget,
        hashes,
      },
      qualifications: [
        'Single cold preparation and one region sample in this process; not a statistical distribution.',
        'Includes the complete reachable authored graph and enabled World stages. Sampling excludes PBR baking and ZIP encoding.',
        'Process peak RSS includes Vite SSR startup and runtime overhead; estimated live data is not an OS process-memory limit.',
        'CPU reference only. Host CPU/memory identification does not imply exclusive CPU allocation or available container memory.',
        'Output checksums use the recorded typed-array byte order; report timings are intentionally not deterministic.',
      ],
    };
    if (source.changedDuringRun)
      report.qualifications.push(
        'Source files changed during this run. This measurement is provisional and must not be attributed to a stable source snapshot.',
      );
    if (values.has('--fields')) {
      const fieldDirectory = resolve(values.get('--fields'));
      await mkdir(dirname(fieldDirectory), { recursive: true });
      await mkdir(fieldDirectory);
      const files = {};
      const save = async (name, data) => {
        const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const filename = `${name}.${data instanceof Uint8Array ? 'u8' : 'f32'}.raw`;
        await writeFile(resolve(fieldDirectory, filename), raw, { flag: 'wx' });
        files[name] = {
          filename,
          bytes: raw.length,
          sha256: sha256(raw),
          format: data instanceof Uint8Array ? 'uint8' : 'float32',
        };
      };
      await save('after', result.heights);
      for (const name of ['hardness', 'lithology', 'uplift', 'incision', 'drainageArea', 'channel'])
        if (result.genesis) await save(name, result.genesis[name]);
      prepared.dispose();
      prepared = undefined;
      const originalWorld = {
        ...world,
        genesis: { ...world.genesis, enabled: false },
        ...(world.transport ? { transport: { ...world.transport, enabled: false } } : {}),
      };
      const original = await prepareWorldEvaluation(project, originalWorld, {
        signal: controller.signal,
      });
      try {
        const before = await original.sampleRegion(grid, { signal: controller.signal });
        await save('before', before.heights);
      } finally {
        original.dispose();
      }
      const metadata = {
        schemaVersion: 1,
        width: result.width,
        height: result.height,
        spacingX: result.spacingX,
        spacingZ: result.spacingZ,
        heightScale: world.domain.heightScale,
        datum: world.domain.datum,
        originX: world.domain.originX,
        originZ: world.domain.originZ,
        byteOrder: endianness(),
        source,
        inputSHA256: sha256(bytes),
        files,
        beforeStage: 'authored graph before Genesis and World transport',
        afterStage: 'completed World result after all enabled stages',
        qualifications: [
          'Height fields use authored units: metres = datum + value * heightScale.',
          'Genesis diagnostic fields retain their own units and describe the Genesis stage before optional World transport.',
          'Before-field evaluation occurs after recorded measurements.',
        ],
      };
      await writeFile(
        resolve(fieldDirectory, 'fields.json'),
        JSON.stringify(metadata, null, 2) + '\n',
        { flag: 'wx' },
      );
      report.fieldsDirectory = relative(root, fieldDirectory);
    }
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.has('--out')) {
      const output = resolve(values.get('--out'));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, json, { flag: 'wx' });
      process.stdout.write(`${output}\n`);
    } else process.stdout.write(json);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  prepared?.dispose();
  await server?.close();
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
