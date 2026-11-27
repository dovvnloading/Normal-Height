import { constants } from 'node:fs';
import { access, link, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_PROJECT_FILE_BYTES } from '../model/heightRaster';
import { parseProject } from '../model/project';
import { createWorldDefinition } from '../model/world';
import { BUILD_INFO } from '../model/buildInfo';
import { MAX_GRAPH_EDGES, MAX_GRAPH_NODES, primaryInputHandle } from '../model/graph';
import { NODE_DEFINITIONS } from '../model/registry';
import { compileGraph } from '../engine/plan/graph';
import { describeWorldGraph } from '../engine/world/capabilities';
import { checkWorldExportBudget, streamWorldExport } from '../export/worldExport';
import type { WorldExportOptions, WorldExportMap } from '../export/worldExport';
import type { TerrainProject } from '../model/types';
import { verifyWorldArchive } from './archive';
import { WORLD_MATERIAL_MAPS } from '../materials/worldMaterial';

const MiB = 1024 * 1024;
const HELP = `Normal Height production CLI

Usage:
  npm run nh -- validate PROJECT.nhterrain.json [--json]
  npm run nh -- inspect PROJECT.nhterrain.json [--json]
  npm run nh -- build PROJECT.nhterrain.json --out WORLD.zip --samples WIDTH[xHEIGHT] [options]
  npm run nh -- verify WORLD.zip [--max-expanded-mib N] [--json]

Build options:
  --profile generic|unreal|unity   Engine profile (default: generic)
  --format png16|raw16|raw32       Default: png16, or raw16 for Unity
  --maps MAP,MAP                  Additional map names; height is always included
  --mask NODE_ID:NAME             Named graph mask; repeat to include several
  --tile-intervals N              Requested tile intervals (engine profiles may override)
  --global-resolution N          Whole-domain reference samples (64 through 1024)
  --memory-mib N                  Conservative export budget (64 through 2048; default: 512)
  --region X,Z,WIDTH,HEIGHT       World-domain interval coordinates
  --force                        Atomically replace an existing output
  --json                         One machine-readable result on stdout

Builds use the CPU reference backend and the same World exporter as the app.
Output is verified before atomic publication. Existing files are never replaced
without --force. Unreal and Unity profiles retain their import qualification status.
Node.js >=22.12 and npm ci are required. Use node scripts/nh.mjs for clean JSON
without npm's script banner. Ctrl+C cancels work and removes the temporary output.
`;
const MAP_NAMES = new Set([
  'height',
  'flow',
  'wear',
  'deposition',
  'normalGL',
  'slope',
  ...WORLD_MATERIAL_MAPS,
]);
const FLAGS: Record<string, ReadonlySet<string>> = {
  validate: new Set(['json']),
  inspect: new Set(['json']),
  build: new Set([
    'json',
    'out',
    'samples',
    'profile',
    'format',
    'maps',
    'mask',
    'tile-intervals',
    'global-resolution',
    'memory-mib',
    'region',
    'force',
  ]),
  verify: new Set(['json', 'max-expanded-mib']),
};
const BOOLEAN = new Set(['json', 'force']);
class UsageError extends Error {}
interface Arguments {
  command: string;
  input: string;
  flags: Map<string, string[]>;
  json: boolean;
}
export interface CLIContext {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  signal?: AbortSignal;
}
function parseArguments(argv: string[]): Arguments | null {
  if (!argv.length || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h'))
    return null;
  const command = argv[0];
  if (!Object.hasOwn(FLAGS, command))
    throw new UsageError(`Unknown command: ${command}. Use --help.`);
  const allowed = FLAGS[command];
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    const name = token.slice(2, equal >= 0 ? equal : undefined);
    if (!token.startsWith('--') || !allowed.has(name))
      throw new UsageError(`Unknown option for ${command}: ${token}.`);
    if (flags.has(name) && name !== 'mask')
      throw new UsageError(`Option --${name} may only be specified once.`);
    let value = '';
    if (BOOLEAN.has(name)) {
      if (equal >= 0) throw new UsageError(`--${name} does not accept a value.`);
    } else {
      value = equal >= 0 ? token.slice(equal + 1) : argv[++i];
      if (!value || value.startsWith('--')) throw new UsageError(`--${name} requires a value.`);
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  if (positional.length !== 1)
    throw new UsageError(`${command} requires exactly one input file. Use --help.`);
  return { command, input: resolve(positional[0]), flags, json: flags.has('json') };
}
function value(args: Arguments, flag: string) {
  return args.flags.get(flag)?.[0];
}
function integer(
  text: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback?: number,
) {
  if (text === undefined && fallback !== undefined) return fallback;
  const n = Number(text);
  if (!text || !/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < min || n > max)
    throw new UsageError(`${name} must be an integer from ${min} through ${max}.`);
  return n;
}
async function readProject(path: string) {
  // Nonblocking admission lets fstat reject a FIFO without waiting for a
  // writer. O_NONBLOCK is irrelevant for regular files and absent on Windows.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let bytes: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Project input must be a regular file.');
    if (info.size > MAX_PROJECT_FILE_BYTES)
      throw new Error('Project input exceeds the 32 MiB file limit.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({
      highWaterMark: 64 * 1024,
      autoClose: false,
    })) {
      size += chunk.length;
      if (size > MAX_PROJECT_FILE_BYTES)
        throw new Error('Project input exceeds the 32 MiB file limit.');
      chunks.push(chunk as Buffer);
    }
    bytes = Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Project input must contain valid UTF-8 JSON.');
  }
  return parseProject(raw);
}

