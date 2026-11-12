import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  assertHardwareRenderer, attachDataUrl, buildTerrain, canvasDataUrl, heightGrid, imageDelta,
  parseList, setCamera, settleMesh,
} from './meshBench';
import type { Quality } from './meshBench';

/**
 * Issue #34 visual evidence on real hardware. Views are aimed at features
 * found in the displayed terrain itself (highest ridge, steepest cliff,
 * lowest valley floor, edge seam), so they are reproducible per preset.
 * For every view the frame drawn before the sliced LOD refinement lands is
 * compared with the settled frame: a crack, hole or topology jump shows up as
 * a large share of strongly changed pixels. An orbit sequence repeats that
 * per small camera step, the way a user drags, and is saved as frames (plus a
 * Playwright video) for review.
 */
const resolution = Number(process.env.MESH_VISUAL_RESOLUTION || 1024);
const quality = (process.env.MESH_VISUAL_QUALITY || 'ultra') as Quality;
const exaggeration = Number(process.env.MESH_VISUAL_EXAGGERATION || 1.8);
const presets = parseList('MESH_VISUAL_PRESETS', 'River-cut highlands,Alpine watershed');
const orbitSteps = Number(process.env.MESH_VISUAL_ORBIT_STEPS || 24);

test.use({ video: process.env.MESH_BENCH_VIDEO === '0' ? 'off' : 'on' });

type Vec3 = [number, number, number];
type Delta = Awaited<ReturnType<typeof imageDelta>>;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');

const thumbnail = (page: Page, data: string, width = 960) => page.evaluate(
  async ([src, w]) => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = Math.round((image.height * w) / image.width);
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.84);
  }, [data, width] as const);

async function setDisplay(page: Page, checkbox: string, on: boolean) {
  const toggle = page.getByRole('button', { name: 'Display settings', exact: true });
  await toggle.click();
  const box = page.getByRole('checkbox', { name: checkbox });
  if (on) await box.check(); else await box.uncheck();
  await toggle.click();
}

