import { expect, test } from '@playwright/test';
import { createProject } from '../../src/model/presets';
import { evaluateGraph } from '../../src/engine';
import { colorizeMap } from '../../src/render/maps';
import { encodeRGBA } from '../../src/export/heightmap';

/**
 * Generated source and physically changed terrain are compared at the same
 * grid size and seed; the images are *review evidence*, not photorealism tests.
 */
for (const [preset, sourceNode, erosionNode] of [
  ['alpine', 'warp', 'erosion'],
  ['badlands', 'terrace', 'erosion'],
  ['volcano', 'warp', 'erosion'],
] as const) {
  test(`fluid-grid terrain evidence: ${preset} source, old, new and runoff`,
    async ({}, testInfo) => {
      test.setTimeout(120_000);
      const project = createProject(preset);
      const n = 256;
      const source = evaluateGraph(project, {
        resolution: n, previewNodeId: sourceNode,
      }).field;
      const selected = project.graph.nodes.find(node => node.id === erosionNode)!;
      const oldMethod = selected.params.method;
      selected.params.method = 'landscape';
      const old = evaluateGraph(project, {
        resolution: n, previewNodeId: erosionNode,
      }).field;
      selected.params.method = 'fluid';
      selected.params.cycles = 28;
      const fresh = evaluateGraph(project, {
        resolution: n, previewNodeId: erosionNode,
      }).field;
      selected.params.method = oldMethod;

      const attach = async (label: string, pixels: Uint8ClampedArray) => {
        await testInfo.attach(`${preset}-${label}.png`, {
          body: Buffer.from(encodeRGBA(pixels, n)),
          contentType: 'image/png',
        });
      };
      for (const [name, terrain, channel] of [
        ['source-height', source, 'height'],
        ['source-relief', source, 'terrain'],
        ['prior-evolution-height', old, 'height'],
        ['new-fluid-height', fresh, 'height'],
        ['new-fluid-relief', fresh, 'terrain'],
        ['new-fluid-runoff', fresh, 'flow'],
        ['new-fluid-wear', fresh, 'wear'],
        ['new-fluid-deposition', fresh, 'deposition'],
      ] as const)
        await attach(name, colorizeMap(terrain, channel,
          project.worldSize, project.heightScale));

      const delta = new Uint8ClampedArray(n * n * 4);
      let meanCut = 0, meanAbsolute = 0, peak = 0, largest = 0;
      for (let i = 0; i < source.height.length; i++) {
        const d = source.height[i] - fresh.height[i];
        meanCut += d;
        meanAbsolute += Math.abs(d);
        largest = Math.max(largest, Math.abs(d));
        peak = Math.max(peak, fresh.height[i]);
      }
      for (let i = 0; i < source.height.length; i++) {
        const d = source.height[i] - fresh.height[i];
        const brightness = Math.round(Math.min(255, Math.abs(d) /
          Math.max(largest, 1e-9) * 255));
        const p = i * 4;
        delta[p] = d > 0 ? brightness : 0;
        delta[p + 1] = d < 0 ? brightness : 0;
        delta[p + 2] = 0;
        delta[p + 3] = 255;
      }
      await attach('physical-height-difference', delta);
      await testInfo.attach(`${preset}-fluid-metrics.json`, {
        body: Buffer.from(JSON.stringify({
          preset, meanSignedCut: meanCut / (n * n),
          meanAbsoluteHeightChange: meanAbsolute / (n * n),
          maximumAbsoluteHeightChange: largest,
          remainingPeakHeight: peak,
          caveat: 'These metrics are differences, not a score of realism',
        }, null, 2)),
        contentType: 'application/json',
      });
      expect(meanAbsolute / (n * n)).toBeGreaterThan(0.00001);
      expect(fresh.height.every(Number.isFinite)).toBe(true);
      expect(fresh.flow.some(value => value > 0)).toBe(true);
    });
}
