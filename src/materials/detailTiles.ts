import { clamp, mix, randomGenerator, smoothstep } from '../engine/noise';
import { layerColorHex, srgbByteToLinear, linearToSrgbByte, resolveSurface } from './pbr';
import type { SurfaceSettings } from './pbr';
import type { MaterialLayer } from './materialPaint';

/** Material tiles are local surface assets, not whole-terrain bakes. */
export const DETAIL_TILE_MODEL_VERSION = 1;
export function detailTileMeters(detailMeters: number): number {
  return clamp(detailMeters * 0.25, 2, 16);
}

const wrap = (i: number, n: number) => i >= 0 && i < n ? i : ((i % n) + n) % n;
const TAU = 2 * Math.PI;
const faultPulse = (phase: number, width: number, footprint: number) => {
  const distance = Math.abs(phase - Math.round(phase));
  const filtered = Math.max(width, footprint);
  return (1 - smoothstep(filtered * 0.18, filtered, distance)) * width / filtered;
};
const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const AO_X = [1,1,0,-1,-1,-1,0,1];
const AO_Y = [0,1,1,1,0,-1,-1,-1];

/**
 * A periodic lattice with independent seeded site position, color and size.
 * Coordinates repeat exactly across both UV axes, including the domain warps.
 * No copied borders or cross-faded seams. All hot-path storage is reused.
 */
class PeriodicLattice {
  private readonly values: Float32Array;
  private readonly offsetX: Float32Array;
  private readonly offsetY: Float32Array;
  private readonly sizes: Float32Array;
  private readonly axisX: Float32Array;
  private readonly axisY: Float32Array;
  private readonly pixel: number;
  readonly visibility: number;
  distance = 0;
  edge = 0;
  pigment = 0;
  size = 0;

  constructor(private readonly nx: number, private readonly ny: number, seed: number, resolution: number, oriented = false) {
    const rng = randomGenerator(seed);
    const count = nx * ny;
    this.values = new Float32Array(count);
    this.offsetX = new Float32Array(count);
    this.offsetY = new Float32Array(count);
    this.sizes = new Float32Array(count);
    this.axisX = new Float32Array(oriented ? count : 0);
    this.axisY = new Float32Array(oriented ? count : 0);
    this.pixel = Math.max(nx, ny) / resolution;
    for (let i = 0; i < count; i++) {
      this.values[i] = rng() * 2 - 1;
      this.offsetX[i] = 0.12 + 0.76 * rng();
      this.offsetY[i] = 0.12 + 0.76 * rng();
      this.sizes[i] = rng();
      if (oriented) {
        const angle = Math.PI * this.values[i];
        this.axisX[i] = Math.cos(angle);
        this.axisY[i] = Math.sin(angle);
      }
    }
    this.visibility = smoothstep(2, 4, resolution / Math.max(nx, ny));
  }

  private index(x: number, y: number): number {
    return wrap(y, this.ny) * this.nx + wrap(x, this.nx);
  }

  noise(u: number, v: number): number {
    if (this.visibility === 0) return 0;
    const x = u * this.nx, y = v * this.ny;
    const ix = Math.floor(x), iy = Math.floor(y);
    const tx = quintic(x - ix), ty = quintic(y - iy);
    return this.visibility * mix(
      mix(this.values[this.index(ix, iy)], this.values[this.index(ix + 1, iy)], tx),
      mix(this.values[this.index(ix, iy + 1)], this.values[this.index(ix + 1, iy + 1)], tx),
      ty,
    );
  }