for (const preset of presets)
  test(`mesh visual audit: ${preset} ${resolution}² ${quality} ×${exaggeration}`,
    async ({ page }, testInfo) => {
      test.setTimeout(900_000);
      await page.goto('/?meshBenchmark=adaptive');
      await page.getByTitle('Choose a landscape').click();
      await page.locator('.presets-modal')
        .getByRole('button', { name: new RegExp(`^${preset}`) }).click();
      await expect(page.getByTitle('Choose a landscape')).toContainText(preset);
      // Presets with a river designer open in 2D; the audit is of the 3D mesh.
      await page.getByRole('button', { name: '3D terrain', exact: true }).click();
      const canvas: Locator = await buildTerrain(page, resolution, quality, 'pbr', exaggeration);
      const renderer = await assertHardwareRenderer(canvas);

      // Locate features on the displayed surface (scene units; tile ±1.3).
      const n = 97;
      const grid = await heightGrid(page, n);
      const coord = (i: number) => -1.3 + (2.6 * i) / (n - 1);
      const at = (i: number, j: number) => grid[j * n + i];
      const heightAt = (x: number, z: number) => {
        const i = Math.round(((x + 1.3) / 2.6) * (n - 1));
        const j = Math.round(((z + 1.3) / 2.6) * (n - 1));
        return at(Math.min(n - 1, Math.max(0, i)), Math.min(n - 1, Math.max(0, j)));
      };
      let peak = { i: 0, j: 0, h: -Infinity };
      let valley = { i: 0, j: 0, h: Infinity };
      let cliff = { i: 0, j: 0, slope: -Infinity, gx: 0, gz: 0 };
      const step = 2.6 / (n - 1);
      for (let j = 4; j < n - 4; j++) for (let i = 4; i < n - 4; i++) {
        const h = at(i, j);
        if (h > peak.h) peak = { i, j, h };
        if (i > n * 0.15 && i < n * 0.85 && j > n * 0.15 && j < n * 0.85 && h < valley.h)
          valley = { i, j, h };
        const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * step);
        const gz = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
        const slope = Math.hypot(gx, gz);
        if (slope > cliff.slope) cliff = { i, j, slope, gx, gz };
      }
      const point = (i: number, j: number): Vec3 => [coord(i), at(i, j), coord(j)];
      const above = (x: number, y: number, z: number, clearance = 0.05): Vec3 =>
        [x, Math.max(y, (Math.abs(x) <= 1.3 && Math.abs(z) <= 1.3 ? heightAt(x, z) : 0) + clearance), z];

      const dir = join(process.cwd(), 'mesh-benchmark-results', 'visual', slug(preset));
      await mkdir(dir, { recursive: true });
      const views: Array<{ name: string; position: Vec3; target: Vec3; lodSwap: Delta;
        meshBuildsDuringView: number }> = [];
      const save = async (name: string, data: string) => {
        await writeFile(join(dir, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
        const jpeg = await thumbnail(page, data);
        await writeFile(join(dir, `${name}.jpg`), Buffer.from(jpeg.split(',')[1], 'base64'));
        await attachDataUrl(testInfo, `${slug(preset)}-${name}.png`, data);
      };
      const capture = async (name: string, position: Vec3, target: Vec3, keep = true) => {
        const before = Number(await canvas.getAttribute('data-mesh-build-count'));
        await setCamera(page, position, target);
        await page.waitForTimeout(90);
        const immediate = await canvasDataUrl(canvas);
        await settleMesh(canvas, page);
        await page.waitForTimeout(120);
        const settled = await canvasDataUrl(canvas);
        const lodSwap = await imageDelta(page, immediate, settled);
        const builds = Number(await canvas.getAttribute('data-mesh-build-count')) - before;
        if (keep) await save(name, settled);
        views.push({ name, position, target, lodSwap, meshBuildsDuringView: builds });
        return lodSwap;
      };

      const [px, py, pz] = point(peak.i, peak.j);
      // Ridge silhouette against the physical sky: low camera, looking up.
      await setDisplay(page, 'Enable sky dome', true);
      const outward = Math.hypot(px, pz) > 0.2 ? [px / Math.hypot(px, pz), pz / Math.hypot(px, pz)] : [0, 1];
      await capture('ridge-silhouette-sky',
        above(px - outward[0] * 1.7, py * 0.55, pz - outward[1] * 1.7, 0.06), [px, py, pz]);
      await setDisplay(page, 'Enable sky dome', false);

      // Steepest cliff, seen from its downhill side.
      const [cx, cy, cz] = point(cliff.i, cliff.j);
      const g = Math.hypot(cliff.gx, cliff.gz) || 1;
      await capture('vertical-cliff',
        above(cx - (cliff.gx / g) * 0.38, cy + 0.04, cz - (cliff.gz / g) * 0.38, 0.05), [cx, cy, cz]);

      // Valley floor / river banks, oblique.
      const [vx, vy, vz] = point(valley.i, valley.j);
      await capture('river-banks', above(vx + 0.34, vy + 0.3, vz + 0.34, 0.08), [vx, vy, vz]);

      // Terrain edge: skirt seam, then the expanded-meadow boundary.
      let edgeI = 0;
      for (let i = 0; i < n; i++) if (at(i, n - 1) > at(edgeI, n - 1)) edgeI = i;
      const ex = coord(edgeI), ey = at(edgeI, n - 1);
      const edgeCamera: Vec3 = [ex + 0.28, ey + 0.12, 1.3 + 0.52];
      const edgeTarget: Vec3 = [ex, ey - 0.04, 1.3];
      await capture('terrain-skirt-seam', edgeCamera, edgeTarget);
      await setDisplay(page, 'Expand ground', true);
      await page.waitForTimeout(600);
      await capture('meadow-boundary', edgeCamera, edgeTarget);
      await setDisplay(page, 'Expand ground', false);

      // Orbit: small steps around the ridge, like a user drag. Each step's
      // pre/post-refinement delta is the visible LOD "pop" at that step.
      const orbit: Delta[] = [];
      const radius = 1.15, height = py + 0.38;
      for (let k = 0; k < orbitSteps; k++) {
        const angle = (k / orbitSteps) * Math.PI * 2;
        const delta = await capture(`orbit-${String(k).padStart(2, '0')}`,
          above(px + Math.cos(angle) * radius, height, pz + Math.sin(angle) * radius, 0.08),
          [px, py * 0.75, pz], true);
        orbit.push(delta);
      }

      const result = {
        schema: 1,
        deviceLabel: process.env.MESH_BENCH_DEVICE || 'unlabelled hardware',
        timestamp: new Date().toISOString(),
        renderer,
        case: { preset, resolution, quality, material: 'pbr', exaggeration },
        features: {
          peak: point(peak.i, peak.j), valley: point(valley.i, valley.j),
          cliff: { at: point(cliff.i, cliff.j), slope: cliff.slope },
        },
        orbitWorstLodSwap: {
          meanAbsDelta: Math.max(...orbit.map((d) => d.meanAbsDelta)),
          strongChangeFraction: Math.max(...orbit.map((d) => d.strongChangeFraction)),
        },
        views,
      };
      await writeFile(join(dir, 'visual.json'), JSON.stringify(result, null, 2));
      await testInfo.attach(`${slug(preset)}-visual.json`, {
        path: join(dir, 'visual.json'), contentType: 'application/json',
      });
      // Exactly one terrain mesh at the end; captures are real frames.
      const builds = Number(await canvas.getAttribute('data-mesh-build-count'));
      const disposals = Number(await canvas.getAttribute('data-mesh-dispose-count'));
      expect(builds - disposals).toBe(1);
      expect(views.length).toBe(5 + orbitSteps);
    });
