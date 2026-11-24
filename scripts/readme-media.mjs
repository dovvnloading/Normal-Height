// Regenerates the README screenshots and landscape-tour GIF in docs/images.
//
//   npm run build
//   npm run preview -- --host 127.0.0.1 --port 4173 --strictPort   # separate shell
//   node scripts/readme-media.mjs
//
// Renders in installed Google Chrome on the hardware GPU (ANGLE D3D11 / Metal /
// GL) so PBR materials, sky and shadows look as they do for users. The GIF is
// encoded with Python + Pillow (`pip install pillow`).
// For a reproducible CI/software capture, use NH_MEDIA_SOFTWARE=1. These
// captures are real UI output, but are not hardware-GPU benchmark evidence.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.NH_URL ?? 'http://127.0.0.1:4173';
const OUT = resolve('docs/images');
const FRAMES = join(tmpdir(), 'nh-readme-frames');
const WORLD_FRAMES = join(tmpdir(), 'nh-world-frames');
const TOUR = ['Alpine watershed', 'Studio ridgelands', 'Studio wind dunes', 'Studio impact field'];
const FRAMES_PER_LANDSCAPE = 28;
const ORBIT_PX_PER_FRAME = 8;
const GIF_WIDTH = 640;
const GIF_FPS = 10;

const angle = { win32: 'd3d11', darwin: 'metal' }[process.platform] ?? 'gl';
const software = process.env.NH_MEDIA_SOFTWARE === '1';
const browser = await chromium.launch({
  channel: software ? undefined : 'chrome',
  executablePath: process.env.NH_CHROMIUM_PATH || undefined,
  headless: true,
  args: software
    ? [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
      ]
    : [`--use-angle=${angle}`, '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});
page.setDefaultTimeout(120_000);
const canvas = page.locator('.nh-three-host canvas');

async function ready() {
  await page.waitForTimeout(800);
  await page
    .locator('.status-bar .status-dot.working')
    .waitFor({ state: 'detached', timeout: 180_000 });
  await page
    .locator('.status-bar')
    .getByText('Terrain ready', { exact: true })
    .waitFor({ timeout: 180_000 });
  await page.waitForTimeout(2500); // PBR maps, environment map and shadows settle
}

async function show3d() {
  await page.getByRole('button', { name: '3D terrain', exact: true }).click();
  await page.waitForTimeout(2000);
}

async function loadLandscape(name) {
  const showLibrary = page.getByRole('button', { name: 'Show node library', exact: true });
  if (await showLibrary.isVisible()) await showLibrary.click();
  await page.getByRole('button', { name: 'Landscapes', exact: true }).click();
  await page.locator('.library').getByText(name, { exact: true }).click();
  const hideLibrary = page.getByRole('button', { name: 'Hide node library', exact: true });
  if (await hideLibrary.isVisible()) await hideLibrary.click();
  await ready();
  await show3d(); // some presets open in the 2D map
}

async function drag(dx, dy, steps = 3) {
  const box = await canvas.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps });
  await page.mouse.up();
}

async function zoom(deltaY) {
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(600);
}

await page.goto(BASE);
await ready();

console.log('Capturing the running studio and diagnostic views');
// Golden-hour sky lighting on the studio tile.
await page.getByRole('button', { name: 'Display settings' }).click();
await page.getByRole('button', { name: 'Golden hour sky preset' }).click();
// Freeze wind using the actual display control for static software captures.
await page.getByLabel('Wind speed', { exact: true }).press('Home');
await page.keyboard.press('Escape');
await page.evaluate(() => document.activeElement?.blur());
await page.waitForTimeout(3000);
mkdirSync(OUT, { recursive: true });
await page.screenshot({ path: join(OUT, 'studio-3d.png') });

// The erosion simulation's water-flow diagnostic in the 2D viewer.
await page.getByRole('button', { name: '2D map', exact: true }).click();
await page.getByRole('combobox', { name: 'Map channel' }).selectOption('flow');
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT, 'studio-flow.png') });
await show3d();

// Record real persistent-cache telemetry after a warm build.
await page.getByRole('button', { name: 'Build terrain', exact: true }).click();
await ready();
await page.getByRole('button', { name: 'Compute diagnostics', exact: true }).click();
await page.screenshot({ path: join(OUT, 'compute-cache.png') });
await page.getByRole('button', { name: 'Close Compute diagnostics', exact: true }).click();

