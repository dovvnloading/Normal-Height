import { test, expect } from '@playwright/test';

test.describe('terrain viewport UX', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.nh-viewport-toolbar')).toBeVisible();
    await expect(page.locator('.nh-render-progress')).toHaveCount(0, { timeout: 90_000 });
    await expect(page.locator('.nh-scene-resolution')).toContainText('tris', { timeout: 90_000 });
  });

  test('top-down survey uses an actual orthographic camera for rendering and picking', async ({ page }) => {
    const terrain = page.getByRole('img', { name: /^Interactive 3D terrain/ });
    await expect(terrain).toHaveAttribute('data-projection', 'perspective');
    await page.getByRole('button', { name: 'View terrain from above' }).click();
    await expect(terrain).toHaveAttribute('data-projection', 'orthographic');
    await page.getByRole('button', { name: 'Reset 3D camera' }).click();
    await expect(terrain).toHaveAttribute('data-projection', 'perspective');
    await page.getByRole('button', { name: 'View terrain from above' }).click();
    await page.getByRole('button', { name: 'Face north' }).click();
    await expect(terrain).toHaveAttribute('data-projection', 'perspective');
  });

  test('focus mode hides the editor docks without remounting WebGL', async ({ page }) => {
    const terrain = page.getByRole('img', { name: /^Interactive 3D terrain/ });
    await terrain.evaluate(el => el.setAttribute('data-same-canvas', 'yes'));
    await page.getByRole('button', { name: 'Focus viewport', exact: true }).click();
    await expect(page.locator('.graph-area')).toBeHidden();
    await expect(page.locator('.library')).toBeHidden();
    await expect(terrain).toBeVisible();
    await expect(terrain).toHaveAttribute('data-same-canvas', 'yes');
    await page.getByRole('button', { name: 'Exit viewport focus mode' }).click();
    await expect(page.locator('.graph-area')).toBeVisible();
  });

  test('linked split map indicates the 3D camera focal point and bearing', async ({ page }) => {
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    const focus = page.locator('.nh-map-camera-focus');
    await expect(focus).toBeVisible();
    const marker = focus.locator('g[transform]');
    const before = await marker.getAttribute('transform');
    await page.getByRole('button', { name: 'Camera bookmarks' }).click();
    await page.getByRole('button', { name: 'Face W' }).click();
    await expect.poll(async () => marker.getAttribute('transform')).not.toBe(before);
  });

  test('map zoom survives 3D/2D toggling; keyboard can resize the split', async ({ page }) => {
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    const map = page.locator('.nh-map > canvas');
    await map.hover();
    await page.mouse.wheel(0, -300);
    const zoomText = await page.locator('.nh-map-controls > span').innerText();
    expect(zoomText).not.toBe('100%');
    await page.getByRole('button', { name: '3D terrain', exact: true }).click();
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await expect(page.locator('.nh-map-controls > span')).toHaveText(zoomText);

    await page.getByRole('button', { name: 'Split', exact: true }).click();
    const separator = page.getByRole('separator', { name: 'Resize 3D and map views' });
    await separator.focus();
    await page.keyboard.press('ArrowRight');
    await expect(separator).toHaveAttribute('aria-valuenow', '55');
    await page.keyboard.press('Home');
    await expect(separator).toHaveAttribute('aria-valuenow', '50');
  });

  test('right-click pans the map without creating a terrain inspection pin', async ({ page }) => {
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect terrain' }).click();
    const map = page.locator('.nh-map > canvas');
    const bounds = (await map.boundingBox())!;
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.click(x, y, { button: 'right' });
    await expect(page.locator('.nh-inspect-pin')).toHaveCount(0);
    await page.mouse.click(x, y, { button: 'left' });
    await expect(page.locator('.nh-inspect-pin')).toHaveCount(1);
  });

  test('two-finger map pinch zooms without accidentally pinning a sample', async ({ page }) => {
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect terrain' }).click();
    const rect = (await page.locator('.nh-map > canvas').boundingBox())!;
    const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const touchPoints = (span: number) =>
      [{ x: cx - span, y: cy, id: 1 }, { x: cx + span, y: cy, id: 2 }];
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: touchPoints(35),
    });
    for (const span of [50, 70, 90]) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: touchPoints(span),
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => page.locator('.nh-map-controls > span')
      .innerText()).not.toBe('100%');
    await expect(page.locator('.nh-inspect-pin')).toHaveCount(0);
    await client.detach();
  });

  test('pins physically sampled points, measures a transect and shows an elevation profile', async ({ page }) => {
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await page.getByRole('button', { name: 'Profile terrain' }).click();
    const canvas = page.locator('.nh-map > canvas');
    const rect = (await canvas.boundingBox())!;
    const mapSize = Math.min(rect.width - 84, rect.height - 82);
    const left = rect.x + (rect.width - mapSize) / 2;
    const top = rect.y + (rect.height - mapSize) / 2;
    await page.mouse.click(left + mapSize * 0.30, top + mapSize * 0.32);
    await page.mouse.click(left + mapSize * 0.70, top + mapSize * 0.68);
    await expect(page.locator('.nh-profile-chart')).toBeVisible();
    await expect(page.locator('.nh-measure-results')).toContainText('Distance');
    await expect(page.locator('.nh-inspect-pin > circle')).toHaveCount(2);
    await page.getByRole('button', { name: 'Focus 3D camera at pinned sample' }).click();
    await expect(page.locator('.nh-mode-split')).toBeVisible();
    await expect(page.locator('.nh-map-camera-focus')).toBeVisible();
    await page.getByRole('button', { name: 'Clear sample points' }).click();
    await expect(page.locator('.nh-profile-chart')).toHaveCount(0);
  });

  test('pinning a baseline enables physical before/after comparison', async ({ page }) => {
    await page.getByRole('button', { name: 'Pin comparison baseline' }).click();
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(page.locator('.nh-compare-panel')).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Before after wipe position' })).toBeVisible();
    await page.getByRole('button', { name: 'Elevation change' }).click();
    await expect(page.locator('.nh-difference-legend')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.nh-difference-legend')).toContainText('Δ elevation in meters');
    await page.getByRole('button', { name: 'Clear comparison baseline' }).click();
    await expect(page.locator('.nh-compare-panel')).toHaveCount(0);
  });

  test('offers map overlays, grouped channels and bookmarked camera views', async ({ page }) => {
    await page.getByRole('button', { name: 'Camera bookmarks' }).click();
    await page.getByRole('button', { name: 'Save current view' }).click();
    await expect(page.locator('.nh-bookmark-item')).toHaveCount(1);
    await page.getByRole('button', { name: 'Face E' }).click();
    await page.locator('.nh-bookmark-item').getByRole('button', { name: 'View 1', exact: true }).click();
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await page.getByRole('button', { name: 'Map overlays' }).click();
    await page.getByRole('combobox', { name: 'Overlay channel' }).selectOption('flow');
    await expect(page.getByRole('slider', { name: 'Overlay opacity' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Map channel' }).locator('optgroup')).toHaveCount(4);
  });

  test('toolbar groups do not collide at common dock widths', async ({ page }) => {
    for (const width of [1920, 1440, 1024, 820, 600, 420]) {
      await page.setViewportSize({ width, height: 850 });
      await page.getByRole('button', { name: '2D map', exact: true }).click();
      const geometry = await page.locator('.nh-viewport-toolbar').evaluate(toolbar => {
        const selectors = ['.nh-view-tabs', '.nh-viewport-toolset', '.nh-viewport-toolbar-right'];
        const rects = selectors.map(selector => toolbar.querySelector(selector)!.getBoundingClientRect());
        const conflicts: string[] = [];
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          if (a.top < b.bottom - 1 && b.top < a.bottom - 1 &&
              a.left < b.right - 1 && b.left < a.right - 1)
            conflicts.push(selectors[i] + ' overlaps ' + selectors[j]);
        }
        return { conflicts, scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth };
      });
      expect(geometry.conflicts, `viewport at ${width}px`).toEqual([]);
      expect(geometry.scrollWidth, `overflow at ${width}px`).toBeLessThanOrEqual(geometry.clientWidth + 2);
    }
  });


  test('Display panel is keyboard reachable and Escape restores focus without clearing selection', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Display settings' });
    const originalNode = page.getByRole('textbox', { name: 'Node name' });
    const label = await originalNode.inputValue();
    await trigger.click();
    const panel = page.getByRole('region', { name: 'Display settings' });
    await expect(panel).toBeVisible();
    await expect(panel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close display settings' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(originalNode).toHaveValue(label);
  });

  test('a pending physical tile edit cannot relabel the last completed terrain', async ({ page }) => {
    const viewport = page.locator('.nh-viewport');
    const originalWidth = Number(await viewport.getAttribute('data-displayed-world-size'));
    const originalScale = Number(await viewport.getAttribute('data-displayed-height-scale'));
    expect(originalWidth).toBeGreaterThan(0);
    expect(originalScale).toBeGreaterThan(0);
    await page.getByRole('checkbox', { name: 'Auto build' }).uncheck({ force: true });
    await page.getByRole('button', { name: 'Scene', exact: true }).click();
    const tileWidth = page.getByRole('spinbutton', { name: 'Terrain tile width' });
    const elevation = page.getByRole('spinbutton', { name: 'Terrain elevation scale' });
    const nextWidth = Math.min(originalWidth * 2, 100000);
    const nextScale = Math.min(originalScale * 1.5, 20000);
    await tileWidth.fill(String(nextWidth));
    await tileWidth.press('Enter');
    await elevation.fill(String(nextScale));
    await elevation.press('Enter');
    await expect(tileWidth).toHaveValue(String(nextWidth));
    await expect(elevation).toHaveValue(String(nextScale));
    // Editor input reflects new settings; terrain/data readouts still use
    // the last completed field's original physical metadata.
    await expect(viewport).toHaveAttribute('data-displayed-world-size', String(originalWidth));
    await expect(viewport).toHaveAttribute('data-displayed-height-scale', String(originalScale));
    await expect(page.locator('.nh-preview-source')).toContainText('Last built:');
    await page.getByRole('button', { name: 'Build terrain', exact: true }).click();
    await expect(viewport).toHaveAttribute('data-displayed-world-size', String(nextWidth),
      { timeout: 90_000 });
    await expect(viewport).toHaveAttribute('data-displayed-height-scale', String(nextScale));
    await expect(page.locator('.nh-preview-source')).not.toContainText('Last built:');
  });

  test('pan and zoom repaint the map without reallocating its backing canvas', async ({ page }) => {
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    const canvas = page.locator('.nh-map > canvas');
    await canvas.evaluate((node) => {
      const el = node as HTMLCanvasElement & { __resets?: () => number };
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
      if (!descriptor?.get || !descriptor.set) throw new Error('No canvas width setter');
      let resets = 0;
      Object.defineProperty(el, 'width', {
        configurable: true,
        get: () => descriptor.get!.call(el),
        set: (width: number) => { resets++; descriptor.set!.call(el, width); },
      });
      el.__resets = () => resets;
    });
    await page.getByRole('button', { name: 'Zoom map in' }).click();
    await expect(page.locator('.nh-map-controls > span')).not.toHaveText('100%');
    await canvas.hover();
    const rect = (await canvas.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 50,
      rect.y + rect.height / 2 + 35, { steps: 10 });
    await page.mouse.up();
    expect(await canvas.evaluate(node =>
      (node as HTMLCanvasElement & { __resets: () => number }).__resets())).toBe(0);
  });

  test('spline editing disables competing terrain inspection tools', async ({ page }) => {
    const library = page.getByRole('complementary', { name: 'Node library', exact: true });
    await library.getByRole('button', { name: /River \/ ridge spline/ }).click();
    await expect(page.getByRole('button', { name: 'Finish editing' })).toBeVisible();
    for (const name of ['Inspect terrain', 'Measure terrain', 'Profile terrain']) {
      await expect(page.getByRole('button', { name })).toBeDisabled();
    }
    await page.getByRole('button', { name: 'Finish editing' }).click();
    await expect(page.getByRole('button', { name: 'Inspect terrain' })).toBeEnabled();
  });

  test('keyboard inspection continues from the point last pinned with a mouse', async ({ page }) => {
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect terrain' }).click();
    const canvas = page.locator('.nh-map > canvas');
    const rect = (await canvas.boundingBox())!;
    const size = Math.min(rect.width - 84, rect.height - 82);
    const x = rect.x + (rect.width - size) / 2 + size * 0.31;
    const y = rect.y + (rect.height - size) / 2 + size * 0.60;
    await page.mouse.click(x, y);
    const first = page.locator('.nh-inspect-pin');
    await expect(first).toHaveCount(1);
    const initial = await first.getAttribute('transform');
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(first).not.toHaveAttribute('transform', initial!);
    const moved = await first.getAttribute('transform');
    expect(moved).toContain('translate(');
    const xAfter = Number(moved?.split('translate(')[1]?.split(' ')[0] ?? '0');
    expect(xAfter).toBeGreaterThan(310);
  });


  test('split stacks when visible work area is narrow despite a wider browser', async ({ page }) => {
    await page.setViewportSize({ width: 1090, height: 880 });
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    const available = await page.locator('.nh-viewport').evaluate(element =>
      element.getBoundingClientRect().width);
    expect(available).toBeLessThanOrEqual(660);
    await expect(page.locator('.nh-mode-split')).toHaveCSS('flex-direction', 'column');
    await expect(page.getByRole('separator', { name: 'Resize 3D and map views' }))
      .toHaveAttribute('aria-orientation', 'horizontal');
  });

  test('Compare hides irrelevant 3D Display settings and does not reopen old popovers', async ({ page }) => {
    await page.getByRole('button', { name: 'Display settings' }).click();
    await expect(page.getByRole('region', { name: 'Display settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Pin comparison baseline' }).click();
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Display settings' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Display settings' })).toHaveCount(0);
    await page.getByRole('button', { name: '3D terrain', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Display settings' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Display settings' })).toHaveCount(0);
  });

  test('before/after comparison reports a real delta after a different height-scale build', async ({ page }) => {
    const viewport = page.locator('.nh-viewport');
    const oldScale = Number(await viewport.getAttribute('data-displayed-height-scale'));
    expect(oldScale).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Pin comparison baseline' }).click();
    await page.getByRole('checkbox', { name: 'Auto build' }).uncheck({ force: true });
    await page.getByRole('button', { name: 'Scene', exact: true }).click();
    const input = page.getByRole('spinbutton', { name: 'Terrain elevation scale' });
    const nextScale = oldScale > 19000 ? oldScale - 300 : oldScale + 300;
    await input.fill(String(nextScale));
    await input.press('Enter');
    await page.getByRole('button', { name: 'Build terrain', exact: true }).click();
    await expect(viewport).toHaveAttribute('data-displayed-height-scale',
      String(nextScale), { timeout: 90_000 });
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.getByRole('button', { name: 'Elevation change' }).click();
    const legend = page.locator('.nh-difference-legend');
    await expect(legend).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () =>
      Number(await legend.getAttribute('data-peak-delta'))).toBeGreaterThan(0);
    await expect(legend.locator('.nh-difference-statistics')).toContainText('m³');
  });

  test('comparison explains sampled cut/fill estimates and cursor elevation delta', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: 'Pin comparison baseline' }).click();
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.getByRole('button', { name: 'Elevation change' }).click();
    const statistics = page.locator('.nh-difference-statistics');
    await expect(statistics).toBeVisible({ timeout: 30_000 });
    await expect(statistics).toContainText('Lowered');
    await expect(statistics).toContainText('Raised');
    await expect(page.locator('.nh-difference-legend')).toContainText('not the sediment budget');
    const canvas = page.locator('.nh-map > canvas');
    const rect = (await canvas.boundingBox())!;
    await canvas.hover({ position: { x: rect.width / 2, y: rect.height / 2 } });
    const sample = page.locator('.nh-compare-sample');
    await expect(sample).toContainText('Cursor');
    await expect(sample).toContainText('Current');
    await expect(sample).toContainText('Δ');
    await page.getByRole('button', { name: 'Inspect terrain' }).click();
    await expect(page.locator('.nh-inspection-readout')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('viewport-compare-inspection.png'),
      animations: 'disabled',
    });
  });

  test('stacks split panes on narrow screens and preserves the workspace controls', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(page.locator('.nh-mode-split')).toHaveCSS('flex-direction', 'column');
    await expect(page.getByRole('separator', { name: 'Resize 3D and map views' }))
      .toHaveAttribute('aria-orientation', 'horizontal');
    await expect(page.getByRole('button', { name: 'Focus viewport', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '2D map', exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath('viewport-narrow-2d.png'),
      animations: 'disabled',
    });
  });
});
