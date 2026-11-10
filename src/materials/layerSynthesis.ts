import { Noise } from '../engine/noise';
import type { HeightField, TerrainProject } from '../model/types';
import type { PBRMaps, SurfaceSettings } from './pbr';
import { createTerrainAnalyzer, diagnosticReference } from './terrainAnalysis';
import type { TerrainFactors } from './terrainAnalysis';

const clamp = (v: number, low = 0, high = 1) => Math.max(low, Math.min(high, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / Math.max(1e-8, b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Evidence-based substrate classification, followed by independent procedural
 * textures for exposed bedrock, transported soil, vegetation and deposited snow.
 *
 * All wavelengths and heights are in physical meters. No temporary per-pixel
 * analysis maps are allocated: 2048² exports already have a tight memory budget.
 * The textures are evaluations of the same seeded physical-coordinate fields at
 * the preview and export resolutions, not resized/randomized pixel noise.
 */
export function synthesizeMaterials(
  field: HeightField,
  project: TerrainProject,
  params: SurfaceSettings,
  palette: number[][],
  encodeSrgb: (value: number) => number,
): PBRMaps {
  const n = field.resolution;
  const count = n * n;
  if (n < 2 || !Number.isFinite(project.worldSize) || project.worldSize <= 0 ||
      !Number.isFinite(project.heightScale) || project.heightScale <= 0 ||
      field.height.length !== count || field.flow.length !== count ||
      field.wear.length !== count || field.deposition.length !== count) {
    throw new Error('PBR generation requires aligned height and erosion fields.');
  }
  const basecolor = new Uint8ClampedArray(count * 4);
  const splat = new Uint8ClampedArray(count * 4);
  const roughness = new Uint8Array(count);
  const ao = new Uint8Array(count);
  const curvature = new Uint8Array(count);
  const detail = new Float32Array(count);
  const noise = new Noise((project.seed + 0x3b9aca07) >>> 0);
  const analyze = createTerrainAnalyzer(field, project);
  const metrics: TerrainFactors = {
    grade: 0, slopeDegrees: 0, northness: 0, landform: 0, occlusion: 1,
  };
  const cell = project.worldSize / (n - 1);
  const wearReference = diagnosticReference(field.wear);
  const depositionReference = diagnosticReference(field.deposition);
  const grainVisibility = smooth(2, 3.5, params.detailMeters / cell);
  const fineVisibility = smooth(2, 3.5, params.detailMeters / (2.1 * cell));
  const fractureVisibility = smooth(3, 5, params.fractureMeters / cell);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const h = field.height[i];
    if (!Number.isFinite(h) || !Number.isFinite(field.flow[i]))
      throw new Error('Invalid terrain elevation or flow for PBR synthesis.');
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  const span = Math.max(1e-8, max - min);
  const vegetationFactor = params.biome === 'arid' ? 0.18 :
    params.biome === 'volcanic' ? 0.48 : 1;
  const stratumContrast = params.biome === 'arid' ? 0.12 :
    params.biome === 'volcanic' ? 0.025 : 0.052;

  for (let y = 0; y < n; y++) {
    const z = y * cell;
    for (let x = 0; x < n; x++) {
      const wx = x * cell;
      const i = y * n + x, p = i * 4;
      const h = field.height[i];
      const height01 = (h - min) / span;
      const { slopeDegrees: slope, grade, northness, landform, occlusion } =
        analyze(x, y, metrics);
      const valley = smooth(0.012, 0.14, landform);
      const crest = smooth(0.012, 0.14, -landform);
      const northExposure = northness * smooth(7, 38, slope);
      const worn = smooth(0.05, 0.9, Math.max(0, field.wear[i]) / wearReference);
      const deposited = smooth(0.05, 0.9, Math.max(0, field.deposition[i]) / depositionReference);
      // Flow is already a normalized visitation diagnostic, not a water-depth
      // measurement. Couple it to the actual landform and depositional evidence.
      const drainage = clamp(field.flow[i] * 0.55 + valley * 0.37 + deposited * 0.26);
      const wetness = clamp(params.moisture *
        (0.12 + drainage * 0.75 + Math.max(0, northExposure) * 0.16));

      // Broad variations do not define the geology; they gently break up the
      // decisions made from slope, curvature, weathering and sediment transport.
      const macro = noise.simplex(wx / 380 + 3.9, z / 380 - 7.2);
      const patch = noise.simplex(wx / 135 - 21.1, z / 135 + 8.2);
      const slopeRock = smooth(params.rockSlope - 12, params.rockSlope + 12,
        slope + worn * 4);
      const rockExposure = clamp(0.11 + 0.78 * slopeRock + 0.42 * crest +
        0.30 * worn - 0.26 * valley - 0.35 * deposited);
      const soilRetention = clamp(0.84 * (1 - slopeRock) + 0.36 * deposited +
        0.32 * valley - 0.30 * worn - 0.34 * crest);
      const climate = params.moisture * (0.78 + 0.15 * northExposure) +
        drainage * params.moisture * 0.28;
      const elevHabitat = smooth(0.015, 0.18, height01) *
        (1 - smooth(0.62, 0.90, height01));
      const vegetationDensity = vegetationFactor * elevHabitat *
        smooth(0.08, 0.68, climate) *
        (0.18 + soilRetention * 0.92) *
        (1 - slopeRock * 0.90) * (0.84 + patch * 0.16);

      // Snow can settle in shaded, concave shelves but is wind-scoured off
      // convex crests and unstable steep faces. This is a climate heuristic,
      // not a snowpack or solar-radiation simulation.
      const snowLevel = height01 + macro * 0.022;
      const snowRetention = clamp(0.78 + 0.24 * valley - 0.18 * crest +
        0.18 * northExposure);
      const snow = params.biome === 'arid' ? 0 : clamp(
        smooth(params.snowLine - 0.11, params.snowLine + 0.10, snowLevel) *
        (1 - smooth(29, 63, slope) * 0.94) * snowRetention * 1.26,
      );

      // Independent substrate evidence is normalized before snow is overlaid.
      // An exact 255-sum splat is produced by quantizing only the first 3.
      const rockMass = 0.08 + rockExposure * 3.55;
      const soilMass = 0.18 + soilRetention * (1.18 + deposited * 0.70) +
        wetness * 0.22;
      const vegMass = vegetationDensity * 2.1;
      const sum = rockMass + soilMass + vegMass;
      const bare = 1 - snow;
      const rock = bare * rockMass / sum;
      const soil = bare * soilMass / sum;
      const vegetation = bare * vegMass / sum;
      const weights = [rock, soil, vegetation, snow];
      const r = Math.round(rock * 255);
      const g = Math.min(255 - r, Math.round(soil * 255));
      const b = Math.min(255 - r - g, Math.round(vegetation * 255));
      splat[p] = r;
      splat[p + 1] = g;
      splat[p + 2] = b;
      splat[p + 3] = 255 - r - g - b;

      // Rock bedding is an elevation-isosurface signal, with domain-warped
      // fracture joints. Horizontal bedding spacing is strataMeters / grade,
      // so it is attenuated where the grid cannot resolve it.
      const beddingSpacing = params.strataMeters / Math.max(0.25, grade);
      const beddingVisibility = smooth(3, 5, beddingSpacing / cell) *
        smooth(16, 47, slope);
      const needRockDetail = rock > 0.025 &&
        (fractureVisibility > 0 || beddingVisibility > 0);
      const rockWarp = needRockDetail
        ? noise.simplex(wx / (params.fractureMeters * 2.8) + 17.3,
            z / (params.fractureMeters * 2.8) - 9.5)
        : 0;
      const fractureSignal = needRockDetail && fractureVisibility > 0
        ? noise.simplex(wx / params.fractureMeters + rockWarp * 0.42 + 31.1,
            z / params.fractureMeters - rockWarp * 0.26 - 19.7)
        : 0;
      const fractures = fractureVisibility *
        (1 - smooth(0.025, 0.22, Math.abs(fractureSignal))) ** 2;
      const bedding = beddingVisibility *
        Math.sin((h * project.heightScale / params.strataMeters +
          rockWarp * 0.22) * 2 * Math.PI);

      // Physically spaced, band-limited microstructure: each material uses
      // the SAME seed fields for its color, roughness and height perturbation.
      const grain = grainVisibility
        ? noise.simplex(wx / params.detailMeters + 11.3,
            z / params.detailMeters - 5.7) * grainVisibility
        : 0;
      const fine = fineVisibility
        ? noise.simplex(wx / (params.detailMeters / 2.1) - 21.1,
            z / (params.detailMeters / 2.1) + 8.2) * fineVisibility
        : 0;
      const drift = snow > 0.01
        ? noise.simplex(wx / 185 + 14.2, z / 185 + 29.4) *
          smooth(2.5, 4, 185 / cell)
        : 0;

      const layerTint = [
        1 + macro * 0.045 + bedding * stratumContrast -
          fractures * 0.17 + worn * 0.032 + grain * 0.025,
        1 + macro * 0.035 + patch * 0.075 - deposited * 0.042 +
          grain * 0.085 + fine * 0.028,
        1 + macro * 0.042 + patch * 0.12 + grain * 0.065 -
          (1 - soilRetention) * 0.035,
        1 + macro * 0.022 + patch * 0.019 + drift * 0.032 +
          grain * 0.014,
      ];
      const darken = 1 - wetness * (rock * 0.12 + soil * 0.29 +
        vegetation * 0.095);
      for (let channel = 0; channel < 3; channel++) {
        let reflectance = 0;
        for (let layer = 0; layer < 4; layer++) {
          reflectance += palette[layer][channel] * weights[layer] * layerTint[layer];
        }
        basecolor[p + channel] = encodeSrgb(reflectance * darken);
      }
      basecolor[p + 3] = 255;

      // The rock fissures are simultaneously darker, rougher and recessed.
      // Deposited/wet soils are darker and smoother; snow stays non-metallic.
      const baseRoughness = rock * 0.88 + soil * 0.94 +
        vegetation * 0.89 + snow * 0.77;
      roughness[i] = Math.round(clamp(baseRoughness +
        rock * (fractures * 0.055 - bedding * 0.018) +
        soil * grain * 0.045 + vegetation * patch * 0.02 +
        snow * grain * 0.035 - wetness * (soil * 0.25 + rock * 0.13),
        0.28, 1) * 255);
      const rockDetail = grain * 0.15 + fine * 0.045 -
        fractures * 0.72 + bedding * 0.34;
      const soilDetail = grain * 0.28 + fine * 0.09;
      const vegetationDetail = grain * 0.13 + fine * 0.045;
      const snowDetail = grain * 0.09 + fine * 0.025 + drift * 0.13;
      detail[i] = params.detailStrength * (rock * rockDetail +
        soil * soilDetail + vegetation * vegetationDetail + snow * snowDetail);

      ao[i] = Math.round(255 * clamp(
        1 - params.aoStrength * (1 - occlusion), 0.45, 1));
      // High values = convex/ridge; low values = concave/channel.
      curvature[i] = Math.round(255 * clamp(0.5 - landform * 1.55));
    }
  }
  return { resolution: n, basecolor, splat, roughness, ao, curvature, detail };
}
