import { GENESIS_LITHOLOGIES, type GenesisSettings } from '../../model/genesis';
import type { WorldDomain } from '../../model/world';
import { clamp, Noise, smoothstep } from '../noise';
import type { GenesisGeologySample } from './types';

/**
 * Analytic strata and uplift are evaluated in physical whole-world coordinates.
 * Raster crop and resolution never enter their definition. Categorical beds
 * are selected directly; their IDs are never interpolated.
 */
export function createGeologySampler(domain: WorldDomain, seed: number, settings: GenesisSettings) {
  const noise = new Noise((seed ^ 0x67a3bc91) >>> 0, 'v2');
  const radians = Math.PI / 180;
  const strike = settings.strataStrikeDegrees * radians;
  const dip = settings.strataDipDegrees * radians;
  const upliftAngle = settings.upliftAngleDegrees * radians;
  const faultAngle = settings.faultAngleDegrees * radians;
  const centerX = domain.originX + domain.width / 2;
  const centerZ = domain.originZ + domain.depth / 2;
  const faultWidth = Math.max(1, Math.min(domain.width, domain.depth) * 0.018);
  const phase = ((seed >>> 0) % 127) * 0.731;
  const faultOffset = (x: number, z: number) =>
    settings.faultThrowMeters *
    0.5 *
    Math.tanh(
      ((x - centerX) * -Math.sin(faultAngle) + (z - centerZ) * Math.cos(faultAngle)) / faultWidth,
    );

  return {
    sample(
      x: number,
      z: number,
      heightMeters: number,
      cumulativeUpliftMeters = 0,
    ): GenesisGeologySample {
      const xx = x - centerX,
        zz = z - centerZ;
      const along = xx * Math.cos(strike) + zz * Math.sin(strike);
      const across = -xx * Math.sin(strike) + zz * Math.cos(strike);
      const wavelength = settings.foldWavelengthMeters;
      const fold =
        settings.foldAmplitudeMeters *
        Math.sin(
          (across / wavelength) * Math.PI * 2 +
            phase +
            0.3 * noise.perlin(along / wavelength, across / wavelength),
        );
      // Undo accumulated tectonic motion before sampling the rock column:
      // uplift moves strata with the terrain, whereas incision exposes beds.
      const stratigraphicHeight =
        (heightMeters - cumulativeUpliftMeters - domain.datum) * Math.cos(dip) -
        across * Math.sin(dip) -
        fold;
      const layer = Math.floor(stratigraphicHeight / settings.strataThicknessMeters + phase);
      const lithology =
        ((layer % GENESIS_LITHOLOGIES.length) + GENESIS_LITHOLOGIES.length) %
        GENESIS_LITHOLOGIES.length;
      const competence = GENESIS_LITHOLOGIES[lithology].competence;
      const variation = noise.perlin((xx / wavelength) * 3 + 19, (zz / wavelength) * 3 - 7);
      const hardness = clamp(
        settings.rockHardness + settings.hardnessContrast * (competence - 0.5 + variation * 0.035),
      );
      return { hardness, lithology };
    },
    /** Signed total displacement target for the entire modeled duration. */
    uplift(x: number, z: number): number {
      const xx = x - centerX,
        zz = z - centerZ;
      const along = xx * Math.cos(upliftAngle) + zz * Math.sin(upliftAngle);
      const across = -xx * Math.sin(upliftAngle) + zz * Math.cos(upliftAngle);
      const width = settings.upliftWidthMeters;
      const belt = Math.exp(-2 * (across / width) ** 2);
      const modulation = 0.87 + 0.13 * noise.perlin(along / width, across / width + 41);
      let edge = 1;
      if (domain.boundary === 'open') {
        // A physical taper protects the fixed open-edge base level without
        // creating a one-cell wall whose width changes with resolution.
        const tx = Math.min(x - domain.originX, domain.originX + domain.width - x);
        const tz = Math.min(z - domain.originZ, domain.originZ + domain.depth - z);
        edge = smoothstep(0, domain.width * 0.06, tx) * smoothstep(0, domain.depth * 0.06, tz);
      }
      return (settings.upliftMeters * belt * modulation + faultOffset(x, z)) * edge;
    },
  };
}