  cells(u: number, v: number): void {
    if (this.visibility === 0) {
      this.distance = 1; this.edge = 1; this.pigment = 0; this.size = 0;
      return;
    }
    const x = u * this.nx, y = v * this.ny;
    const ix = Math.floor(x), iy = Math.floor(y);
    let first = Infinity, second = Infinity, nearest = 0;
    // First visit the central neighborhood, then the outer ring. The site
    // is constrained to its jitter box, so the box distance is a conservative
    // lower bound: expensive hash/lookups cannot change the nearest pair
    // when that bound exceeds the current runner-up.
    for (let ring = 1; ring <= 2; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (ring === 2 && Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
          const cx = ix + dx, cy = iy + dy;
          const minX = Math.max(0, cx + 0.11999 - x, x - cx - 0.88001);
          const minY = Math.max(0, cy + 0.11999 - y, y - cy - 0.88001);
          if (minX*minX + minY*minY > second) continue;
          const index = this.index(cx, cy);
          const px = cx + this.offsetX[index] - x, py = cy + this.offsetY[index] - y;
          const d = px * px + py * py;
          if (d < first) { second = first; first = d; nearest = index; }
          else if (d < second) second = d;
        }
      }
    }
    this.distance = Math.sqrt(first);
    this.edge = Math.sqrt(second) - this.distance;
    this.pigment = this.values[nearest];
    this.size = this.sizes[nearest];
  }

  /** Rounded, irregular-sized particle cut out of a Voronoi cell. */
  particle(u: number, v: number, angular: boolean): number {
    this.cells(u, v);
    const radius = 0.17 + 0.30 * this.size;
    const dome = 1 - smoothstep(0.025, radius, this.distance);
    return this.visibility * (angular ? Math.min(dome, smoothstep(0, 0.20, this.edge)) : dome);
  }

  /** Tapered, individually oriented and curved leaf/needle silhouettes.
   *  Their compact support fits in the adjacent cells; footprint broadening
   *  conserves approximate coverage when the blade becomes sub-texel.
   */
  blades(u: number, v: number): number {
    if (this.visibility === 0 || this.axisX.length === 0) return 0;
    const x = u*this.nx, y = v*this.ny;
    const ix = Math.floor(x), iy = Math.floor(y);
    let result = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix+dx, cy = iy+dy, i = this.index(cx,cy);
      const px = x-cx-this.offsetX[i], py = y-cy-this.offsetY[i];
      if (px*px+py*py > 0.85*0.85) continue;
      const along = px*this.axisX[i] + py*this.axisY[i];
      const length = 0.36 + 0.23*this.sizes[i];
      const t = along/length;
      if (Math.abs(t) >= 1) continue;
      const across = -px*this.axisY[i] + py*this.axisX[i] + 0.12*this.values[i]*t*t;
      const width = (0.11 + 0.10*this.sizes[i]) * (1 - 0.83*Math.abs(t));
      const filtered = Math.max(width, this.pixel*0.64);
      const body = (1-smoothstep(0,filtered,Math.abs(across))) *
        smoothstep(0,0.25,1-Math.abs(t)) * width/filtered;
      result = Math.max(result, body);
    }
    return result*this.visibility;
  }
}

export interface DetailSample {
  /** Linear-light unlit reflectance, before sRGB encoding. */
  red: number;
  green: number;
  blue: number;
  roughness: number;
  reliefMeters: number;
}

/** A deterministic artist-oriented material, over one period in local XY. */
export class DetailTileSampler {
  readonly meters: number;
  private readonly palette: number[];
  private readonly warpX: PeriodicLattice;
  private readonly warpY: PeriodicLattice;
  private readonly medium: PeriodicLattice;
  private readonly small: PeriodicLattice;
  private readonly grain: PeriodicLattice;
  private readonly fine: PeriodicLattice;
  private readonly grit: PeriodicLattice;
  private readonly direction: PeriodicLattice;
  private readonly clasts: PeriodicLattice;
  private readonly chips: PeriodicLattice;
  private readonly veins: PeriodicLattice;
  private readonly leaves: PeriodicLattice;
  private readonly needles: PeriodicLattice;
  private readonly laminaVisibility: number;
  private readonly faultFootprint: number;
  private readonly sedimentary: boolean;
  private readonly basalt: boolean;
  private readonly strength: number;

