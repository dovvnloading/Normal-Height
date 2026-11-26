import { describe, expect, it } from 'vitest';
import { createNode } from '../model/registry';
import { createWorldDefinition } from '../model/world';
import type { TerrainProject } from '../model/types';
import type {
  WorldExportManifest,
  WorldExportOptions,
  WorldExportRequest,
  WorldExportResponse,
} from './worldExport';
import {
  WorldExportClient,
  type WorldExportState,
  type WorldFileHandle,
  type WorldFileWriter,
} from './worldExportClient';

function options(): WorldExportOptions {
  const source = createNode('noise', { x: 0, y: 0 }, 'source');
  source.params = { ...source.params, noiseModel: 'v3' };
  const output = createNode('output', { x: 300, y: 0 }, 'output');
  const project: TerrainProject = {
    version: 1,
    name: 'Export lifecycle',
    seed: 7,
    resolution: 64,
    worldSize: 1024,
    heightScale: 100,
    presetId: 'custom',
    graph: {
      nodes: [source, output],
      edges: [
        {
          id: 'edge',
          source: source.id,
          target: output.id,
          sourceHandle: 'height',
          targetHandle: 'in',
        },
      ],
    },
  };
  const world = createWorldDefinition(project);
  world.globalResolution = 64;
  world.tileCells = 32;
  return { project, world, samplesX: 256, samplesZ: 256, profile: 'generic', format: 'raw32' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

class Worker {
  onmessage: ((event: MessageEvent<WorldExportResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  messages: WorldExportRequest[] = [];
  terminated = 0;
  postError?: Error;
  postMessage(message: WorldExportRequest) {
    if (this.postError) throw this.postError;
    this.messages.push(message);
  }
  terminate() {
    this.terminated++;
  }
  emit(data: WorldExportResponse) {
    this.onmessage?.({ data } as MessageEvent<WorldExportResponse>);
  }
}

const manifest = { manifestVersion: 1, tiles: [] } as unknown as WorldExportManifest;
function harness() {
  const states: WorldExportState[] = [];
  const workers: Worker[] = [];
  const pickers: ReturnType<typeof deferred<WorldFileHandle>>[] = [];
  const downloads: { blob: Blob; filename: string }[] = [];
  const faults: Partial<
    Record<'worker' | 'post' | 'download' | 'picker' | 'open' | 'write' | 'close', Error>
  > = {};
  const calls = { open: 0, write: 0, close: 0, abort: 0 };
  let openGate: ReturnType<typeof deferred<WorldFileWriter>> | null = null;
  let writeGate: ReturnType<typeof deferred<void>> | null = null;
  let closeGate: ReturnType<typeof deferred<void>> | null = null;
  let time = 1000;
  const writer: WorldFileWriter = {
    async write() {
      calls.write++;
      if (faults.write) throw faults.write;
      await writeGate?.promise;
    },
    async close() {
      calls.close++;
      if (faults.close) throw faults.close;
      await closeGate?.promise;
    },
    async abort() {
      calls.abort++;
    },
  };
  const client = new WorldExportClient(
    () => {
      if (faults.worker) throw faults.worker;
      const worker = new Worker();
      worker.postError = faults.post;
      workers.push(worker);
      return worker;
    },
    () => {
      if (faults.picker) return Promise.reject(faults.picker);
      const pending = deferred<WorldFileHandle>();
      pickers.push(pending);
      return pending.promise;
    },
    (blob, filename) => {
      if (faults.download) throw faults.download;
      downloads.push({ blob, filename });
    },
    (state) => states.push(state),
    () => time,
  );
  const pick = (index = pickers.length - 1) =>
    pickers[index].resolve({
      async createWritable() {
        calls.open++;
        if (faults.open) throw faults.open;
        return openGate ? openGate.promise : writer;
      },
    });
  const last = () => states.at(-1);
  const active = () => {
    const worker = workers.at(-1)!;
    return { worker, id: worker.messages[0].id };
  };
  const chunk = (bytes = new Uint8Array([1, 2, 3]).buffer, sequence = 0) => {
    const { worker, id } = active();
    worker.emit({ type: 'chunk', id, sequence, bytes });
  };
  const complete = () => {
    const { worker, id } = active();
    time += 25;
    worker.emit({ type: 'complete', id, filename: 'world.zip', manifest });
  };
  return {
    client,
    states,
    workers,
    pickers,
    downloads,
    faults,
    calls,
    writer,
    pick,
    last,
    active,
    chunk,
    complete,
    holdOpen() {
      openGate = deferred<WorldFileWriter>();
      return openGate;
    },
    holdWrite() {
      writeGate = deferred<void>();
      return writeGate;
    },
    holdClose() {
      closeGate = deferred<void>();
      return closeGate;
    },
  };
}

describe('World package lifecycle', () => {
  it('reserves before the picker and freezes the authored graph and world settings', async () => {
    const h = harness(),
      request = options();
    h.client.start(request, 'file');
    h.client.start(request, 'file');
    expect(h.pickers).toHaveLength(1);
    expect(h.client.busy).toBe(true);
    expect(h.workers).toHaveLength(0);
    request.world.domain.width = 9999;
    request.project.name = 'Changed while choosing';
    request.project.graph.nodes[0].params.scale = 999;
    h.pick();
    await settle();
    const message = h.active().worker.messages[0];
    expect(message.type).toBe('export');
    if (message.type !== 'export') throw new Error('Missing export request');
    expect(message.options.world.domain.width).toBe(1024);
    expect(message.options.project.name).toBe('Export lifecycle');
    expect(message.options.project.graph.nodes[0].params.scale).not.toBe(999);
    h.client.cancel();
  });

  it('shows counted work within a phase and keeps unknown-duration stages indeterminate', () => {
    const h = harness();
    h.client.start(options());
    const { worker, id } = h.active();
    worker.emit({
      type: 'progress',
      id: id + 1,
      progress: 1,
      stage: 'wrong',
      detail: { phase: 'range', completed: 5, total: 5 },
    });
    expect(h.last()).toMatchObject({ stage: 'Preparing world package', progress: null });
    worker.emit({
      type: 'progress',
      id,
      progress: 0.9,
      stage: 'Global solve',
      detail: { phase: 'prepare' },
    });
    expect(h.last()).toMatchObject({ phase: 'preparing', progress: null });
    worker.emit({
      type: 'progress',
      id,
      progress: 0.3,
      stage: 'Range pass',
      detail: { phase: 'range', completed: 2, total: 5 },
    });
    expect(h.last()).toMatchObject({ phase: 'range', progress: 0.4, completed: 2, total: 5 });
    worker.emit({
      type: 'progress',
      id,
      progress: 1,
      stage: 'Packing',
      detail: { phase: 'archive', completed: 1, total: 1 },
    });
    expect(h.last()).toMatchObject({ phase: 'packing', progress: null });
    h.client.cancel();
  });

  it('serializes finalization behind the write and only acknowledges persisted chunks', async () => {
    const h = harness(),
      write = h.holdWrite();
    h.client.start(options(), 'file');
    h.pick();
    await settle();
    h.chunk();
    h.complete();
    await settle();
    expect(h.calls.write).toBe(1);
    expect(h.calls.close).toBe(0);
    expect(h.active().worker.messages.filter((message) => message.type === 'ack')).toHaveLength(0);
    write.resolve();
    await settle();
    expect(h.calls.close).toBe(1);
    expect(h.calls.abort).toBe(0);
    expect(h.active().worker.messages.filter((message) => message.type === 'ack')).toHaveLength(1);
    expect(h.last()).toMatchObject({
      status: 'success',
      receipt: { bytes: 3, filename: 'world.zip', sink: 'file', durationMs: 25 },
    });
    expect(h.workers[0].terminated).toBe(1);
    expect(h.client.busy).toBe(false);
  });

  it('downloads real bytes once, ignores late replies and releases the worker', async () => {
    const h = harness();
    h.client.start(options());
    const { worker, id } = h.active();
    h.chunk();
    h.complete();
    await settle();
    expect(h.downloads).toHaveLength(1);
    expect([...new Uint8Array(await h.downloads[0].blob.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(h.last()).toMatchObject({ status: 'success', receipt: { bytes: 3, sink: 'memory' } });
    worker.emit({ type: 'complete', id, filename: 'late.zip', manifest });
    worker.onerror?.({ message: 'late crash' } as ErrorEvent);
    await settle();
    expect(h.downloads).toHaveLength(1);
    expect(worker.terminated).toBe(1);
    expect(h.last()?.status).toBe('success');
  });

  it('never opens a writable after cancellation while choosing', async () => {
    const h = harness();
    h.client.start(options(), 'file');
    h.client.cancel();
    h.pick();
    await settle();
    expect(h.calls.open).toBe(0);
    expect(h.workers).toHaveLength(0);
    expect(h.last()?.status).toBe('cancelled');
    h.client.retry();
    expect(h.pickers).toHaveLength(2);
    h.pick();
    await settle();
    h.chunk();
    h.complete();
    await settle();
    expect(h.last()?.status).toBe('success');
  });

  it('aborts a writable that resolves after cancellation', async () => {
    const h = harness(),
      open = h.holdOpen();
    h.client.start(options(), 'file');
    h.pick();
    await settle();
    expect(h.calls.open).toBe(1);
    h.client.cancel();
    open.resolve(h.writer);
    await settle();
    expect(h.calls.abort).toBe(1);
    expect(h.workers).toHaveLength(0);
    expect(h.last()?.status).toBe('cancelled');
  });

  it('suppresses a late write rejection and stale ACK after another job starts', async () => {
    const h = harness(),
      write = h.holdWrite();
    h.client.start(options(), 'file');
    h.pick();
    await settle();
    const old = h.active();
    h.chunk();
    await settle();
    h.client.cancel();
    expect(h.calls.abort).toBe(1);
    h.client.start(options());
    const next = h.active();
    write.reject(new Error('late write failure'));
    await settle();
    expect(old.worker.messages.filter((message) => message.type === 'ack')).toHaveLength(0);
    expect(h.last()).toMatchObject({ status: 'running', id: next.id });
    h.chunk();
    h.complete();
    await settle();
    expect(h.last()?.status).toBe('success');
  });

  it('cancels final file close without publishing late success', async () => {
    const h = harness(),
      close = h.holdClose();
    h.client.start(options(), 'file');
    h.pick();
    await settle();
    h.chunk();
    h.complete();
    await settle();
    expect(h.last()).toMatchObject({ status: 'running', phase: 'saving' });
    h.client.cancel();
    close.resolve();
    await settle();
    expect(h.last()?.status).toBe('cancelled');
    expect(h.calls.abort).toBe(1);
    expect(h.downloads).toHaveLength(0);
  });

  it.each(['worker', 'post', 'download', 'picker', 'open', 'write', 'close'] as const)(
    'recovers from %s failure and retries the captured package',
    async (fault) => {
      const h = harness();
      h.faults[fault] = new Error(`injected ${fault}`);
      const file = ['picker', 'open', 'write', 'close'].includes(fault);
      h.client.start(options(), file ? 'file' : 'memory');
      if (file && fault !== 'picker') {
        h.pick();
        await settle();
      }
      if (['write', 'close', 'download'].includes(fault)) {
        h.chunk();
        h.complete();
      }
      await settle();
      expect(h.last()).toMatchObject({ status: 'error', message: `injected ${fault}` });
      expect(h.client.busy).toBe(false);
      expect(h.downloads).toHaveLength(0);
      expect(h.workers.every((worker) => worker.terminated === 1)).toBe(true);
      delete h.faults[fault];
      h.client.retry();
      if (file) {
        h.pick();
        await settle();
      }
      h.chunk();
      h.complete();
      await settle();
      expect(h.last()?.status).toBe('success');
    },
  );

  it('rejects unsupported graphs before any picker or worker is created', () => {
    const h = harness(),
      request = options();
    request.project.graph.nodes[0].kind = 'heightImport';
    h.client.start(request, 'file');
    expect(h.last()?.status).toBe('error');
    expect(h.pickers).toHaveLength(0);
    expect(h.workers).toHaveLength(0);
    expect(h.client.busy).toBe(false);
  });

  it('fails unreadable worker messages and out-of-order chunks without a corrupted download', async () => {
    for (const fault of ['unreadable', 'order'] as const) {
      const h = harness();
      h.client.start(options());
      if (fault === 'unreadable') h.active().worker.onmessageerror?.({} as MessageEvent);
      else h.chunk(new ArrayBuffer(3), 1);
      await settle();
      expect(h.last()?.status).toBe('error');
      expect(h.client.busy).toBe(false);
      expect(h.downloads).toHaveLength(0);
      expect(h.workers[0].terminated).toBe(1);
    }
  });

  it('unmounts silently and does not open a late picker result', async () => {
    const h = harness();
    h.client.start(options(), 'file');
    const count = h.states.length;
    h.client.dispose();
    h.client.dispose();
    h.pick();
    await settle();
    expect(h.states).toHaveLength(count);
    expect(h.calls.open).toBe(0);
    expect(h.client.busy).toBe(false);
  });
});
