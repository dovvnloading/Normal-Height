import { expect, type Page } from '@playwright/test';

type Bounds = { x: number; y: number; width: number; height: number };

/** Capture the complete viewport, including the studio controls around WebGL. */
export async function captureViewport(page: Page): Promise<Buffer> {
  const viewport = page.locator('.nh-viewport');
  const bounds = () => viewport.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
  const change = (a: Bounds, b: Bounds) => Math.max(
    Math.abs(a.x - b.x), Math.abs(a.y - b.y),
    Math.abs(a.width - b.width), Math.abs(a.height - b.height),
  );

  // Software WebGL can starve the two animation frames used by element
  // screenshot actionability, even while the DOM bounds remain unchanged.
  // Check layout with bounded timer polls, then use a compositor page capture.
  let previous: Bounds | undefined;
  let stableSamples = 0;
  await expect.poll(async () => {
    const current = await bounds();
    stableSamples = previous && change(previous, current) <= 0.5 ? stableSamples + 1 : 0;
    previous = current;
    return stableSamples;
  }, { message: 'Viewport geometry settles before visual evidence', timeout: 5_000,
    intervals: [100, 100, 250] }).toBeGreaterThanOrEqual(2);

  const clip = previous!;
  expect(clip.width).toBeGreaterThan(0);
  expect(clip.height).toBeGreaterThan(0);
  const screenshot = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  expect(change(clip, await bounds()), 'Viewport geometry is unchanged during capture').toBeLessThanOrEqual(0.5);
  return screenshot;
}
