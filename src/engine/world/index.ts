import type { TerrainNode, TerrainProject } from '../../model/types';
import { validateWorldDefinition, WORLD_REGION_BUDGET } from '../../model/world';
import type { WorldDefinition } from '../../model/world';
import { compileGraph } from '../plan/graph';
import { evaluateGraph } from '../index';
import { clamp, mix, Noise, smoothstep } from '../noise';
import { hydraulicErosion, sampleHeight, thermalErosion } from '../erosion';
import { reconstructionWeight } from '../erosionMask';
import { sculptSpline } from '../spline';
import { createPointwiseBackend } from '../gpu/pointwise';
import type { ComputeCapability, PointwiseBackend, PointwiseOperation } from '../gpu/pointwise';
import { createWorldNoiseSampler } from './noise';
import { quintic } from '../noiseStudio/math';
import { gridIndex, gridSpacing, validateWorldGrid, worldCoordinate } from './grid';
import { simulateWorldTransport } from './hydrology';
import type { WorldMassBudget } from './hydrology';
import type {
  WorldCapability,
  WorldRegionResult,
  WorldRunOptions,
  WorldSampleGrid,
  WorldStageReport,
} from './types';
export * from './types';
export * from './grid';
export * from './hydrology';

type Channels = {
  height: Float32Array;
  flow: Float32Array;
  wear: Float32Array;
  deposition: Float32Array;
};
type Sample = readonly [number, number, number, number];
type Sampler = (x: number, z: number, dx: number, dz: number) => Sample;
const channels = ['height', 'flow', 'wear', 'deposition'] as const;
const F = Math.fround;
const number = (node: TerrainNode, key: string, fallback: number, min = -1e6, max = 1e6) => {
  const value = Number(node.params[key] ?? fallback);
  return clamp(Number.isFinite(value) ? value : fallback, min, max);
};
const text = (node: TerrainNode, key: string, fallback: string) =>
  String(node.params[key] ?? fallback);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('World build cancelled.', 'AbortError');
}
const channelIndex = (channel: string) =>
  Math.max(0, channels.indexOf(channel as (typeof channels)[number]));

export interface WorldPrepareOptions extends WorldRunOptions {
  previewNodeId?: string;
  pointwiseBackend?: PointwiseBackend;
}
export interface PreparedWorldEvaluation {
  readonly stages: WorldStageReport[];
  readonly capability: WorldCapability;
  readonly computeCapability: ComputeCapability;
  readonly transportBudget?: WorldMassBudget;
  sampleRegion(grid: WorldSampleGrid, options?: WorldRunOptions): Promise<WorldRegionResult>;
  dispose(): void;
}

function isGlobal(node: TerrainNode, hasInput: boolean): boolean {
  if (node.bypassed && hasInput) return false;
  return (
    node.kind === 'mountain' ||
    (node.kind === 'noise' && node.params.noiseModel !== 'v3') ||
    node.kind === 'hydraulic' ||
    node.kind === 'thermal' ||
    node.kind === 'spline'
  );
}

