import type {
  EvaluationOptions,
  EvaluationResult,
  HeightField,
  TerrainEdge,
  TerrainGraph,
  TerrainNode,
  TerrainProject,
} from '../model/types';
import { clamp, mix, Noise, smoothstep } from './noise';
import { hydraulicErosion, sampleHeight, thermalErosion } from './erosion';
import { generateOrogenicRelief } from './orogeny';
import { sculptSpline } from './spline';
import { validSplinePoint, MAX_SPLINE_POINTS } from '../model/splines';

export { hydraulicErosion, thermalErosion } from './erosion';
export { Noise, randomGenerator } from './noise';

interface WorkingField extends HeightField {
  eroded: number;
  deposited: number;
  exportedSediment: number;
}
const kinds = new Set([
  'mountain',
  'noise',
  'warp',
  'spline',
  'hydraulic',
  'thermal',
  'terrace',
  'remap',
  'blend',
  'mask',
  'output',
  'note',
  'group',
]);
const metadata = (node: TerrainNode) => node.kind === 'note' || node.kind === 'group';
const number = (
  node: TerrainNode,
  key: string,
  fallback: number,
  min = -1e6,
  max = 1e6,
): number => {
  const value = Number(node.params[key] ?? fallback);
  return clamp(Number.isFinite(value) ? value : fallback, min, max);
};
const text = (node: TerrainNode, key: string, fallback: string): string =>
  String(node.params[key] ?? fallback);
const inputHandle = (edge: TerrainEdge, node: TerrainNode) =>
  edge.targetHandle || (node.kind === 'blend' ? 'a' : 'in');

/** Structural errors are rejected; unfinished, disconnected nodes may remain on the canvas. */
export function validateGraph(graph: TerrainGraph): string | null {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    return 'This project does not contain a valid terrain graph.';
  if (graph.nodes.length > 256 || graph.edges.length > 768)
    return 'The graph exceeds the 256-node or 768-connection limit.';
  const nodes = new Map<string, TerrainNode>();
  for (const node of graph.nodes) {
    if (!node.id || nodes.has(node.id)) return 'Each node must have a unique identifier.';
    if (!kinds.has(node.kind)) return `Unknown node type: ${String(node.kind)}.`;
    if (!node.params || typeof node.params !== 'object')
      return `“${node.label || node.id}” has invalid parameters.`;
    if (node.kind === 'spline' &&
      (!Array.isArray(node.path) || node.path.length < 2 ||
       node.path.length > MAX_SPLINE_POINTS || !node.path.every(validSplinePoint)))
      return `“${node.label || node.id}” needs at least two valid spline points.`;
    nodes.set(node.id, node);
  }
  const ports = new Set<string>(),
    edgeIds = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!edge.id || edgeIds.has(edge.id)) return 'Each connection must have a unique identifier.';
    edgeIds.add(edge.id);
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target);
    if (!source || !target) return 'A connection refers to a missing node.';
    if (metadata(source) || metadata(target)) return 'Notes and groups cannot carry terrain data.';
    if (source.id === target.id) return 'A node cannot connect to itself.';
    const handle = inputHandle(edge, target);
    const inputs =
      target.kind === 'blend'
        ? ['a', 'b', 'mask']
        : target.kind === 'hydraulic'
          ? ['in', 'mask']
          : ['mountain', 'noise'].includes(target.kind)
            ? []
            : ['in'];
    if (!inputs.includes(handle)) return `“${target.label}” does not have a “${handle}” input.`;
    if (!['height', 'flow', 'wear', 'deposition'].includes(edge.sourceHandle || 'height'))
      return 'A connection uses an unknown output channel.';
    const port = `${target.id}:${handle}`;
    if (ports.has(port))
      return `“${target.label}” already has a connection on its “${handle}” input.`;
    ports.add(port);
    outgoing.set(source.id, [...(outgoing.get(source.id) || []), target.id]);
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    active.add(id);
    for (const next of outgoing.get(id) || []) if (!visit(next)) return false;
    active.delete(id);
    visited.add(id);
    return true;
  };
  for (const node of graph.nodes)
    if (!visit(node.id))
      return 'This connection creates a cycle. Terrain must flow forward through the graph.';
  return null;
}

