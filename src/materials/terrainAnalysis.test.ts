import { describe, expect, it } from 'vitest';
import { createProject } from '../model/presets';
import type { HeightField } from '../model/types';
import { generatePBR, resolveSurface } from './pbr';
import { createTerrainAnalyzer, diagnosticReference } from './terrainAnalysis';

function fieldFrom(n: number, heightAt: (u: number, v: number) => number): HeightField {
  const height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    height[y * n + x] = heightAt(x / (n - 1), y / (n - 1));
  return { resolution: n, height, flow: new Float32Array(n * n),
    wear: new Float32Array(n * n), deposition: new Float32Array(n * n) };
}

const pixel = (map: Uint8ClampedArray, n: number, x: number, y: number, channel: number) =>
  map[(y * n + x) * 4 + channel];

describe('physical terrain analysis and material layering', () => {
  it('computes the analytic slope/aspect of a plane and removes plane tilt from AO/curvature', () => {
    const n = 129;
    const field = fieldFrom(n, (u, v) => 0.2 + u * 0.2 + v * 0.15);
    const project = { ...createProject(), worldSize: 1000, heightScale: 800 };
    const metrics = createTerrainAnalyzer(field, project)(64, 64);
    expect(metrics.grade).toBeCloseTo(0.2, 4);
    expect(metrics.slopeDegrees).toBeCloseTo(Math.atan(0.2) * 180 / Math.PI, 3);
    expect(metrics.northness).toBeCloseTo(0.6, 4);
    expect(metrics.landform).toBeCloseTo(0, 4);
    expect(metrics.occlusion).toBeCloseTo(1, 4);
    const maps = generatePBR(field, project);
    expect(maps.ao[64 * n + 64]).toBe(255);
    expect(maps.curvature[64 * n + 64]).toBe(128);
  });

  it('distinguishes valleys from convex crests at identical world coordinates', () => {
    const n = 129;
    const project = { ...createProject(), worldSize: 1000, heightScale: 1200 };
    const valley = fieldFrom(n, (u, v) =>
      0.14 + 0.53 * (u - 0.5) ** 2 + 0.4 * (v - 0.5) ** 2);
    const ridge = fieldFrom(n, (u, v) =>
      0.86 - 0.53 * (u - 0.5) ** 2 - 0.4 * (v - 0.5) ** 2);
    const idx = 64 * n + 64;
    expect(createTerrainAnalyzer(valley, project)(64, 64).landform).toBeGreaterThan(0);
    expect(createTerrainAnalyzer(ridge, project)(64, 64).landform).toBeLessThan(0);
    const low = generatePBR(valley, project);
    const high = generatePBR(ridge, project);
    expect(low.curvature[idx]).toBeLessThan(128);
    expect(high.curvature[idx]).toBeGreaterThan(128);
    expect(low.ao[idx]).toBeLessThan(255);
    expect(high.ao[idx]).toBe(255);
  });

  it('samples identical physical locations consistently when export resolution doubles', () => {
    const project = { ...createProject(), worldSize: 1000, heightScale: 1100,
      surface: { ...resolveSurface(), detailMeters: 96 } };
    const formula = (u: number, v: number) =>
      0.12 + 0.6 * (u - 0.5) ** 2 + 0.33 * (v - 0.5) ** 2;
    const coarseField = fieldFrom(129, formula);
    const fineField = fieldFrom(257, formula);
    const a = createTerrainAnalyzer(coarseField, project)(64, 48);
    const b = createTerrainAnalyzer(fineField, project)(128, 96);
    expect(Math.abs(a.landform - b.landform)).toBeLessThan(0.002);
    expect(Math.abs(a.occlusion - b.occlusion)).toBeLessThan(0.003);
    const coarse = generatePBR(coarseField, project);
    const fine = generatePBR(fineField, project);
    const p = (48 * 129 + 64) * 4, q = (96 * 257 + 128) * 4;
    for (let c = 0; c < 4; c++)
      expect(Math.abs(coarse.splat[p + c] - fine.splat[q + c])).toBeLessThanOrEqual(7);
    for (let c = 0; c < 3; c++)
      expect(Math.abs(coarse.basecolor[p + c] - fine.basecolor[q + c])).toBeLessThanOrEqual(6);
  });

  it('uses percentile-scaled deposition as soil evidence, wear as exposed rock evidence', () => {
    const n = 129;
    const field = fieldFrom(n, (_u, v) => 0.1 + v * 0.8);
    const depositIndex = 64 * n + 32, wearIndex = 64 * n + 96;
    field.deposition[depositIndex] = 0.03;
    field.wear[wearIndex] = 0.03;
    const project = { ...createProject(), worldSize: 1900, heightScale: 850 };
    const maps = generatePBR(field, project);
    expect(maps.splat[depositIndex * 4 + 1]).toBeGreaterThan(
      maps.splat[wearIndex * 4 + 1],
    );
    expect(maps.splat[wearIndex * 4]).toBeGreaterThan(
      maps.splat[depositIndex * 4],
    );
    const samples = new Float32Array([0, 0.002, 0.008, 0.02, 0.04, 0.05]);
    expect(diagnosticReference(samples)).toBeGreaterThan(0.035);
    expect(diagnosticReference(new Float32Array(4))).toBe(1);
  });

  it('keeps high stable shelves snowier than equally elevated steep walls', () => {
    const n = 129;
    const field = fieldFrom(n, (u, v) => 0.12 + v * 0.65 +
      (u < 0.47 ? 0 : 0.15 * Math.tanh(((u * (n - 1)) - 90) / 3)));
    const project = { ...createProject(), worldSize: 5000, heightScale: 1200,
      surface: { ...resolveSurface(), snowLine: 0.55 } };
    const maps = generatePBR(field, project);
    expect(field.height[115 * n + 20]).toBeCloseTo(field.height[115 * n + 90], 5);
    expect(pixel(maps.splat, n, 20, 115, 3)).toBeGreaterThan(
      pixel(maps.splat, n, 90, 115, 3) + 60,
    );
  });

  it('keeps authored micro wavelengths absent when undersampled, but resolves them at 4x grid density', () => {
    const project = { ...createProject(), worldSize: 1600,
      surface: { ...resolveSurface(), detailMeters: 24, detailStrength: 1 } };
    const coarse = generatePBR(fieldFrom(64, () => 0.5), project);
    const fine = generatePBR(fieldFrom(256, () => 0.5), project);
    expect(coarse.detail.every(value => value === 0)).toBe(true);
    expect(fine.detail.some(value => Math.abs(value) > 0.001)).toBe(true);
  });
});