console.log('Capturing the actual World Studio workflow');
// World coordinates, region selection, native detail and stage disclosure.
rmSync(WORLD_FRAMES, { recursive: true, force: true });
mkdirSync(WORLD_FRAMES, { recursive: true });
let worldFrame = 0;
const worldShot = async () => {
  await page.screenshot({
    path: join(WORLD_FRAMES, `f${String(worldFrame++).padStart(4, '0')}.png`),
  });
};
await page.getByRole('button', { name: 'World Studio', exact: true }).click();
const world = page.getByRole('dialog', { name: 'World Studio', exact: true });
await world.getByText('World overview ready', { exact: true }).waitFor({ timeout: 180_000 });
await worldShot();
await world.getByLabel('East intervals', { exact: true }).fill('2048');
await world.getByLabel('South intervals', { exact: true }).fill('2048');
await world.getByRole('button', { name: 'Build world', exact: true }).click();
await world.getByText('World overview ready', { exact: true }).waitFor({ timeout: 180_000 });
await worldShot();
const worldMap = world.getByRole('button', { name: /^World region map/ });
await worldMap.focus();
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowDown');
await worldShot();
await page.screenshot({ path: join(OUT, 'world-studio.png') });
await world.getByRole('button', { name: 'Refine region', exact: true }).click();
await world.getByText('Region ready', { exact: true }).waitFor({ timeout: 180_000 });
await worldShot();
await world.getByLabel('World map channel').selectOption('height');
await worldShot();
await world.getByLabel('World map channel').selectOption('flow');
await worldShot();
await world.getByLabel('World map channel').selectOption('relief');
await world.getByRole('tab', { name: 'Compute', exact: true }).click();
await world.locator('summary').click();
await worldShot();
await page.screenshot({ path: join(OUT, 'world-stage-report.png') });
await world.getByRole('button', { name: 'Overview', exact: true }).click();
await world.getByText('World overview ready', { exact: true }).waitFor({ timeout: 180_000 });
await world.locator('summary').click();
await world.getByRole('tab', { name: 'Export', exact: true }).click();
await worldShot();
await page.screenshot({ path: join(OUT, 'world-export.png') });
await world.getByRole('button', { name: 'Close World Studio', exact: true }).click();

// Landscape tour: orbit each preset in viewport focus mode, without the
// viewport chrome, captioned with the landscape name. The GIF output is 640px;
// a smaller real browser viewport avoids rendering excess software GPU pixels.
await page.setViewportSize({ width: 960, height: 640 });
await page.waitForTimeout(800);
await page.addStyleTag({
  content: `.nh-three-pane > :not(.nh-three-host):not(#nh-tour-label), .nh-preview-source { visibility: hidden !important; }
    #nh-tour-label { position: absolute; left: 24px; bottom: 22px; z-index: 50; padding: 7px 13px;
      border-radius: 6px; background: rgba(20, 24, 22, .62); color: #f3f1ea; font: 600 15px/1.2 'Inter Variable', sans-serif;
      letter-spacing: .01em; backdrop-filter: blur(6px); }`,
});
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
let frame = 0;
for (const name of TOUR) {
  console.log(`Capturing ${FRAMES_PER_LANDSCAPE} real orbit frames: ${name}`);
  if (frame > 0) await loadLandscape(name);
  await page.getByRole('button', { name: 'Focus viewport' }).click();
  await page.waitForTimeout(1500);
  await page.evaluate((text) => {
    const pane = document.querySelector('.nh-three-pane');
    let label = document.getElementById('nh-tour-label');
    if (!label) {
      label = document.createElement('div');
      label.id = 'nh-tour-label';
    }
    pane.appendChild(label);
    label.textContent = text;
  }, name);
  await page.locator('[aria-label="Reset 3D camera"]').dispatchEvent('click'); // hidden by the tour CSS
  await page.waitForTimeout(800);
  await zoom(-260);
  await page.waitForTimeout(1500);
  for (let i = 0; i < FRAMES_PER_LANDSCAPE; i++) {
    await drag(-ORBIT_PX_PER_FRAME, 0);
    await page.waitForTimeout(150);
    await page
      .locator('.nh-three-pane')
      .screenshot({ path: join(FRAMES, `f${String(frame++).padStart(4, '0')}.png`) });
  }
  await page.getByRole('button', { name: 'Exit viewport focus mode' }).click();
  await page.waitForTimeout(500);
}
writeFileSync(
  join(OUT, 'capture-provenance.json'),
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      browser: browser.version(),
      rendering: software
        ? 'Chromium / ANGLE SwiftShader software rendering; not hardware performance evidence'
        : `Chrome / ANGLE ${angle}`,
      viewport: { width: 1600, height: 1000 },
      application: 'Actual production build',
      landscapes: TOUR,
      landscapeViewport: { width: 960, height: 640 },
      landscapeFrameCount: frame,
      worldFrameCount: worldFrame,
      staticLighting: 'Golden hour preset; wind speed set to zero through the display controls',
      world:
        'Alpine graph, 2048 interval domain, 256 sample global reference; reconstructed global stages disclosed in UI',
      script: 'scripts/readme-media.mjs',
    },
    null,
    2,
  ) + '\n',
);
await browser.close();

// Shared adaptive palette for all frames keeps the GIF small and flicker-free.
const encoder = `
import glob, sys
from PIL import Image
frames_dir, out, width, fps = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
paths = sorted(glob.glob(frames_dir + '/f*.png'))
def load(p):
    im = Image.open(p).convert('RGB')
    return im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
frames = [load(p) for p in paths]
sample = Image.new('RGB', (width, frames[0].height * 10))
for k, i in enumerate(range(0, len(frames), max(1, len(frames) // 10))[:10]):
    sample.paste(frames[i], (0, k * frames[0].height))
palette = sample.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
quantized = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
quantized[0].save(out, save_all=True, append_images=quantized[1:], duration=round(1000 / fps), loop=0, optimize=True, disposal=1)
`;
const python = process.platform === 'win32' ? 'python' : 'python3';
execFileSync(
  python,
  ['-c', encoder, FRAMES, join(OUT, 'landscape-tour.gif'), String(GIF_WIDTH), String(GIF_FPS)],
  {
    stdio: 'inherit',
  },
);
execFileSync(python, ['-c', encoder, WORLD_FRAMES, join(OUT, 'world-workflow.gif'), '960', '1'], {
  stdio: 'inherit',
});
console.log(`Wrote updated studio, world, diagnostics and tour media to ${OUT}`);