  constructor(private readonly layer: MaterialLayer, settings: SurfaceSettings, seed: number, resolution: number) {
    this.meters = detailTileMeters(settings.detailMeters);
    const hex = layerColorHex(settings, layer);
    this.palette = [1, 3, 5].map(offset => srgbByteToLinear(parseInt(hex.slice(offset, offset + 2), 16)));
    const salt = { rock: 0x77f23, soil: 0x41b25, vegetation: 0x198de, snow: 0x53b14 }[layer];
    const biomeSalt = { alpine: 0x28a9a, arid: 0x533d1, volcanic: 0x6d04b }[settings.biome];
    const rng = randomGenerator(seed ^ salt ^ biomeSalt);
    const lattice = (x: number, y = x, oriented = false) => new PeriodicLattice(x, y, Math.floor(rng() * 4294967296), resolution, oriented);
    this.warpX = lattice(3, 4);
    this.warpY = lattice(4, 3);
    this.medium = lattice(9, 11);
    this.small = lattice(23, 19);
    this.grain = lattice(53, 47);
    this.fine = lattice(103, 97);
    this.grit = lattice(211, 197);
    this.direction = lattice(67, 13);
    this.clasts = lattice(11, 13);
    this.chips = lattice(37, 41);
    this.veins = lattice(7, 8);
    this.leaves = lattice(37, 43, layer === 'vegetation');
    this.needles = lattice(83, 79, layer === 'vegetation');
    this.laminaVisibility = smoothstep(2.5, 5, resolution / 19);
    this.faultFootprint = 0.6 * Math.hypot(6,5) / resolution;
    this.sedimentary = settings.biome === 'arid';
    this.basalt = settings.biome === 'volcanic';
    this.strength = settings.detailStrength;
  }

