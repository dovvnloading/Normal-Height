import { describe, expect, it } from 'vitest';
import { createProject } from '../src/model/presets';
import { parseProject } from '../src/model/project';
import { createWorldDefinition } from '../src/model/world';

describe('explicit World project versioning', () => {
  it('preserves version 1 projects and their authored graph exactly', () => {
    const project = createProject('studio-ridges');
    const restored = parseProject(JSON.parse(JSON.stringify(project)));
    expect(restored.version).toBe(1);
    expect(restored.world).toBeUndefined();
    expect(restored.graph).toEqual(project.graph);
  });
  it('roundtrips rectangular World coordinates and original versioned algorithms', () => {
    const project = createProject('studio-dunes');
    const world = createWorldDefinition(project);
    world.domain = {
      ...world.domain,
      width: 12000,
      depth: 7000,
      originX: -2500,
      originZ: 842,
      cellsX: 1234,
      cellsZ: 737,
      datum: -125,
    };
    const restored = parseProject(JSON.parse(JSON.stringify({ ...project, version: 2, world })));
    expect(restored.version).toBe(2);
    expect(restored.world).toEqual(world);
    expect(restored.graph).toEqual(project.graph);
    restored.world!.domain.width = 500;
    expect(world.domain.width).toBe(12000);
  });
  it('rejects invalid domains instead of silently changing spatial interpretation', () => {
    const project = createProject();
    const world = createWorldDefinition(project);
    expect(() => parseProject({ ...project, world })).toThrow(/World v2/);
    expect(() => parseProject({ ...project, version: 2 })).toThrow(/World settings/);
    expect(() =>
      parseProject({
        ...project,
        version: 2,
        world: { ...world, domain: { ...world.domain, cellsX: 2.5 } },
      }),
    ).toThrow(/integer/);
    expect(() =>
      parseProject({ ...project, version: 2, world: { ...world, backend: 'pretend-gpu' } }),
    ).toThrow(/CPU reference/);
  });
});
