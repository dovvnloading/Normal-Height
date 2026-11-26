import { importHeightRaster } from './heightmap';
import type { HeightRaster } from '../model/heightRaster';
import type { RawLayout } from './rawLayout';

export interface ImportRequest {
  file: File;
  rawLayout?: RawLayout;
}

export type ImportReply = { raster: HeightRaster } | { error: string };
self.onmessage = async (event: MessageEvent<ImportRequest>) => {
  try {
    const { file, rawLayout } = event.data;
    self.postMessage({ raster: await importHeightRaster(file, rawLayout) } satisfies ImportReply);
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'The heightmap could not be read.',
    } satisfies ImportReply);
  }
};
