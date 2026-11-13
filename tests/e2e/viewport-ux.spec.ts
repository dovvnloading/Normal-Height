import { test, expect } from '@playwright/test';

test.describe('terrain viewport UX', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.nh-viewport-toolbar')).toBeVisible();
    await expect(page.locator('.nh-render-progress')).toHaveCount(0, { timeout: 90_000 });
    await expect(page.locator('.nh-scene-resolution')).toContainText('tris', { timeout: 90_000 });
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

  test('stacks split panes on narrow screens and preserves the workspace controls', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 760 });
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(page.locator('.nh-mode-split')).toHaveCSS('flex-direction', 'column');
    await expect(page.getByRole('separator', { name: 'Resize 3D and map views' }))
      .toHaveAttribute('aria-orientation', 'horizontal');
    await expect(page.getByRole('button', { name: 'Focus viewport', exact: true })).toBeVisible();
  });
});
