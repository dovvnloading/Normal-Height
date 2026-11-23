import { clamp, mix, smoothstep } from '../engine/noise';
import type { HeightField, TerrainProject } from '../model/types';
import { createMaterialPaintRaster } from './materialPaint';
import type { PBRMaps, SurfaceSettings } from './pbr';
import { SurfaceFabric, rockReflectance } from './surfaceFabric';
import { createTerrainAnalyzer, diagnosticReference } from './terrainAnalysis';
import type { TerrainFactors } from './terrainAnalysis';

// Unlit multipliers of the biome's linear-light endmembers. These describe
// constituent pigments; lighting, skylight and horizon occlusion stay separate.
const SOIL_FINES = [0.81, 0.70, 0.62];
const SOIL_CLAST = [1.47, 1.56, 1.71];
const GREEN_TIPS = [0.59, 0.85, 0.66];
const STEPPE_TIPS = [0.71, 0.85, 0.73];
const LICHEN_CUSHION = [1.64, 1.57, 1.22];
const DRY_STEMS = [2.29, 1.29, 0.86];
const SNOW_FIRN = [0.83, 0.92, 0.99];
const SNOW_GRAINS = [1.18, 1.15, 1.12];

/** Bake the material field at the requested world sampling interval. */
export function synthesizeMaterials(
  field: HeightField,
  project: TerrainProject,
  params: SurfaceSettings,
  palette: number[][],
  encodeSrgb: (value: number) => number,
): PBRMaps {
  const n = field.resolution;
  const count = n * n;
  if (!Number.isInteger(n) || n < 2 || !Number.isFinite(project.worldSize) || project.worldSize <= 0 ||
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
  const analyze = createTerrainAnalyzer(field, project);
  const metrics: TerrainFactors = {
    grade: 0, gradientX: 0, gradientY: 0, slopeDegrees: 0,
    northness: 0, landform: 0, occlusion: 1,
  };
  const fabric = new SurfaceFabric(params, project.seed, project.worldSize / (n - 1));
  const paint = createMaterialPaintRaster(project.materialPaint, n);
  const cell = project.worldSize / (n - 1);
  const wearReference = diagnosticReference(field.wear);
  const depositionReference = diagnosticReference(field.deposition);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const h = field.height[i];
    if (!Number.isFinite(h) || !Number.isFinite(field.flow[i]))
      throw new Error('Invalid terrain elevation or flow for PBR synthesis.');
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  const span = Math.max(1e-8, max - min);
  const arid = params.biome === 'arid';
  const basalt = params.biome === 'volcanic';
  const growthTint = arid ? STEPPE_TIPS : basalt ? LICHEN_CUSHION : GREEN_TIPS;
  const plantCapacity = arid ? 0.33 : basalt ? 0.72 : 1;

  for (let y = 0; y < n; y++) {
    const painted = paint?.row(y);
    for (let x = 0; x < n; x++) {
      const i = y * n + x, p = i * 4;
      const h = field.height[i];
      const elevation = (h - min) / span;
      const { gradientX, gradientY, slopeDegrees: slope, northness, landform, occlusion } = analyze(x, y, metrics);
      fabric.sample(x * cell, y * cell, h * project.heightScale, gradientX, gradientY);
      const valley = smoothstep(0.006, 0.105, landform);
      const ridge = smoothstep(0.006, 0.105, -landform);
      const worn = smoothstep(0.02, 0.95, field.wear[i] / wearReference);
      const deposited = smoothstep(0.02, 0.95, field.deposition[i] / depositionReference);
      const aspect = northness * smoothstep(4, 42, slope);
      const runoff = clamp(field.flow[i] * 0.65 + valley * 0.45 + deposited * 0.24);
      const wet = clamp(params.moisture * (0.33 + 0.9 * runoff + 0.16 * aspect + 0.11 * fabric.patch));

      // Transport and retention compete for *area*. Sequential coverage allows
      // a single endmember to fill a surface (a scree chute, a snowfield, or an
      // exposed cliff). Additive score normalization leaves muddy traces of all
      // substrates almost everywhere. The contacts move around resistant beds.
      const exposure = (slope - params.rockSlope) / 22 + 0.66 * ridge + 0.93 * worn -
        0.91 * deposited - 0.60 * valley + 0.37 * fabric.formation + 0.27 * fabric.patch +
        0.19 * (fabric.mineral - 0.4) + 0.18 * fabric.fleck;
      const outcrop = smoothstep(-1.05, 0.33, exposure);
      const growingSeason = 1 - smoothstep(0.57 + 0.06 * aspect, 0.94, elevation);
      const rootZone = params.moisture + 0.33 * runoff + 0.13 * aspect - 0.26 * worn;
      const growing = plantCapacity * smoothstep(0.06, 0.61, rootZone) * growingSeason;
      const carpet = growing * smoothstep(-0.83, 0.44,
        fabric.patch * 0.69 + fabric.formation * 0.34 + fabric.fleck * 0.30 +
        0.13 * fabric.hummock + 0.23 * deposited - slope * 0.004);
      const leeward = -fabric.windward;
      const snowClimate = elevation - params.snowLine + 0.06 * aspect +
        0.07 * valley - 0.054 * ridge + 0.054 * leeward +
        0.066 * fabric.formation + 0.047 * fabric.patch + 0.021 * fabric.fleck;
      const stability = 1 - smoothstep(31, 61, slope + 8 * ridge - 7 * valley);
      let snow = arid ? 0 : smoothstep(-0.10, 0.12, snowClimate) * stability;
      let rock = (1 - snow) * outcrop;
      let soil = (1 - snow) * (1 - outcrop) * (1 - carpet);
      let vegetation = (1 - snow) * (1 - outcrop) * carpet;
      if (painted) {
        const q = x * 4;
        const auto = Math.max(0, 1 - painted[q] - painted[q + 1] - painted[q + 2] - painted[q + 3]);
        rock = auto * rock + painted[q];
        soil = auto * soil + painted[q + 1];
        vegetation = auto * vegetation + painted[q + 2];
        snow = auto * snow + painted[q + 3];
      }
      // Round cumulative coverage boundaries. Zero-weight constituents stay
      // zero and the four quantized footprints still partition exactly 255.
      const r = Math.round(255 * rock);
      const rg = Math.round(255 * (rock + soil));
      const rgb = Math.min(255, Math.round(255 * (rock + soil + vegetation)));
      splat[p] = r;
      splat[p + 1] = rg - r;
      splat[p + 2] = rgb - rg;
      splat[p + 3] = 255 - rgb;

      const stone = clamp(0.22 + 0.52 * fabric.clasts + 0.23 * fabric.fleck +
        0.21 * fabric.grit + 0.19 * worn - 0.20 * deposited + (arid ? 0.11 * fabric.sorting : 0));
      const litter = clamp((arid ? 0.37 : 0.13) + fabric.straw * 0.73 + 0.21 * elevation - 0.54 * wet);
      const powder = clamp(0.64 + 0.21 * leeward + 0.29 * fabric.patch -
        0.28 * fabric.scour + 0.13 * valley);
      const rockValue = (1 - 0.28 * fabric.joint + 0.12 * fabric.grit) * (1 - 0.23 * wet);
      const soilValue = (1 + 0.18 * fabric.formation + 0.15 * fabric.patch +
        0.095 * fabric.sorting + 0.12 * fabric.grit) * (1 - (arid ? 0.43 : 0.52) * wet);
      const plantValue = (0.81 + 0.33 * fabric.hummock + 0.17 * fabric.fleck + 0.08 * fabric.grit) * (1 - 0.15 * wet);
      for (let c = 0; c < 3; c++) {
        const rockColor = palette[0][c] * rockValue * rockReflectance(fabric, params.biome, c);
        const cinderPigment = (c === 0 ? 0.42 : c === 1 ? -0.21 : -0.39) * fabric.iron - 0.23 * fabric.cinder;
        const soilColor = palette[1][c] * soilValue * mix(SOIL_FINES[c], SOIL_CLAST[c], stone) *
          (basalt ? 1 + cinderPigment : 1);
        const plantColor = palette[2][c] * plantValue * mix(growthTint[c], DRY_STEMS[c], litter);
        const snowColor = palette[3][c] * mix(SNOW_FIRN[c], SNOW_GRAINS[c], powder);
        basecolor[p + c] = encodeSrgb(rock * rockColor + soil * soilColor + vegetation * plantColor + snow * snowColor);
      }
      basecolor[p + 3] = 255;

      // Three.js uses alpha = perceptualRoughness². Area-average this GGX
      // parameter as a single-lobe approximation to the four substrate lobes.
      const rr = clamp(0.85 - 0.19 * fabric.mineral + 0.10 * fabric.joint - 0.23 * wet);
      const rs = clamp(0.96 - 0.19 * stone - 0.40 * wet + 0.018 * fabric.sorting);
      const rv = clamp(0.77 + 0.15 * litter + 0.052 * fabric.hummock - 0.07 * wet);
      const rn = clamp(0.48 + 0.35 * powder + 0.018 * fabric.scour);
      roughness[i] = Math.round(255 * Math.sqrt(rock * rr * rr + soil * rs * rs + vegetation * rv * rv + snow * rn * rn));
      detail[i] = params.detailStrength * (rock * fabric.rockHeight + soil * fabric.soilHeight +
        vegetation * fabric.plantHeight + snow * fabric.snowHeight);
      ao[i] = Math.round(255 * clamp(1 - params.aoStrength * (1 - occlusion)));
      curvature[i] = clamp(128 - Math.round(landform * 395), 0, 255);
    }
  }
  return { resolution: n, basecolor, splat, roughness, ao, curvature, detail };
}
