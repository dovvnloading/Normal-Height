import { describe, expect, it, vi } from 'vitest';
import { createHeightImportClient } from './heightImportClient';
import type { ImportReply } from './heightmap.worker';
import type { HeightRaster } from '../model/heightRaster';

class FakeWorker {
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  reply(data: ImportReply) {
    this.onmessage?.call(this as unknown as Worker, new MessageEvent('message', { data }));
  }
}

const raster: HeightRaster = { name: 'survey.r16', width: 2, height: 2, format: 'u16le', data: 'AAAAAAAAAAA=' };
const request = { file: new File([new Uint8Array(8)], raster.name) };

describe('heightmap import worker lifecycle', () => {
  it('reports success exactly once and releases the worker before publishing the raster', () => {
    const worker = new FakeWorker();
    const client = createHeightImportClient(() => worker);
    const result = vi.fn(() => expect(worker.terminate).toHaveBeenCalledOnce());
    const error = vi.fn();
    client.start(request, result, error);
    expect(worker.postMessage).toHaveBeenCalledWith(request);
    const late = worker.onmessage!;
    worker.reply({ raster });
    late.call(worker as unknown as Worker, new MessageEvent('message', { data: { raster } }));
    expect(result).toHaveBeenCalledExactlyOnceWith(raster);
    expect(error).not.toHaveBeenCalled();
    expect(worker.onmessage).toBeNull();
    client.cancel();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('ignores messages and errors from cancelled and superseded tasks', () => {
    const workers = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
    let index = 0;
    const client = createHeightImportClient(() => workers[index++]);
    const result = vi.fn();
    const error = vi.fn();
    client.start(request, result, error);
    const stale = workers[0].onmessage!;
    const staleError = workers[0].onerror!;
    client.start(request, result, error);
    stale.call(workers[0] as unknown as Worker, new MessageEvent('message', { data: { raster } }));
    staleError.call(workers[0] as unknown as Worker, { message: 'late', preventDefault: vi.fn() } as unknown as ErrorEvent);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const cancelled = workers[1].onmessage!;
    client.cancel();
    cancelled.call(workers[1] as unknown as Worker, new MessageEvent('message', { data: { error: 'late' } }));
    expect(workers[1].terminate).toHaveBeenCalledOnce();
    expect(result).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    client.start(request, result, error);
    workers[2].reply({ raster });
    expect(result).toHaveBeenCalledExactlyOnceWith(raster);
  });

  it('reports synchronous worker creation failures without throwing', () => {
    const client = createHeightImportClient(() => { throw new Error('worker blocked'); });
    const error = vi.fn();
    const result = vi.fn();
    expect(() => client.start(request, result, error)).not.toThrow();
    expect(error).toHaveBeenCalledExactlyOnceWith('worker blocked');
    expect(result).not.toHaveBeenCalled();
    client.cancel();
  });

  it('cleans up when posting the file throws', () => {
    const worker = new FakeWorker();
    worker.postMessage.mockImplementation(() => { throw new Error('cannot clone'); });
    const client = createHeightImportClient(() => worker);
    const error = vi.fn();
    client.start(request, vi.fn(), error);
    expect(error).toHaveBeenCalledExactlyOnceWith('cannot clone');
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
  });

  it.each(['reply', 'error', 'messageerror'] as const)('cleans up asynchronous %s failures', (mode) => {
    const worker = new FakeWorker();
    const client = createHeightImportClient(() => worker);
    const error = vi.fn();
    const result = vi.fn();
    client.start(request, result, error);
    const preventDefault = vi.fn();
    if (mode === 'reply') worker.reply({ error: 'invalid raster' });
    else if (mode === 'error') worker.onerror?.call(worker as unknown as Worker, { message: 'reader crashed', preventDefault } as unknown as ErrorEvent);
    else worker.onmessageerror?.call(worker as unknown as Worker, new MessageEvent('messageerror'));
    expect(error).toHaveBeenCalledOnce();
    expect(result).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
    if (mode === 'error') expect(preventDefault).toHaveBeenCalledOnce();
  });
});