function normalizeDiagnostic(values: Float32Array, logarithmic = false): Float32Array {
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (max <= 0) return values;
  const output = new Float32Array(values.length);
  const divisor = logarithmic ? Math.log1p(max) : max;
  for (let i = 0; i < values.length; i++)
    output[i] = (logarithmic ? Math.log1p(values[i]) : values[i]) / divisor;
  return output;
}

function thumbnail(values: Float32Array, n: number): Float32Array {
  const small = new Float32Array(48 * 48);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 48; x++)
      small[y * 48 + x] = sampleHeight(values, n, (x / 47) * (n - 1), (y / 47) * (n - 1));
  return small;
}

const WORKING_MEMORY_BUDGET = 512 * 1024 * 1024;

/** Conservative preflight, including cached branches, diagnostic routes and workspace overhead. */
function estimatedWorkingBytes(
  graph: TerrainGraph,
  needed: Set<string>,
  resolution: number,
): number {
  // Reserve the shared zero field, final flow normalization, Float64 thermal
  // scratch and both old/new UI result buffers. A fixed reserve covers the
  // display mesh, encoding bookkeeping and small JS allocations.
  let buffers = 12;
  for (const node of graph.nodes) {
    if (!needed.has(node.id) || metadata(node) || node.kind === 'output') continue;
    // A source has no input to forward; marking it bypassed still generates it.
    if (node.bypassed && node.kind !== 'mountain' && node.kind !== 'noise') continue;
    buffers += ['hydraulic', 'warp', 'blend', 'spline'].includes(node.kind) ? 4 : 1;
  }
  for (const edge of graph.edges)
    if (needed.has(edge.target) && edge.sourceHandle && edge.sourceHandle !== 'height') buffers++;
  return 64 * 1024 * 1024 + buffers * resolution * resolution * Float32Array.BYTES_PER_ELEMENT;
}

