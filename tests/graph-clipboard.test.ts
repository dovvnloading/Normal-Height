import { describe, expect, it } from 'vitest';
import {
  createGraphSnippet,
  parseGraphSnippet,
  pasteGraphSnippet,
  serializeGraphSnippet,
} from '../src/model/graphClipboard';
import { nodeSummary } from '../src/model/nodeSummary';
import { createProject } from '../src/model/presets';
import { createNode } from '../src/model/registry';
import { MAX_GRAPH_NODES } from '../src/model/graph';
import { MAX_PROJECT_FILE_BYTES, encodeSamples } from '../src/model/heightRaster';
import { projectStorageBytes } from '../src/model/projectStorage';
import type { MaterialStroke } from '../src/materials/materialPaint';

function source() {
  const project = createProject();
  const outer = createNode('group', { x: 1000, y: 900 }, 'outer');
  const group = createNode('group', { x: 30, y: 40 }, 'group');
  group.parentId = outer.id;
  const imported = createNode('heightImport', { x: 20, y: 60 }, 'import');
  imported.parentId = group.id;
  imported.raster = {
    name: 'Source heights',
    width: 2,
    height: 2,
    format: 'u16le',
    data: encodeSamples(new Uint8Array([0, 0, 0, 128, 255, 255, 0, 64])),
  };
  const spline = createNode('spline', { x: 240, y: 60 }, 'river');
  spline.parentId = group.id;
  const note = createNode('note', { x: 20, y: 250 }, 'note');
  note.parentId = group.id;
  note.params.text = 'Artist-authored drainage constraint.';
  const output = createNode('output', { x: 1700, y: 900 }, 'output');
  project.graph = {
    nodes: [outer, group, imported, spline, note, output],
    edges: [
      {
        id: 'import-river',
        source: imported.id,
        target: spline.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
      {
        id: 'river-output',
        source: spline.id,
        target: output.id,
        sourceHandle: 'height',
        targetHandle: 'in',
      },
    ],
  };
  return project;
}

function target() {
  const project = createProject();
  const source = createNode('noise', { x: 0, y: 0 }, 'existing-source');
  const output = createNode('output', { x: 200, y: 0 }, 'existing-output');
  project.graph = {
    nodes: [source, output],
    edges: [{ id: 'existing-edge', source: source.id, target: output.id }],
  };
  return project;
}

describe('portable graph reuse', () => {
  it('includes group descendants and internal wires, preserving splines, rasters and annotations', () => {
    const project = source(),
      before = structuredClone(project);
    const snippet = createGraphSnippet(project, ['group']);
    expect(snippet.graph.nodes.map((node) => node.id)).toEqual([
      'group',
      'import',
      'river',
      'note',
    ]);
    expect(snippet.graph.edges.map((edge) => edge.id)).toEqual(['import-river']);
    expect(snippet.graph.nodes[0].parentId).toBeUndefined();
    expect(snippet.graph.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(snippet.graph.nodes[1].raster).toEqual(project.graph.nodes[2].raster);
    expect(snippet.graph.nodes[2].path).toEqual(project.graph.nodes[3].path);
    expect(snippet.graph.nodes[3].params.text).toBe('Artist-authored drainage constraint.');
    expect(parseGraphSnippet(serializeGraphSnippet(snippet))).toEqual(snippet);
    expect(project).toEqual(before);
  });

  it('detaches separately selected children in their common absolute coordinate system', () => {
    const project = source();
    const snippet = createGraphSnippet(project, ['river', 'output']);
    const [river, output] = snippet.graph.nodes;
    expect(river.parentId).toBeUndefined();
    expect(output.position.x - river.position.x).toBe(1700 - (1000 + 30 + 240));
    expect(output.position.y - river.position.y).toBe(900 - (900 + 40 + 60));
    expect(snippet.graph.edges).toHaveLength(1);
  });

  it('pastes into a different project with fresh identities and one complete immutable candidate', () => {
    const original = source(),
      destination = target();
    const before = structuredClone(destination);
    const snippet = createGraphSnippet(original, ['group']);
    let next = 0;
    const pasted = pasteGraphSnippet(
      destination,
      snippet,
      { x: 600, y: 400 },
      () => `pasted-${++next}`,
    );
    expect(pasted.nodeIds).toHaveLength(4);
    expect(pasted.edgeIds).toHaveLength(1);
    const group = pasted.project.graph.nodes.find((node) => node.id === pasted.nodeIds[0])!;
    expect(group.position).toEqual({ x: 600, y: 400 });
    for (const id of pasted.nodeIds.slice(1))
      expect(pasted.project.graph.nodes.find((node) => node.id === id)?.parentId).toBe(group.id);
    const edge = pasted.project.graph.edges.at(-1)!;
    expect(pasted.nodeIds).toContain(edge.source);
    expect(pasted.nodeIds).toContain(edge.target);
    expect(pasted.project.seed).toBe(destination.seed);
    expect(pasted.project.worldSize).toBe(destination.worldSize);
    expect(pasted.project.graph.nodes[0]).toBe(destination.graph.nodes[0]);
    expect(destination).toEqual(before);
    expect(original.graph.nodes[2].raster?.data).toBe(snippet.graph.nodes[1].raster?.data);
  });

  it('rejects dangling external wires, parent cycles and unsupported schemas', () => {
    const snippet = createGraphSnippet(source(), ['group']);
    const dangling = structuredClone(snippet);
    dangling.graph.edges[0].source = 'external';
    expect(() => parseGraphSnippet(dangling)).toThrow(/invalid connection/);
    const cycle = structuredClone(snippet);
    cycle.graph.nodes[0].parentId = cycle.graph.nodes[0].id;
    expect(() => parseGraphSnippet(cycle)).toThrow(/cycle/);
    expect(() => parseGraphSnippet({ ...snippet, version: 2 })).toThrow(
      /Unsupported graph snippet/,
    );
    expect(() => parseGraphSnippet(JSON.stringify(target()))).toThrow(/graph snippet/);
    expect(() => parseGraphSnippet('not JSON')).toThrow(/valid graph JSON/);
  });

  it('rejects oversized or hostile snippets before changing the destination', () => {
    expect(() => parseGraphSnippet(' '.repeat(MAX_PROJECT_FILE_BYTES + 1))).toThrow(/32 MiB/);
    const snippet = createGraphSnippet(source(), ['group']);
    snippet.graph.nodes[0].id = '__proto__';
    const destination = target(),
      before = structuredClone(destination);
    expect(() => pasteGraphSnippet(destination, snippet, { x: 0, y: 0 })).toThrow(/identifier/);
    expect(destination).toEqual(before);
  });

  it('preflights combined graph and sample budgets, including implicit descendants', () => {
    const destination = target();
    while (destination.graph.nodes.length < MAX_GRAPH_NODES - 3)
      destination.graph.nodes.push(
        createNode('note', { x: 0, y: 0 }, `note-${destination.graph.nodes.length}`),
      );
    const snippet = createGraphSnippet(source(), ['group']);
    const count = destination.graph.nodes.length;
    expect(() => pasteGraphSnippet(destination, snippet, { x: 0, y: 0 })).toThrow(/node.*limit/);
    expect(destination.graph.nodes).toHaveLength(count);

    const raster = {
      name: 'Full raster',
      width: 2048,
      height: 2048,
      format: 'u16le' as const,
      data: 'A'.repeat(4 * Math.ceil((2048 * 2048 * 2) / 3) - 1) + '=',
    };
    const heavy = target();
    for (let index = 0; index < 2; index++) {
      const imported = createNode('heightImport', { x: index * 200, y: 200 }, `heavy-${index}`);
      imported.raster = raster;
      heavy.graph.nodes.push(imported);
    }
    expect(() => pasteGraphSnippet(heavy, snippet, { x: 0, y: 0 })).toThrow(/16 MiB/);
    expect(heavy.graph.nodes).toHaveLength(4);
  });

  it('preflights the complete project file budget, including existing paint', () => {
    const destination = target();
    const stroke: MaterialStroke = {
      layer: 'rock',
      radius: 0.1,
      hardness: 0.5,
      strength: 0.5,
      points: [{ u: 0.5, v: 0.5 }],
      selection: {
        points: Array.from({ length: 256 }, (_, i) => ({
          u: 0.1234567890123456 + i * 1e-8,
          v: 0.9876543210987654 - i * 1e-8,
        })),
      },
    };
    destination.materialPaint = Array.from({ length: 4096 }, () => stroke);
    expect(projectStorageBytes(destination)).toBeGreaterThan(MAX_PROJECT_FILE_BYTES);
    expect(() =>
      pasteGraphSnippet(destination, createGraphSnippet(source(), ['note']), { x: 0, y: 0 }),
    ).toThrow(/32 MiB/);
    expect(destination.graph.nodes).toHaveLength(2);
  });

  it('fails safely if unique identifiers or a valid destination cannot be allocated', () => {
    const destination = target(),
      snippet = createGraphSnippet(source(), ['note']);
    expect(() =>
      pasteGraphSnippet(destination, snippet, { x: 0, y: 0 }, () => 'existing-source'),
    ).toThrow(/unique graph identifiers/);
    expect(() => pasteGraphSnippet(destination, snippet, { x: Infinity, y: 0 })).toThrow(/finite/);
    expect(() => pasteGraphSnippet(destination, snippet, { x: 1e7, y: 0 })).toThrow(
      /coordinate limits/,
    );
    expect(destination.graph.nodes).toHaveLength(2);
  });
});

describe('model-aware graph summaries', () => {
  it('describes the actual v3 kernel/fractal and preserves legacy noise summaries', () => {
    const noise = createNode('noise', { x: 0, y: 0 }, 'noise');
    noise.params = { ...noise.params, noiseModel: 'v3', kernel: 'gabor', fractal: 'swiss' };
    expect(nodeSummary(noise)).toBe('Gabor · Swiss turbulence');
    noise.params = { ...noise.params, noiseModel: 'legacy', mode: 'voronoi' };
    expect(nodeSummary(noise)).toBe('Voronoi F1');
  });
  it('does not describe landscape/fluid solvers as particle droplet counts', () => {
    const node = createNode('hydraulic', { x: 0, y: 0 }, 'erosion');
    node.params.cycles = 36;
    for (const method of ['landscape', 'hybrid', 'fluid', 'watershed']) {
      node.params.method = method;
      expect(nodeSummary(node)).not.toMatch(/drops|droplets|512/);
    }
    node.params.method = 'fluid';
    expect(nodeSummary(node)).toContain('36 steps');
    expect(nodeSummary(node)).toContain('experimental');
    node.params.method = 'droplet';
    expect(nodeSummary(node)).toBe('70k droplets / 512²');
  });
});
