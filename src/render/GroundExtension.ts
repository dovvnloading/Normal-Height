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
  const levels = [0, 0.2, 0.45, 0.7, 0.9, 1];
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const heightScale = (TERRAIN_SIZE * project.heightScale / project.worldSize) * exaggeration;

  for (const t of levels) {
    const eased = t * t * (3 - 2 * t);
    for (let i = 0; i < count; i++) {
      const side = Math.floor(i / segments);
      const s = (i % segments) / segments;
      let x = 0, z = 0;
      if (side === 0) { x = -HALF + s * TERRAIN_SIZE; z = -HALF; }
      if (side === 1) { x = HALF; z = -HALF + s * TERRAIN_SIZE; }
      if (side === 2) { x = HALF - s * TERRAIN_SIZE; z = HALF; }
      if (side === 3) { x = -HALF; z = HALF - s * TERRAIN_SIZE; }
      const height = bilinear(field, x / TERRAIN_SIZE + 0.5, z / TERRAIN_SIZE + 0.5);
      // Start with the actual outward terrain slope before easing into flat
      // ground. This preserves the silhouette and normal transition at the tile.
      const step = TERRAIN_SIZE / Math.max(1, field.resolution - 1);
      const insideX = x + (side === 1 ? -step : side === 3 ? step : 0);
      const insideZ = z + (side === 0 ? step : side === 2 ? -step : 0);
      const innerHeight = bilinear(field, insideX / TERRAIN_SIZE + 0.5, insideZ / TERRAIN_SIZE + 0.5);
      const edgeSlope = THREE.MathUtils.clamp((height - innerHeight) * heightScale / step, -1.5, 1.5);
      const scale = 1 + (APRON_WIDTH / HALF) * t;
      const px = x * scale, pz = z * scale;
      const projected = height * heightScale + edgeSlope * APRON_WIDTH * t;
      vertices.push(px, THREE.MathUtils.lerp(projected, flatY, eased), pz);
      uvs.push(0.5 + px / extent, 0.5 - pz / extent);
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
  geo.setIndex(indices);
  geo.computeVertexNormals();
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

  update(field: HeightField | null, project: TerrainProject | null, settings: ViewSettings, minimum: number) {
    if (!settings.expandGround) {
      if (this.meadow) this.meadow.visible = false;
      if (this.apron) this.apron.visible = false;
      if (this.tufts) this.tufts.visible = false;
      return;
    }
    const extent = TERRAIN_SIZE * settings.groundReach;
    const base = minimum * settings.exaggeration - 0.048;
    const fieldKey = field && project ? [
      field.resolution, project.worldSize, project.heightScale, settings.exaggeration,
    ].join('/') : 'empty';
    const key = [fieldKey, extent].join('|');
    // A new field object requires a fresh conforming border even if its
    // resolution and parameter values are unchanged.
    const currentField = this.lastField;
    if (key !== this.geometryKey || field !== currentField) {
      this.geometryKey = key;
      this.lastField = field;
      this.meadow?.geometry.dispose();
      const geometry = meadowGeometry(extent, !!field);
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
          buildGroundApron(field, project, settings.exaggeration, base, extent),
          this.meadowMaterial,
        );
        this.apron.name = 'Terrain to meadow transition';
        this.apron.receiveShadow = true;
        this.scene.add(this.apron);
      }
    } else if (this.apron && base !== this.lastBase && field && project) {
      this.apron.geometry.dispose();
      this.apron.geometry = buildGroundApron(field, project, settings.exaggeration, base, extent);
    }
    this.lastBase = base;
    if (this.meadow) {
      this.meadow.position.y = base;
      this.meadow.visible = true;
    }
    if (this.apron) this.apron.visible = true;
    this.texture.repeat.set(extent * 1.7, extent * 1.7);
    const foliageKey = [extent, project?.seed ?? 1, settings.grassDensity].join('/');
    if (this.foliageKey !== foliageKey) {
      this.foliageKey = foliageKey;
      if (this.tufts) {
        this.scene.remove(this.tufts);
        this.tufts.geometry.dispose();
      }
      this.tufts = this.createTufts(extent, project?.seed ?? 1, settings.grassDensity);
      this.scene.add(this.tufts);
    }
    if (this.tufts) {
      this.tufts.position.y = base + 0.001;
      this.tufts.visible = true;
    }
  }

  private lastField: HeightField | null = null;
  private lastBase = 0;

  private createTufts(extent: number, seed: number, density: number) {
    const half = extent * 0.5;
    const edge = HALF + APRON_WIDTH + 0.08;
    const availableArea = Math.max(0, extent * extent - (2 * edge) ** 2);
    const count = Math.min(8000, Math.round(availableArea * 21 * density));
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
    this.bladeMaterial.dispose();
    this.texture.dispose();
  }
}