function createMountains(
  node: TerrainNode, n: number, noise: Noise, seed: number,
): Float32Array {
  if (text(node, 'profile', 'range') === 'orogenic') {
    // Evolve the *regional uplift source*, rather than stamping a river mask
    // onto a smooth mountain image. The normal mountain model remains
    // separately available for exact legacy comparisons.
    const broadNode: TerrainNode = {
      ...node, params: { ...node.params, profile: 'range' },
    };
    const upliftSource = createMountains(broadNode, n, noise, seed);
    return generateOrogenicRelief(
      upliftSource, n, seed, number(node, 'dissection', 0.82, 0, 1),
    ).height;
  }
  const map = new Float32Array(n * n);
  const scale = number(node, 'scale', 3.2, 0.1, 30),
    octaves = Math.round(number(node, 'octaves', 6, 1, 10));
  const roughness = number(node, 'roughness', 0.42, 0.1, 0.85),
    lacunarity = number(node, 'lacunarity', 2.1, 1.2, 3.5);
  const warp = number(node, 'warp', 0.85, 0, 3),
    sharpness = number(node, 'sharpness', 1.25, 0.4, 4);
  const angle = (number(node, 'direction', -24, -360, 360) * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const width = number(node, 'width', 0.62, 0.12, 1.5),
    relief = number(node, 'relief', 0.78, 0, 2),
    base = number(node, 'base', 0.05, -1, 1);
  const profile = text(node, 'profile', 'range');
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = (x / (n - 1)) * 2 - 1,
        py = (y / (n - 1)) * 2 - 1;
      const u = px * cos - py * sin,
        v = px * sin + py * cos;
      const wu = u + warp * noise.fractal(u * 1.3 + 21.7, v * 1.3, 3) * 0.25;
      const wv = v + warp * noise.fractal(u * 1.3, v * 1.3 + 34.1, 3) * 0.25;
      const ridge = noise.fractal(
        wu * scale + 12.36,
        wv * scale + 8.17,
        octaves,
        roughness * 0.82,
        lacunarity,
        'ridged',
        0.22 / sharpness,
      );
      const detail = noise.fractal(
        wu * scale * 1.7 + 51.1,
        wv * scale * 1.7 - 13,
        octaves,
        roughness,
        lacunarity,
      );
      const bend = 0.16 * Math.sin(wu * 3 + 0.8) + 0.13 * noise.simplex(wu * 1.4 + 7.3, 6.2);
      let shape: number;
      if (profile === 'volcano') {
        const radius = Math.hypot(wu * 0.94, wv * 1.06) / width;
        const cone = Math.exp(-radius * 1.65);
        const crater = Math.exp(-((radius / 0.18) ** 2)) * 0.53;
        shape =
          Math.max(0, cone - crater) * (0.76 + 0.24 * ridge) +
          Math.exp(-radius * 3) * detail * 0.035;
      } else if (profile === 'massif') {
        const radius = Math.hypot(wu * 0.85, wv * 1.15) / width;
        const broadMass =
          0.72 + 0.28 * noise.fractal(wu * scale * 0.42 + 7, wv * scale * 0.42 - 4, 3, 0.42);
        shape =
          Math.exp(-radius * radius * 1.15) *
          broadMass *
          (0.66 + 0.34 * Math.pow(ridge, sharpness * 0.65));
      } else if (profile === 'badlands') {
        const envelope =
          0.45 + 0.4 * smoothstep(-0.5, 0.7, noise.fractal(wu * 0.8 + 3.1, wv * 0.8 + 4.1, 3));
        shape = envelope * (0.18 + 0.82 * Math.pow(ridge, sharpness * 1.2));
      } else {
        // The broad spine carries the elevation. Small ridges contribute
        // relief on its flanks instead of turning every zero crossing of
        // ridged noise into a peak with the full height of the mountain.
        const envelope = Math.exp(-(((wv - bend) / width) ** 2) * 1.85);
        const alongRange =
          0.56 + 0.44 * smoothstep(-0.5, 0.5, noise.fractal(wu * scale * 0.55 + 4, 13.5, 3, 0.42));
        const broadRock =
          0.83 + 0.17 * noise.fractal(wu * scale * 0.65 + 3.8, wv * scale * 0.65 - 8.1, 3, 0.4);
        const ridgeRelief = 0.7 + 0.3 * Math.pow(ridge, sharpness * 0.65);
        const foothills = Math.exp(-(((wv - bend) / (width * 1.7)) ** 2) * 2) * 0.12;
        shape =
          envelope * alongRange * broadRock * ridgeRelief +
          foothills * (0.65 + detail * 0.55) +
          envelope * detail * 0.025;
      }
      const edge = 1 - smoothstep(0.78, 1.38, Math.max(Math.abs(px), Math.abs(py)));
      map[y * n + x] = base + Math.max(0, shape) * relief * edge;
    }
  return map;
}

function createNoise(node: TerrainNode, n: number, noise: Noise): Float32Array {
  const map = new Float32Array(n * n),
    mode = text(node, 'mode', 'fbm');
  const scale = number(node, 'scale', 3.4, 0.05, 60),
    octaves = Math.round(number(node, 'octaves', 6, 1, 10));
  const persistence = number(node, 'persistence', 0.5, 0.05, 0.95),
    lacunarity = number(node, 'lacunarity', 2.05, 1.1, 4);
  const amplitude = number(node, 'amplitude', 0.75, 0, 3),
    offset = number(node, 'offset', 0.1, -2, 2),
    warp = number(node, 'warp', 0.6, 0, 4);
  const rotation = (number(node, 'rotation', 0, -360, 360) * Math.PI) / 180,
    cos = Math.cos(rotation),
    sin = Math.sin(rotation);
  const stretch = number(node, 'stretch', 1, 0.1, 8);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = (x / (n - 1) - 0.5) * scale,
        py = (y / (n - 1) - 0.5) * scale;
      const u = (px * cos - py * sin) / stretch + 17.319,
        v = (px * sin + py * cos) * stretch + 8.173;
      map[y * n + x] =
        offset + amplitude * noise.sample(mode, u, v, octaves, persistence, lacunarity, warp);
    }
  return map;
}