  sample(u: number, v: number, out: DetailSample): DetailSample {
    // All UV coefficients in the unwarped periodic transforms are integers,
    // including the directional/sheared coordinates. Warp is periodic too.
    const wx = this.warpX.noise(u, v), wy = this.warpY.noise(u, v);
    const x = u + 0.054 * wx, y = v + 0.054 * wy;
    const medium = this.medium.noise(x, y);
    const small = this.small.noise(x + 0.011 * medium, y - 0.013 * medium);
    const grain = this.grain.noise(x, y), fine = this.fine.noise(x, y), grit = this.grit.noise(x, y);
    const direction = this.direction.noise(x + y, y);
    let red = 1, green = 1, blue = 1, roughness = 0.8, relief = 0;
    if (this.layer === 'rock') {
      // Polygonal cooling joints belong to basalt. Sedimentary and
      // metamorphic rock instead get interrupted, warped fracture sets.
      let joint: number, block: number;
      if (this.basalt) {
        this.veins.cells(x + 0.018*small, y - 0.016*small);
        joint = (1-smoothstep(0.01,0.08,this.veins.edge))*this.veins.visibility *
          (0.45+0.55*smoothstep(-0.5,0.2,medium+small));
        block = this.veins.pigment*smoothstep(0,0.16,this.veins.edge);
      } else {
        const faultA = 3*x + 5*y + 0.34*wx + 0.11*medium;
        const faultB = 6*x - 2*y + 0.29*wy + 0.10*small;
        const first = faultPulse(faultA,0.046+0.023*smoothstep(-0.6,0.5,small),this.faultFootprint) *
          smoothstep(-0.25,0.32,medium+0.5*small);
        const second = faultPulse(faultB,0.048,this.faultFootprint) *
          smoothstep(-0.05,0.47,-medium+0.58*small);
        joint = Math.max(first,second*0.75);
        block = 0.60*medium + 0.40*small;
      }
      const inclusion = this.chips.particle(x, y, this.basalt);
      if (this.basalt) {
        // Dense dark lava, angular cooling plates, vesicles with oxidized rims.
        const pore = inclusion;
        const rim = smoothstep(0.02, 0.25, pore) * (1 - smoothstep(0.32, 0.72, pore));
        const oxidized = smoothstep(-0.12, 0.40, medium + 0.36 * small);
        red = 0.77 + 0.45 * oxidized + 0.16 * block + 0.14 * grain + 0.27 * rim;
        green = 0.87 + 0.07 * oxidized + 0.15 * block + 0.13 * grain + 0.04 * rim;
        blue = 0.96 - 0.24 * oxidized + 0.14 * block + 0.12 * grain;
        relief = 0.022 * block - 0.036 * pore + 0.008 * rim - 0.044 * joint
          + 0.012 * small + 0.004 * grain + 0.0017 * fine;
        roughness = 0.68 + 0.16 * pore + 0.11 * oxidized + 0.08 * joint + 0.05 * fine;
      } else {
        // Folded gneiss or cross-bedded sandstone. The bands pinch out and
        // intersect irregular fractures rather than covering every stone.
        const bed = 6.28318530718 * (5 * y + 2 * x + 0.47 * wx + 0.16 * medium);
        const band = Math.sin(bed + (this.sedimentary ? 0.82 : 1.3) * Math.sin(2 * bed + wy));
        const lens = smoothstep(0.20, 0.83, band)
          * smoothstep(-0.40, 0.27, medium + 0.45 * small);
        const dark = smoothstep(0.45, 0.91, -band) * (0.60 + 0.40 * small);
        // Fine cross-strata in sandstone, mineral foliation in gneiss.
        const lamina = Math.sin(TAU*(this.sedimentary
          ? 17*y + 5*x + 0.68*wx + 0.25*medium
          : 11*y + 4*x + 0.83*wx + 0.17*medium)) *
          smoothstep(-0.5,0.35,medium+0.4*small) * this.laminaVisibility;
        const iron = smoothstep(-0.16, 0.38, medium - 0.3 * small);
        red = 0.79 + 0.49 * lens - 0.15 * dark + 0.17 * block + 0.28 * inclusion
          + 0.14 * grain + (this.sedimentary ? 0.15 : 0.08) * iron;
        green = 0.81 + 0.47 * lens - 0.17 * dark + 0.18 * block + 0.25 * inclusion
          + 0.12 * grain - 0.08 * iron;
        blue = 0.84 + 0.52 * lens - 0.13 * dark + 0.17 * block + 0.32 * inclusion
          + 0.11 * grain - (this.sedimentary ? 0.24 : 0.10) * iron;
        red += 0.10*lamina + 0.065*fine; green += 0.095*lamina + 0.060*fine; blue += 0.08*lamina + 0.055*fine;
        relief = (this.sedimentary ? 0.024 : 0.034)*lens - 0.009*dark - 0.031*joint
          + 0.011*block + 0.009*inclusion + 0.013*small + 0.005*grain + 0.0022*fine
          + (this.sedimentary ? 0.009 : 0.005)*lamina;
        roughness = 0.80 - 0.16*lens - 0.12*inclusion + 0.09*joint + 0.07*dark - 0.045*lamina;
      }
      // The darker fracture material is pigment/infill, not baked directional light.
      red *= 1 - 0.21 * joint; green *= 1 - 0.20 * joint; blue *= 1 - 0.19 * joint;
      relief += 0.0007 * grit;
    } else if (this.layer === 'soil') {
      const stone = this.clasts.particle(x, y, true) * smoothstep(-0.55, 0.30, medium + small);
      const stonePigment = this.clasts.pigment * stone;
      const gravel = this.chips.particle(x + 0.02 * wy, y, this.basalt);
      const fines = smoothstep(-0.4, 0.55, medium - 0.5 * small);
      const ripple = this.sedimentary
        ? Math.sin(6.28318530718 * (13 * x + 2 * y + 0.38 * wx + 0.12 * medium))
          * smoothstep(-0.28, 0.38, medium) : 0;
      red = 0.85 - 0.15 * fines + 0.37 * stone + 0.25 * gravel + 0.19 * grain + 0.10 * ripple;
      green = 0.79 - 0.13 * fines + 0.43 * stone + 0.28 * gravel + 0.17 * grain + 0.09 * ripple;
      blue = 0.72 - 0.10 * fines + 0.55 * stone + 0.31 * gravel + 0.15 * grain + 0.07 * ripple;
      if (this.basalt) {
        red += 0.26 * stone + 0.13 * stonePigment;
        green -= 0.16 * stone;
        blue -= 0.25 * stone;
      } else {
        red += 0.13 * stonePigment; blue -= 0.11 * stonePigment;
      }
      relief = (this.sedimentary ? 0.022 : 0.055) * stone + 0.018 * gravel
        + 0.009 * ripple + 0.008 * small + 0.0032 * grain + 0.0015 * fine + 0.0006 * grit;
      roughness = 0.94 - 0.18 * stone - 0.12 * gravel - 0.05 * fines + 0.04 * grain;
    } else if (this.layer === 'vegetation') {
      const tuft = this.clasts.particle(x, y, false);
      const crown = smoothstep(-0.45,0.35,medium+0.65*small+0.42*tuft);
      const cover = 0.35+0.65*crown;
      const blade = (0.72*this.leaves.blades(x,y)+0.54*this.needles.blades(x+0.009*wy,y))*cover;
      const litter = smoothstep(this.sedimentary ? -0.15 : 0.07,0.60,-medium+0.5*small+0.38*fine);
      if (this.basalt) {
        const colony = smoothstep(-0.32,0.38,medium+0.72*small+0.52*grain);
        const lobe = 4*colony*(1-colony);
        const nodules = this.chips.particle(x+0.009*wx,y,false)*colony;
        const speckle = 0.5*grain + 0.32*fine + 0.18*grit;
        red = 0.67 + 0.59*colony + 0.24*lobe + 0.32*nodules + 0.31*speckle;
        green = 0.73 + 0.58*colony + 0.18*lobe + 0.28*nodules + 0.35*speckle;
        blue = 0.67 + 0.34*colony + 0.13*lobe + 0.19*nodules + 0.24*speckle;
        relief = 0.014*colony + 0.006*lobe + 0.011*nodules + 0.006*small + 0.004*grain + 0.0018*fine;
        roughness = 0.78 + 0.12*colony + 0.045*lobe - 0.13*nodules + 0.05*speckle;
      } else {
        red = 0.78-0.12*crown+0.52*litter+0.56*blade+0.18*grain+0.12*fine;
        green = 0.79+0.36*crown+0.10*litter+0.53*blade+0.20*grain+0.12*fine;
        blue = 0.65+0.08*crown+0.14*litter+0.23*blade+0.16*grain+0.09*fine;
        if (this.sedimentary) { red += 0.28*litter+0.17*blade; green -= 0.12*crown; }
        relief = (this.sedimentary ? 0.047 : 0.031)*tuft + 0.016*crown
          + 0.019*blade + 0.006*small + 0.003*grain + 0.0012*fine;
        roughness = 0.83 + 0.10*litter - 0.16*blade - 0.05*crown + 0.035*grain;
      }
    } else {
      // Wind-packed firn, soft drifts and small crystalline grains; nearly
      // white reflectance with subtle cool pigment, not blue baked shadows.
      const driftPhase = TAU*(4*y+x+0.55*wx+0.20*medium);
      const wind = smoothstep(-0.46,0.43,medium+0.34*small);
      const drift = (0.5+0.5*Math.sin(driftPhase+0.3*Math.sin(2*driftPhase)))*wind;
      const crust = smoothstep(-0.28,0.42,medium+0.27*direction+0.43*small);
      const crystal = this.chips.particle(x, y, false);
      red = 0.97 - 0.060 * crust + 0.025 * crystal + 0.016 * fine;
      green = 0.99 - 0.039 * crust + 0.023 * crystal + 0.015 * fine;
      blue = 1.0 - 0.020 * crust + 0.019 * crystal + 0.013 * fine;
      relief = 0.027*drift*(0.42+0.58*crust)+0.0035*direction
        + 0.009*small+0.005*crystal+0.0025*grain+0.0011*fine;
      roughness = 0.84 - 0.23 * crust + 0.07 * crystal + 0.05 * grain;
    }
    out.red = clamp(this.palette[0] * red);
    out.green = clamp(this.palette[1] * green);
    out.blue = clamp(this.palette[2] * blue);
    out.roughness = clamp(roughness, 0.28, 1);
    // Shape amplitudes are authored for a 6 m tile and scale with its period.
    out.reliefMeters = relief * (this.meters / 6) * this.strength;
    return out;
  }
}

