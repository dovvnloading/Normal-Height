import { NODE_DEFINITIONS } from './registry';
import { resolveStudioSettings, STUDIO_KERNELS, STUDIO_FRACTALS } from './noiseStudio';
import type { TerrainNode } from './types';

export function nodeSummary(node: TerrainNode) {
  const p = node.params;
  switch (node.kind) {
    case 'mountain':
      return p.ridges ? `${p.ridges} ridge lines` : 'Connected mountain ranges';
    case 'noise':
      if (p.noiseModel === 'v3') {
        const settings = resolveStudioSettings(p);
        const kernel =
          STUDIO_KERNELS.find(([id]) => id === settings.kernel)?.[1] ?? settings.kernel;
        const fractal =
          STUDIO_FRACTALS.find(([id]) => id === settings.fractal)?.[1] ?? settings.fractal;
        return `${kernel} · ${fractal}`;
      }
      return (
        NODE_DEFINITIONS.noise.params
          .find((param) => param.key === 'mode')
          ?.options?.find((option) => option.value === p.mode)?.label ?? 'Fractal noise'
      );
    case 'heightImport':
      return node.raster
        ? `${node.raster.width} × ${node.raster.height} · ${node.raster.name}`
        : 'Choose a heightmap';
    case 'coast':
      return `${p.beachWidth} m beach · ${p.shelfWidth} m shelf`;
    case 'maskOutput':
      return 'Linear 16-bit mask';
    case 'spline':
      return `${node.params.mode === 'ridge' ? 'Mountain ridge' : 'River valley'} · ${node.path?.length ?? 0} points`;
    case 'hydraulic':
      if (p.method === 'droplet')
        return `${Math.round(Number(p.droplets ?? 70000) / 1000)}k droplets / 512²`;
      if (p.method === 'watershed') return 'Watershed v1 · stream power';
      if (p.method === 'fluid') return `Fluid grid · ${p.cycles ?? 28} steps (experimental)`;
      if (p.method === 'hybrid')
        return `Landscape + fluid · ${p.cycles ?? 28} steps (experimental)`;
      return `Landscape · ${p.cycles ?? 28} steps · ${p.multiscale === false ? 'single scale' : 'multi-scale'}`;
    case 'thermal':
      return `${p.iterations ?? 24} relaxation passes`;
    case 'warp':
      return 'Domain displacement';
    case 'terrace':
      return `${p.steps ?? 8} elevation bands`;
    case 'remap':
      return 'Elevation & contrast';
    case 'blend':
      return String(p.mode ?? 'mix').replaceAll('-', ' ');
    case 'mask':
      return String(p.mode ?? p.type ?? 'Elevation mask').replaceAll('-', ' ');
    case 'output':
      return 'Final heightfield';
    default:
      return '';
  }
}