export function evaluateGraph(
  project: TerrainProject,
  options: EvaluationOptions,
): EvaluationResult {
  const started = performance.now();
  const error = validateGraph(project.graph);
  if (error) throw new Error(error);
  if (!Number.isFinite(options.resolution) || options.resolution < 16 || options.resolution > 2048)
    throw new Error('Choose a terrain resolution between 16 and 2048 samples.');
  const n = Math.round(options.resolution),
    length = n * n;
  const byId = new Map(project.graph.nodes.map((node) => [node.id, node]));
  const target = options.previewNodeId
    ? byId.get(options.previewNodeId)
    : project.graph.nodes.find((node) => node.kind === 'output');
  if (!target || metadata(target))
    throw new Error(
      options.previewNodeId
        ? 'Choose a terrain node to preview.'
        : 'Add an Output node and connect a terrain to it.',
    );
  const incoming = new Map<string, TerrainEdge[]>();
  for (const edge of project.graph.edges)
    incoming.set(edge.target, [...(incoming.get(edge.target) || []), edge]);
  const needed = new Set<string>();
  const markNeeded = (id: string) => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const edge of incoming.get(id) || []) markNeeded(edge.source);
  };
  markNeeded(target.id);
  const estimatedBytes = estimatedWorkingBytes(project.graph, needed, n);
  if (estimatedBytes > WORKING_MEMORY_BUDGET) {
    const smaller =
      [1024, 512, 256, 128, 64].find(
        (size) =>
          size < n && estimatedWorkingBytes(project.graph, needed, size) <= WORKING_MEMORY_BUDGET,
      ) || 64;
    throw new Error(
      `This connected graph at ${n} × ${n} exceeds the 512 MiB working-memory budget (estimated ${Math.ceil(estimatedBytes / 1024 / 1024)} MiB). Choose ${smaller} × ${smaller} or reduce the connected stages.`,
    );
  }
  const fields = new Map<string, WorkingField>();
  const thumbnails: Record<string, Float32Array> = {},
    nodeTimings: Record<string, number> = {};
  const empty = new Float32Array(length);
  let completed = 0;
  const baseField = (height: Float32Array): WorkingField => ({
    resolution: n,
    height,
    flow: empty,
    wear: empty,
    deposition: empty,
    eroded: 0,
    deposited: 0,
    exportedSediment: 0,
  });
  const calculate = (node: TerrainNode): WorkingField => {
    const cached = fields.get(node.id);
    if (cached) return cached;
    const inputs = new Map<string, WorkingField>();
    for (const edge of incoming.get(node.id) || []) {
      let field = calculate(byId.get(edge.source)!);
      const handle = edge.sourceHandle || 'height';
      if (handle !== 'height')
        field = {
          ...field,
          height: normalizeDiagnostic(
            field[handle as 'flow' | 'wear' | 'deposition'],
            handle === 'flow',
          ),
        };
      inputs.set(inputHandle(edge, node), field);
    }
    const begin = performance.now();
    const progress = (fraction: number) =>
      options.onProgress?.((completed + clamp(fraction)) / Math.max(needed.size, 1), node.label);
    progress(0);
    const input = inputs.get('in') || inputs.get('a');
    const seed =
      ((Number(project.seed) || 0) +
        Math.round(number(node, 'seed', 0, -2147483647, 2147483647))) >>>
      0;
    const noise = new Noise(seed);
    let field: WorkingField;
    if (node.bypassed && input) field = input;
    else if (node.kind === 'mountain') field = baseField(createMountains(node, n, noise, seed));
    else if (node.kind === 'noise') field = baseField(createNoise(node, n, noise));
    else {
      if (!input) throw new Error(`Connect a height input to “${node.label}”.`);
      field = { ...input };
      switch (node.kind) {
        case 'output':
          break;
        case 'spline':
          field.height = sculptSpline(input.height, n, node.path, {
            mode: text(node, 'mode', 'river') === 'ridge' ? 'ridge' : 'river',
            width: number(node, 'width', 0.016, 0.002, 0.12),
            strength: number(node, 'strength', 0.09, 0, 0.55),
            falloff: number(node, 'falloff', 3, 1.5, 6),
            downhill: node.params.downhill !== false,
          });
          break;
        case 'warp': {
          const strength = number(node, 'strength', 0.35, 0, 2),
            scale = number(node, 'scale', 3, 0.1, 30),
            octaves = Math.round(number(node, 'octaves', 3, 1, 6));
          const channels = ['height', 'flow', 'wear', 'deposition'] as const;
          const warped = {
            height: new Float32Array(length),
            flow: input.flow === empty ? empty : new Float32Array(length),
            wear: input.wear === empty ? empty : new Float32Array(length),
            deposition: input.deposition === empty ? empty : new Float32Array(length),
          };
          for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++) {
              const u = (x / n) * scale,
                v = (y / n) * scale;
              const dx = noise.fractal(u + 12.7, v + 1.9, octaves) * strength * n * 0.16;
              const dy = noise.fractal(u + 2.3, v + 41.9, octaves) * strength * n * 0.16;
              for (const channel of channels)
                if (warped[channel] !== empty)
                  warped[channel][y * n + x] = sampleHeight(input[channel], n, x + dx, y + dy);
            }
          field = { ...field, ...warped };
          break;
        }
        case 'hydraulic': {
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
              method: text(node, 'method', 'landscape') === 'fluid' ? 'fluid' :
                text(node, 'method', 'landscape') === 'droplet' ? 'droplet' :
                text(node, 'method', 'landscape') === 'watershed' ? 'watershed' : 'landscape',
              cycles: number(node, 'cycles', 28, 4, 72),
              featureMeters: number(node, 'featureMeters', 140, 24, 600),
              hillslope: number(node, 'hillslope', 0.38, 0, 1),
              bankAngle: number(node, 'bankAngle', 38, 18, 80),
              worldSize: project.worldSize,
              heightScale: project.heightScale,
            },
            inputs.get('mask')?.height,
            progress,
          );
          field = {
            resolution: n,
            ...result,
            eroded: input.eroded + result.eroded,
            deposited: input.deposited + result.deposited,
            exportedSediment: input.exportedSediment + result.exportedSediment,
          };
          for (let i = 0; i < length; i++) {
            field.flow[i] += input.flow[i];
            field.wear[i] += input.wear[i];
            field.deposition[i] += input.deposition[i];
          }
          break;
        }
        case 'thermal':
          field.height = thermalErosion(
            input.height,
            n,
            number(node, 'iterations', 20, 0, 150),
            number(node, 'talus', 0.008, 0, 0.2),
            number(node, 'strength', 0.5, 0, 1),
            progress,
          );
          break;
        case 'terrace': {
          const steps = Math.round(number(node, 'steps', 12, 2, 80)),
            softness = number(node, 'softness', 0.3, 0.001, 1);
          field.height = input.height.map((value) => {
            const level = value * steps,
              floor = Math.floor(level),
              fraction = level - floor;
            return (floor + smoothstep(0.5 - softness / 2, 0.5 + softness / 2, fraction)) / steps;
          });
          break;
        }
        case 'remap': {
          const contrast = number(node, 'contrast', 1.05, 0.05, 5),
            brightness = number(node, 'brightness', 0, -1, 1),
            gamma = number(node, 'gamma', 1, 0.1, 5);
          field.height = input.height.map((value) => {
            const adjusted = (value - 0.5) * contrast + 0.5 + brightness;
            const result = Math.sign(adjusted) * Math.pow(Math.abs(adjusted), 1 / gamma);
            return node.params.clamp === false ? result : clamp(result);
          });
          break;
        }
        case 'blend': {
          const b = inputs.get('b');
          if (!b) throw new Error(`Connect both A and B inputs to “${node.label}”.`);
          const amount = number(node, 'amount', 0.35, 0, 1),
            mode = text(node, 'mode', 'mix'),
            blendMask = inputs.get('mask')?.height;
          field.height = new Float32Array(length);
          field.flow = new Float32Array(length);
          field.wear = new Float32Array(length);
          field.deposition = new Float32Array(length);
          let contributionA = 0,
            contributionB = 0,
            wearTotal = 0,
            depositionTotal = 0;
          for (let i = 0; i < length; i++) {
            const a = input.height[i];
            const value = b.height[i],
              contribution = amount * (blendMask ? clamp(blendMask[i]) : 1);
            if (mode === 'add') field.height[i] = a + value * contribution;
            else if (mode === 'multiply') field.height[i] = mix(a, a * value, contribution);
            else if (mode === 'max') field.height[i] = mix(a, Math.max(a, value), contribution);
            else if (mode === 'min') field.height[i] = mix(a, Math.min(a, value), contribution);
            else field.height[i] = mix(a, value, contribution);
            const bSelected = !((mode === 'max' && value <= a) || (mode === 'min' && value >= a));
            const wb = bSelected ? contribution : 0,
              wa = mode === 'add' ? 1 : 1 - wb;
            field.flow[i] = input.flow[i] * wa + b.flow[i] * wb;
            field.wear[i] = input.wear[i] * wa + b.wear[i] * wb;
            field.deposition[i] = input.deposition[i] * wa + b.deposition[i] * wb;
            contributionA += wa;
            contributionB += wb;
            wearTotal += field.wear[i];
            depositionTotal += field.deposition[i];
          }
          field.eroded = wearTotal;
          field.deposited = depositionTotal;
          field.exportedSediment =
            (input.exportedSediment * contributionA) / length +
            (b.exportedSediment * contributionB) / length;
          break;
        }
        case 'mask': {
          const mode = text(node, 'mode', 'height'),
            low = number(node, 'low', 0.25, 0, 1),
            high = Math.max(low, number(node, 'high', 0.7, 0, 1)),
            softness = number(node, 'softness', 0.15, 0.001, 1);
          field.height = new Float32Array(length);
          const spacing = Math.max(1, Number(project.worldSize) || 4000) / (n - 1),
            vertical = Math.max(1, Number(project.heightScale) || 1800);
          for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++) {
              const i = y * n + x;
              let value = input.height[i];
              if (mode === 'slope') {
                const dx =
                  ((input.height[y * n + Math.min(n - 1, x + 1)] -
                    input.height[y * n + Math.max(0, x - 1)]) *
                    vertical) /
                  (spacing * 2);
                const dy =
                  ((input.height[Math.min(n - 1, y + 1) * n + x] -
                    input.height[Math.max(0, y - 1) * n + x]) *
                    vertical) /
                  (spacing * 2);
                value = Math.atan(Math.hypot(dx, dy)) / (Math.PI / 2);
              }
              const selected =
                smoothstep(low - softness, low + softness, value) *
                (1 - smoothstep(high - softness, high + softness, value));
              field.height[i] = node.params.invert === true ? 1 - selected : selected;
            }
          break;
        }
        default:
          throw new Error(`“${node.label}” cannot produce terrain.`);
      }
    }
    fields.set(node.id, field);
    thumbnails[node.id] = thumbnail(field.height, n);
    nodeTimings[node.id] = performance.now() - begin;
    completed++;
    progress(0);
    return field;
  };
  const output = calculate(target);
  let min = Infinity,
    max = -Infinity,
    sum = 0;
  for (const value of output.height) {
    if (!Number.isFinite(value))
      throw new Error('A node produced an invalid elevation. Reduce its strength and regenerate.');
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  options.onProgress?.(1, 'Terrain ready');
  return {
    field: {
      resolution: n,
      height: output.height,
      flow: normalizeDiagnostic(output.flow, true),
      wear: output.wear,
      deposition: output.deposition,
    },
    thumbnails,
    nodeTimings,
    stats: {
      min,
      max,
      mean: sum / length,
      eroded: output.eroded,
      deposited: output.deposited,
      exportedSediment: output.exportedSediment,
    },
    duration: performance.now() - started,
    outputNodeId: target.id,
  };
}
