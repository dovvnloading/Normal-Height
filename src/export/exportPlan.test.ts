import { describe, expect, it } from 'vitest';
import { checkPBRExportBudget, isPBRExportFormat } from './budget';
import type { ExportFormat } from './heightmap';
import { EXPORT_RESOLUTIONS, exportDescription, formatExportSize, mapPayloadBytes, pbrPreflight } from './exportPlan';

describe('export planning', () => {
  it('counts actual decoded channel bytes, not compressed archive size', () => {
    expect(mapPayloadBytes('png16', 1024)).toBe(2 * 1024 ** 2);
    expect(mapPayloadBytes('mask16', 1024)).toBe(2 * 1024 ** 2);
    expect(mapPayloadBytes('raw32', 1024)).toBe(4 * 1024 ** 2);
    expect(mapPayloadBytes('normal', 1024)).toBe(4 * 1024 ** 2);
    expect(mapPayloadBytes('pbr', 1024)).toBe(48 * 1024 ** 2);
    expect(formatExportSize(256 * 256 * 2)).toBe('128.0 KiB');
    expect(formatExportSize(4 * 1024 ** 2)).toBe('4.0 MiB');
  });

  it('uses the same memory gate as the encoder and suggests the largest smaller safe grid', () => {
    const formats: ExportFormat[] = ['png16', 'mask16', 'raw32', 'normal', 'flow', 'wear', 'deposition',
      'pbr', 'basecolor', 'roughness', 'ao', 'metallic', 'orm', 'splat', 'curvature', 'normalGL',
      'normalDX', 'detailNormal'];
    for (const format of formats) {
      expect(exportDescription(format).length).toBeGreaterThan(20);
      for (const memory of [undefined, 2, 4, 8]) {
        for (const bundle of [false, true]) {
          for (const resolution of EXPORT_RESOLUTIONS) {
            const preflight = pbrPreflight(format, resolution, bundle, memory);
            if (!isPBRExportFormat(format)) {
              expect(preflight).toBeNull();
              continue;
            }
            expect(preflight).not.toBeNull();
            const { overBudget, budget, suggested } = preflight!;
            const gate = () => checkPBRExportBudget(resolution, budget, format, bundle);
            if (overBudget) {
              expect(gate).toThrow('device budget');
              expect(suggested).toBeDefined();
              expect(suggested!).toBeLessThan(resolution);
              expect(() => checkPBRExportBudget(suggested!, budget, format, bundle)).not.toThrow();
              for (const size of EXPORT_RESOLUTIONS.filter((n) => n > suggested! && n < resolution))
                expect(() => checkPBRExportBudget(size, budget, format, bundle)).toThrow();
            } else expect(gate).not.toThrow();
          }
        }
      }
    }
  });
});
