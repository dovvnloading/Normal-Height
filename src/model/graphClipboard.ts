import type { TerrainGraph, TerrainNode, TerrainProject } from './types';
import { parseProject } from './project';
import { assertProjectStorageBudget } from './projectStorage';
import { assertRasterBudget, MAX_PROJECT_FILE_BYTES } from './heightRaster';
import {
  GRAPH_LIMIT_ERROR,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  validGraphIdentifier,
  validateGraph,
} from './graph';

export const GRAPH_SNIPPET_TYPE = 'normal-height-graph';
export interface GraphSnippet {
  type: typeof GRAPH_SNIPPET_TYPE;
  version: 1;
  name: string;
  graph: TerrainGraph;
}
const encoder = new TextEncoder();

function checkBytes(text: string) {
  if (
    text.length > MAX_PROJECT_FILE_BYTES ||
    encoder.encode(text).byteLength > MAX_PROJECT_FILE_BYTES
  )
    throw new Error('This graph snippet exceeds the 32 MiB file limit.');
}
function cleanGraph(graph: unknown): TerrainGraph {
  // Reuse the project's complete node/edge/raster/spline validation and legacy
  // migrations. Project-level context is deliberately not imported with nodes.
  return parseProject({
    version: 1,
    name: 'Graph snippet',
    seed: 0,
    resolution: 64,
    worldSize: 4000,
    heightScale: 1800,
    presetId: 'custom',
    graph,
  }).graph;
}

export function parseGraphSnippet(raw: unknown): GraphSnippet {
  if (typeof raw === 'string') {
    checkBytes(raw);
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('The clipboard or file does not contain valid graph JSON.');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('This file does not contain a Normal Height graph snippet.');
  const value = raw as Record<string, unknown>;
  if (value.type !== GRAPH_SNIPPET_TYPE || value.version !== 1)
    throw new Error(
      'Unsupported graph snippet. Expected a Normal Height .nhgraph.json version 1 file.',
    );
  const graph = cleanGraph(value.graph);
  if (!graph.nodes.length) throw new Error('A graph snippet must contain at least one node.');
  const snippet: GraphSnippet = {
    type: GRAPH_SNIPPET_TYPE,
    version: 1,
    name: typeof value.name === 'string' ? value.name.slice(0, 100) : 'Graph selection',
    graph,
  };
  checkBytes(JSON.stringify(snippet));
  return snippet;
}

export function serializeGraphSnippet(snippet: GraphSnippet): string {
  const text = JSON.stringify(parseGraphSnippet(snippet));
  checkBytes(text);
  return text;
}

function absolutePosition(node: TerrainNode, byId: ReadonlyMap<string, TerrainNode>) {
  const position = { ...node.position };
  let parentId = node.parentId;
  const seen = new Set([node.id]);
  while (parentId) {
    if (seen.has(parentId)) throw new Error('Groups cannot contain one another in a cycle.');
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) throw new Error('A selected node has a missing parent.');
    position.x += parent.position.x;
    position.y += parent.position.y;
    parentId = parent.parentId;
  }
  return position;
}

/** Selected groups carry all descendants. Only internal edges are portable.
 * A child copied without its parent is detached at its absolute position. */
export function createGraphSnippet(
  project: TerrainProject,
  selectedIds: Iterable<string>,
): GraphSnippet {
  const error = validateGraph(project.graph);
  if (error) throw new Error(error);
  const byId = new Map(project.graph.nodes.map((node) => [node.id, node]));
  const ids = new Set(selectedIds);
  if (!ids.size) throw new Error('Select one or more nodes to copy or export.');
  if ([...ids].some((id) => !byId.has(id)))
    throw new Error('The selection contains a node that no longer exists.');
  for (let pass = 0; pass < project.graph.nodes.length; pass++) {
    let added = false;
    for (const node of project.graph.nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        added = true;
      }
    }
    if (!added) break;
  }
  const nodes = project.graph.nodes
    .filter((node) => ids.has(node.id))
    .map((node) => {
      const copy = structuredClone(node);
      if (node.parentId && !ids.has(node.parentId)) {
        copy.position = absolutePosition(node, byId);
        delete copy.parentId;
      }
      return copy;
    });
  const roots = nodes.filter((node) => !node.parentId);
  const center = {
    x:
      (Math.min(...roots.map((node) => node.position.x)) +
        Math.max(...roots.map((node) => node.position.x))) /
      2,
    y:
      (Math.min(...roots.map((node) => node.position.y)) +
        Math.max(...roots.map((node) => node.position.y))) /
      2,
  };
  for (const node of roots) {
    node.position.x -= center.x;
    node.position.y -= center.y;
  }
  return parseGraphSnippet({
    type: GRAPH_SNIPPET_TYPE,
    version: 1,
    name: project.name,
    graph: {
      nodes,
      edges: structuredClone(
        project.graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
      ),
    },
  });
}

export interface GraphPaste {
  project: TerrainProject;
  nodeIds: string[];
  edgeIds: string[];
}

/** Construct and fully admit a paste before changing either the document or
 * editor selection. Original source and destination objects remain immutable. */
export function pasteGraphSnippet(
  project: TerrainProject,
  raw: unknown,
  anchor: { x: number; y: number },
  makeId: () => string = () => crypto.randomUUID(),
): GraphPaste {
  const snippet = parseGraphSnippet(raw);
  if (
    project.graph.nodes.length + snippet.graph.nodes.length > MAX_GRAPH_NODES ||
    project.graph.edges.length + snippet.graph.edges.length > MAX_GRAPH_EDGES
  )
    throw new Error(GRAPH_LIMIT_ERROR);
  if (![anchor.x, anchor.y].every(Number.isFinite))
    throw new Error('Choose a finite paste position.');
  const allocated = new Set(
    [...project.graph.nodes, ...project.graph.edges].map((item) => item.id),
  );
  const fresh = () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = makeId();
      if (validGraphIdentifier(id) && !allocated.has(id)) {
        allocated.add(id);
        return id;
      }
    }
    throw new Error('Could not allocate unique graph identifiers. Please retry the paste.');
  };
  const ids = new Map(snippet.graph.nodes.map((node) => [node.id, fresh()]));
  const nodes = snippet.graph.nodes.map((node) => ({
    ...node,
    id: ids.get(node.id)!,
    ...(node.parentId ? { parentId: ids.get(node.parentId)! } : {}),
    position: node.parentId
      ? { ...node.position }
      : {
          x: node.position.x + anchor.x,
          y: node.position.y + anchor.y,
        },
  }));
  if (
    nodes.some(
      (node) =>
        ![node.position.x, node.position.y].every(
          (coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e6,
        ),
    )
  )
    throw new Error(
      'The pasted nodes would exceed the graph coordinate limits. Move the view closer to the origin.',
    );
  const edges = snippet.graph.edges.map((edge) => ({
    ...edge,
    id: fresh(),
    source: ids.get(edge.source)!,
    target: ids.get(edge.target)!,
  }));
  const graph: TerrainGraph = {
    nodes: [...project.graph.nodes, ...nodes],
    edges: [...project.graph.edges, ...edges],
  };
  const error = validateGraph(graph);
  if (error) throw new Error(error);
  assertRasterBudget(graph.nodes);
  const next = { ...project, graph };
  assertProjectStorageBudget(next);
  return {
    project: next,
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
  };
}
