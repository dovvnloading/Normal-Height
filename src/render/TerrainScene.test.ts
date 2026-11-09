import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TerrainScene } from './TerrainScene';

// Exercise the renderer's real support and camera transforms without creating
// a WebGL context. The scene graph and projection math are genuine Three.js.
interface SceneMathHarness {
  terrain: THREE.Mesh;
  skirt: THREE.Mesh;
  floor: THREE.Object3D;
  grid: THREE.Object3D;
  plinth: THREE.Object3D;
  sun: THREE.DirectionalLight;
  camera: THREE.PerspectiveCamera;
  controls: { target: THREE.Vector3; maxDistance: number; update: () => void };
  host: { clientWidth: number; clientHeight: number };
  settings: { exaggeration: number; sunElevation: number };
  minimumElevation: number;
  cameraView: 'perspective';
  updateSupport: () => void;
  fitCamera: () => void;
}

function harness(heights: number[], exaggeration: number, width: number): SceneMathHarness {
  const scene = Object.create(TerrainScene.prototype) as SceneMathHarness;
  const geometry = new THREE.PlaneGeometry(2.6, 2.6, 2, 2);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute('position');
  heights.forEach((value, i) => positions.setY(i, value));
  scene.terrain = new THREE.Mesh(geometry);
  const skirtGeometry = new THREE.BufferGeometry();
  skirtGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -1.3,
        heights[0],
        -1.3,
        -1.3,
        0,
        -1.3,
        0,
        heights[1],
        -1.3,
        0,
        heights[1],
        -1.3,
        -1.3,
        0,
        -1.3,
        0,
        0,
        -1.3,
      ],
      3,
    ),
  );
  scene.skirt = new THREE.Mesh(skirtGeometry);
  scene.floor = new THREE.Object3D();
  scene.grid = new THREE.Object3D();
  scene.plinth = new THREE.Object3D();
  scene.sun = new THREE.DirectionalLight();
  scene.camera = new THREE.PerspectiveCamera(36, width / 500, 0.025, 40);
  scene.controls = {
    target: new THREE.Vector3(),
    maxDistance: 12,
    update: () => {
      scene.camera.lookAt(scene.controls.target);
      scene.camera.updateMatrixWorld();
    },
  };
  scene.host = { clientWidth: width, clientHeight: 500 };
  scene.settings = { exaggeration, sunElevation: 38 };
  scene.minimumElevation = Math.min(0, ...heights);
  scene.cameraView = 'perspective';
  return scene;
}

describe('negative-elevation scene support and framing', () => {
  it('keeps all-negative and mixed terrain above the support and inside the camera at every display scale', () => {
    for (const heights of [
      [-0.8, -0.4, -0.3, -0.5, -0.1, -0.7, -0.6, -0.2, -0.4],
      [-0.8, -0.4, 0.3, -0.5, 0.6, -0.7, -0.6, 0.2, -0.4],
    ])
      for (const exaggeration of [0.5, 1, 3])
        for (const width of [360, 950]) {
          const scene = harness(heights, exaggeration, width);
          const positions = scene.terrain.geometry.getAttribute('position');
          const original = Array.from(positions.array);
          scene.updateSupport();
          scene.fitCamera();
          const minimum = Math.min(...heights) * exaggeration;
          expect(scene.floor.position.y).toBeLessThan(minimum);
          expect(scene.grid.position.y).toBeLessThan(minimum);
          expect(scene.plinth.position.y + 0.0175).toBeLessThan(minimum);
          for (const index of [1, 4, 5])
            expect(
              scene.skirt.geometry.getAttribute('position').getY(index) * exaggeration,
            ).toBeLessThan(minimum);
          for (let i = 0; i < positions.count; i++) {
            const point = new THREE.Vector3(
              positions.getX(i),
              positions.getY(i) * exaggeration,
              positions.getZ(i),
            ).project(scene.camera);
            expect(Math.abs(point.x)).toBeLessThan(1);
            expect(Math.abs(point.y)).toBeLessThan(1);
            expect(point.z).toBeGreaterThan(-1);
            expect(point.z).toBeLessThan(1);
          }
          expect(Array.from(positions.array)).toEqual(original);
        }
  });

  it('preserves the positive terrain support positions at the default physical scale', () => {
    const scene = harness([0.05, 0.1, 0.2, 0.4, 0.8, 0.3, 0.1, 0.5, 0.05], 1, 950);
    scene.updateSupport();
    expect(scene.floor.position.y).toBe(-0.048);
    expect(scene.grid.position.y).toBe(-0.045);
    expect(scene.plinth.position.y).toBe(-0.019);
    expect(scene.sun.target.position.y).toBe(0.15);
  });
});
