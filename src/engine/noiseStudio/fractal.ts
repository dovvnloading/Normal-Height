import type { StudioSettings } from '../../model/noiseStudio';
import { deriveSeed } from '../../model/noiseStudio';
import { createKernel } from './kernels';
import type { StudioKernelEvaluator } from './kernels';
import { clamp, mix, octaveVisibility } from './math';
import { calibrationFor, pingPongSignal, ridgeSignal } from './statistics';

interface Layer {
  kernel: StudioKernelEvaluator;
  frequency: number;
  amplitude: number;
  fraction: number;
  cos: number;
  sin: number;
}
export interface FractalEvaluator {
  sample(x: number, y: number, footprint: number): number;
}

/** Bounded synthesis in [0,1], normalized by authored weights, not visible layers. */
export function createFractal(s: StudioSettings, seed: number): FractalEvaluator {
  const layers: Layer[] = [],
    count = s.fractal === 'none' ? 1 : Math.ceil(s.octaves);
  let frequency = 1,
    amplitude = 1,
    normalization = 0;
  for (let i = 0; i < count; i++) {
    const fraction = s.fractal === 'none' ? 1 : Math.min(1, s.octaves - i);
    const angle = (i * s.octaveRotation * Math.PI) / 180;
    layers.push({
      kernel: createKernel(s, i === 0 ? seed : deriveSeed(seed, 101, i)),
      frequency,
      amplitude,
      fraction,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
    });
    normalization += amplitude * fraction;
    amplitude *= s.persistence;
    frequency *= s.lacunarity;
  }
  const getMoments = calibrationFor(s);
  // Musgrave's heterogeneous recurrence is multiplicative. Its normalization
  // uses a conservative analytic range, independent of pixels and random seed.
  let heteroGrowth = 1;
  for (let i = 1; i < layers.length; i++)
    heteroGrowth *= 1 + layers[i].amplitude * layers[i].fraction * (s.fractalOffset + 1);
  const heteroLow = Math.min(0, s.fractalOffset - 1) * heteroGrowth;
  const heteroHigh = (s.fractalOffset + 1) * heteroGrowth;
  const hybridLow = Math.min(0, s.fractalOffset - 1) * normalization;
  const hybridHigh = (s.fractalOffset + 1) * normalization;

  return {
    sample(x, y, footprint) {
      let sum = 0,
        feedback = 1,
        ridgeWeight = 1,
        hybridWeight = 1;
      let dx = 0,
        dy = 0,
        dampX = 0,
        dampY = 0,
        swissAmplitude = 1;
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i];
        if (l.amplitude === 0) continue;
        let px = x,
          py = y;
        if (s.fractal === 'swiss') {
          px += s.derivativeWarp * dx;
          py += s.derivativeWarp * dy;
        }
        let qx = (px * l.cos - py * l.sin) * l.frequency;
        let qy = (px * l.sin + py * l.cos) * l.frequency;
        if (s.fractal === 'jordan') {
          qx += dx * l.cos - dy * l.sin;
          qy += dx * l.sin + dy * l.cos;
        }
        const visibility =
          footprint > 0 ? octaveVisibility(footprint * l.frequency * l.kernel.bandwidth) : 1;
        const derivativeMode = s.fractal === 'swiss' || s.fractal === 'jordan';
        const kernelFootprint = footprint * l.frequency;
        const g =
          derivativeMode && visibility > 0 ? l.kernel.gradient(qx, qy, kernelFootprint) : undefined;
        const raw =
          visibility === 0 ? 0 : clamp(g?.value ?? l.kernel.sample(qx, qy, kernelFootprint), -1, 1);
        // The mean is fetched only when needed. This avoids calibration work for
        // unfiltered references and sufficiently resolved layers.
        const m = visibility < 1 ? getMoments() : undefined;
        const n = m ? mix(m.raw, raw, visibility) : raw;
        const a = l.amplitude * l.fraction * feedback;
        switch (s.fractal) {
          case 'none':
            return clamp(0.5 + 0.5 * n);
          case 'fbm':
            sum += a * n;
            break;
          case 'billow': {
            const folded = m ? mix(m.absolute, Math.abs(raw), visibility) : Math.abs(raw);
            sum += a * (2 * folded - 1);
            break;
          }
          case 'turbulence': {
            const folded = m ? mix(m.absolute, Math.abs(raw), visibility) : Math.abs(raw);
            sum += a * folded;
            break;
          }
          case 'ridged': {
            const r = m ? mix(m.ridge, ridgeSignal(raw, s), visibility) : ridgeSignal(raw, s);
            sum += a * r * ridgeWeight;
            ridgeWeight = clamp(r * s.ridgeGain);
            break;
          }
          case 'pingpong': {
            const folded = m
              ? mix(m.pingpong, pingPongSignal(raw, s.pingPongStrength), visibility)
              : pingPongSignal(raw, s.pingPongStrength);
            sum += a * (2 * folded - 1);
            break;
          }
          case 'hybrid': {
            const signal = n + s.fractalOffset;
            if (i === 0) {
              sum = signal;
              hybridWeight = signal;
            } else {
              sum += a * clamp(hybridWeight) * signal;
              hybridWeight *= l.amplitude * signal;
            }
            break;
          }
          case 'hetero': {
            const signal = n + s.fractalOffset;
            if (i === 0) sum = signal;
            else sum += a * signal * sum;
            break;
          }
          case 'swiss': {
            const ridge = m ? 1 - mix(m.absolute, Math.abs(raw), visibility) : 1 - Math.abs(raw);
            const weight = swissAmplitude * l.fraction * feedback;
            sum += weight * ridge;
            if (g) {
              // Local derivative rotated back to the common domain. As in the
              // reference recurrence, no extra octave-frequency chain factor.
              const gx = g.dx * l.cos + g.dy * l.sin,
                gy = -g.dx * l.sin + g.dy * l.cos;
              dx += weight * gx * -raw * visibility;
              dy += weight * gy * -raw * visibility;
            }
            swissAmplitude *= s.persistence * clamp(sum);
            break;
          }
          case 'jordan': {
            const square = m ? mix(m.square, raw * raw, visibility) : raw * raw;
            // Shared UI coefficients are a bounded reference-derived Jordan
            // variant. Damping preferentially removes detail in flat regions.
            const dampScale = s.derivativeDamping / (1 + s.derivativeDamping);
            const damping =
              i === 0 || l.kernel.derivative === 'discontinuous'
                ? 1
                : 1 - dampScale / (1 + dampX * dampX + dampY * dampY);
            sum += a * damping * square;
            if (g) {
              const gx = (g.dx * l.cos + g.dy * l.sin) * raw * visibility;
              const gy = (-g.dx * l.sin + g.dy * l.cos) * raw * visibility;
              dx += s.derivativeWarp * gx;
              dy += s.derivativeWarp * gy;
              dampX += gx;
              dampY += gy;
            }
            break;
          }
        }
        // Standard signed detail weighting keeps all advertised modes connected
        // to this control. It cannot increase a layer above its authored weight.
        feedback *= mix(1, clamp((n + 1) * 0.5), s.weightedStrength);
      }
      if (s.fractal === 'hybrid') return clamp((sum - hybridLow) / (hybridHigh - hybridLow));
      if (s.fractal === 'hetero') return clamp((sum - heteroLow) / (heteroHigh - heteroLow));
      if (s.fractal === 'fbm' || s.fractal === 'billow' || s.fractal === 'pingpong')
        return clamp(0.5 + (0.5 * sum) / normalization);
      return clamp(sum / normalization);
    },
  };
}
