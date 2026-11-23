import { clamp, mix, Noise, randomGenerator, smoothstep } from '../engine/noise';
import type { SurfaceSettings } from './pbr';

const TAU = 2 * Math.PI;

/** Fade unresolved features to their mean instead of changing their wavelength. */
export function bandVisibility(period: number, footprint: number): number {
  return smoothstep(2, 3.5, period / Math.max(1e-8, footprint));
}

/**
 * Material coverage requires broad, continuously varying fields even when an
 * export texel spans an entire outcrop. Pigment and relief are separate: quartz
 * changes reflectance, a bedding ledge changes height, and a joint does both.
 * Coordinates/periods and returned relief are in metres. The frame is fixed to
 * the rock mass; it never rotates with the camera or slides along a slope.
 */
export class SurfaceFabric {
  private readonly noise: Noise;
  private readonly sedimentary: boolean;
  private readonly basalt: boolean;
  private readonly angleX: number;
  private readonly angleZ: number;
  private readonly dip: number;
  private readonly phase: number;
  private readonly grainPeriod: number;
  private readonly jointPeriod: number;
  private readonly bedPeriod: number;
  private readonly cell: number;
  private readonly regionBand: number;
  private readonly patchBand: number;
  private readonly textureBand: number;
  private readonly grainBand: number;
  private readonly fineBand: number;

  formation = 0;
  patch = 0;
  fleck = 0;
  windward = 0;
  mineral = 0;
  iron = 0;
  joint = 0;
  grit = 0;
  rockHeight = 0;
  clasts = 0;
  sorting = 0;
  cinder = 0;
  soilHeight = 0;
  hummock = 0;
  straw = 0;
  plantHeight = 0;
  scour = 0;
  snowHeight = 0;

  constructor(settings: SurfaceSettings, seed: number, cell: number) {
    this.noise = new Noise(seed ^ 0x6d2b79f5);
    const random = randomGenerator(seed ^ 0x427106a5);
    const azimuth = TAU * random();
    this.angleX = Math.cos(azimuth);
    this.angleZ = Math.sin(azimuth);
    this.phase = random() * 19;
    this.sedimentary = settings.biome === 'arid';
    this.basalt = settings.biome === 'volcanic';
    this.dip = this.sedimentary ? 0.14 : this.basalt ? 0.09 : 0.46;
    this.cell = cell;
    this.bedPeriod = settings.strataMeters;
    this.jointPeriod = settings.fractureMeters;
    this.grainPeriod = settings.detailMeters;
    this.regionBand = bandVisibility(1150, cell);
    this.patchBand = bandVisibility(310, cell);
    this.textureBand = bandVisibility(108, cell);
    this.grainBand = bandVisibility(this.grainPeriod, cell);
    this.fineBand = bandVisibility(this.grainPeriod * 0.35, cell);
  }

