import { createNode } from './registry';
import type { TerrainProject, TerrainNode, NodeKind, ParamValue } from './types';

export interface Preset {
  id: string;
  name: string;
  eyebrow: string;
  description: string;
  seed: number;
  color: string;
  build: () => TerrainNode[];
}
function node(
  id: string,
  kind: NodeKind,
  x: number,
  params: Record<string, ParamValue> = {},
  label?: string,
): TerrainNode {
  const n = createNode(kind, { x, y: 100 }, id);
  return { ...n, label: label ?? n.label, params: { ...n.params, ...params } };
}
export const PRESETS: Preset[] = [
  {
    id: 'alpine',
    name: 'Alpine watershed',
    eyebrow: 'RIDGES / DRAINAGE',
    description:
      'A connected spine, branching tributaries, and weathered slopes. A starting point for natural mountain ranges.',
    seed: 48271,
    color: '#a9b99d',
    build: () => [
      node('range', 'mountain', 0, {}, 'Alpine spine'),
      node('warp', 'warp', 270, { strength: 0.12, scale: 2.8 }, 'Break the symmetry'),
      node('erosion', 'hydraulic', 540, {}, 'Carve the watershed'),
      node('thermal', 'thermal', 810, { iterations: 10, strength: 0.35 }, 'Settle the scree'),
      node('output', 'output', 1080, {}, 'Terrain output'),
    ],
  },
  {
    id: 'massif',
    name: 'Granite massif',
    eyebrow: 'MASS / FRACTURE',
    description:
      'A broad mountain core with exposed rock, deeper cuts, and a more compact silhouette.',
    seed: 71391,
    color: '#aaaeb5',
    build: () => [
      node(
        'range',
        'mountain',
        0,
        {
          profile: 'massif',
          scale: 4.1,
          sharpness: 1.5,
          width: 0.7,
          relief: 1.05,
          direction: 18,
          roughness: 0.5,
        },
        'Granite core',
      ),
      node('warp', 'warp', 270, { strength: 0.1, scale: 4.5 }, 'Fracture the rock'),
      node(
        'erosion',
        'hydraulic',
        540,
        { droplets: 90000, capacity: 5, erosion: 0.32, inertia: 0.24 },
        'Deep runoff',
      ),
      node('thermal', 'thermal', 810, { iterations: 18, talus: 0.006 }, 'Talus aprons'),
      node('output', 'output', 1080),
    ],
  },
  {
    id: 'badlands',
    name: 'Desert badlands',
    eyebrow: 'SEDIMENT / GULLIES',
    description: 'Low sedimentary ridges with dense drainage channels and layered shelves.',
    seed: 20814,
    color: '#c5a784',
    build: () => [
      node(
        'range',
        'mountain',
        0,
        {
          profile: 'badlands',
          scale: 5.6,
          relief: 0.54,
          width: 0.9,
          sharpness: 1.2,
          roughness: 0.38,
        },
        'Sediment beds',
      ),
      node('terrace', 'terrace', 270, { steps: 16, softness: 0.65 }, 'Geologic layers'),
      node(
        'erosion',
        'hydraulic',
        540,
        {
          droplets: 150000,
          capacity: 6,
          erosion: 0.4,
          inertia: 0.12,
          evaporation: 0.026,
          radius: 2,
        },
        'Fine gullies',
      ),
      node(
        'thermal',
        'thermal',
        810,
        { iterations: 8, talus: 0.005, strength: 0.25 },
        'Soft deposits',
      ),
      node('output', 'output', 1080),
    ],
  },
  {
    id: 'volcano',
    name: 'Volcanic caldera',
    eyebrow: 'RADIAL / EROSION',
    description: 'A volcanic cone and open crater, eroded into radial drainage channels.',
    seed: 93217,
    color: '#b6a49b',
    build: () => [
      node(
        'range',
        'mountain',
        0,
        { profile: 'volcano', scale: 3.8, relief: 0.9, width: 0.7, warp: 0.36, sharpness: 1.2 },
        'Volcanic cone',
      ),
      node('warp', 'warp', 270, { strength: 0.055, scale: 4 }, 'Deform the crater'),
      node(
        'erosion',
        'hydraulic',
        540,
        { droplets: 100000, capacity: 4.8, erosion: 0.3, inertia: 0.1, lifetime: 85 },
        'Radial drainage',
      ),
      node('thermal', 'thermal', 810, { iterations: 15, talus: 0.009 }, 'Loose volcanic rock'),
      node('output', 'output', 1080),
    ],
  },
  {
    id: 'highlands',
    name: 'Folded highlands',
    eyebrow: 'SOFT / WEATHERED',
    description:
      'Long, lower ridges, broad valleys, and softened slopes for an older mountain landscape.',
    seed: 16403,
    color: '#97b0a2',
    build: () => [
      node(
        'range',
        'mountain',
        0,
        {
          scale: 2.8,
          relief: 0.52,
          sharpness: 0.85,
          width: 0.85,
          direction: 32,
          roughness: 0.35,
          warp: 1.3,
        },
        'Ancient folds',
      ),
      node('warp', 'warp', 270, { strength: 0.2, scale: 2 }, 'Bend the strata'),
      node(
        'erosion',
        'hydraulic',
        540,
        { droplets: 110000, erosion: 0.22, deposition: 0.5, radius: 4 },
        'Mature drainage',
      ),
      node(
        'thermal',
        'thermal',
        810,
        { iterations: 35, talus: 0.004, strength: 0.6 },
        'Weathered slopes',
      ),
      node('output', 'output', 1080),
    ],
  },
];
export function createProject(presetId = 'alpine'): TerrainProject {
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const nodes = preset.build();
  return {
    version: 1,
    name: preset.name,
    seed: preset.seed,
    resolution: 512,
    worldSize: 8000,
    heightScale: 2400,
    presetId: preset.id,
    graph: {
      nodes,
      edges: nodes
        .slice(1)
        .map((n, i) => ({
          id: `${nodes[i].id}-${n.id}`,
          source: nodes[i].id,
          target: n.id,
          sourceHandle: 'height',
          targetHandle: 'in',
        })),
    },
  };
}