export interface DetailTileMaps {
  resolution: number;
  meters: number;
  basecolor: Uint8ClampedArray;
  normal: Uint8ClampedArray;
  orm: Uint8ClampedArray;
  relief: Float32Array;
}

export function generateDetailTile(
  layer: MaterialLayer, surface: Partial<SurfaceSettings> | undefined, seed: number, resolution: number,
): DetailTileMaps {
  if (!Number.isInteger(resolution) || resolution < 8 || resolution > 2048)
    throw new Error('Invalid detail tile resolution (8–2048).');
  const settings = resolveSurface(surface);
  const sampler = new DetailTileSampler(layer, settings, seed, resolution);
  const count = resolution * resolution;
  const basecolor = new Uint8ClampedArray(count * 4), normal = new Uint8ClampedArray(count * 4);
  const orm = new Uint8ClampedArray(count * 4), relief = new Float32Array(count);
  const sample: DetailSample = { red: 0, green: 0, blue: 0, roughness: 0, reliefMeters: 0 };
  const n = resolution;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, p = i * 4;
    sampler.sample((x + 0.5) / n, (y + 0.5) / n, sample);
    basecolor[p] = linearToSrgbByte(sample.red);
    basecolor[p + 1] = linearToSrgbByte(sample.green);
    basecolor[p + 2] = linearToSrgbByte(sample.blue);
    basecolor[p + 3] = 255;
    relief[i] = sample.reliefMeters;
    orm[p + 1] = Math.round(255 * sample.roughness);
    orm[p + 3] = 255;
  }
  const cell = sampler.meters / n;
  // Local cavity approximation at two physical distances, independent of
  // macro terrain AO. Signed relief and wrapped gradients are also used for
  // normals, so repeating the tile does not create a normal/AO seam.
  const radiusA = Math.max(1, Math.round(n / 128));
  const radiusB = Math.max(radiusA + 1, Math.round(n / 48));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, p = i * 4;
    const dx = (relief[y*n+wrap(x+1,n)] - relief[y*n+wrap(x-1,n)]) / (2*cell);
    const dy = (relief[wrap(y+1,n)*n+x] - relief[wrap(y-1,n)*n+x]) / (2*cell);
    const length = Math.hypot(dx, dy, 1);
    normal[p] = Math.round(255 * (0.5 - 0.5 * dx / length));
    normal[p + 1] = Math.round(255 * (0.5 + 0.5 * dy / length));
    normal[p + 2] = Math.round(255 * (0.5 + 0.5 / length));
    normal[p + 3] = 255;
    let visibility = 0;
    for (let direction = 0; direction < 8; direction++) {
      // Cardinal and diagonal direction vectors; compare horizon with local
      // tangent so a uniformly sloped facet does not self-occlude.
      const ux = AO_X[direction], uy = AO_Y[direction];
      const d = direction % 2 ? Math.SQRT2 : 1;
      const t = (dx*ux+dy*uy)/d;
      const h1 = (relief[wrap(y+uy*radiusA,n)*n+wrap(x+ux*radiusA,n)]-relief[i])/(radiusA*cell*d);
      const h2 = (relief[wrap(y+uy*radiusB,n)*n+wrap(x+ux*radiusB,n)]-relief[i])/(radiusB*cell*d);
      const horizon = Math.max(t,h1,h2);
      // sin²(atan(horizon)-atan(t)), clamped at a right angle; avoid
      // hundreds of millions of transcendental calls in large tile exports.
      const difference = horizon-t;
      const blocked = 1+horizon*t <= 0 ? 1 : difference*difference/((1+horizon*horizon)*(1+t*t));
      visibility += 1 - clamp(blocked);
    }
    orm[p] = Math.round(255 * (1 - settings.aoStrength * (1 - visibility / 8)));
    // B=0 (dielectric), A=255; no directional shading in basecolor.
  }
  return { resolution, meters: sampler.meters, basecolor, normal, orm, relief };
}
