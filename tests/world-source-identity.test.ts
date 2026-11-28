import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeSamples } from '../src/model/heightRaster';
import type { TerrainProject } from '../src/model/types';
import { createWorldDefinition } from '../src/model/world';
import { createWorldPreviewGrid } from '../src/engine/worldPreviewPlan';
import { worldSourceSignature } from '../src/engine/worldSourceIdentity';
import { WorldPreviewSession } from '../src/engine/worldPreviewSession';
import { prepareWorldEvaluation } from '../src/engine/world';
import { createWorldRegionStore } from '../src/engine/worldStore';
import { MemoryWorldRegionStorage } from '../src/engine/worldStore/storage';
import type { WorldWorkerResponse } from '../src/hooks/worldProtocol';

afterEach(() => vi.unstubAllGlobals());

function scene(values = [0, 65535, 0, 65535]): TerrainProject {
  const bytes = new Uint8Array(values.length * 2),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return {
    version: 1,
    name: 'Survey',
    seed: 1,
    resolution: 64,
    worldSize: 1000,
    heightScale: 1000,
    presetId: 'test',
    graph: {
      nodes: [
        {
          id: 'source',
          kind: 'heightImport',
          label: 'Survey',
          params: {},
          position: { x: 0, y: 0 },
          raster: {
            name: 'survey.r16',
            width: 2,
            height: 2,
            format: 'u16le',
            data: encodeSamples(bytes),
          },
        },
        { id: 'out', kind: 'output', label: 'Output', params: {}, position: { x: 100, y: 0 } },
      ],
      edges: [{ id: 'edge', source: 'source', target: 'out' }],
    },
  };
}

function request(project = scene()) {
  const world = createWorldDefinition(project);
  world.globalResolution = 64;
  world.domain.cellsX = world.domain.cellsZ = 16;
  return {
    type: 'preview' as const,
    id: 1,
    project,
    world,
    grid: createWorldPreviewGrid(world),
    cache: true,
  };
}

describe('World source content identity', () => {
  it('survives structured cloning and includes source bytes and dimensions without file names', async () => {
    const project = scene(),
      world = createWorldDefinition(project);
    const first = await worldSourceSignature(project, world);
    expect(first.persistentSafe).toBe(true);
    expect(first.signature).toContain('sha256:');
    const clone = structuredClone(project);
    clone.graph.nodes[0].raster = { ...clone.graph.nodes[0].raster!, name: 'renamed.r16' };
    expect(await worldSourceSignature(clone, world)).toEqual(first);
    expect((await worldSourceSignature(scene([1, 65535, 0, 65535]), world)).signature).not.toBe(
      first.signature,
    );
    const rectangular = scene([0, 1, 2, 3, 4, 5]);
    rectangular.graph.nodes[0].raster = {
      ...rectangular.graph.nodes[0].raster!,
      width: 2,
      height: 3,
    };
    const a = await worldSourceSignature(rectangular, world);
    rectangular.graph.nodes[0].raster = {
      ...rectangular.graph.nodes[0].raster!,
      width: 3,
      height: 2,
    };
    expect((await worldSourceSignature(rectangular, world)).signature).not.toBe(a.signature);
  });

  it('reuses prepared imported terrain across worker-message clones and a different region', async () => {
    const prepare = vi.fn(prepareWorldEvaluation);
    const session = new WorldPreviewSession({ prepare });
    const input = request();
    input.cache = false;
    const events: WorldWorkerResponse[] = [];
    await session.run(input, (event) => events.push(event));
    const next = structuredClone(input);
    next.id = 2;
    next.grid = { ...next.grid, startX: 8, cellsX: 8, samplesX: 9 };
    await session.run(next, (event) => events.push(event));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: 'result', id: 2, preparedReused: true });
    session.dispose();
  });

  it('never restores a different raster after a worker restart and reuses identical saved content', async () => {
    class DurableStorage extends MemoryWorldRegionStorage {
      close() {
        /* preserve across connections */
      }
    }
    const storage = new DurableStorage();
    const createStore = () => createWorldRegionStore({ storage });
    const prepare = vi.fn(prepareWorldEvaluation);
    const original = request(),
      changed = request(scene([65535, 0, 65535, 0]));
    const first = new WorldPreviewSession({ createStore, prepare });
    const events: WorldWorkerResponse[] = [];
    await first.run(original, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'result', cacheHit: false });
    first.dispose();
    const second = new WorldPreviewSession({ createStore, prepare });
    await second.run(changed, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'result', cacheHit: false });
    expect(prepare).toHaveBeenCalledTimes(2);
    second.dispose();
    const third = new WorldPreviewSession({ createStore, prepare });
    await third.run(structuredClone(original), (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      cacheHit: true,
      cacheSource: 'persistent',
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    third.dispose();
  });

  it('keeps imported terrain usable without cryptographic caching and rejects oversized hash inputs', async () => {
    vi.stubGlobal('crypto', undefined);
    const input = request();
    expect((await worldSourceSignature(input.project, input.world)).persistentSafe).toBe(false);
    const createStore = vi.fn(createWorldRegionStore);
    const session = new WorldPreviewSession({ createStore });
    const events: WorldWorkerResponse[] = [];
    await session.run(input, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'result', cacheHit: false });
    expect(createStore).not.toHaveBeenCalled();
    session.dispose();
    vi.unstubAllGlobals();
    input.project.graph.nodes[0].raster = { ...input.project.graph.nodes[0].raster!, data: 'bad' };
    await expect(worldSourceSignature(input.project, input.world)).rejects.toThrow(/length/);
    const controller = new AbortController();
    controller.abort();
    await expect(
      worldSourceSignature(scene(), input.world, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
