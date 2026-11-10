import { expect, test } from '@playwright/test';
import { createProject } from '../../src/model/presets';
import { evaluateGraph } from '../../src/engine';
import { colorizeMap } from '../../src/render/maps';
import { encodeRGBA } from '../../src/export/heightmap';

/**
 * Genuine untextured heightfield evidence. The pictures are derived directly
 * from the graph's Float32 samples, not generated image references.
 */
for (const [preset, mountainId] of [
  ['alpine', 'range'],
  ['highlands', 'range'],
] as const) {
  test(`orogenic terrain geometry: ${preset} compared to the classic source`,
    async ({}, testInfo) => {
      test.setTimeout(120_000);
      const project = createProject(preset);
      const n = 384;
      project.resolution = n;
      const mountain = project.graph.nodes.find(node => node.id === mountainId)!;
      const originalProfile = mountain.params.profile;
      mountain.params.profile = 'range';
      const classic = evaluateGraph(project, { resolution: n, previewNodeId: mountainId }).field;
      mountain.params.profile = 'orogenic';
      const evolved = evaluateGraph(project, { resolution: n, previewNodeId: mountainId }).field;
      mountain.params.profile = originalProfile;
      const finalTerrain = evaluateGraph(project, { resolution: n }).field;

      const save = async (label: string, field: typeof classic,
        channel: 'height' | 'terrain') => {
        await testInfo.attach(`${preset}-${label}.png`, {
          body: Buffer.from(encodeRGBA(colorizeMap(field, channel,
            project.worldSize, project.heightScale), n)),
          contentType: 'image/png',
        });
      };
      await save('classic-source-height', classic, 'height');
      await save('orogenic-source-height', evolved, 'height');
      await save('classic-source-relief', classic, 'terrain');
      await save('orogenic-source-relief', evolved, 'terrain');
      await save('orogenic-with-hydraulic-erosion-height', finalTerrain, 'height');
      await save('orogenic-with-hydraulic-erosion-relief', finalTerrain, 'terrain');

      let difference = 0;
      for (let i = 0; i < classic.height.length; i++)
        difference += Math.abs(classic.height[i] - evolved.height[i]);
      const meanDelta = difference / classic.height.length;
      const fineRelief = (height: Float32Array) => {
        let sum = 0;
        for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
          const i = y * n + x;
          const neighbors = (height[i - n] + height[i + n] +
            height[i - 1] + height[i + 1]) / 4;
          sum += Math.abs(height[i] - neighbors);
        }
        return sum / ((n - 2) * (n - 2));
      };
      const classicFine = fineRelief(classic.height);
      const evolvedFine = fineRelief(evolved.height);
      await testInfo.attach(`${preset}-orogenic-audit.json`, {
        body: Buffer.from(JSON.stringify({
          preset, resolution: n, meanAbsoluteHeightChange: meanDelta,
          classicFineRelief: classicFine, orogenicFineRelief: evolvedFine,
          fineReliefRatio: evolvedFine / Math.max(classicFine, 1e-10),
          note: 'A measurable difference does not prove visual realism. Review height PNGs.',
        }, null, 2)),
        contentType: 'application/json',
      });
      expect(meanDelta).toBeGreaterThan(0.008);
      expect(evolvedFine).toBeGreaterThan(classicFine * 1.2);
      expect(evolved.height.every(Number.isFinite)).toBe(true);
      expect(finalTerrain.height.every(Number.isFinite)).toBe(true);
    });
}