  sample(x: number, z: number, h: number, gx: number, gz: number): void {
    const noise = this.noise;
    const u = this.angleX * x + this.angleZ * z;
    const v = -this.angleZ * x + this.angleX * z;
    const long = this.regionBand * noise.simplex(u / 1150 + 7.1, v / 1420 - 4.9);
    const patch = this.patchBand * noise.simplex(u / 310 + long * 0.75, v / 390 + 9.4);
    const fleck = this.textureBand * noise.simplex(u / 108 - patch * 0.25, v / 145 + 17.4);
    this.formation = long;
    this.patch = patch;
    this.fleck = fleck;
    this.windward = (gx * this.angleX + gz * this.angleZ) / Math.sqrt(1 + gx * gx + gz * gz);

    // Intersect a folded, dipping sequence with the actual terrain in XYZ.
    // The phase gradient (cycles/m) accounts for steep walls crossing many beds.
    const period = this.bedPeriod;
    const bed = (h + this.dip * u) / period + long * 1.6 + patch * 0.27 + this.phase;
    const bedGradient = Math.abs(gx + this.dip * this.angleX) + Math.abs(gz + this.dip * this.angleZ);
    const bedFootprint = this.cell * (bedGradient + period * 0.0035);
    const bedBand = bandVisibility(period, bedFootprint);
    const laminaBand = bandVisibility(period / 3.1, bedFootprint);
    const phase = bed + 0.17 * Math.sin(bed * 2.2);
    // A continuous stratigraphic sequence with variable bed thickness and
    // composition. Foliation pinches out along strike; sandstone foresets meet
    // the bounding bed at a different dip (cross bedding).
    const bedding = bedBand === 0 ? 0 : bedBand * noise.perlin(phase * 1.5 + 11.7, 3.8 + patch * 0.38);
    const lamina = laminaBand === 0 ? 0 : laminaBand * noise.simplex(
      phase * 3.1 + (this.sedimentary ? 0.37 * v / period : 1.15 * fleck),
      17.2 + v / (5 * period) + patch * 0.61,
    );
    const grade = Math.hypot(gx, gz);
    const grain = this.grainPeriod;
    const grainMask = this.grainBand;
    const fine = this.fineBand === 0 ? 0 : this.fineBand * noise.simplex(u / (grain * 0.35) + 6.7, v / (grain * 0.35) - 8.5);
    const chips = grainMask === 0 ? 0 : grainMask * noise.simplex(u / grain + patch * 1.2 - 1.9, v / grain + 7.3);
    // Project the mineral fabric obliquely through the volume, so a vertical
    // change of elevation also traverses different mineral inclusions.
    const mineralBand = bandVisibility(grain * 0.72, this.cell * Math.hypot(1, grade));
    const crystals = mineralBand === 0 ? 0 : mineralBand * noise.simplex(
      (u + 0.76 * h) / (grain * 0.72) + 0.64 * chips,
      (v - 0.51 * h) / grain + 0.35 * fleck,
    );
    // Joint sets cut bedding. Vary the aperture, fracture persistence and the
    // extent of infill along each plane. On basalt a cooling-cell boundary
    // separates distinct plates. The footprint dilutes sub-texel seam contrast.
    const spacing = this.jointPeriod;
    const jointFoot = this.cell * (1 + 0.35 * grade) / spacing;
    const jointBand = smoothstep(3, 5, 1 / jointFoot);
    let fracture = 0;
    if (jointBand > 0) {
      const ju = (u + 0.37 * h) / spacing + patch * 0.25 + fleck * 0.10 + chips * 0.039;
      const jv = (v - 0.26 * h) / spacing - long * 0.52 + patch * 0.21;
      const aperture = 0.019 + 0.027 * smoothstep(-0.47, 0.60, chips + 0.61 * fleck);
      const width = aperture + jointFoot * 0.44;
      if (this.basalt) {
        const cells = noise.cellular(ju, jv);
        fracture = (1 - smoothstep(0, width * 2, cells.edge)) *
          (0.45 + 0.55 * smoothstep(-0.70, 0.38, fleck + 0.46 * chips));
      } else {
        const a = ju + 0.42 * noise.value(ju * 0.54, jv * 0.19);
        const b = jv * 0.74 + 0.34 * ju + 0.27 * noise.value(ju * 0.28 + 9, jv * 0.56);
        const longSet = (1 - smoothstep(0, width, Math.abs(a - Math.round(a)))) *
          smoothstep(-0.95, 0.07, bedding + 0.57 * fleck - 0.32 * chips);
        const crossSet = (1 - smoothstep(0, width, Math.abs(b - Math.round(b)))) *
          smoothstep(-0.5, 0.50, patch - 0.79 * fleck + 0.48 * bedding);
        fracture = Math.max(longSet, crossSet);
      }
      fracture *= aperture / width;
    }
    this.joint = jointBand * fracture;
    let particles = 0, hummock = 0, lee = 0, windCrust = 0;
    if (grainMask > 0) {
      // Broad clast concentrations grade into a finer matrix. Cellular edge
      // distance clips the domes into angular chips where adjacent clasts meet.
      const grains = noise.cellular(u / grain * 1.25 + 0.23 * fine, v / grain * 1.25 + 0.30 * chips);
      const radius = 0.19 + 0.34 * grains.cell;
      const dome = 1 - smoothstep(0.05, radius, grains.f1);
      const angular = smoothstep(0, 0.27, grains.edge);
      particles = grainMask * Math.min(dome, angular) * smoothstep(-0.65, 0.30, patch + chips);
      const tufts = noise.simplex(u / grain + 2.8 * long + 1.5, v / (grain * 1.9) + 9.3);
      hummock = grainMask * smoothstep(-0.27, 0.46, tufts + 0.53 * fine);
      const crest = TAU * (u / grain + 1.7 * patch + 0.51 * fleck + 0.16 * tufts);
      const ripple = Math.sin(crest) + 0.29 * bandVisibility(grain / 2, this.cell) * Math.sin(2 * crest + 0.9);
      lee = grainMask * ripple * smoothstep(-0.77, 0.32, fleck + 0.39 * chips);
      // Wind-carved snow tongues taper and terminate. A clamped lobe along
      // wind replaces the repeating sand ripple on the snow surface.
      const tongue = noise.simplex(u / (grain * 1.9) + 9.2 + 0.8 * fleck, v / (grain * 0.73) + 1.3 * patch);
      windCrust = grainMask * smoothstep(-0.14, 0.57, tongue) * (0.77 + 0.23 * chips);
    }
    // The mesoscale mineral signatures span multiple beds. Basalt has isolated
    // lighter inclusions surrounded by dark groundmass, sandstone shows pale
    // resistant laminae and iron-rich bands, gneiss alternates felsic/mafic rock.
    this.mineral = this.basalt
      ? clamp(0.12 + 0.34 * long + 0.16 * patch + 0.32 * particles + 0.24 * crystals + 0.16 * fine)
      : clamp((this.sedimentary ? 0.35 : 0.41) + 0.24 * long + 0.20 * patch +
          (this.sedimentary ? 0.22 : 0.32) * bedding + 0.23 * lamina + 0.24 * crystals + 0.11 * fine);
    this.iron = clamp(0.28 + (this.basalt ? 0.72 : 0.45) * patch -
      0.32 * long + 0.18 * fleck - 0.18 * bedding + 0.12 * crystals + 0.13 * this.joint);
    this.rockHeight = this.basalt
      ? -this.joint * Math.min(1.55, spacing * 0.019) + 0.22 * crystals - 0.29 * particles + 0.13 * fine
      : bedding * (0.73 + 0.27 * bedding) * Math.min(1.8, period * 0.015) *
        smoothstep(0.10, 0.4, grade) - this.joint * Math.min(1.6, spacing * 0.019) +
        0.13 * lamina * smoothstep(0.10, 0.4, grade) + fine * 0.12 + 0.22 * crystals;
    this.grit = chips + 0.62 * fine;
    this.clasts = particles;
    // Deflated aeolian pavement grades into ripple sand. Scoria has angular
    // cinders, dark fresh breaks and ochre oxidized faces. On alpine hillsides
    // debris accumulates in coarse, stony pockets interrupted by fines.
    const cinder = smoothstep(-0.16, 0.58, chips + fine * 0.48) * grainMask;
    this.cinder = this.basalt ? cinder : 0;
    this.sorting = this.sedimentary ? lee : this.basalt ? cinder - 0.65 * particles : fine;
    this.soilHeight = (this.sedimentary ? 0.18 : 0.47) * particles +
      (this.sedimentary ? 0.17 * lee : 0.10 * fine);
    if (this.basalt) this.soilHeight += 0.35 * cinder - 0.16 * fine;
    // Tussock, woody steppe and pioneer cushions respond differently at the
    // same wind exposure. Preserve a shared aggregate scale but change the
    // actual plant morphology as well as its pigment.
    this.hummock = this.sedimentary
      ? grainMask * smoothstep(0.12, 0.64, chips + fine * 0.33)
      : this.basalt ? grainMask * smoothstep(-0.05, 0.49, fine + 0.46 * hummock) : hummock;
    this.straw = clamp(0.4 + 0.44 * patch - 0.27 * fleck + 0.25 * fine - 0.27 * hummock + 0.18 * chips);
    this.plantHeight = (this.sedimentary ? 0.38 : this.basalt ? 0.115 : 0.28) * this.hummock +
      (this.basalt ? 0.027 : 0.055) * fine;
    this.scour = windCrust;
    this.snowHeight = 0.47 * windCrust + fine * 0.05;
  }
}

