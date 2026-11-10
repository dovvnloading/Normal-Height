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
): THREE.BufferGeometry {
  // Match the 3D tile's tessellation exactly, eliminating border cracks on
  // high-frequency heightfields and at reduced working mesh resolutions.
  const segments = Math.max(1, Math.min(511, field.resolution - 1));
  const count = segments * 4;
  // Extra near-edge rings stop high-frequency erosion from stretching into
  // visible radial grooves. Each ring is shared by its neighboring triangles.
  const levels = [0, 0.035, 0.075, 0.14, 0.24, 0.38, 0.55, 0.75, 1];
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const blends: number[] = [];
  const boundaryColors: number[] = [];
  const heightScale = (TERRAIN_SIZE * project.heightScale / project.worldSize) * exaggeration;

  for (const t of levels) {
    for (let i = 0; i < count; i++) {
      const side = Math.floor(i / segments);
      const s = (i % segments) / segments;
      let x = 0, z = 0;
      if (side === 0) { x = -HALF + s * TERRAIN_SIZE; z = -HALF; }
      if (side === 1) { x = HALF; z = -HALF + s * TERRAIN_SIZE; }
      if (side === 2) { x = HALF - s * TERRAIN_SIZE; z = HALF; }
      if (side === 3) { x = -HALF; z = HALF - s * TERRAIN_SIZE; }
      const height = bilinear(field, x / TERRAIN_SIZE + 0.5, z / TERRAIN_SIZE + 0.5);
      // Preserve the exact incoming boundary, then rapidly attenuate the fine
      // shoreline detail while the broad forms relax toward a level meadow.
      // Sampling along the edge (not radially outward) avoids fan-shaped lines.
      let broadHeight = height * 2.5;
      let weight = 2.5;
      const radius = TERRAIN_SIZE * 0.06;
      for (const [offset, influence] of [
        [-1, 1], [1, 1], [-0.6, 1.3], [0.6, 1.3], [-0.25, 1.6], [0.25, 1.6],
      ]) {
        const step = offset * radius;
        const sx = THREE.MathUtils.clamp(x + (side % 2 === 0 ? step : 0), -HALF, HALF);
        const sz = THREE.MathUtils.clamp(z + (side % 2 === 1 ? step : 0), -HALF, HALF);
        broadHeight += bilinear(field, sx / TERRAIN_SIZE + 0.5, sz / TERRAIN_SIZE + 0.5)
          * influence;
        weight += influence;
      }
      broadHeight /= weight;
      const highFrequency = Math.exp(-30 * t);
      const shorelineHeight = broadHeight + (height - broadHeight) * highFrequency;
      const flatten = THREE.MathUtils.smoothstep(t, 0.02, 0.94);
      const shapeY = THREE.MathUtils.lerp(shorelineHeight * heightScale, flatY, flatten);
      const scale = 1 + (APRON_WIDTH / HALF) * t;
      const px = x * scale, pz = z * scale;
      vertices.push(px, shapeY, pz);
      uvs.push(0.5 + px / extent, 0.5 - pz / extent);
      // The tile now fades its own exterior into the exact same grass map.
      // Use grass right up to the edge, so the boundary is color-continuous.
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
  ctx.fillStyle = '#667e46';
  ctx.fillRect(0, 0, 256, 256);
  // Fine, tileable-looking field strokes: no network requests or stock textures.
  let seed = 0x9168c25;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const palette = ['#819653', '#526f3c', '#89945a', '#4b693b', '#a2a475', '#738a43'];
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

function bladeGeometry(): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [];
  const low = new THREE.Color('#496e2e'), high = new THREE.Color('#b3b875');
  for (let blade = 0; blade < 4; blade++) {
    const angle = (blade * Math.PI) / 4;
    const c = Math.cos(angle), s = Math.sin(angle);
    const height = 0.058 + (blade % 3) * 0.012;
    const width = 0.013 + (blade % 2) * 0.004;
    const points = [
      [-width, 0, 0],
      [width, 0, 0],
      [-width * 0.42, height * 0.62, 0.009],
      [width * 0.42, height * 0.62, 0.009],
      [0.006, height, 0.019],
    ];
    for (const i of [0, 1, 2, 1, 3, 2, 2, 3, 4]) {
      const [x, y, z] = points[i];
      positions.push(x * c - z * s, y, x * s + z * c);
      const tint = low.clone().lerp(high, y / height);
      colors.push(tint.r, tint.g, tint.b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export class GroundExtension {
  private readonly texture = grassTexture();
  private readonly meadowMaterial = new THREE.MeshStandardMaterial({
    map: this.texture, color: '#f4f3e5', roughness: 0.96, metalness: 0, side: THREE.DoubleSide,
  });
  private readonly apronMaterial = new THREE.MeshStandardMaterial({
    map: this.texture, color: '#ffffff', roughness: 0.94, metalness: 0, side: THREE.DoubleSide,
  });
  private readonly bladeTime = { value: 0 };
  private readonly bladeMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff', vertexColors: true, roughness: 1, side: THREE.DoubleSide,
  });
  private meadow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private apron: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private tufts: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private geometryKey = '';
  private foliageKey = '';

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
    this.bladeMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.nhWindTime = this.bladeTime;
      shader.vertexShader = 'uniform float nhWindTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float sway = sin(nhWindTime * 1.9 + instanceMatrix[3].x * 2.1 + instanceMatrix[3].z * 1.6);
          transformed.x += position.y * position.y * sway * 2.6;
          transformed.z += position.y * position.y * cos(nhWindTime + instanceMatrix[3].z) * 1.2;
        #endif`,
      );
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
      if (this.tufts) this.tufts.visible = false;
      return;
    }
    // Always carry the low-detail meadow beyond the fog horizon, so the
    // landscape never ends in a visible square. Ground reach controls the
    // high-detail, instanced-grass area closest to the generated tile.
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
    if (key !== this.geometryKey || field !== currentField) {
      this.geometryKey = key;
      this.lastField = field;
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
          buildGroundApron(field, project, settings.exaggeration, base, horizonExtent),
          this.apronMaterial,
        );
        this.apron.name = 'Terrain to meadow transition';
        this.apron.receiveShadow = true;
        this.scene.add(this.apron);
      }
    } else if (this.apron && base !== this.lastBase && field && project) {
      this.apron.geometry.dispose();
      this.apron.geometry = buildGroundApron(field, project, settings.exaggeration, base, horizonExtent);
    }
    this.lastBase = base;
    if (this.meadow) {
      this.meadow.position.y = base;
      this.meadow.visible = true;
    }
    if (this.apron) this.apron.visible = true;
    this.texture.repeat.set(horizonExtent * 0.8, horizonExtent * 0.8);
    if (terrain) this.syncBoundary(terrain, settings.exaggeration);
    const foliageKey = [extent, project?.seed ?? 1].join('/');
    if (this.foliageKey !== foliageKey) {
      this.foliageKey = foliageKey;
      if (this.tufts) {
        this.scene.remove(this.tufts);
        this.tufts.geometry.dispose();
      }
      this.tufts = this.createTufts(extent, project?.seed ?? 1);
      this.scene.add(this.tufts);
    }
    if (this.tufts) {
      const edge = HALF + APRON_WIDTH + 0.08;
      const area = Math.max(0, extent * extent - (2 * edge) ** 2);
      // Density changes only update the active instance count; no expensive
      // blade geometry or GPU buffers are recreated while dragging the slider.
      this.tufts.count = Math.min(this.tufts.instanceMatrix.count,
        Math.round(area * 21 * settings.grassDensity));
      this.tufts.position.y = base + 0.001;
      this.tufts.visible = true;
    }
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
    const segments = edgeCount / 4;
    const sourcePositions = terrain.geometry.getAttribute('position');
    const sourceNormals = terrain.geometry.getAttribute('normal');
    const sourceColors = terrain.geometry.getAttribute('color');
    const sourceSegments = Math.round(Math.sqrt(sourcePositions.count)) - 1;
    if (sourceSegments !== segments) return;
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
      const side = Math.floor(i / segments);
      const step = i % segments;
      const ix = side === 1 ? segments : side === 3 ? 0
        : side === 2 ? segments - step : step;
      const iy = side === 0 ? 0 : side === 2 ? segments
        : side === 3 ? segments - step : step;
      const sourceIndex = iy * (segments + 1) + ix;
      const textureX = Math.round((ix / segments) * (size - 1));
      const textureY = Math.round((iy / segments) * (size - 1));
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

  /** The physically lit meadow and foliage share the sky's cloud shadows. */
  get materials(): THREE.MeshStandardMaterial[] {
    return [this.meadowMaterial, this.apronMaterial, this.bladeMaterial];
  }

  private lastField: HeightField | null = null;
  private lastBase = 0;

  private createTufts(extent: number, seed: number) {
    const half = extent * 0.5;
    const edge = HALF + APRON_WIDTH + 0.08;
    const availableArea = Math.max(0, extent * extent - (2 * edge) ** 2);
    const count = Math.min(8000, Math.round(availableArea * 21 * 1.5));
    const mesh = new THREE.InstancedMesh(bladeGeometry(), this.bladeMaterial, count);
    mesh.name = 'Instanced meadow grass';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    const random = seededRandom(seed ^ 0x759ef20a);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      let x = 0, z = 0;
      for (let attempt = 0; attempt < 80; attempt++) {
        x = (random() * 2 - 1) * (half - 0.12);
        z = (random() * 2 - 1) * (half - 0.12);
        if (Math.max(Math.abs(x), Math.abs(z)) > edge) break;
      }
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, random() * Math.PI, 0);
      const scale = 0.65 + random() * 0.95;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.setHSL(0.22 + random() * 0.07, 0.28 + random() * 0.17, 0.68 + random() * 0.22);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  }

  tick(seconds: number, windSpeed: number) {
    this.bladeTime.value = seconds * windSpeed;
  }

  dispose() {
    if (this.meadow) {
      this.scene.remove(this.meadow);
      this.meadow.geometry.dispose();
    }
    if (this.apron) {
      this.scene.remove(this.apron);
      this.apron.geometry.dispose();
    }
    if (this.tufts) {
      this.scene.remove(this.tufts);
      this.tufts.geometry.dispose();
    }
    this.meadowMaterial.dispose();
    this.apronMaterial.dispose();
    this.bladeMaterial.dispose();
    this.texture.dispose();
  }
}