/** Classify every reachable stage before starting allocations or global solves. */
export function describeWorldGraph(
  project: TerrainProject,
  world: WorldDefinition,
  previewNodeId?: string,
): { stages: WorldStageReport[]; capability: WorldCapability } {
  const error = validateWorldDefinition(world);
  if (error) throw new Error(error);
  const plan = compileGraph(project, previewNodeId),
    d = world.domain,
    warnings: string[] = [];
  const transportEnabled =
    !!world.transport?.enabled && !(previewNodeId && plan.target.kind !== 'output');
  if (world.transport?.enabled && !transportEnabled)
    warnings.push(
      'Intermediate and mask previews show authored graph fields before optional post-graph World transport.',
    );
  const stages: WorldStageReport[] = plan.stages.map((stage) => {
    const node = plan.byId.get(stage.nodeId)!,
      global = isGlobal(node, stage.inputs.length > 0);
    const simulation =
      node.kind === 'hydraulic' && !['droplet', 'watershed'].includes(String(node.params.method))
        ? Math.min(512, world.globalResolution)
        : world.globalResolution;
    const scope = node.kind === 'warp' ? 'local' : stage.scope;
    let reason = global
      ? `${world.globalResolution} × ${world.globalResolution} whole-domain CPU reference; interpolated to requested samples.`
      : 'Evaluated at canonical world coordinates on the requested sample grid.';
    if (global && ['hydraulic', 'thermal', 'spline'].includes(node.kind))
      reason = `One whole-domain solve; ${simulation} × ${simulation} simulation/reference samples. Its displacement is reconstructed over the native input; no independent tile resets.`;
    if (node.kind === 'mask' && node.params.mode === 'slope')
      reason = 'Physical central differences query the upstream field beyond internal tile edges.';
    if (node.kind === 'warp')
      reason =
        'Bounded world-space displacement queries the same upstream field across tile boundaries.';
    if (node.bypassed && stage.inputs.length)
      reason = 'Bypassed: forwards the primary field without scheduling secondary inputs.';
    return {
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      scope,
      mode: global ? 'reconstructed' : 'native',
      backend: 'cpu-reference',
      algorithmVersion: `world-1/${node.kind}/${node.params.noiseModel ?? 'reference'}`,
      samplesX: global ? simulation : d.cellsX + 1,
      samplesZ: global ? simulation : d.cellsZ + 1,
      spacingX: d.width / (global ? simulation - 1 : d.cellsX),
      spacingZ: d.depth / (global ? simulation - 1 : d.cellsZ),
      simulationResolution: global ? simulation : null,
      reason,
    };
  });
  const legacyGlobal = stages.some((stage) => stage.mode !== 'native');
  if (transportEnabled) {
    stages.push({
      nodeId: 'world-transport',
      label: 'World transport',
      kind: 'world-transport',
      scope: 'iterative',
      mode: 'reconstructed',
      backend: 'cpu-reference',
      algorithmVersion: 'world-transport-1/f64-conservative',
      samplesX: world.globalResolution,
      samplesZ: world.globalResolution,
      spacingX: d.width / (world.globalResolution - 1),
      spacingZ: d.depth / (world.globalResolution - 1),
      simulationResolution: world.globalResolution,
      reason:
        'Experimental whole-domain finite-volume water/sediment and thermal transport. Every shared face is reconciled once; coarse displacement is reconstructed over native graph detail.',
    });
    warnings.push(
      'World transport is an experimental artistic CPU reference, not a calibrated geophysical simulation. Its mass budget is measured before fine-grid reconstruction.',
    );
  }
  const requiresGlobal = legacyGlobal || transportEnabled;
  let reason: string | undefined;
  if (legacyGlobal && d.width !== d.depth)
    reason =
      'This graph contains square-domain legacy/global stages. Use equal width and depth, or a Noise Studio graph with native World stages for a rectangular world.';
  if (requiresGlobal && d.boundary === 'periodic')
    reason =
      'Global transport/legacy solvers do not implement periodic boundary conditions. Use an open or closed domain, or disable global stages.';
  const unsupported = stages.find((stage) =>
    stage.kind === 'heightImport' || stage.kind === 'coast' || stage.kind === 'maskOutput',
  );
  if (unsupported)
    reason = `“${unsupported.label}” is available in the single-domain Terrain workspace. World tiles do not yet implement imported rasters, coastal shelf shaping or named-mask output nodes.`;
  if (requiresGlobal)
    warnings.push(
      'Global stages retain their bounded reference/simulation spacing. More output samples do not imply finer erosion.',
    );
  if (legacyGlobal) {
    warnings.push(
      'Legacy global solvers retain their authored outer-boundary rules; the World boundary setting does not rewrite their numerical model.',
    );
  }
  if (
    stages.some(
      (stage) => stage.kind === 'mountain' || (stage.kind === 'noise' && stage.mode !== 'native'),
    )
  )
    warnings.push(
      'Legacy sources are anchored to the whole authored domain; the origin georeferences those fields. Studio v3 sources are anchored to absolute world coordinates.',
    );
  if (plan.stages.some((stage) => stage.inputs.some((input) => input.channel !== 'height')))
    warnings.push(
      'Diagnostic routes use one whole-domain normalization at the global reference resolution.',
    );
  if (d.cellsX > 8192 || d.cellsZ > 8192)
    warnings.push(
      'Dimensions above 8192 intervals describe a logical tiled domain; no monolithic allocation or native large-grid erosion is implied.',
    );
  return {
    stages,
    capability: {
      supported: !reason,
      native: !requiresGlobal && !unsupported,
      fullGraph: !unsupported,
      requiresGlobal,
      warnings,
      reason,
    },
  };
}

