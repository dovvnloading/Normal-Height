import { crc32 } from '../model/pngCrc';
import { zlibSync, zipSync, strToU8 } from 'fflate';
import { normalMapPixels, colorizeMap } from '../render/maps';
import { generatePBR, pbrPixels, SPLAT_LAYERS, resolveSurface, AO_RADII_METERS } from '../materials/pbr';
import type { PBRChannel } from '../materials/pbr';
import { DETAIL_TILE_MODEL_VERSION, detailTileMeters, generateDetailTile } from '../materials/detailTiles';
import type { HeightField, TerrainProject } from '../model/types';
import { slug } from '../model/project';
import { serializeProjectFile } from '../model/projectStorage';
import { listMaskOutputs } from './maskOutputs';
import { isSinglePBRExportFormat } from './budget';
import { getPaintLayers, getPaintStrokes } from '../materials/paintLayers';

const encoder = new TextEncoder();
function chunk(type: string, data: Uint8Array) {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(encoder.encode(type), 4);
  result.set(data, 8);
  view.setUint32(data.length + 8, crc32(result.subarray(4, data.length + 8)));
  return result;
}
function concat(arrays: Uint8Array[]) {
  const total = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}
function encodePNG(
  width: number,
  height: number,
  scanlines: Uint8Array,
  bitDepth: number,
  colorType: number,
) {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = bitDepth;
  header[9] = colorType;
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(scanlines, { level: 6 })),
    chunk('IEND', new Uint8Array()),
  ]);
}
export function heightRange(height: Float32Array) {
  let min = Infinity,
    max = -Infinity;
  for (const h of height) {
    if (!Number.isFinite(h)) throw new Error('The heightfield contains invalid elevation data.');
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  return { min, max };
}
export function encodeHeightPNG(
  field: Pick<HeightField, 'height' | 'resolution'>,
  range = heightRange(field.height),
) {
  const n = field.resolution;
  if (field.height.length !== n * n) throw new Error('Heightfield dimensions do not match.');
  const rowBytes = n * 2 + 1;
  const pixels = new Uint8Array(n * rowBytes);
  const span = range.max - range.min || 1;
  for (let y = 0; y < n; y++) {
    let offset = y * rowBytes + 1;
    for (let x = 0; x < n; x++) {
      const value = Math.round(
        Math.min(1, Math.max(0, (field.height[y * n + x] - range.min) / span)) * 65535,
      );
      pixels[offset++] = value >>> 8;
      pixels[offset++] = value & 255;
    }
  }
  return encodePNG(n, n, pixels, 16, 0);
}
export function encodeRGBA(pixels: Uint8ClampedArray, n: number) {
  const rows = new Uint8Array(n * (n * 4 + 1));
  for (let y = 0; y < n; y++)
    rows.set(pixels.subarray(y * n * 4, (y + 1) * n * 4), y * (n * 4 + 1) + 1);
  return encodePNG(n, n, rows, 8, 6);
}
export function encodeRawHeight(field: HeightField, heightScale: number) {
  const bytes = new Uint8Array(field.height.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < field.height.length; i++)
    view.setFloat32(i * 4, field.height[i] * heightScale, true);
  return bytes;
}
export type ExportFormat = 'png16' | 'mask16' | 'raw32' | 'normal' | 'flow' | 'wear' | 'deposition'
  | 'pbr' | 'detailTiles' | 'basecolor' | 'roughness' | 'ao' | 'metallic' | 'orm'
  | 'splat' | 'curvature' | 'normalGL' | 'normalDX' | 'detailNormal';
/** A separate portable set: four tileable surface assets, no DEM simulation. */
export function makeDetailTileExport(project: TerrainProject, resolution: number, onLayer?: (layer: string) => void) {
  const name = slug(project.name);
  const surface = resolveSurface(project.surface);
  const files: Record<string, Uint8Array> = {};
  const materials: { layer: string; path: string; minReliefMeters: number; maxReliefMeters: number }[] = [];
  for (const layer of SPLAT_LAYERS) {
    onLayer?.(layer);
    const tile = generateDetailTile(layer, surface, project.seed, resolution);
    const root = layer + '/';
    const range = heightRange(tile.relief);
    materials.push({ layer, path: root, minReliefMeters: range.min, maxReliefMeters: range.max });
    files[root + 'basecolor.png'] = encodeRGBA(tile.basecolor, resolution);
    files[root + 'height16.png'] = encodeHeightPNG({ height: tile.relief, resolution }, range);
    files[root + 'normal-gl.png'] = encodeRGBA(tile.normal, resolution);
    // Encode OpenGL first, then reuse the owned normal buffer for DirectX.
    for (let i = 1; i < tile.normal.length; i += 4) tile.normal[i] = 255 - tile.normal[i];
    files[root + 'normal-dx.png'] = encodeRGBA(tile.normal, resolution);
    files[root + 'orm.png'] = encodeRGBA(tile.orm, resolution);
    // Reuse normal storage for standalone grayscale roughness to bound peak RAM.
    for (let i = 0; i < tile.normal.length; i += 4) {
      tile.normal[i] = tile.normal[i+1] = tile.normal[i+2] = tile.orm[i+1];
      tile.normal[i+3] = 255;
    }
    files[root + 'roughness.png'] = encodeRGBA(tile.normal, resolution);
  }
  const meters = detailTileMeters(surface.detailMeters);
  files['material-tiles.json'] = strToU8(JSON.stringify({
    application: 'Normal Height', materialTileModelVersion: DETAIL_TILE_MODEL_VERSION,
    resolution: [resolution, resolution], tileSizeMeters: [meters, meters],
    sampleSpacingMeters: meters / resolution, seed: project.seed, surface,
    sampling: 'Repeat U and V; pixel centers are (index+0.5)/resolution. No duplicated border texels.',
    orientation: 'North at top; column increases east. OpenGL +Y and DirectX -Y normals provided.',
    channelContract: {
      basecolor: 'sRGB, unlit reflectance, opaque alpha',
      height16: 'Linear 16-bit UNORM. relief_m = minReliefMeters + code/65535*(maxReliefMeters-minReliefMeters)',
      'normal-gl': 'Linear RGB tangent normal, +Y',
      'normal-dx': 'Linear RGB tangent normal, -Y',
      orm: 'Linear R=approximate local cavity AO, G=perceptual roughness, B=0 metallic, A=255',
      roughness: 'Linear grayscale perceptual roughness',
    },
    usage: 'Independent surface assets for repeat sampling and layer blending using terrain splat masks. Not pixel-identical to the live analytic terrain shader. Local cavity AO is not terrain horizon AO. Blend or layer detail normals with the terrain normal; do not overwrite terrain slope.',
    materials,
  }, null, 2));
  return { bytes: zipSync(files, { level: 0 }), filename: name + '-' + surface.biome + '-' + resolution + '-detail-tiles.zip', mime: 'application/zip' };
}

export function makeExport(
  field: HeightField,
  project: TerrainProject,
  format: ExportFormat,
  bundle: boolean,
  outputNodeId?: string,
) {
  if (format === 'detailTiles') return makeDetailTileExport(project, field.resolution);
  const name = slug(project.name);
  const range = heightRange(field.height);
  if (format === 'mask16') {
    const mask = listMaskOutputs(project.graph).find((item) => item.id === outputNodeId);
    if (!mask?.input) throw new Error('Choose a connected Mask output to export.');
    const prefix = `${name}-${field.resolution}-${mask.stem}-mask16`;
    const filename = prefix + '.png';
    const bytes = encodeHeightPNG(field, { min: 0, max: 1 });
    if (!bundle) return { bytes, filename, mime: 'image/png' };
    const metadata = {
      application: 'Normal Height',
      version: 1,
      format,
      filename,
      outputNodeId: mask.id,
      outputName: mask.label,
      sourceNodeId: mask.input.source,
      sourceHandle: mask.input.sourceHandle || 'height',
      maskEncoding: 'Linear unsigned 16-bit grayscale. Weight = sample / 65535. Input is clamped to [0, 1].',
      colorSpace: 'linear-non-color',
      resolution: [field.resolution, field.resolution],
      worldSizeMeters: [project.worldSize, project.worldSize],
      sampleSpacingMeters: project.worldSize / (field.resolution - 1),
      orientation: 'Row-major, first row is north (negative Z). X increases east/right.',
      seed: project.seed,
    };
    const files = {
      [filename]: bytes,
      [prefix + '-metadata.json']: strToU8(JSON.stringify(metadata, null, 2)),
      [name + '.nhterrain.json']: strToU8(serializeProjectFile({ ...project, resolution: field.resolution })),
    };
    return { bytes: zipSync(files, { level: 0 }), filename: prefix + '.zip', mime: 'application/zip' };
  }
  if (format === 'pbr') {
    const maps = generatePBR(field, project);
    const reliefRange = heightRange(maps.detail);
    const prefix = name + '-' + field.resolution;
    const png = (channel: PBRChannel, directX = false) =>
      encodeRGBA(pbrPixels(maps, field, project, channel, directX), field.resolution);
    const metadata = {
      application: 'Normal Height',
      version: 1,
      materialVersion: 4,
      surfaceSchemaVersion: 1,
      resolution: [field.resolution, field.resolution],
      worldSizeMeters: [project.worldSize, project.worldSize],
      sampleSpacingMeters: project.worldSize / (field.resolution - 1),
      elevationMinMeters: range.min * project.heightScale,
      elevationMaxMeters: range.max * project.heightScale,
      elevationEncoding: '16-bit grayscale UNORM; elevation_m = min_m + sample/65535*(max_m-min_m)',
      orientation: 'Row-major; first row north (-Z), X east/right.',
      baseColorSpace: 'sRGB; albedo excludes lighting and ambient occlusion',
      dataColorSpace: 'Linear / non-color for normals, roughness, AO, ORM, masks and displacement',
      normals: {
        normal_gl: 'OpenGL +Y, height and microdetail; intended for flat or low-detail meshes',
        normal_dx: 'DirectX -Y; exact green-channel inverse of OpenGL normals',
        detailnormal_gl: 'Microdetail ONLY, for displaced high-resolution terrain; avoids duplicated geometry normals',
      },
      packedMaps: {
        orm: 'R=ambient occlusion, G=roughness, B=metallic (0), A=255; glTF-style',
        unity_hdrp_mask: 'R=metallic (0), G=AO, B=detail mask (255), A=smoothness (1-roughness)',
        splat_rgba: SPLAT_LAYERS,
      },
      materialModel: 'Seeded biome-specific facies and natural substrate contacts, mixed in linear light using terrain evidence and authored layer coverage.',
      materialRelief: {
        minMeters: reliefRange.min, maxMeters: reliefRange.max,
        decoding: 'vertical relief in meters = minMeters + sample/65535 * (maxMeters-minMeters)',
      },
      paintedStrokes: getPaintStrokes(project).length,
      paintLayers: getPaintLayers(project).map(({ id, name, visible, opacity }) => ({ id, name, visible, opacity })),
      terrainAnalysis: {
        slope: 'Physical gradient in meters per meter; slope exposed in degrees',
        landform: 'Signed plane-corrected multi-radius height residual: positive valley / negative crest',
        aspect: 'Northern hemisphere proxy: positive north-facing, based on the height gradient',
        erosion: 'Wear/deposition relative to nonzero 90th-percentile diagnostics; neither is measured sediment depth',
        snow: 'Relative terrain snow line with slope stability, concavity and aspect retention; not simulated snowpack',
        ao: 'Cosine-weighted sky visibility integrated between the local tangent and sampled horizon in eight azimuths',
        resolvedDetail: 'Texture wavelengths smaller than 2-5 source cells fade instead of aliasing or resizing',
        materialHeightUnits: 'Microdetail in meters; the displaced terrain field is unchanged',
      },
      surface: resolveSurface(project.surface),
      seed: project.seed,
      aoHorizonRadiiMeters: AO_RADII_METERS,
      textureChannels: {
        basecolor: { colorSpace: 'sRGB', channels: ['red', 'green', 'blue', 'alpha'] },
        normal_gl: { colorSpace: 'linear', channels: ['normalX', 'normalY_OpenGL', 'normalZ', 'alpha'] },
        normal_dx: { colorSpace: 'linear', channels: ['normalX', 'normalY_DirectX', 'normalZ', 'alpha'] },
        detailnormal_gl: { colorSpace: 'linear', channels: ['microNormalX', 'microNormalY_OpenGL', 'microNormalZ', 'alpha'] },
        roughness: { colorSpace: 'linear', channels: ['roughness', 'roughness', 'roughness', 'alpha'] },
        ao: { colorSpace: 'linear', channels: ['occlusion', 'occlusion', 'occlusion', 'alpha'] },
        metallic: { colorSpace: 'linear', channels: ['metallic', 'metallic', 'metallic', 'alpha'] },
        orm: { colorSpace: 'linear', channels: ['occlusion', 'roughness', 'metallic', 'alpha'] },
        splat_rgba: { colorSpace: 'linear', channels: SPLAT_LAYERS },
        curvature: { colorSpace: 'linear', channels: ['curvature', 'curvature', 'curvature', 'alpha'] },
        unity_hdrp_mask: { colorSpace: 'linear', channels: ['metallic', 'occlusion', 'detailMask', 'smoothness'] },
        height16: { colorSpace: 'linear', channels: ['elevationUNorm16'] },
        relief16: { colorSpace: 'linear', channels: ['materialReliefUNorm16'] },
      },
    };
    const files: Record<string, Uint8Array> = {
      [prefix + '-height16.png']: encodeHeightPNG(field, range),
      [prefix + '-relief16.png']: encodeHeightPNG({ height: maps.detail, resolution: maps.resolution }, reliefRange),
      [prefix + '-basecolor.png']: png('basecolor'),
      [prefix + '-normal-gl.png']: png('normal'),
      [prefix + '-normal-dx.png']: png('normal', true),
      [prefix + '-detailnormal-gl.png']: png('detailNormal'),
      [prefix + '-roughness.png']: png('roughness'),
      [prefix + '-ao.png']: png('ao'),
      [prefix + '-metallic.png']: png('metallic'),
      [prefix + '-orm.png']: png('orm'),
      [prefix + '-splat-rgba.png']: png('splat'),
      [prefix + '-curvature.png']: png('curvature'),
      [prefix + '-unity-hdrp-mask.png']: png('unityMask'),
      [name + '-material-metadata.json']: strToU8(JSON.stringify(metadata, null, 2)),
      [name + '.nhterrain.json']: strToU8(
        serializeProjectFile({ ...project, surface: resolveSurface(project.surface), resolution: field.resolution }),
      ),
    };
    // PNG files are already compressed: storing them in ZIP avoids a second
    // costly deflate pass and lowers peak transient allocations.
    return { bytes: zipSync(files, { level: 0 }), filename: prefix + '-pbr.zip',
      mime: 'application/zip' };
  }
  let bytes: Uint8Array;
  let filename: string;
  if (format === 'png16') {
    bytes = encodeHeightPNG(field, range);
    filename = `${name}-${field.resolution}-height16.png`;
  } else if (format === 'raw32') {
    bytes = encodeRawHeight(field, project.heightScale);
    filename = `${name}-${field.resolution}-elevation-f32le.raw`;
  } else {
    const pixels = isSinglePBRExportFormat(format)
      ? pbrPixels(generatePBR(field, project), field, project,
          format === 'normalDX' || format === 'normalGL' ? 'normal' : format as PBRChannel, format === 'normalDX')
      : format === 'normal'
        ? normalMapPixels(field, project.worldSize, project.heightScale)
        : colorizeMap(field, format as 'flow' | 'wear' | 'deposition', project.worldSize, project.heightScale);
    bytes = encodeRGBA(pixels, field.resolution);
    filename = `${name}-${field.resolution}-${format}.png`;
  }
  const materialChannelNames: Partial<Record<ExportFormat, string[]>> = {
    basecolor: ['red', 'green', 'blue', 'alpha'],
    roughness: ['roughness', 'roughness', 'roughness', 'alpha'],
    ao: ['occlusion', 'occlusion', 'occlusion', 'alpha'],
    metallic: ['metallic', 'metallic', 'metallic', 'alpha'],
    orm: ['occlusion', 'roughness', 'metallic', 'alpha'],
    splat: [...SPLAT_LAYERS],
    curvature: ['curvature', 'curvature', 'curvature', 'alpha'],
    normalGL: ['normalX', 'normalY_OpenGL', 'normalZ', 'alpha'],
    detailNormal: ['microNormalX', 'microNormalY_OpenGL', 'microNormalZ', 'alpha'],
    normalDX: ['normalX', 'normalY_DirectX', 'normalZ', 'alpha'],
    normal: ['normalX', 'normalY_OpenGL', 'normalZ', 'alpha'],
  };
  // Single material-map bundles must remain reproducible even when an old
  // project did not explicitly store a surface configuration. Legacy height
  // and diagnostic bundle metadata is intentionally unchanged.
  const resolvedProject = materialChannelNames[format]
    ? { ...project, surface: resolveSurface(project.surface), resolution: field.resolution }
    : { ...project, resolution: field.resolution };
  const metadata = {
    application: 'Normal Height',
    version: 1,
    format,
    resolution: [field.resolution, field.resolution],
    worldSizeMeters: [project.worldSize, project.worldSize],
    sampleSpacingMeters: project.worldSize / (field.resolution - 1),
    elevationMinMeters: range.min * project.heightScale,
    elevationMaxMeters: range.max * project.heightScale,
    orientation: 'Row-major, first row is north (negative Z); X increases east/right.',
    heightEncoding:
      format === 'png16'
        ? 'Unsigned 16-bit grayscale; elevation_m = min_m + (sample / 65535) * (max_m - min_m)'
        : format === 'raw32'
          ? 'Little-endian IEEE 754 Float32 elevation in meters, no header'
          : undefined,
    normalConvention:
      ['normal', 'normalGL', 'detailNormal'].includes(format)
        ? 'OpenGL +Y: G encodes north/up, RGB maps [-1,1] to [0,255].'
        : format === 'normalDX'
          ? 'DirectX -Y: green is inverted relative to OpenGL +Y, RGB maps [-1,1] to [0,255].'
          : undefined,
    materialEncoding: ['basecolor', 'roughness', 'ao', 'metallic', 'orm', 'splat', 'curvature', 'normalDX', 'normalGL', 'detailNormal'].includes(format)
      ? 'Procedural PBR material map; see complete PBR bundle for channel packing and color-space conventions.'
      : undefined,
    diagnosticEncoding: ['flow', 'wear', 'deposition'].includes(format)
      ? '8-bit display visualization, normalized independently; not physical flow rate.'
      : undefined,
    colorSpace: format === 'basecolor' ? 'sRGB' : format === 'raw32' || format === 'png16' ? 'linear' : 'linear-non-color',
    channelNames: materialChannelNames[format] ?? null,
    surfaceSchemaVersion: materialChannelNames[format] ? 1 : undefined,
    surface: materialChannelNames[format] ? resolveSurface(project.surface) : undefined,
    seed: project.seed,
    project: materialChannelNames[format] ? resolvedProject : project,
  };
  if (bundle) {
    return {
      bytes: zipSync(
        {
          [filename]: bytes,
          [`${name}-metadata.json`]: strToU8(JSON.stringify(metadata, null, 2)),
          [`${name}.nhterrain.json`]: strToU8(
            serializeProjectFile(resolvedProject),
          ),
        },
        { level: 6 },
      ),
      filename: `${name}-${field.resolution}-${format}.zip`,
      mime: 'application/zip',
    };
  }
  return { bytes, filename, mime: format === 'raw32' ? 'application/octet-stream' : 'image/png' };
}
