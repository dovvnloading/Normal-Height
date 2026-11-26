import { describe, expect, it } from 'vitest';
import type { EvaluationResult, GenerateRequest, TerrainProject, WorkerResponse } from '../model/types';
import { TerrainExportClient, type ExportOptions, type ExportState } from './exportClient';
import type { EncodeRequest, EncodeResponse } from './exportProtocol';

class FakeWorker<Request, Response> {
  onmessage: ((event: MessageEvent<Response>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posts: { message: Request; transfer: Transferable[] }[] = [];
  terminated = 0;
  postError?: Error;

  postMessage(message: Request, transfer: Transferable[] = []) {
    if (this.postError) throw this.postError;
    this.posts.push({ message, transfer });
  }
  terminate() { this.terminated++; }
  emit(data: Response) { this.onmessage?.({ data } as MessageEvent<Response>); }
  crash(message = '') { this.onerror?.({ message } as ErrorEvent); }
  unreadable() { this.onmessageerror?.({} as MessageEvent); }
}

const project: TerrainProject = {
  version: 1, name: 'Test terrain', seed: 17, resolution: 512, worldSize: 8000,
  heightScale: 1000, presetId: 'custom', graph: { nodes: [], edges: [] },
};
const options: ExportOptions = {
  project, resolution: 256, format: 'mask16', bundle: true,
  previewNodeId: 'mask-output', memoryBudgetMiB: 512,
};
function result(): EvaluationResult {
  const diagnostic = new Float32Array(4);
  return {
    field: {
      resolution: 2, height: new Float32Array([0, 0.5, 0.75, 1]),
      flow: diagnostic, wear: diagnostic, deposition: diagnostic,
    },
    thumbnails: {}, nodeTimings: {}, duration: 1, outputNodeId: 'mask-output',
    stats: { min: 0, max: 1, mean: 0.5, eroded: 0, deposited: 0, exportedSediment: 0 },
  };
}
function harness() {
  const states: ExportState[] = [];
  const terrains: FakeWorker<GenerateRequest, WorkerResponse>[] = [];
  const encoders: FakeWorker<EncodeRequest, EncodeResponse>[] = [];
  const downloads: { blob: Blob; filename: string }[] = [];
  const faults: { terrain?: Error; encoder?: Error; terrainPost?: Error; encoderPost?: Error; download?: Error } = {};
  const client = new TerrainExportClient(
    () => {
      if (faults.terrain) throw faults.terrain;
      const w = new FakeWorker<GenerateRequest, WorkerResponse>();
      w.postError = faults.terrainPost;
      terrains.push(w);
      return w;
    },
    () => {
      if (faults.encoder) throw faults.encoder;
      const w = new FakeWorker<EncodeRequest, EncodeResponse>();
      w.postError = faults.encoderPost;
      encoders.push(w);
      return w;
    },
    (blob, filename) => {
      if (faults.download) throw faults.download;
      downloads.push({ blob, filename });
    },
    (state) => states.push(state),
  );
  const last = () => states.at(-1);
  const generate = () => {
    const w = terrains.at(-1)!;
    const id = w.posts[0].message.id;
    w.emit({ type: 'result', id, result: result() });
    return id;
  };
  const complete = (id: number) => encoders.at(-1)!.emit({
    type: 'result', id, bytes: new Uint8Array([1, 2, 3]).buffer,
    filename: 'test.zip', mime: 'application/zip',
  });
  return { client, faults, states, terrains, encoders, downloads, last, generate, complete };
}

describe('terrain export lifecycle', () => {
  it('hands off an isolated snapshot, deduplicates transfers and reports actual bytes', async () => {
    const h = harness();
    h.client.start(options);
    h.client.start(options); // a rapid second click cannot create another worker
    expect(h.terrains).toHaveLength(1);
    expect(h.terrains[0].posts[0].message).toMatchObject({
      project, resolution: 256, previewNodeId: 'mask-output',
    });
    const id = h.generate();
    expect(h.terrains[0].terminated).toBe(1);
    expect(h.last()).toMatchObject({ phase: 'encoding' });
    const post = h.encoders[0].posts[0];
    expect(post.message).toMatchObject({
      project, format: 'mask16', outputNodeId: 'mask-output', bundle: true, memoryBudgetMiB: 512,
    });
    if (post.message.type !== 'encode') throw new Error('Expected terrain encode');
    expect(post.transfer).toEqual([post.message.field.height.buffer, post.message.field.flow.buffer]);
    h.complete(id);
    expect(h.encoders[0].terminated).toBe(1);
    expect(h.last()).toEqual({ phase: 'success', filename: 'test.zip', bytes: 3 });
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0].blob.type).toBe('application/zip');
    expect([...new Uint8Array(await h.downloads[0].blob.arrayBuffer())]).toEqual([1, 2, 3]);
    h.complete(id);
    h.encoders[0].crash('late error');
    expect(h.downloads).toHaveLength(1);
    expect(h.last()?.phase).toBe('success');
  });

  it('ignores incorrect ids, clamps progress and ignores replies from the retired terrain phase', () => {
    const h = harness();
    h.client.start(options);
    const worker = h.terrains[0];
    const id = worker.posts[0].message.id;
    worker.emit({ type: 'progress', id: id + 1, progress: 1, stage: 'wrong run' });
    expect(h.last()).toMatchObject({ progress: 0 });
    worker.emit({ type: 'progress', id, progress: 0.6, stage: 'erosion' });
    worker.emit({ type: 'progress', id, progress: 0.2, stage: 'next node' });
    worker.emit({ type: 'progress', id, progress: NaN, stage: 'invalid' });
    expect(h.last()).toMatchObject({ progress: 0.6 });
    worker.emit({ type: 'progress', id, progress: 2, stage: 'done' });
    expect(h.last()).toMatchObject({ progress: 1 });
    h.generate();
    worker.emit({ type: 'error', id, message: 'late failure' });
    worker.emit({ type: 'result', id, result: result() });
    expect(h.encoders).toHaveLength(1);
    expect(h.last()?.phase).toBe('encoding');
    h.complete(id + 1);
    expect(h.downloads).toHaveLength(0);
    h.complete(id);
    expect(h.last()?.phase).toBe('success');
  });

  it('cancels either phase, ignores late replies and retries cleanly', () => {
    const h = harness();
    h.client.start(options);
    const old = h.terrains[0];
    const oldId = old.posts[0].message.id;
    h.client.cancel();
    expect(old.terminated).toBe(1);
    expect(h.last()).toEqual({ phase: 'cancelled' });
    old.emit({ type: 'result', id: oldId, result: result() });
    expect(h.encoders).toHaveLength(0);
    h.client.start(options);
    const id = h.generate();
    const oldEncoder = h.encoders[0];
    h.client.cancel();
    expect(oldEncoder.terminated).toBe(1);
    h.client.start(options);
    const nextId = h.generate();
    oldEncoder.emit({ type: 'result', id, bytes: new ArrayBuffer(1), filename: 'stale.zip', mime: 'application/zip' });
    expect(h.downloads).toHaveLength(0);
    expect(h.last()?.phase).toBe('encoding');
    h.complete(nextId);
    expect(h.last()?.phase).toBe('success');
    expect(h.downloads).toHaveLength(1);
  });

  it.each(['terrain', 'terrainPost', 'encoder', 'encoderPost', 'download'] as const)(
    'recovers from synchronous %s failure without leaving a worker active',
    (fault) => {
      const h = harness();
      h.faults[fault] = new Error('injected failure');
      h.client.start(options);
      if (fault === 'encoder' || fault === 'encoderPost' || fault === 'download') {
        const id = h.generate();
        if (fault === 'download') h.complete(id);
      }
      expect(h.last()).toEqual({ phase: 'error', message: 'injected failure' });
      expect(h.downloads).toHaveLength(0);
      for (const w of [...h.terrains, ...h.encoders]) expect(w.terminated).toBe(1);
      delete h.faults[fault];
      h.client.start(options);
      h.complete(h.generate());
      expect(h.last()?.phase).toBe('success');
    },
  );

  it.each(['terrain', 'encoder'] as const)('handles worker crashes and unreadable messages in %s', (phase) => {
    for (const kind of ['crash', 'unreadable', 'reported'] as const) {
      const h = harness();
      h.client.start(options);
      const id = h.terrains[0].posts[0].message.id;
      if (phase === 'encoder') h.generate();
      const w = phase === 'encoder' ? h.encoders[0] : h.terrains[0];
      if (kind === 'crash') w.crash('worker crashed');
      else if (kind === 'unreadable') w.unreadable();
      else w.emit({ type: 'error', id, message: 'worker reported failure' });
      expect(h.last()?.phase).toBe('error');
      expect(w.terminated).toBe(1);
      expect(h.downloads).toHaveLength(0);
    }
  });

  it('generates seamless assets directly in the cancellable encoding worker without evaluating terrain', () => {
    const h = harness();
    h.client.start({ ...options, format: 'detailTiles', bundle: true, previewNodeId: undefined });
    expect(h.terrains).toHaveLength(0);
    expect(h.encoders).toHaveLength(1);
    expect(h.last()?.phase).toBe('encoding');
    const post = h.encoders[0].posts[0];
    expect(post.message).toMatchObject({ type: 'encodeTiles', resolution: 256, format: 'detailTiles' });
    expect(post.transfer).toEqual([]);
    const id = post.message.id;
    h.client.cancel();
    expect(h.encoders[0].terminated).toBe(1);
    h.complete(id);
    expect(h.downloads).toHaveLength(0);
    h.client.start({ ...options, format: 'detailTiles' });
    h.complete(h.encoders[1].posts[0].message.id);
    expect(h.last()?.phase).toBe('success');
    expect(h.downloads).toHaveLength(1);
  });

  it('disposes silently on close and suppresses queued download callbacks', () => {
    const h = harness();
    h.client.start(options);
    const id = h.generate();
    const count = h.states.length;
    h.client.dispose();
    h.client.dispose();
    h.complete(id);
    h.encoders[0].unreadable();
    expect(h.states).toHaveLength(count);
    expect(h.encoders[0].terminated).toBe(1);
    expect(h.downloads).toHaveLength(0);
  });
});
