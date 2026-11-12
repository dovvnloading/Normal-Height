import * as THREE from 'three';
import type { HeightField, TerrainProject, ViewSettings } from '../model/types';

export const TERRAIN_SIZE = 2.6;
const HALF = TERRAIN_SIZE / 2;
const APRON_WIDTH = 0.74;

function bilinear(field: HeightField, u: number, v: number): number {
  const n = field.resolution;
  const x = THREE.MathUtils.clamp(u, 0, 1) * (n - 1);
  const y = THREE.MathUtils.clamp(v, 0, 1) * (n - 1);
  const ix = Math.floor(x), iy = Math.floor(y);
  const nx = Math.min(n - 1, ix + 1), ny = Math.min(n - 1, iy + 1);
  const fx = x - ix, fy = y - iy, data = field.height;
  return (
    data[iy * n + ix] * (1 - fx) * (1 - fy) +
    data[iy * n + nx] * fx * (1 - fy) +
    data[ny * n + ix] * (1 - fx) * fy +
    data[ny * n + nx] * fx * fy
  );
}

/**
 * Four sided, conforming terrain apron. The inner vertices match the generated
 * heightmap exactly; the outer vertices flatten into the surrounding meadow.
 * This is visual-only geometry and never touches the generated height field.
 */
export function buildGroundApron(
  field: HeightField,
  project: TerrainProject,
  exaggeration: number,
  flatY: number,
  extent: number,
  terrain?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null,
): THREE.BufferGeometry {
  // Match the 3D tile's tessellation exactly, eliminating border cracks on
  // high-frequency heightfields and at reduced working mesh resolutions.
  const sourceIndices = terrain?.geometry.userData.nhPerimeterIndices as number[] | undefined;
  const sourcePositions = terrain?.geometry.getAttribute('position');
  const segments = Math.max(1, Math.min(511, field.resolution - 1));
  // The adaptive surface's outer edge can contain different numbers of
  // segments per side. Use its exact indices, not an assumed square grid.
  const count = sourceIndices?.length ?? segments * 4;
  // Extra near-edge rings stop high-frequency erosion from stretching into
  // visible radial grooves. Each ring is shared by its neighboring triangles.
  const levels = [0, 0.035, 0.075, 0.14, 0.24, 0.38, 0.55, 0.75, 1];
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const blends: number[] = [];
  const boundaryColors: number[] = [];
  const heightScale = (TERRAIN_SIZE * project.heightScale / project.worldSize) * exaggeration;

  // Evaluate the entire closed perimeter once. Averaging wrapped perimeter
  // samples, rather than smoothing each side independently, prevents creases
  // that shoot radially outward from the tile's four corners.
  const edge = Array.from({ length: count }, (_, i) => {
    if (sourceIndices && sourcePositions) {
      const source = sourceIndices[i];
      return {
        x: sourcePositions.getX(source),
        z: sourcePositions.getZ(source),
        height: sourcePositions.getY(source) /
          (TERRAIN_SIZE * project.heightScale / project.worldSize),
      };
    }
    const side = Math.floor(i / segments);
    const fraction = (i % segments) / segments;
    let x = 0, z = 0;
    if (side === 0) { x = -HALF + fraction * TERRAIN_SIZE; z = -HALF; }
    if (side === 1) { x = HALF; z = -HALF + fraction * TERRAIN_SIZE; }
    if (side === 2) { x = HALF - fraction * TERRAIN_SIZE; z = HALF; }
    if (side === 3) { x = -HALF; z = HALF - fraction * TERRAIN_SIZE; }
    return { x, z, height: bilinear(field, x / TERRAIN_SIZE + 0.5, z / TERRAIN_SIZE + 0.5) };
  });
  const offsets: Array<[number, number]> = [
    [-0.055, 0.7], [-0.025, 1.2], [-0.009, 1.5], [0, 3.2],
    [0.009, 1.5], [0.025, 1.2], [0.055, 0.7],
  ];
  const smoothed = edge.map((_, i) => {
    let sum = 0, weights = 0;
    for (const [fraction, weight] of offsets) {
      const shift = Math.round(fraction * segments);
      const neighbor = ((i + shift) % count + count) % count;
      sum += edge[neighbor].height * weight;
      weights += weight;
    }
    return sum / weights;
  });

  for (const t of levels) {
    const scale = 1 + (APRON_WIDTH / HALF) * t;
    const fineDetail = Math.exp(-30 * t);
    const flatten = THREE.MathUtils.smoothstep(t, 0.02, 0.72);
    for (let i = 0; i < count; i++) {
      const { x, z, height } = edge[i];
      const seamlessHeight = smoothed[i] + (height - smoothed[i]) * fineDetail;
      const px = x * scale, pz = z * scale;
      vertices.push(px, THREE.MathUtils.lerp(seamlessHeight * heightScale, flatY, flatten), pz);
      uvs.push(0.5 + px / extent, 0.5 - pz / extent);
      blends.push(1);
      boundaryColors.push(0.38, 0.45, 0.32);
    }
  }
  for (let ring = 0; ring < levels.length - 1; ring++) {
    for (let i = 0; i < count; i++) {
      const a = ring * count + i, b = ring * count + (i + 1) % count;
      const c = (ring + 1) * count + i, d = (ring + 1) * count + (i + 1) % count;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('nhGrassBlend', new THREE.Float32BufferAttribute(blends, 1));
  geo.setAttribute('nhEdgeAlbedo', new THREE.Float32BufferAttribute(boundaryColors, 3));
  geo.userData.edgeVertexCount = count;
  geo.userData.edgeLevels = levels;
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.setAttribute('nhOriginalNormal', geo.getAttribute('normal').clone());
  geo.computeBoundingSphere();
  return geo;
}

function grassTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The grass preview texture could not be created.');
  ctx.fillStyle = '#4e6a39';
  ctx.fillRect(0, 0, 256, 256);
  // Fine, tileable-looking field strokes: no network requests or stock textures.
  let seed = 0x9168c25;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const palette = ['#768a4e', '#425d31', '#87955b', '#3f5c35', '#a6a16b', '#5d783e'];
  // Broad, restrained tonal patches keep the meadow from looking like a
  // uniformly colored plane at high camera altitude.
  for (let patch = 0; patch < 240; patch++) {
    ctx.globalAlpha = 0.025 + random() * 0.075;
    ctx.fillStyle = palette[Math.floor(random() * palette.length)];
    ctx.beginPath();
    ctx.ellipse(random() * 256, random() * 256, 5 + random() * 21,
      3 + random() * 13, random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 18000; i++) {
    const x = random() * 256, y = random() * 256;
    ctx.globalAlpha = 0.11 + random() * 0.42;
    ctx.strokeStyle = palette[Math.floor(random() * palette.length)];
    ctx.lineWidth = 0.25 + random() * 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (random() - 0.5) * 2, y - 1 - random() * 5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function meadowGeometry(extent: number, hasTile: boolean): THREE.BufferGeometry {
  const outer = extent / 2, inner = HALF + APRON_WIDTH;
  const shape = new THREE.Shape();
  shape.moveTo(-outer, -outer);
  shape.lineTo(-outer, outer);
  shape.lineTo(outer, outer);
  shape.lineTo(outer, -outer);
  shape.closePath();
  if (hasTile) {
    const hole = new THREE.Path();
    hole.moveTo(-inner, -inner);
    hole.lineTo(inner, -inner);
    hole.lineTo(inner, inner);
    hole.lineTo(-inner, inner);
    hole.closePath();
    shape.holes.push(hole);
  }
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, 0.5 + position.getX(i) / extent, 0.5 - position.getZ(i) / extent);
  }
  uv.needsUpdate = true;
  return geometry;
}

export class GroundExtension {
  private readonly texture = grassTexture();
  private readonly meadowMaterial = new THREE.MeshStandardMaterial({
    map: this.texture, color: '#ffffff', roughness: 0.98, metalness: 0, side: THREE.DoubleSide,
  });
  private readonly apronMaterial = new THREE.MeshStandardMaterial({
    map: this.texture, color: '#ffffff', roughness: 0.98, metalness: 0, side: THREE.DoubleSide,
  });
  private meadow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private apron: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private geometryKey = '';
  private lastTerrainGeometry: THREE.BufferGeometry | null = null;

  constructor(private readonly scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.apronMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute vec3 nhEdgeAlbedo; attribute float nhGrassBlend; varying vec3 vNHEdgeAlbedo; varying float vNHGrassBlend;\n' +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvNHEdgeAlbedo = nhEdgeAlbedo; vNHGrassBlend = nhGrassBlend;');
      shader.fragmentShader =
        'varying vec3 vNHEdgeAlbedo; varying float vNHGrassBlend;\n' +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
        '#include <map_fragment>\ndiffuseColor.rgb = mix(vNHEdgeAlbedo, diffuseColor.rgb, vNHGrassBlend);');
    };
  }

  update(
    field: HeightField | null,
    project: TerrainProject | null,
    settings: ViewSettings,
    minimum: number,
    terrain?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null,
  ) {
    if (!settings.expandGround) {
      if (this.meadow) this.meadow.visible = false;
      if (this.apron) this.apron.visible = false;
      return;
    }
    // Carry the textured ground beyond the fog horizon, without any upright
    // grass meshes, sprites or foliage instances. Ground reach remains an
    // artist-controlled preview extent.
    const extent = TERRAIN_SIZE * settings.groundReach;
    const horizonExtent = Math.max(54, extent);
    const base = minimum * settings.exaggeration - 0.048;
    const fieldKey = field && project ? [
      field.resolution, project.worldSize, project.heightScale, settings.exaggeration,
    ].join('/') : 'empty';
    const key = [fieldKey, horizonExtent].join('|');
    // A new field object requires a fresh conforming border even if its
    // resolution and parameter values are unchanged.
    const currentField = this.lastField;
    if (key !== this.geometryKey || field !== currentField ||
        (terrain?.geometry ?? null) !== this.lastTerrainGeometry) {
      this.geometryKey = key;
      this.lastField = field;
      this.lastTerrainGeometry = terrain?.geometry ?? null;
      this.meadow?.geometry.dispose();
      const geometry = meadowGeometry(horizonExtent, !!field);
      if (!this.meadow) {
        this.meadow = new THREE.Mesh(geometry, this.meadowMaterial);
        this.meadow.name = 'Expanded grassy landscape';
        this.meadow.receiveShadow = true;
        this.scene.add(this.meadow);
      } else this.meadow.geometry = geometry;

      if (this.apron) {
        this.scene.remove(this.apron);
        this.apron.geometry.dispose();
        this.apron = null;
      }
      if (field && project) {
        this.apron = new THREE.Mesh(
          buildGroundApron(field, project, settings.exaggeration, base, horizonExtent, terrain),
          this.apronMaterial,
        );
        this.apron.name = 'Terrain to meadow transition';
        this.apron.receiveShadow = true;
        this.scene.add(this.apron);
      }
    } else if (this.apron && base !== this.lastBase && field && project) {
      this.apron.geometry.dispose();
      this.apron.geometry = buildGroundApron(field, project, settings.exaggeration, base, horizonExtent, terrain);
    }
    this.lastBase = base;
    if (this.meadow) {
      this.meadow.position.y = base;
      this.meadow.visible = true;
    }
    if (this.apron) this.apron.visible = true;
    this.texture.repeat.set(horizonExtent * 0.8, horizonExtent * 0.8);
    if (terrain) this.syncBoundary(terrain, settings.exaggeration);

  }


  /**
   * Match the terrain albedo and smoothed normals at the shared inner edge.
   * The continuation changes appearance only; terrain and PBR export buffers
   * remain byte-for-byte identical.
   */
  syncBoundary(
    terrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
    exaggeration: number,
  ) {
    if (!this.apron) return;
    const destination = this.apron.geometry;
    const edgeCount = destination.userData.edgeVertexCount as number;
    const levels = destination.userData.edgeLevels as number[];
    if (!edgeCount || !levels) return;
    const sourcePositions = terrain.geometry.getAttribute('position');
    const sourceNormals = terrain.geometry.getAttribute('normal');
    const sourceColors = terrain.geometry.getAttribute('color');
    const sourceIndices = terrain.geometry.userData.nhPerimeterIndices as number[] | undefined;
    const segments = edgeCount / 4;
    const sourceSegments = Math.round(Math.sqrt(sourcePositions.count)) - 1;
    if (sourceIndices ? sourceIndices.length !== edgeCount : sourceSegments !== segments) return;
    const edgeColors = destination.getAttribute('nhEdgeAlbedo');
    const normalColors = destination.getAttribute('normal');
    const originalNormals = destination.getAttribute('nhOriginalNormal');
    const tex = terrain.material.map as THREE.DataTexture | null;
    const image = tex?.image as { data?: Uint8Array; width?: number; height?: number } | undefined;
    const pixels = image?.data;
    const size = image?.width ?? 0;
    const sample = new THREE.Color();
    const boundaryNormal = new THREE.Vector3();
    const computedNormal = new THREE.Vector3();
    for (let i = 0; i < edgeCount; i++) {
      let sourceIndex: number;
      if (sourceIndices) sourceIndex = sourceIndices[i];
      else {
        const side = Math.floor(i / segments);
        const step = i % segments;
        const ix = side === 1 ? segments : side === 3 ? 0
          : side === 2 ? segments - step : step;
        const iy = side === 0 ? 0 : side === 2 ? segments
          : side === 3 ? segments - step : step;
        sourceIndex = iy * (segments + 1) + ix;
      }
      const textureX = Math.round((sourcePositions.getX(sourceIndex) / TERRAIN_SIZE + 0.5) * (size - 1));
      const textureY = Math.round((sourcePositions.getZ(sourceIndex) / TERRAIN_SIZE + 0.5) * (size - 1));
      const offset = (textureY * size + textureX) * 4;
      if (pixels && size > 1 && offset >= 0 && offset + 2 < pixels.length) {
        sample.setRGB(pixels[offset] / 255, pixels[offset + 1] / 255,
          pixels[offset + 2] / 255, THREE.SRGBColorSpace);
      } else if (terrain.material.vertexColors && sourceColors) {
        sample.setRGB(sourceColors.getX(sourceIndex), sourceColors.getY(sourceIndex),
          sourceColors.getZ(sourceIndex));
        if (sample.r + sample.g + sample.b < 0.015) sample.set('#859982');
      } else {
        sample.copy(terrain.material.color);
      }
      boundaryNormal.set(
        sourceNormals.getX(sourceIndex),
        sourceNormals.getY(sourceIndex) / exaggeration,
        sourceNormals.getZ(sourceIndex),
      ).normalize();
      for (let ring = 0; ring < levels.length; ring++) {
        const index = ring * edgeCount + i;
        edgeColors.setXYZ(index, sample.r, sample.g, sample.b);
        // Normals should be continuous at the border, but quickly converge to
        // the naturally smoothed apron rather than extending tile-side slopes.
        const match = 1 - THREE.MathUtils.smoothstep(levels[ring], 0, 0.14);
        if (match <= 0) continue;
        computedNormal.set(
          originalNormals.getX(index), originalNormals.getY(index), originalNormals.getZ(index),
        ).lerp(boundaryNormal, match).normalize();
        normalColors.setXYZ(index, computedNormal.x, computedNormal.y, computedNormal.z);
      }
    }
    edgeColors.needsUpdate = true;
    normalColors.needsUpdate = true;
  }

  /** Shared color map lets the tile's perimeter seamlessly fade to meadow. */
  get grassMap(): THREE.Texture {
    return this.texture;
  }

  /** Both flat ground surfaces receive the same physical sky/cloud lighting. */
  get materials(): THREE.MeshStandardMaterial[] {
    return [this.meadowMaterial, this.apronMaterial];
  }

  private lastField: HeightField | null = null;
  private lastBase = 0;

  dispose() {
    if (this.meadow) {
      this.scene.remove(this.meadow);
      this.meadow.geometry.dispose();
    }
    if (this.apron) {
      this.scene.remove(this.apron);
      this.apron.geometry.dispose();
    }
    this.meadowMaterial.dispose();
    this.apronMaterial.dispose();
    this.texture.dispose();
  }
}
