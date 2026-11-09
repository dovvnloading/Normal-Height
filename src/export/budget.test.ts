import { describe, expect, it } from 'vitest';
import { checkPBRExportBudget, estimatePBRPeakMiB, pbrBudgetMiB } from './budget';

describe('PBR export allocation guard', () => {
  it('grows with real pixel count and excludes high-risk requests on constrained devices', () => {
    expect(estimatePBRPeakMiB(256)).toBeLessThan(estimatePBRPeakMiB(512));
    expect(estimatePBRPeakMiB(512)).toBeLessThan(estimatePBRPeakMiB(1024));
    expect(estimatePBRPeakMiB(1024)).toBeLessThan(estimatePBRPeakMiB(2048));
    expect(() => checkPBRExportBudget(1024, pbrBudgetMiB())).not.toThrow();
    expect(() => checkPBRExportBudget(2048, pbrBudgetMiB(2))).toThrow('smaller resolution');
    expect(() => checkPBRExportBudget(2048, pbrBudgetMiB(8))).not.toThrow();
  });
  it('rejects invalid requests instead of allocating large unbounded arrays', () => {
    expect(() => estimatePBRPeakMiB(NaN)).toThrow('resolution');
    expect(() => estimatePBRPeakMiB(20000)).toThrow('resolution');
    expect(() => checkPBRExportBudget(1024, 0)).toThrow('device budget');
  });
});