function operation(node: TerrainNode): PointwiseOperation | null {
  if (node.kind === 'remap')
    return {
      kind: 'remap',
      contrast: number(node, 'contrast', 1.05, 0.05, 5),
      brightness: number(node, 'brightness', 0, -1, 1),
      gamma: number(node, 'gamma', 1, 0.1, 5),
      clamp: node.params.clamp !== false,
    };
  if (node.kind === 'terrace')
    return {
      kind: 'terrace',
      steps: Math.round(number(node, 'steps', 12, 2, 80)),
      softness: number(node, 'softness', 0.3, 0.001, 1),
    };
  if (node.kind === 'blend') {
    const mode = text(node, 'mode', 'mix');
    return {
      kind: 'blend',
      mode: ['add', 'multiply', 'min', 'max'].includes(mode)
        ? (mode as 'add' | 'multiply' | 'min' | 'max')
        : 'mix',
      amount: number(node, 'amount', 0.35, 0, 1),
    };
  }
  if (node.kind === 'mask' && node.params.mode !== 'slope') {
    const low = number(node, 'low', 0.25, 0, 1);
    return {
      kind: 'mask',
      low,
      high: Math.max(low, number(node, 'high', 0.7, 0, 1)),
      softness: number(node, 'softness', 0.15, 0.001, 1),
      invert: node.params.invert === true,
    };
  }
  return null;
}
function scalar(op: PointwiseOperation, a: number, b = 0, mask = 1): number {
  if (op.kind === 'remap') {
    const adjusted = (a - 0.5) * op.contrast + 0.5 + op.brightness;
    const value = Math.sign(adjusted) * Math.pow(Math.abs(adjusted), 1 / op.gamma);
    return F(op.clamp ? clamp(value) : value);
  }
  if (op.kind === 'terrace') {
    const level = a * op.steps,
      floor = Math.floor(level);
    return F(
      (floor + smoothstep(0.5 - op.softness / 2, 0.5 + op.softness / 2, level - floor)) / op.steps,
    );
  }
  if (op.kind === 'mask') {
    const selected =
      smoothstep(op.low - op.softness, op.low + op.softness, a) *
      (1 - smoothstep(op.high - op.softness, op.high + op.softness, a));
    return F(op.invert ? 1 - selected : selected);
  }
  const amount = op.amount * clamp(mask);
  return F(
    op.mode === 'add'
      ? a + b * amount
      : mix(
          a,
          op.mode === 'multiply'
            ? a * b
            : op.mode === 'min'
              ? Math.min(a, b)
              : op.mode === 'max'
                ? Math.max(a, b)
                : b,
          amount,
        ),
  );
}

/**
 * Prepare global context once, then evaluate bounded strips or tiles. Each
 * returned field is independently owned; cancellation publishes no partial field.
 */
