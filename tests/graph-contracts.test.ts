import { describe, expect, it } from 'vitest';
import {
  GRAPH_LIMIT_ERROR,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  inputHandle,
  graphOutputPorts,
  outputHandle,
  supportsOutput,
  validateGraph,
} from '../src/model/graph';
import { parseProject } from '../src/model/project';
import { createProject } from '../src/model/presets';
import { createNode } from '../src/model/registry';
import { serializeProjectFile } from '../src/model/projectStorage';
import type { TerrainGraph, TerrainProject } from '../src/model/types';
import { compileGraph, semanticProjectSignature } from '../src/engine/plan/graph';
import { evaluateGraph } from '../src/engine';

function fixture(): TerrainProject {
  const source = createNode('noise', { x: 0, y: 0 }, 'source');
  const blend = createNode('blend', { x: 200, y: 0 }, 'blend');
  blend.bypassed = true;
  const out = createNode('output', { x: 400, y: 0 }, 'out');
  return {
    ...createProject(),
    resolution: 64,
    graph: {
      nodes: [source, blend, out],
      edges: [
        { id: 'source-blend', source: 'source', target: 'blend' },
        { id: 'blend-output', source: 'blend', target: 'out' },
      ],
    },
  };
}

function roundTrip(project: TerrainProject) {
  return parseProject(JSON.parse(serializeProjectFile(project)));
}

