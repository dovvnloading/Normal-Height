import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrushFeedback } from './brushFeedback';
import { requestPBR } from '../materials/pbrClient';
import type { PBRMaps } from '../materials/pbr';
import type { MaterialStroke } from '../materials/materialPaint';
import { createPaintLayer, getPaintStrokes } from '../materials/paintLayers';
import { createProject } from '../model/presets';
import { createNode } from '../model/registry';
import type { HeightField, TerrainProject } from '../model/types';

vi.mock('../materials/pbrClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../materials/pbrClient')>()),
  requestPBR: vi.fn(),
}));

interface PreviewJob {
  field: HeightField;
  project: TerrainProject;
  release: ReturnType<typeof vi.fn>;
  resolve: (maps: PBRMaps) => void;
  reject: (error: Error) => void;
}
const jobs: PreviewJob[] = [];
const workers: GuideWorker[] = [];
class GuideWorker {
  onmessage?: (event: { data: { pixels: Uint8ClampedArray; resolution: number } }) => void;
  onerror?: (event: unknown) => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    workers.push(this);
  }
  complete() {
    this.onmessage?.({ data: { resolution: 2, pixels: new Uint8ClampedArray(16) } });
  }
}
const project = createProject();
function field(resolution = 17): HeightField {
  return {
    resolution,
    height: new Float32Array(resolution * resolution).fill(0.4),
    flow: new Float32Array(resolution * resolution),
    wear: new Float32Array(resolution * resolution),
    deposition: new Float32Array(resolution * resolution),
  };
}
const snow: MaterialStroke = {
  layer: 'snow',
  radius: 0.1,
  hardness: 0.5,
  strength: 1,
  points: [{ u: 0.5, v: 0.5 }],
};
function maps(resolution = 17): PBRMaps {
  return {
    resolution,
    basecolor: new Uint8ClampedArray(resolution * resolution * 4),
    splat: new Uint8ClampedArray(resolution * resolution * 4),
    roughness: new Uint8Array(resolution * resolution),
    ao: new Uint8Array(resolution * resolution),
    curvature: new Uint8Array(resolution * resolution),
    detail: new Float32Array(resolution * resolution),
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
let feedbacks: BrushFeedback[] = [];
function brush(dem = field()) {
  const feedback = new BrushFeedback();
  feedback.configure(dem, project, 'paint-base');
  feedbacks.push(feedback);
  return feedback;
}

beforeEach(() => {
  vi.useFakeTimers();
  jobs.length = 0;
  workers.length = 0;
  feedbacks = [];
  vi.stubGlobal('Worker', GuideWorker);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  vi.stubGlobal(
    'Path2D',
    class {
      moveTo() {}
      lineTo() {}
      closePath() {}
      rect() {}
    },
  );
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        clip: vi.fn(),
        stroke: vi.fn(),
        setLineDash: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        drawImage: vi.fn(),
        putImageData: vi.fn(),
        createImageData: (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
      }),
    }),
  });
  vi.mocked(requestPBR).mockReset();
  vi.mocked(requestPBR).mockImplementation((dem, scene) => {
    let resolve!: (value: PBRMaps) => void, reject!: (error: Error) => void;
    const promise = new Promise<PBRMaps>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const release = vi.fn();
    jobs.push({ field: dem, project: scene, resolve, reject, release });
    return { promise, release };
  });
});
afterEach(() => {
  for (const feedback of feedbacks) feedback.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live brush preview lifecycle', () => {
  it('lets the map finish while keeping the same committed mark visible in the slower 3D consumer', async () => {
    const feedback = brush();
    feedback.registerConsumer('map');
    feedback.registerConsumer('scene');
    expect(feedback.begin()).toBe(true);
    feedback.preview([snow]);
    await vi.advanceTimersByTimeAsync(100);
    jobs[0].resolve(maps());
    await flush();
    const live = feedback.liveFor('scene');
    expect(live).not.toBeNull();
    feedback.finish(true);
    feedback.baked([snow], 'map');
    expect(feedback.hasMarksFor('map')).toBe(false);
    expect(feedback.liveFor('map')).toBeNull();
    expect(feedback.hasMarksFor('scene')).toBe(true);
    expect(feedback.liveFor('scene')).toBe(live);
    expect(feedback.status).toBe('Refining material…');
    feedback.baked([snow], 'scene');
    expect(feedback.hasMarks).toBe(false);
    expect(feedback.liveFor('scene')).toBeNull();
    expect(feedback.status).toBe('Ready to paint');
  });

  it('never resurrects a cancelled gesture from a late worker result', async () => {
    const feedback = brush();
    feedback.registerConsumer('map');
    feedback.begin();
    feedback.preview([snow]);
    await vi.advanceTimersByTimeAsync(100);
    feedback.finish(false);
    expect(jobs[0].release).toHaveBeenCalled();
    jobs[0].resolve(maps());
    await flush();
    expect(feedback.liveFor('map')).toBeNull();
    expect(feedback.hasMarks).toBe(false);
    expect(feedback.drawing).toBe(false);
    const rock = { ...snow, layer: 'rock' as const };
    feedback.begin();
    feedback.preview([rock]);
    await vi.advanceTimersByTimeAsync(100);
    jobs[1].resolve(maps());
    await flush();
    expect(getPaintStrokes(feedback.liveFor('map')!.project).map((stroke) => stroke.layer)).toEqual(
      ['rock'],
    );
  });

  it('removes undone marks and rejects any late preview belonging to that history revision', async () => {
    const dem = field(),
      feedback = brush(dem);
    feedback.registerConsumer('scene');
    feedback.begin();
    feedback.preview([snow]);
    feedback.finish(true);
    feedback.configure(dem, { ...project, materialPaint: [snow] }, 'paint-base');
    await vi.advanceTimersByTimeAsync(100);
    feedback.configure(dem, project, 'paint-base');
    jobs[0].resolve(maps());
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(feedback.hasMarksFor('scene')).toBe(false);
    expect(feedback.liveFor('scene')).toBeNull();
    expect(feedback.status).toBe('Ready to paint');
    expect(jobs).toHaveLength(1);
  });

  it('rejects an older material revision while a committed stroke waits for its final bake', async () => {
    const dem = field(),
      feedback = brush(dem);
    feedback.registerConsumer('scene');
    feedback.begin();
    feedback.preview([snow]);
    feedback.finish(true);
    const painted = { ...project, materialPaint: [snow] };
    feedback.configure(dem, painted, 'paint-base');
    await vi.advanceTimersByTimeAsync(100);
    const recolored = {
      ...painted,
      surface: { ...painted.surface!, layerColors: { snow: '#0000ff' } },
    };
    feedback.configure(dem, recolored, 'paint-base');
    jobs[0].resolve(maps());
    await flush();
    expect(feedback.liveFor('scene')).toBeNull();
    expect(jobs[0].release).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(jobs).toHaveLength(2);
    jobs[1].resolve(maps());
    await flush();
    expect(feedback.liveFor('scene')?.project.surface?.layerColors?.snow).toBe('#0000ff');
  });

  it('snapshots mutable stroke points and bounds interactive baking independently of final resolution', async () => {
    const feedback = brush(field(512));
    feedback.registerConsumer('map');
    const stroke = { ...snow, points: [{ u: 0.2, v: 0.2 }] };
    feedback.begin();
    feedback.preview([stroke]);
    await vi.advanceTimersByTimeAsync(100);
    stroke.points.push({ u: 0.8, v: 0.8 });
    expect(getPaintStrokes(jobs[0].project)[0].points).toEqual([{ u: 0.2, v: 0.2 }]);
    expect(jobs[0].field.resolution).toBeLessThanOrEqual(192);
    expect(jobs[0].field.height).toHaveLength(jobs[0].field.resolution ** 2);
  });

  it('releases pending work when the final consumer leaves and cancels workers/timers on disposal', async () => {
    const dem = field(),
      feedback = brush(dem);
    const release = feedback.registerConsumer('map');
    feedback.begin();
    feedback.preview([snow]);
    feedback.finish(true);
    await vi.advanceTimersByTimeAsync(100);
    release();
    expect(feedback.hasMarks).toBe(false);
    expect(jobs[0].release).toHaveBeenCalled();
    const listener = vi.fn();
    feedback.subscribe(listener);
    feedback.setGuides(dem, project, [{ slope: [0, 30] }], null, true);
    const worker = workers[0];
    feedback.begin();
    feedback.preview([snow]);
    feedback.dispose();
    const notifications = listener.mock.calls.length;
    jobs[0].resolve(maps());
    worker.complete();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(notifications);
    expect(worker.terminate).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(feedback.hasMarks).toBe(false);
    expect(jobs).toHaveLength(1);
  });

  it('omits imported rasters and paint history from guides while keeping physical mask settings', () => {
    const dem = field(),
      feedback = brush(dem),
      source = createNode('heightImport');
    source.raster = {
      name: 'Imported terrain',
      width: 2,
      height: 2,
      format: 'u16le',
      data: 'AAAAAP////8=',
    };
    const imported: TerrainProject = {
      ...project,
      worldSize: 1600,
      heightScale: 800,
      seed: 47,
      graph: { nodes: [source], edges: [] },
      materialPaint: [snow],
      paintLayers: [{ ...createPaintLayer('Snow', 'paint-base'), strokes: [snow] }],
    };
    feedback.configure(dem, imported, 'paint-base');
    const mask = { elevation: [100, 400] as [number, number], breakup: 0.4, scale: 24 };
    feedback.setGuides(dem, imported, [mask], null, true);
    const payload = workers[0].postMessage.mock.calls[0][0];
    expect(payload.project).toMatchObject({
      worldSize: 1600,
      heightScale: 800,
      seed: 47,
      graph: { nodes: [], edges: [] },
    });
    expect(payload.project.materialPaint).toBeUndefined();
    expect(payload.project.paintLayers).toBeUndefined();
    expect(payload.masks).toEqual([mask]);
    expect(imported.graph.nodes[0].raster).toBe(source.raster);
    expect(imported.paintLayers![0].strokes).toEqual([snow]);
  });

  it('does not let a late guide-worker error disconnect a newer guide request', () => {
    const dem = field(),
      feedback = brush(dem);
    feedback.setGuides(dem, project, [{ slope: [0, 30] }], null, true);
    const previous = workers[0];
    feedback.setGuides(dem, project, [{ slope: [30, 90] }], null, true);
    const current = workers[1],
      revision = feedback.guideRevision;
    expect(previous.terminate).toHaveBeenCalled();
    previous.onerror?.({ message: 'late worker error' });
    current.complete();
    expect(feedback.guideRevision).toBeGreaterThan(revision);
    expect(current.terminate).toHaveBeenCalled();
  });
});