/** Linear-light RGB factors around the biome's unlit reflectance anchors. */
export function rockReflectance(
  fabric: SurfaceFabric, biome: SurfaceSettings['biome'], channel: number,
): number {
  const c = channel;
  if (biome === 'arid') {
    const ochre = c === 0 ? 1.12 : c === 1 ? 0.79 : 0.62;
    const cream = c === 0 ? 1.43 : c === 1 ? 1.66 : 1.94;
    return mix(ochre, cream, fabric.mineral) * (1 - fabric.iron * (c === 0 ? 0.11 : c === 1 ? 0.38 : 0.56));
  }
  if (biome === 'volcanic') {
    const basalt = c === 0 ? 0.64 : c === 1 ? 0.73 : 0.86;
    const clinker = c === 0 ? 1.96 : c === 1 ? 0.83 : 0.61;
    return mix(basalt, clinker, fabric.iron) + 0.88 * fabric.mineral;
  }
  const mafic = c === 0 ? 0.52 : c === 1 ? 0.66 : 0.84;
  const felsic = c === 0 ? 1.85 : c === 1 ? 1.83 : 1.91;
  return mix(mafic, felsic, fabric.mineral) * (1 + fabric.iron * (c === 0 ? 0.22 : c === 1 ? -0.04 : -0.25));
}
