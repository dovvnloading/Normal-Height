import { expect, test } from '@playwright/test';
import { createProject } from '../../src/model/presets';
import { evaluateGraph } from '../../src/engine';
import { colorizeMap } from '../../src/render/maps';
import { encodeRGBA } from '../../src/export/heightmap';

/**
 * Deterministic *visual evidence*, not a claim of photorealism.
 * Render input and erosion-result heightfields, plus a runoff network and
 * actual positive/negative sediment changes. GitHub Actions preserves these
 * PNGs as build artifacts for human review of each landscape profile.
 */
for (const [preset, source, erosionNode] of [
  ['alpine', 'warp', 'erosion'],
  ['badlands', 'terrace', 'erosion'],
  ['volcano', 'warp', 'erosion'],
] as const) {
  test(`watershed geometry evidence: ${preset} before/after, catchments, sediment`,
    async ({}, testInfo) => {
      test.setTimeout(90_000);
      const project = createProject(preset);
      const resolution = 256;
      project.resolution = resolution;
      const before = evaluateGraph(project, { resolution, previewNodeId: source }).field;
      const after = evaluateGraph(project, { resolution, previewNodeId: erosionNode }).field;
      // Keep an apples-to-apples view of the immediately preceding watershed
      // algorithm. Both results receive the same source terrain and settings.
      const erosion = project.graph.nodes.find(node => node.id === erosionNode)!;
      const method = erosion.params.method;
      erosion.params.method = 'watershed';
      const earlier = evaluateGraph(project, { resolution, previewNodeId: erosionNode }).field;
      erosion.params.method = method;
      const attach = async (name: string, pixels: Uint8ClampedArray) => {
        await testInfo.attach(`${preset}-${name}.png`, {
          body: Buffer.from(encodeRGBA(pixels, resolution)),
          contentType: 'image/png',
        });
      };
      await attach('source-shaded', colorizeMap(before, 'terrain',
        project.worldSize, project.heightScale));
      await attach('landscape-evolution-shaded', colorizeMap(after, 'terrain',
        project.worldSize, project.heightScale));
      await attach('previous-watershed-shaded', colorizeMap(earlier, 'terrain',
        project.worldSize, project.heightScale));
      await attach('runoff-flow', colorizeMap(after, 'flow',
        project.worldSize, project.heightScale));
      await attach('erosion-wear', colorizeMap(after, 'wear',
        project.worldSize, project.heightScale));
      await attach('sediment-deposition', colorizeMap(after, 'deposition',
        project.worldSize, project.heightScale));

      const changed = new Uint8ClampedArray(resolution * resolution * 4);
      let totalDifferenceFromPrevious = 0;
      for (let i = 0; i < after.height.length; i++)
        totalDifferenceFromPrevious += Math.abs(after.height[i] - earlier.height[i]);
      let incised = 0, deposited = 0, largest = 0;
      for (let i = 0; i < before.height.length; i++) {
        const d = before.height[i] - after.height[i];
        largest = Math.max(largest, Math.abs(d));
        if (d > 0.000001) incised++;
        if (d < -0.000001) deposited++;
      }
      for (let i = 0; i < before.height.length; i++) {
        const delta = before.height[i] - after.height[i];
        const intensity = Math.min(255, Math.round(Math.abs(delta) /
          Math.max(1e-8, largest) * 255));
        const p = i * 4;
        changed[p] = delta > 0 ? intensity : 0;
        changed[p + 1] = delta < 0 ? intensity : 0;
        changed[p + 2] = 0;
        changed[p + 3] = 255;
      }
      await attach('difference-red-incision-green-deposition', changed);
      await testInfo.attach(`${preset}-watershed-metrics.json`, {
        body: Buffer.from(JSON.stringify({
          preset, resolution, incised, deposited,
          meanAbsoluteDifferenceFromPreviousWatershed:
            totalDifferenceFromPrevious / after.height.length,
          maximumAbsoluteHeightChange: largest,
          note: 'Positive-red is erosion; green is deposition; colors scaled by the largest delta for visual review',
        }, null, 2)),
        contentType: 'application/json',
      });
      expect(incised).toBeGreaterThan(10);
      expect(totalDifferenceFromPrevious / after.height.length).toBeGreaterThan(0.000001);
      expect(largest).toBeGreaterThan(0.00001);
      expect(after.flow.some(v => v > 0.5)).toBe(true);
      expect(after.wear.some(v => v > 0)).toBe(true);
      expect(after.height.every(Number.isFinite)).toBe(true);
    });
}