export async function prepareWorldEvaluation(
  project: TerrainProject,
  world: WorldDefinition,
  options: WorldPrepareOptions = {},
): Promise<PreparedWorldEvaluation> {
  cancelled(options.signal);
  const initialError = validateWorldDefinition(world);
  if (initialError) throw new Error(initialError);
  // Prepared evaluators own their authored snapshot, including nested settings.
  // External edits cannot change a sampler halfway through a tiled export.
  project = structuredClone(project);
  world = structuredClone(world);
  const excludedTransport =
    !!world.transport?.enabled &&
    !!options.previewNodeId &&
    project.graph.nodes.find((node) => node.id === options.previewNodeId)?.kind !== 'output';
  if (excludedTransport && world.transport)
    world = { ...world, transport: { ...world.transport, enabled: false } };
  const description = describeWorldGraph(project, world, options.previewNodeId);
  if (excludedTransport)
    description.capability.warnings.push(
      'Intermediate and mask previews show authored graph fields before optional post-graph World transport.',
    );
  if (!description.capability.supported) throw new Error(description.capability.reason);
  const plan = compileGraph(project, options.previewNodeId),
    d = world.domain,
    n = world.globalResolution;
  const sampleCosts = new Map<string, number>();
  for (const stage of plan.stages) {
    const node = plan.byId.get(stage.nodeId)!;
    let cost =
      1 + stage.inputs.reduce((sum, input) => sum + (sampleCosts.get(input.nodeId) ?? 1), 0);
    if (node.kind === 'mask' && node.params.mode === 'slope' && !node.bypassed) cost *= 5;
    if (cost > 4096)
      throw new Error(
        'This graph requires too many nested spatial samples. Reduce repeated slope-mask branches or simplify the graph before building a World region.',
      );
    sampleCosts.set(node.id, cost);
  }
  const globalCount = description.stages.filter((stage) => stage.mode !== 'native').length;
  const globalBytes = globalCount * n * n * 6 * 4;
  let globalScratchBytes = world.transport?.enabled ? n * n * 224 : 0;
  for (const stage of plan.stages) {
    const node = plan.byId.get(stage.nodeId)!;
    if (!isGlobal(node, stage.inputs.length > 0)) continue;
    let scratch = n * n * 24;
    if (node.kind === 'hydraulic') {
      const solver = ['landscape', 'fluid', 'hybrid'].includes(
        String(node.params.method ?? 'landscape'),
      )
        ? Math.min(n, 512)
        : n;
      scratch = n * n * 64 + solver * solver * 224;
    } else if (node.kind === 'thermal') scratch = n * n * 40;
    else if (node.kind === 'spline') scratch = n * n * 56;
    else if (
      node.kind === 'mountain' &&
      ['fluvial', 'orogenic'].includes(String(node.params.profile))
    )
      scratch = n * n * 160;
    globalScratchBytes = Math.max(globalScratchBytes, scratch);
  }
  if (globalBytes + globalScratchBytes > WORLD_REGION_BUDGET)
    throw new Error(
      'The whole-domain reference/transport working fields exceed 128 MiB. Reduce the global reference resolution or the number of global stages.',
    );
  const backend = options.pointwiseBackend ?? (await createPointwiseBackend(world.backend));
  const ownsBackend = !options.pointwiseBackend;
  let disposed = false,
    sampling = false;
  const samplers = new Map<string, Sampler>(),
    normalizers = new Map<string, number>();
  const retained: Float32Array[] = [];
  let transportBudget: WorldMassBudget | undefined, transportSampler: Sampler | undefined;
  const stageById = new Map(description.stages.map((stage) => [stage.nodeId, stage]));
  const check = (signal?: AbortSignal) => {
    if (disposed) throw new Error('This World evaluation has been disposed.');
    cancelled(options.signal);
    cancelled(signal);
  };
  const bounded = (x: number, z: number) =>
    d.boundary === 'periodic'
      ? {
          x: d.originX + ((((x - d.originX) % d.width) + d.width) % d.width),
          z: d.originZ + ((((z - d.originZ) % d.depth) + d.depth) % d.depth),
        }
      : {
          x: clamp(x, d.originX, d.originX + d.width),
          z: clamp(z, d.originZ, d.originZ + d.depth),
        };
  const coarseGrid: WorldSampleGrid = {
    startX: 0,
    startZ: 0,
    cellsX: d.cellsX,
    cellsZ: d.cellsZ,
    samplesX: n,
    samplesZ: n,
  };

  async function renderSampler(
    sampler: Sampler,
    grid: WorldSampleGrid,
    signal?: AbortSignal,
    progress?: (fraction: number) => void,
  ): Promise<Channels> {
    const count = grid.samplesX * grid.samplesZ;
    const field: Channels = {
      height: new Float32Array(count),
      flow: new Float32Array(count),
      wear: new Float32Array(count),
      deposition: new Float32Array(count),
    };
    const dx = gridSpacing(d, grid, 'X'),
      dz = gridSpacing(d, grid, 'Z');
    for (let row = 0; row < grid.samplesZ; row++) {
      const j = gridIndex(d, grid, 'Z', row);
      for (let column = 0; column < grid.samplesX; column++) {
        const i = gridIndex(d, grid, 'X', column),
          p = worldCoordinate(d, i, j);
        const values = sampler(p.x, p.z, dx, dz),
          at = row * grid.samplesX + column;
        for (let c = 0; c < 4; c++) {
          if (!Number.isFinite(values[c]))
            throw new Error('A World stage produced a non-finite value. Reduce its strength.');
          field[channels[c]][at] = values[c];
        }
      }
      if ((row & 7) === 7 || row === grid.samplesZ - 1) {
        check(signal);
        progress?.((row + 1) / grid.samplesZ);
        await tick();
      }
    }
    check(signal);
    return field;
  }
  const interpolate = (values: Float32Array, x: number, z: number) =>
    sampleHeight(
      values,
      n,
      ((x - d.originX) / d.width) * (n - 1),
      ((z - d.originZ) / d.depth) * (n - 1),
    );
  const keep = (field: Channels) => {
    for (const key of channels) retained.push(field[key]);
  };
  const normalize = async (id: string, channel: string): Promise<number> => {
    const key = `${id}:${channel}`;
    if (normalizers.has(key)) return normalizers.get(key)!;
    const sampler = samplers.get(id)!,
      c = channelIndex(channel);
    let max = 0;
    for (let j = 0; j < n; j++) {
      const z = d.originZ + (j * d.depth) / (n - 1);
      for (let i = 0; i < n; i++)
        max = Math.max(
          max,
          sampler(d.originX + (i * d.width) / (n - 1), z, d.width / (n - 1), d.depth / (n - 1))[c],
        );
      if ((j & 7) === 7) {
        check();
        await tick();
      }
    }
    normalizers.set(key, max);
    return max;
  };
  try {
    for (let stageIndex = 0; stageIndex < plan.stages.length; stageIndex++) {
      check();
      const stage = plan.stages[stageIndex],
        node = plan.byId.get(stage.nodeId)!;
      const inputs = new Map<string, Sampler>();
      for (const input of stage.inputs) {
        const original = samplers.get(input.nodeId)!;
        if (input.channel === 'height') inputs.set(input.port, original);
        else {
          const maximum = await normalize(input.nodeId, input.channel),
            c = channelIndex(input.channel);
          inputs.set(input.port, (x, z, dx, dz) => {
            const values = original(x, z, dx, dz);
            const value =
              maximum > 0
                ? clamp(
                    input.channel === 'flow'
                      ? Math.log1p(Math.max(0, values[c])) / Math.log1p(maximum)
                      : values[c] / maximum,
                  )
                : values[c];
            return [F(value), values[1], values[2], values[3]];
          });
        }
      }
      const primary = inputs.get('in') ?? inputs.get('a');
      if (node.bypassed && primary) samplers.set(node.id, primary);
      else if (node.kind === 'noise' && node.params.noiseModel === 'v3') {
        const noise = createWorldNoiseSampler(node.params, project.seed, d);
        samplers.set(node.id, (x, z, dx, dz) => [F(noise(x, z, dx, dz)), 0, 0, 0]);
      } else if (node.kind === 'mountain' || node.kind === 'noise') {
        options.onProgress?.(stageIndex / plan.stages.length, `Global source · ${node.label}`);
        const field = evaluateGraph(
          { ...project, worldSize: d.width, heightScale: d.heightScale },
          {
            resolution: n,
            previewNodeId: node.id,
            onProgress: (progress) => {
              check();
              options.onProgress?.(
                (stageIndex + progress) / plan.stages.length,
                `Global source · ${node.label}`,
              );
            },
          },
        ).field;
        keep(field);
        samplers.set(node.id, (x, z) => [
          F(interpolate(field.height, x, z)),
          F(interpolate(field.flow, x, z)),
          F(interpolate(field.wear, x, z)),
          F(interpolate(field.deposition, x, z)),
        ]);
      } else {
        if (!primary) throw new Error(`Connect a height input to “${node.label}”.`);
        if (isGlobal(node, true)) {
          options.onProgress?.(stageIndex / plan.stages.length, `Global context · ${node.label}`);
          const input = await renderSampler(primary, coarseGrid);
          const maskSampler = inputs.get('mask'),
            mask = maskSampler ? (await renderSampler(maskSampler, coarseGrid)).height : undefined;
          const progress = (fraction: number) => {
            check();
            options.onProgress?.(
              (stageIndex + fraction) / plan.stages.length,
              `Global solve · ${node.label}`,
            );
          };
          let formed: Channels;
          if (node.kind === 'hydraulic') {
            const seed =
              ((Number(project.seed) || 0) +
                Math.round(number(node, 'seed', 0, -2147483647, 2147483647))) >>>
              0;
            const result = hydraulicErosion(
              input.height,
              n,
              {
                droplets: number(node, 'droplets', 70000, 0, 500000),
                lifetime: number(node, 'lifetime', 64, 8, 200),
                inertia: number(node, 'inertia', 0.18, 0, 0.95),
                capacity: number(node, 'capacity', 4, 0.1, 20),
                erosion: number(node, 'erosion', 0.28, 0, 1),
                deposition: number(node, 'deposition', 0.28, 0, 1),
                evaporation: number(node, 'evaporation', 0.018, 0.001, 0.5),
                radius: number(node, 'radius', 3, 1, 8),
                gravity: number(node, 'gravity', 4, 0.01, 20),
                seed,
                multiscale: node.params.multiscale !== false,
                method: ['hybrid', 'fluid', 'droplet', 'watershed'].includes(
                  text(node, 'method', 'landscape'),
                )
                  ? (text(node, 'method', 'landscape') as
                      'hybrid' | 'fluid' | 'droplet' | 'watershed')
                  : 'landscape',
                cycles: number(node, 'cycles', 28, 4, 72),
                featureMeters: number(node, 'featureMeters', 140, 24, 600),
                hillslope: number(node, 'hillslope', 0.38, 0, 1),
                bankAngle: number(node, 'bankAngle', 38, 18, 80),
                bedrockPreserve: node.params.bedrockPreserve === true,
                soilDepthMeters: number(node, 'soilDepthMeters', 1.5, 0, 30),
                bedrockResistance: number(node, 'bedrockResistance', 0.6, 0, 1),
                worldSize: d.width,
                heightScale: d.heightScale,
              },
              mask,
              progress,
            );
            formed = result;
            for (let i = 0; i < n * n; i++) {
              formed.flow[i] += input.flow[i];
              formed.wear[i] += input.wear[i];
              formed.deposition[i] += input.deposition[i];
            }
          } else if (node.kind === 'thermal')
            formed = {
              ...input,
              height: thermalErosion(
                input.height,
                n,
                number(node, 'iterations', 20, 0, 150),
                number(node, 'talus', 0.008, 0, 0.2),
                number(node, 'strength', 0.5, 0, 1),
                progress,
              ),
            };
          else
            formed = {
              ...input,
              height: sculptSpline(input.height, n, node.path, {
                mode: text(node, 'mode', 'river') === 'ridge' ? 'ridge' : 'river',
                width: number(node, 'width', 0.016, 0.002, 0.12),
                strength: number(node, 'strength', 0.09, 0, 0.55),
                falloff: number(node, 'falloff', 3, 1.5, 6),
                downhill: node.params.downhill !== false,
                worldSize: d.width,
                heightScale: d.heightScale,
              }),
            };
          const delta = new Float32Array(n * n),
            flowDelta = new Float32Array(n * n),
            wearDelta = new Float32Array(n * n),
            depositionDelta = new Float32Array(n * n);
          for (let i = 0; i < delta.length; i++) {
            delta[i] = formed.height[i] - input.height[i];
            flowDelta[i] = formed.flow[i] - input.flow[i];
            wearDelta[i] = formed.wear[i] - input.wear[i];
            depositionDelta[i] = formed.deposition[i] - input.deposition[i];
          }
          retained.push(delta, flowDelta, wearDelta, depositionDelta);
          if (mask) retained.push(mask);
          samplers.set(node.id, (x, z, dx, dz) => {
            const a = primary(x, z, dx, dz);
            const weight =
              mask && maskSampler
                ? reconstructionWeight(maskSampler(x, z, dx, dz)[0], interpolate(mask, x, z))
                : 1;
            return [
              F(a[0] + interpolate(delta, x, z) * weight),
              F(a[1] + interpolate(flowDelta, x, z)),
              F(a[2] + interpolate(wearDelta, x, z) * weight),
              F(a[3] + interpolate(depositionDelta, x, z) * weight),
            ];
          });
        } else if (node.kind === 'output') samplers.set(node.id, primary);
        else if (node.kind === 'warp') {
          const noise = new Noise(
            ((Number(project.seed) || 0) +
              Math.round(number(node, 'seed', 0, -2147483647, 2147483647))) >>>
              0,
          );
          const strength = number(node, 'strength', 0.35, 0, 2),
            scale = number(node, 'scale', 3, 0.1, 30),
            octaves = Math.round(number(node, 'octaves', 3, 1, 6));
          const displacement = (x: number, z: number, ox: number, oz: number): number => {
            const sample = (px: number, pz: number) =>
              noise.fractal((px / d.width) * scale + ox, (pz / d.depth) * scale + oz, octaves);
            if (d.boundary !== 'periodic') return sample(x, z);
            const p = bounded(x, z),
              u = (p.x - d.originX) / d.width,
              v = (p.z - d.originZ) / d.depth;
            return mix(
              mix(sample(p.x, p.z), sample(p.x - d.width, p.z), quintic(u)),
              mix(sample(p.x, p.z - d.depth), sample(p.x - d.width, p.z - d.depth), quintic(u)),
              quintic(v),
            );
          };
          samplers.set(node.id, (x, z, dx, dz) => {
            const p = bounded(
              x + displacement(x, z, 12.7, 1.9) * strength * d.width * 0.16,
              z + displacement(x, z, 2.3, 41.9) * strength * d.depth * 0.16,
            );
            return primary(p.x, p.z, dx, dz);
          });
        } else if (node.kind === 'mask' && node.params.mode === 'slope') {
          const low = number(node, 'low', 0.25, 0, 1),
            high = Math.max(low, number(node, 'high', 0.7, 0, 1)),
            softness = number(node, 'softness', 0.15, 0.001, 1);
          samplers.set(node.id, (x, z, dx, dz) => {
            const left = bounded(x - dx, z),
              right = bounded(x + dx, z),
              north = bounded(x, z - dz),
              south = bounded(x, z + dz);
            const gx =
              ((primary(right.x, right.z, dx, dz)[0] - primary(left.x, left.z, dx, dz)[0]) *
                d.heightScale) /
              (2 * dx);
            const gz =
              ((primary(south.x, south.z, dx, dz)[0] - primary(north.x, north.z, dx, dz)[0]) *
                d.heightScale) /
              (2 * dz);
            const slope = Math.atan(Math.hypot(gx, gz)) / (Math.PI / 2),
              a = primary(x, z, dx, dz);
            const selected =
              smoothstep(low - softness, low + softness, slope) *
              (1 - smoothstep(high - softness, high + softness, slope));
            return [F(node.params.invert === true ? 1 - selected : selected), a[1], a[2], a[3]];
          });
        } else {
          const op = operation(node);
          if (!op) throw new Error(`“${node.label}” does not have a World evaluator.`);
          const second = inputs.get('b'),
            mask = inputs.get('mask');
          if (op.kind === 'blend' && !second)
            throw new Error(`Connect both A and B inputs to “${node.label}”.`);
          samplers.set(node.id, (x, z, dx, dz) => {
            const a = primary(x, z, dx, dz),
              b = second?.(x, z, dx, dz),
              weight = mask ? mask(x, z, dx, dz)[0] : 1;
            const height = scalar(op, a[0], b?.[0], weight);
            if (op.kind !== 'blend' || !b) return [height, a[1], a[2], a[3]];
            const wb =
              (op.mode === 'max' && b[0] <= a[0]) || (op.mode === 'min' && b[0] >= a[0])
                ? 0
                : op.amount * clamp(weight);
            const wa = op.mode === 'add' ? 1 : 1 - wb;
            return [
              height,
              F(a[1] * wa + b[1] * wb),
              F(a[2] * wa + b[2] * wb),
              F(a[3] * wa + b[3] * wb),
            ];
          });
        }
      }
      options.onProgress?.((stageIndex + 1) / plan.stages.length, `Prepared · ${node.label}`);
      await tick();
    }
    if (world.transport?.enabled) {
      check();
      options.onProgress?.(0, 'World transport · preparing global field');
      const sourceSampler = samplers.get(plan.target.id)!;
      const source = await renderSampler(sourceSampler, coarseGrid);
      const metres = Float64Array.from(source.height, (value) => d.datum + value * d.heightScale);
      const transport = await simulateWorldTransport(
        metres,
        {
          width: n,
          height: n,
          widthMeters: d.width,
          depthMeters: d.depth,
          boundary: d.boundary as 'open' | 'closed',
        },
        world.transport,
        {
          signal: options.signal,
          tileCells: world.tileCells,
          onProgress: (fraction) => {
            check();
            options.onProgress?.(fraction, 'World transport · exchanging water and sediment');
          },
        },
      );
      transportBudget = transport.budget;
      const delta = new Float32Array(n * n),
        flow = new Float32Array(n * n),
        wear = new Float32Array(n * n),
        deposition = new Float32Array(n * n);
      for (let i = 0; i < delta.length; i++) {
        delta[i] = (transport.height[i] - metres[i]) / d.heightScale;
        flow[i] = transport.flow[i];
        wear[i] = source.wear[i] + transport.wear[i] / d.heightScale;
        deposition[i] = source.deposition[i] + transport.deposition[i] / d.heightScale;
      }
      retained.push(delta, flow, wear, deposition);
      transportSampler = (x, z, dx, dz) => [
        F(sourceSampler(x, z, dx, dz)[0] + interpolate(delta, x, z)),
        F(interpolate(flow, x, z)),
        F(interpolate(wear, x, z)),
        F(interpolate(deposition, x, z)),
      ];
      samplers.set(plan.target.id, transportSampler);
    }
    const hasFlow =
      !!world.transport?.enabled ||
      plan.stages.some((stage) => {
        const node = plan.byId.get(stage.nodeId)!;
        return node.kind === 'hydraulic' && !node.bypassed;
      });
    const outputFlowMax = hasFlow ? await normalize(plan.target.id, 'flow') : 0;
    const retainedBytes = [...new Set(retained.map((array) => array.buffer))].reduce(
      (sum, buffer) => sum + buffer.byteLength,
      0,
    );
    const gpuEligible = new Set(
      plan.stages
        .filter((stage) => {
          if (world.transport?.enabled) return false;
          const node = plan.byId.get(stage.nodeId)!;
          // GPU results cannot feed a CPU spatial resampler or a precomputed global
          // stage: their boundaries must use one numerical implementation throughout.
          const descendants: string[] = [node.id],
            seen = new Set<string>();
          while (descendants.length) {
            const id = descendants.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            const child = plan.byId.get(id)!;
            if (
              id !== node.id &&
              (isGlobal(child, true) ||
                child.kind === 'warp' ||
                (child.kind === 'mask' && child.params.mode === 'slope'))
            )
              return false;
            for (const consumer of plan.stages)
              if (
                consumer.inputs.some((input) => input.nodeId === id && input.channel !== 'height')
              )
                return false;
            descendants.push(...(plan.consumers.get(id) ?? []));
          }
          return (
            !node.bypassed &&
            operation(node) !== null &&
            stage.inputs.every((input) => input.channel === 'height')
          );
        })
        .map((stage) => stage.nodeId),
    );
    for (const id of gpuEligible)
      if (backend.capability.backend === 'webgpu') stageById.get(id)!.backend = 'webgpu';

    // The final preparation/render yield can deliver cancellation too.
    check();
    return {
      stages: description.stages,
      capability: {
        ...description.capability,
        warnings: [
          ...description.capability.warnings,
          ...(world.backend !== 'cpu-reference' && backend.capability.backend !== 'webgpu'
            ? [backend.capability.reason]
            : []),
        ],
      },
      computeCapability: backend.capability,
      transportBudget,
      async sampleRegion(grid, run = {}) {
        check(run.signal);
        if (sampling)
          throw new Error('A prepared World evaluation processes one bounded region at a time.');
        validateWorldGrid(d, grid);
        const count = grid.samplesX * grid.samplesZ;
        // Includes retained global fields, region channels, a second render pass,
        // typed-array snapshots and GPU upload/readback staging when selected.
        const peakBytes = Math.max(
          globalBytes + globalScratchBytes,
          retainedBytes + count * 4 * (8 + 4 * plan.stages.length),
        );
        if (peakBytes > WORLD_REGION_BUDGET)
          throw new Error(
            `This region needs an estimated ${Math.ceil(peakBytes / 1048576)} MiB, above the 128 MiB World region budget. Request smaller tiles or strips.`,
          );
        sampling = true;
        const started = performance.now(),
          fields = new Map<string, Channels>();
        const dx = gridSpacing(d, grid, 'X'),
          dz = gridSpacing(d, grid, 'Z');
        const localStages = description.stages.map((stage) =>
          stage.mode === 'native'
            ? {
                ...stage,
                samplesX: grid.samplesX,
                samplesZ: grid.samplesZ,
                spacingX: dx,
                spacingZ: dz,
              }
            : { ...stage },
        );
        try {
          for (let index = 0; !transportSampler && index < plan.stages.length; index++) {
            check(run.signal);
            const stage = plan.stages[index],
              node = plan.byId.get(stage.nodeId)!;
            let field: Channels;
            const inputs = new Map(
              stage.inputs
                .filter((input) => input.channel === 'height')
                .map((input) => [input.port, fields.get(input.nodeId)!]),
            );
            const primary = inputs.get('in') ?? inputs.get('a'),
              second = inputs.get('b'),
              mask = inputs.get('mask');
            const op = operation(node);
            if ((node.bypassed || node.kind === 'output') && primary) field = primary;
            else if (primary && op && stage.inputs.every((input) => input.channel === 'height')) {
              const height =
                backend.capability.backend === 'webgpu' && gpuEligible.has(node.id)
                  ? (await backend.apply(op, primary.height, second?.height, mask?.height)).values
                  : new Float32Array(count);
              const gpu = backend.capability.backend === 'webgpu' && gpuEligible.has(node.id);
              field = { ...primary, height };
              if (op.kind === 'blend') {
                if (!second) throw new Error('Blend needs two connected inputs.');
                field.flow = new Float32Array(count);
                field.wear = new Float32Array(count);
                field.deposition = new Float32Array(count);
              }
              for (let i = 0; i < count; i++) {
                if (!gpu)
                  height[i] = scalar(
                    op,
                    primary.height[i],
                    second?.height[i],
                    mask?.height[i] ?? 1,
                  );
                if (op.kind === 'blend' && second) {
                  const wb =
                      (op.mode === 'max' && second.height[i] <= primary.height[i]) ||
                      (op.mode === 'min' && second.height[i] >= primary.height[i])
                        ? 0
                        : op.amount * clamp(mask?.height[i] ?? 1),
                    wa = op.mode === 'add' ? 1 : 1 - wb;
                  for (const channel of ['flow', 'wear', 'deposition'] as const)
                    field[channel][i] = primary[channel][i] * wa + second[channel][i] * wb;
                }
                if ((i & 32767) === 32767) {
                  check(run.signal);
                  await tick();
                }
              }
            } else
              field = await renderSampler(samplers.get(node.id)!, grid, run.signal, (fraction) =>
                run.onProgress?.((index + fraction) / plan.stages.length, node.label),
              );
            fields.set(node.id, field);
            run.onProgress?.((index + 1) / plan.stages.length, node.label);
          }
          check(run.signal);
          const output = transportSampler
            ? await renderSampler(transportSampler, grid, run.signal, (fraction) =>
                run.onProgress?.(fraction, 'World transport · reconstructing region'),
              )
            : fields.get(plan.target.id)!;
          let min = Infinity,
            max = -Infinity;
          for (const value of output.height) {
            if (!Number.isFinite(value))
              throw new Error('World output contains non-finite elevations.');
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
          const flow = output.flow.map((value) =>
            outputFlowMax > 0
              ? clamp(Math.log1p(Math.max(0, value)) / Math.log1p(outputFlowMax))
              : value,
          );
          return {
            width: grid.samplesX,
            height: grid.samplesZ,
            heights: output.height,
            flow,
            wear: output.wear,
            deposition: output.deposition,
            min,
            max,
            stages: localStages,
            spacingX: dx,
            spacingZ: dz,
            duration: performance.now() - started,
            backend: localStages.some((stage) => stage.backend === 'webgpu')
              ? 'webgpu'
              : 'cpu-reference',
            estimatedPeakBytes: peakBytes,
            ...(transportBudget ? { transportBudget: { ...transportBudget } } : {}),
          };
        } finally {
          sampling = false;
          fields.clear();
        }
      },
      dispose() {
        disposed = true;
        samplers.clear();
        retained.length = 0;
        normalizers.clear();
        if (ownsBackend) backend.dispose();
      },
    };
  } catch (error) {
    samplers.clear();
    retained.length = 0;
    if (ownsBackend) backend.dispose();
    throw error;
  }
}

export async function generateWorldRegion(
  project: TerrainProject,
  world: WorldDefinition,
  grid: WorldSampleGrid,
  options: WorldPrepareOptions = {},
): Promise<WorldRegionResult> {
  const prepared = await prepareWorldEvaluation(project, world, options);
  try {
    return await prepared.sampleRegion(grid, options);
  } finally {
    prepared.dispose();
  }
}
