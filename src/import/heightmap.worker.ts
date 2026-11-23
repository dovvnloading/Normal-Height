import { importHeightRaster } from './heightmap';
import type { HeightRaster } from '../model/heightRaster';

export type ImportReply = { raster: HeightRaster } | { error: string };
self.onmessage = async (event: MessageEvent<File>) => {
  try {
    self.postMessage({ raster: await importHeightRaster(event.data) } satisfies ImportReply);
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'The heightmap could not be read.',
    } satisfies ImportReply);
  }
};
