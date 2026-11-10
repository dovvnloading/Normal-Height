import type { CSSProperties } from 'react';
import type { NodeKind, MapChannel } from '../model/types';
import type { ExportFormat } from '../export/heightmap';
import './TerrainIcon.css';

/** 31 transparent images in a 4 × 8 sprite atlas. Cells are 128 × 80 pixels. */
export const ICON_NAMES = [
  "normal-height-logo",
  "mountain-range",
  "procedural-noise",
  "domain-warp",
  "river-ridge-spline",
  "hydraulic-erosion",
  "thermal-weathering",
  "terrace",
  "height-remap",
  "blend",
  "height-slope-mask",
  "terrain-output",
  "heightmap",
  "shaded-relief",
  "normal-map",
  "slope-map",
  "water-flow-map",
  "erosion-map",
  "deposition-map",
  "pbr-base-color",
  "roughness-map",
  "ambient-occlusion",
  "material-weights",
  "curvature-map",
  "packed-orm",
  "alpine-watershed",
  "granite-massif",
  "desert-badlands",
  "volcanic-caldera",
  "folded-highlands",
  "river-cut-highlands"
] as const;
export type TerrainIconName = (typeof ICON_NAMES)[number];

export const NODE_ICON_NAMES: Partial<Record<NodeKind, TerrainIconName>> = {
  mountain: 'mountain-range',
  noise: 'procedural-noise',
  warp: 'domain-warp',
  spline: 'river-ridge-spline',
  hydraulic: 'hydraulic-erosion',
  thermal: 'thermal-weathering',
  terrace: 'terrace',
  remap: 'height-remap',
  blend: 'blend',
  mask: 'height-slope-mask',
  output: 'terrain-output',
};
export const PRESET_ICON_NAMES: Record<string, TerrainIconName> = {
  alpine: 'alpine-watershed',
  massif: 'granite-massif',
  badlands: 'desert-badlands',
  volcano: 'volcanic-caldera',
  highlands: 'folded-highlands',
  'river-gorge': 'river-cut-highlands',
};
export const MAP_ICON_NAMES: Record<MapChannel, TerrainIconName> = {
  height: 'heightmap',
  terrain: 'shaded-relief',
  normal: 'normal-map',
  slope: 'slope-map',
  flow: 'water-flow-map',
  wear: 'erosion-map',
  deposition: 'deposition-map',
  basecolor: 'pbr-base-color',
  roughness: 'roughness-map',
  ao: 'ambient-occlusion',
  splat: 'material-weights',
  rockWeight: 'material-weights',
  soilWeight: 'material-weights',
  vegetationWeight: 'material-weights',
  snowWeight: 'material-weights',
  curvature: 'curvature-map',
  orm: 'packed-orm',
};
export const EXPORT_ICON_NAMES: Record<ExportFormat, TerrainIconName> = {
  png16: 'heightmap',
  raw32: 'heightmap',
  normal: 'normal-map',
  normalDX: 'normal-map',
  flow: 'water-flow-map',
  wear: 'erosion-map',
  deposition: 'deposition-map',
  pbr: 'material-weights',
  basecolor: 'pbr-base-color',
  roughness: 'roughness-map',
  ao: 'ambient-occlusion',
  metallic: 'packed-orm',
  orm: 'packed-orm',
  splat: 'material-weights',
  curvature: 'curvature-map',
};

interface TerrainIconProps {
  name: TerrainIconName;
  height?: number;
  className?: string;
  label?: string;
}

/** Uses the Vite base URL to also work under the GitHub Pages repo subpath. */
export function TerrainIcon({ name, height = 18, className = '', label }: TerrainIconProps) {
  const index = ICON_NAMES.indexOf(name);
  const column = index % 4;
  const row = Math.floor(index / 4);
  const style: CSSProperties = {
    width: Math.round(height * 1.6),
    height,
    backgroundImage: `url("${import.meta.env.BASE_URL}icons/terrain-icons-atlas.webp")`,
    backgroundPosition: `${(column / 3) * 100}% ${(row / 7) * 100}%`,
    backgroundSize: '400% 800%',
  };
  return (
    <i
      className={`terrain-icon ${className}`.trim()}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={style}
    />
  );
}
