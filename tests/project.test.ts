import { describe, it, expect } from 'vitest';
import { createProject } from '../src/model/presets';
import { parseProject } from '../src/model/project';
import { createNode } from '../src/model/registry';

describe('project import boundaries', () => {
  it('round-trips a project and its annotation/group organization', () => {
    const p = createProject();
    const group = createNode('group', { x: 200, y: 100 }, 'group-1');
    const note = createNode('note', { x: 20, y: 40 }, 'note-1');
    note.parentId = group.id;
    note.params.text = 'Keep runoff connected to the major ridge.';
    p.graph.nodes.push(group, note);
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it('rejects out-of-range and non-finite values before replacing the active project', () => {
    const p = createProject();
    p.graph.nodes[0].params.octaves = 999;
    expect(() => parseProject(p)).toThrow('Invalid Detail octaves');
    const q = createProject();
    q.seed = Infinity;
    expect(() => parseProject(q)).toThrow('seed');
  });
  it('rejects duplicate node identifiers and unknown ports', () => {
    const p = createProject();
    p.graph.nodes[1].id = p.graph.nodes[0].id;
    expect(() => parseProject(p)).toThrow('duplicate');
    const q = createProject();
    q.graph.edges[0].targetHandle = 'missing';
    expect(() => parseProject(q)).toThrow('unknown input');
  });
  it('rejects group-parent loops and unsupported versions', () => {
    const p = createProject();
    const a = createNode('group', { x: 0, y: 0 }, 'a');
    const b = createNode('group', { x: 0, y: 0 }, 'b');
    a.parentId = 'b';
    b.parentId = 'a';
    p.graph.nodes.push(a, b);
    expect(() => parseProject(p)).toThrow('cycle');
    expect(() => parseProject({ ...createProject(), version: 2 })).toThrow('version');
  });
  it('rejects identifiers that collide with diagnostic object prototypes', () => {
    const p = createProject();
    p.graph.nodes[0].id = '__proto__';
    expect(() => parseProject(p)).toThrow('identifier');
  });
});