function analyze(project: TerrainProject) {
  const plan = compileGraph(project);
  const errors: string[] = [];
  for (const stage of plan.stages) {
    const node = plan.byId.get(stage.nodeId)!;
    if (node.kind === 'heightImport' && !node.raster)
      errors.push(`Choose a heightmap for “${node.label}”.`);
    if (
      NODE_DEFINITIONS[node.kind].inputs.length &&
      !stage.inputs.some((input) => input.port === primaryInputHandle(node))
    )
      errors.push(`Connect a height input to “${node.label}”.`);
    if (
      node.kind === 'blend' &&
      !node.bypassed &&
      !stage.inputs.some((input) => input.port === 'b')
    )
      errors.push(`Connect both A and B inputs to “${node.label}”.`);
  }
  const world = {
    ...(project.world ?? createWorldDefinition(project)),
    backend: 'cpu-reference' as const,
  };
  const description = describeWorldGraph(project, world);
  if (!description.capability.supported && description.capability.reason)
    errors.push(description.capability.reason);
  return {
    name: project.name,
    projectSchemaVersion: project.version,
    seed: project.seed,
    authoredResolution: project.resolution,
    nodes: project.graph.nodes.length,
    connections: project.graph.edges.length,
    reachableNodes: plan.needed.size,
    target: plan.target.id,
    limits: { nodes: MAX_GRAPH_NODES, connections: MAX_GRAPH_EDGES },
    world,
    worldWasDerived: project.world === undefined,
    capability: description.capability,
    stages: description.stages,
    buildable: errors.length === 0,
    errors,
  };
}
function buildOptions(args: Arguments, project: TerrainProject): WorldExportOptions {
  const samples = value(args, 'samples');
  if (!samples || !/^\d+(?:x\d+)?$/.test(samples))
    throw new UsageError('--samples requires WIDTH or WIDTHxHEIGHT.');
  const parts = samples.split('x');
  const samplesX = integer(parts[0], 'Sample width', 16, 8193);
  const samplesZ = integer(parts[1] ?? parts[0], 'Sample height', 16, 8193);
  const profile = value(args, 'profile') ?? 'generic';
  if (!['generic', 'unreal', 'unity'].includes(profile))
    throw new UsageError('Unknown export profile.');
  const format = value(args, 'format') ?? (profile === 'unity' ? 'raw16' : 'png16');
  if (!['png16', 'raw16', 'raw32'].includes(format)) throw new UsageError('Unknown height format.');
  const maps = value(args, 'maps')?.split(',');
  if (maps?.some((name) => !MAP_NAMES.has(name)))
    throw new UsageError('Unknown map name in --maps.');
  const masks = args.flags.get('mask')?.map((item) => {
    const separator = item.indexOf(':');
    if (separator < 1 || separator === item.length - 1)
      throw new UsageError('--mask requires NODE_ID:NAME.');
    return { nodeId: item.slice(0, separator), name: item.slice(separator + 1) };
  });
  const world = structuredClone(project.world ?? createWorldDefinition(project));
  // Headless CLI qualification uses the deterministic CPU oracle. Browser GPU
  // selection is presentation/runtime policy, not part of the authored graph.
  world.backend = 'cpu-reference';
  if (args.flags.has('global-resolution'))
    world.globalResolution = integer(
      value(args, 'global-resolution'),
      'Global resolution',
      64,
      1024,
    );
  let region: WorldExportOptions['region'];
  if (args.flags.has('region')) {
    const coordinates = value(args, 'region')!.split(',').map(Number);
    if (
      coordinates.length !== 4 ||
      !coordinates.every(Number.isFinite) ||
      value(args, 'region')!
        .split(',')
        .some((part) => part.trim() === '')
    )
      throw new UsageError('--region requires four finite interval coordinates: X,Z,WIDTH,HEIGHT.');
    const [startX, startZ, cellsX, cellsZ] = coordinates;
    region = { startX, startZ, cellsX, cellsZ };
  }
  return {
    project,
    world,
    samplesX,
    samplesZ,
    profile: profile as WorldExportOptions['profile'],
    format: format as WorldExportOptions['format'],
    maps: maps as WorldExportMap[] | undefined,
    masks,
    tileIntervals: args.flags.has('tile-intervals')
      ? integer(value(args, 'tile-intervals'), 'Tile intervals', 16, 512)
      : undefined,
    memoryBudgetBytes: integer(value(args, 'memory-mib'), 'Memory budget', 64, 2048, 512) * MiB,
    region,
    sink: 'file',
  };
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function build(args: Arguments, project: TerrainProject, context: CLIContext) {
  const out = value(args, 'out');
  if (!out) throw new UsageError('build requires --out PATH.zip.');
  const destination = resolve(out);
  const force = args.flags.has('force');
  const present = await exists(destination);
  if (
    destination === args.input ||
    (present && (await realpath(destination)) === (await realpath(args.input)))
  )
    throw new Error('Build output must not replace the source project.');
  if (present && !force)
    throw new Error('Output already exists. Choose another filename or explicitly pass --force.');
  if (present && !(await stat(destination)).isFile())
    throw new Error('Output path must be a regular file.');
  const options = buildOptions(args, project);
  const analyzed = analyze({ ...project, version: 2, world: options.world });
  if (!analyzed.buildable) throw new Error(analyzed.errors.join(' '));
  const estimate = checkWorldExportBudget(options);
  context.signal?.throwIfAborted();
  await mkdir(dirname(destination), { recursive: true });
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.partial`,
  );
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let lastProgress = -1;
  try {
    file = await open(temporary, 'wx', 0o600);
    const manifest = await streamWorldExport(
      options,
      async (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          context.signal?.throwIfAborted();
          const { bytesWritten } = await file!.write(chunk, offset, chunk.byteLength - offset);
          if (!bytesWritten) throw new Error('Output write made no progress.');
          offset += bytesWritten;
        }
      },
      (fraction, stage) => {
        const percent = Math.floor(fraction * 100);
        if (percent !== lastProgress) {
          lastProgress = percent;
          if (!args.json) context.stderr?.(`${percent}% ${stage}\n`);
        }
      },
      context.signal,
    );
    await file.sync();
    await file.close();
    file = undefined;
    const verification = await verifyWorldArchive(temporary, { signal: context.signal });
    context.signal?.throwIfAborted();
    // A same-directory hard link is an atomic, no-clobber publication. Rename
    // replaces an existing file only when the user explicitly requested it.
    if (force) await rename(temporary, destination);
    else {
      await link(temporary, destination);
      await unlink(temporary);
    }
    published = true;
    return { output: destination, estimate, verification, manifest };
  } finally {
    await file?.close();
    if (!published)
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
}

export async function runCLI(argv: string[], context: CLIContext = {}): Promise<number> {
  const started = performance.now();
  const stdout = context.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr = context.stderr ?? ((message: string) => process.stderr.write(message));
  const machine = argv.includes('--json');
  try {
    const args = parseArguments(argv);
    if (!args) {
      stdout(HELP);
      return 0;
    }
    context.signal?.throwIfAborted();
    let result: unknown;
    if (args.command === 'verify') {
      const budget = integer(value(args, 'max-expanded-mib'), 'Verification budget', 1, 2048, 2048);
      result = await verifyWorldArchive(args.input, {
        maxExpandedBytes: Math.min(2 ** 31 - 1, budget * MiB),
        signal: context.signal,
      });
    } else {
      const project = await readProject(args.input);
      context.signal?.throwIfAborted();
      if (args.command === 'build') result = await build(args, project, { ...context, stderr });
      else {
        result = analyze(project);
        if (args.command === 'validate' && !(result as ReturnType<typeof analyze>).buildable)
          throw new Error((result as ReturnType<typeof analyze>).errors.join(' '));
      }
    }
    const response = {
      schemaVersion: 1,
      ok: true,
      command: args.command,
      build: BUILD_INFO,
      measurements: {
        elapsedMilliseconds: performance.now() - started,
        peakProcessRssBytes: process.resourceUsage().maxRSS * 1024,
        scope:
          'Single process high-water RSS, including source loading and earlier operations; not live-buffer estimates or a process memory cap.',
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      result,
    };
    if (args.json) stdout(JSON.stringify(response) + '\n');
    else stdout(JSON.stringify(response, null, 2) + '\n');
    return 0;
  } catch (error) {
    const cancelled =
      context.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
    const exitCode = cancelled ? 130 : error instanceof UsageError ? 2 : 1;
    const response = {
      schemaVersion: 1,
      ok: false,
      error: {
        code: cancelled ? 'CANCELLED' : error instanceof UsageError ? 'USAGE' : 'FAILED',
        message: cancelled
          ? 'Operation cancelled; incomplete output was removed.'
          : error instanceof Error
            ? error.message
            : String(error),
      },
    };
    if (machine) stdout(JSON.stringify(response) + '\n');
    else stderr(response.error.message + '\n');
    return exitCode;
  }
}
