import { buildDifferenceMap } from './compareMap';
import type { DifferenceMapInput } from './compareMap';

/**
 * Compute signed physical elevation changes on an isolated worker.
 * Source Float32 arrays are transferred copies; the live terrain field and
 * currently displayed 3D mesh remain untouched.
 */
self.onmessage = (event: MessageEvent<DifferenceMapInput>) => {
  const result = buildDifferenceMap(event.data);
  self.postMessage(result, { transfer: [result.pixels.buffer] });
};
