import { describe, expect, it } from 'vitest';
import {
  checkPBRExportBudget, estimatePBRPeakMiB, isPBRExportFormat,
  isSinglePBRExportFormat, pbrBudgetMiB,
} from './budget';

describe('PBR export allocation guard', () => {
  it('grows with real pixel count and excludes high-risk requests on constrained devices', () => {
    expect(estimatePBRPeakMiB(256)).toBeLessThan(estimatePBRPeakMiB(512));
    expect(estimatePBRPeakMiB(512)).toBeLessThan(estimatePBRPeakMiB(1024));
    expect(estimatePBRPeakMiB(1024)).toBeLessThan(estimatePBRPeakMiB(2048));
    expect(() => checkPBRExportBudget(1024, pbrBudgetMiB())).not.toThrow();
    expect(() => checkPBRExportBudget(2048, pbrBudgetMiB(2))).toThrow('smaller resolution');
    expect(() => checkPBRExportBudget(2048, pbrBudgetMiB(8))).not.toThrow();
  });
  it('guards every material map and accounts for optional ZIP packing', () => {
    const formats = [
      'basecolor', 'roughness', 'ao', 'metallic', 'orm', 'splat', 'curvature',
      'normalGL', 'normalDX', 'detailNormal',
    ] as const;
    for (const format of formats) {
      expect(isSinglePBRExportFormat(format)).toBe(true);
      expect(isPBRExportFormat(format)).toBe(true);
      for (const bundle of [false, true]) {
        expect(() => checkPBRExportBudget(2048, pbrBudgetMiB(2), format, bundle))
          .toThrow('smaller resolution');
        expect(() => checkPBRExportBudget(2048, pbrBudgetMiB(), format, bundle))
          .toThrow('smaller resolution');
        expect(() => checkPBRExportBudget(1024, pbrBudgetMiB(), format, bundle)).not.toThrow();
        expect(() => checkPBRExportBudget(2048, pbrBudgetMiB(8), format, bundle)).not.toThrow();
      }
    }
    expect(estimatePBRPeakMiB(2048, 'basecolor')).toBeLessThan(
      estimatePBRPeakMiB(2048, 'basecolor', true));
    expect(estimatePBRPeakMiB(2048, 'basecolor', true)).toBeLessThan(
      estimatePBRPeakMiB(2048, 'pbr'));
    expect(isPBRExportFormat('pbr')).toBe(true);
    expect(isSinglePBRExportFormat('pbr')).toBe(false);
    for (const format of ['png16', 'raw32', 'normal', 'flow', 'wear', 'deposition'] as const)
      expect(isPBRExportFormat(format)).toBe(false);
  });

  it('rejects invalid requests instead of allocating large unbounded arrays', () => {
    expect(() => estimatePBRPeakMiB(NaN)).toThrow('resolution');
    expect(() => estimatePBRPeakMiB(20000)).toThrow('resolution');
    expect(() => checkPBRExportBudget(1024, 0)).toThrow('device budget');
  });
});
