import { MAX_SPLINE_POINTS, validSplinePoint } from './splines';
import { resolveSurface, SURFACE_LIMITS } from '../materials/pbr';
import { NODE_DEFINITIONS, createNode } from './registry';
import type { NodeKind, TerrainProject, TerrainNode, TerrainEdge, ParamValue } from './types';

export const STORAGE_KEY = 'normal-height.project.v1';
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function parseProject(raw: unknown): TerrainProject {
  if (!raw || typeof raw !== 'object')
    throw new Error('This file does not contain a terrain project.');
  const p = raw as Record<string, unknown>;
  if (p.version !== 1)
    throw new Error('This project version is not supported. Expected a Normal Height v1 project.');
  const g = p.graph as { nodes: unknown[]; edges: unknown[] } | undefined;
  if (
    !g ||
    !Array.isArray(g.nodes) ||
    !Array.isArray(g.edges) ||
    g.nodes.length > 128 ||
    g.edges.length > 512
  )
    throw new Error('The project graph is missing or exceeds the 128-node limit.');
  const ids = new Set<string>();
  const nodes: TerrainNode[] = g.nodes.map((rawNode) => {
    if (!rawNode || typeof rawNode !== 'object') throw new Error('A node is not valid.');
    const n = rawNode as Record<string, unknown>;
    const kind = n.kind as NodeKind;
    if (
      !Object.hasOwn(NODE_DEFINITIONS, kind) ||
      typeof n.id !== 'string' ||
      !n.id ||
      ['__proto__', 'constructor', 'prototype'].includes(n.id) ||
      ids.has(n.id)
    )
      throw new Error('The project contains an unknown node or duplicate identifier.');
    ids.add(n.id);
    const pos = n.position as { x: number; y: number } | undefined;
    if (!pos || !finite(pos.x, -1e6, 1e6) || !finite(pos.y, -1e6, 1e6))
      throw new Error('A node has an invalid position.');
    const clean = createNode(kind, pos, n.id);
    clean.label = typeof n.label === 'string' ? n.label.slice(0, 100) : clean.label;
    const params =
      n.params && typeof n.params === 'object' ? (n.params as Record<string, unknown>) : {};
    for (const def of NODE_DEFINITIONS[kind].params) {
      const value = params[def.key];
      if (value === undefined) continue;
      if (def.type === 'range' || def.type === 'number') {
        if (!finite(value, def.min ?? -1e9, def.max ?? 1e9))
          throw new Error(`Invalid ${def.label} on ${clean.label}.`);
        clean.params[def.key] = value;
      } else if (def.type === 'toggle') {
        if (typeof value !== 'boolean') throw new Error(`Invalid ${def.label}.`);
        clean.params[def.key] = value;
      } else if (def.type === 'select') {
        if (!def.options?.some((o) => o.value === value)) throw new Error(`Unknown ${def.label}.`);
        clean.params[def.key] = value as ParamValue;
      } else if (typeof value === 'string') clean.params[def.key] = value.slice(0, 4000);
    }
    if (kind === 'spline') {
      if (
        !Array.isArray(n.path) ||
        n.path.length < 2 ||
        n.path.length > MAX_SPLINE_POINTS ||
        !n.path.every(validSplinePoint)
      )
        throw new Error('Spline paths must contain 2–24 points inside the terrain tile.');
      clean.path = n.path.map((p) => ({ x: p.x, y: p.y }));
    }
    if (typeof n.parentId === 'string') clean.parentId = n.parentId;
    if (typeof n.bypassed === 'boolean') clean.bypassed = n.bypassed;
    if (finite(n.width, 100, 10000)) clean.width = n.width;
    if (finite(n.height, 60, 10000)) clean.height = n.height;
    return clean;
  });
  for (const n of nodes) {
    if (
      n.parentId &&
      (!ids.has(n.parentId) ||
        nodes.find((p) => p.id === n.parentId)?.kind !== 'group' ||
        n.parentId === n.id)
    )
      throw new Error('A group has an invalid parent.');
    const seen = new Set([n.id]);
    let parent = n.parentId;
    while (parent) {
      if (seen.has(parent)) throw new Error('Groups cannot contain one another in a cycle.');
      seen.add(parent);
      parent = nodes.find((p) => p.id === parent)?.parentId;
    }
  }
  const edgeIds = new Set<string>();
  const edges: TerrainEdge[] = g.edges.map((rawEdge) => {
    const e = rawEdge as TerrainEdge;
    if (
      !e ||
      typeof e.id !== 'string' ||
      edgeIds.has(e.id) ||
      !ids.has(e.source) ||
      !ids.has(e.target)
    )
      throw new Error('The project contains an invalid connection.');
    edgeIds.add(e.id);
    const source = nodes.find((n) => n.id === e.source)!;
    const target = nodes.find((n) => n.id === e.target)!;
    const sh = e.sourceHandle ?? 'height';
    const th = e.targetHandle ?? 'in';
    if (
      !NODE_DEFINITIONS[source.kind].outputs.some((p) => p.id === sh) ||
      !NODE_DEFINITIONS[target.kind].inputs.some((p) => p.id === th)
    )
      throw new Error('A connection uses an unknown input or output.');
    return { id: e.id, source: e.source, target: e.target, sourceHandle: sh, targetHandle: th };
  });
  if (
    !finite(p.seed, 0, 2147483647) ||
    !finite(p.worldSize, 100, 100000) ||
    !finite(p.heightScale, 10, 20000) ||
    !finite(p.resolution, 64, 2048)
  )
    throw new Error('Project scale, seed, or resolution is invalid.');
  let surface: TerrainProject['surface'];
  if (p.surface !== undefined) {
    if (!p.surface || typeof p.surface !== 'object' || Array.isArray(p.surface))
      throw new Error('Invalid PBR surface settings.');
    const rawSurface = p.surface as Record<string, unknown>;
    const biome = rawSurface.biome;
    if (biome !== undefined && !['alpine', 'arid', 'volcanic'].includes(String(biome)))
      throw new Error('Unknown PBR biome.');
    const clean = resolveSurface();
    if (biome !== undefined) clean.biome = biome as typeof clean.biome;
    for (const key of Object.keys(SURFACE_LIMITS) as (keyof typeof SURFACE_LIMITS)[]) {
      const value = rawSurface[key];
      if (value !== undefined) {
        const [min, max] = SURFACE_LIMITS[key];
        if (!finite(value, min, max)) throw new Error('Invalid PBR ' + key + '.');
        clean[key] = value;
      }
    }
    surface = clean;
  }
  return {
    version: 1,
    name: typeof p.name === 'string' ? p.name.slice(0, 100) : 'Untitled terrain',
    seed: Math.floor(p.seed),
    resolution: Math.floor(p.resolution),
    worldSize: p.worldSize,
    heightScale: p.heightScale,
    presetId: typeof p.presetId === 'string' ? p.presetId : 'custom',
    ...(surface ? { surface } : {}),
    graph: { nodes, edges },
  };
}
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function saveProject(project: TerrainProject) {
  downloadBlob(
    new Blob([JSON.stringify({ ...project, surface: resolveSurface(project.surface) }, null, 2)], { type: 'application/json' }),
    `${slug(project.name)}.nhterrain.json`,
  );
}
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'terrain';