describe('shared authoring, import and execution graph contract', () => {
  it('normalizes omitted Blend input to A without changing evaluation or cache identity', () => {
    const project = fixture();
    const restored = roundTrip(project);
    expect(restored.graph.edges[0]).toMatchObject({ sourceHandle: 'height', targetHandle: 'a' });
    expect(compileGraph(restored).stages).toEqual(compileGraph(project).stages);
    expect(semanticProjectSignature(restored)).toBe(semanticProjectSignature(project));
    expect(evaluateGraph(restored, { resolution: 24 }).field).toEqual(
      evaluateGraph(project, { resolution: 24 }).field,
    );
  });

  it.each(['flow', 'wear', 'deposition'])(
    'preserves existing %s routes through processors during project round trips',
    (channel) => {
      const project = fixture();
      project.graph.edges[1].sourceHandle = channel;
      const restored = roundTrip(project);
      expect(validateGraph(restored.graph)).toBeNull();
      expect(restored.graph.edges[1].sourceHandle).toBe(channel);
      expect(compileGraph(restored).stages).toEqual(compileGraph(project).stages);
      expect(evaluateGraph(restored, { resolution: 24 }).field).toEqual(
        evaluateGraph(project, { resolution: 24 }).field,
      );
      // Compatibility does not invent new visible ports for unrelated nodes.
      expect(supportsOutput(project.graph.nodes[1], channel, false)).toBe(false);
    },
  );

  it('renders existing legacy diagnostic wires without exposing unrelated ports', () => {
    const project = fixture();
    const blend = project.graph.nodes[1];
    expect(graphOutputPorts(blend, project.graph.edges).map((port) => port.id)).toEqual(['height']);
    project.graph.edges[1].sourceHandle = 'flow';
    expect(graphOutputPorts(blend, project.graph.edges)).toEqual([
      { id: 'height', label: 'Height' },
      { id: 'flow', label: 'Flow (legacy)' },
    ]);
    const out = project.graph.nodes[2];
    expect(
      graphOutputPorts(out, [
        { id: 'invalid', source: out.id, target: blend.id, sourceHandle: 'flow' },
      ]),
    ).toEqual([]);
  });

  it('preserves explicit null defaults but rejects empty and unknown port identifiers', () => {
    const project = fixture();
    project.graph.edges[0].sourceHandle = null;
    project.graph.edges[0].targetHandle = null;
    expect(outputHandle(project.graph.edges[0])).toBe('height');
    expect(inputHandle(project.graph.edges[0], project.graph.nodes[1])).toBe('a');
    expect(() => roundTrip(project)).not.toThrow();
    for (const key of ['sourceHandle', 'targetHandle'] as const) {
      for (const invalid of ['', 'missing']) {
        const malformed = structuredClone(project);
        malformed.graph.edges[0][key] = invalid;
        expect(validateGraph(malformed.graph)).not.toBeNull();
        expect(() => roundTrip(malformed)).toThrow(/unknown input or output/);
      }
    }
  });

  it('rejects cyclic imports before they can replace a working project', () => {
    const project = fixture();
    const a = createNode('remap', { x: 0, y: 100 }, 'a');
    const b = createNode('remap', { x: 200, y: 100 }, 'b');
    project.graph.nodes.push(a, b);
    project.graph.edges.push(
      { id: 'a-b', source: 'a', target: 'b' },
      { id: 'b-a', source: 'b', target: 'a' },
    );
    expect(validateGraph(project.graph)).toMatch(/cycle/);
    expect(() => roundTrip(project)).toThrow(/cycle/);
    expect(() => compileGraph(project)).toThrow(/cycle/);
  });

  it('rejects duplicate input connections after applying the same port defaults', () => {
    const project = fixture();
    project.graph.edges.push({
      id: 'duplicate',
      source: 'source',
      target: 'blend',
      targetHandle: 'a',
    });
    expect(validateGraph(project.graph)).toMatch(/already has a connection/);
    expect(() => roundTrip(project)).toThrow(/already has a connection/);
    expect(() => compileGraph(project)).toThrow(/already has a connection/);
  });

  it.each(['', '__proto__', 'constructor', 'prototype'])(
    'rejects unsafe or empty connection identifier %j at both boundaries',
    (identifier) => {
      const project = fixture();
      project.graph.edges[0].id = identifier;
      expect(validateGraph(project.graph)).toMatch(/identifier/);
      expect(() => roundTrip(project)).toThrow(/invalid connection/);
    },
  );

  it('accepts the authoring node limit and rejects one extra node consistently', () => {
    const project = fixture();
    while (project.graph.nodes.length < MAX_GRAPH_NODES) {
      project.graph.nodes.push(
        createNode('note', { x: 0, y: 0 }, `note-${project.graph.nodes.length}`),
      );
    }
    expect(() => roundTrip(project)).not.toThrow();
    expect(() => compileGraph(project)).not.toThrow();
    project.graph.nodes.push(createNode('note', { x: 0, y: 0 }, 'overflow'));
    expect(validateGraph(project.graph)).toBe(GRAPH_LIMIT_ERROR);
    expect(() => roundTrip(project)).toThrow(GRAPH_LIMIT_ERROR);
    expect(() => compileGraph(project)).toThrow(GRAPH_LIMIT_ERROR);
  });

  it('rejects connection overflow before traversing the graph', () => {
    const project = fixture();
    project.graph.edges = Array.from({ length: MAX_GRAPH_EDGES + 1 }, (_, index) => ({
      id: `edge-${index}`,
      source: 'source',
      target: 'blend',
    }));
    expect(validateGraph(project.graph)).toBe(GRAPH_LIMIT_ERROR);
    expect(() => roundTrip(project)).toThrow(GRAPH_LIMIT_ERROR);
    expect(() => compileGraph(project)).toThrow(GRAPH_LIMIT_ERROR);
  });

  it('validates annotation ancestry without requiring unfinished nodes to evaluate', () => {
    const project = fixture();
    const group = createNode('group', { x: 0, y: 0 }, 'group');
    const unfinished = createNode('remap', { x: 20, y: 20 }, 'unfinished');
    unfinished.parentId = group.id;
    project.graph.nodes.push(group, unfinished);
    expect(() => roundTrip(project)).not.toThrow();
    expect(compileGraph(project).needed.has(unfinished.id)).toBe(false);
    group.parentId = group.id;
    expect(validateGraph(project.graph)).toMatch(/cycle/);
    expect(() => roundTrip(project)).toThrow(/cycle/);
  });

  it('returns actionable errors instead of throwing for malformed graph members', () => {
    expect(validateGraph({ nodes: [null], edges: [] } as unknown as TerrainGraph)).toMatch(
      /identifier/,
    );
    expect(validateGraph({ nodes: [], edges: [null] } as unknown as TerrainGraph)).toMatch(
      /identifier/,
    );
  });
});
