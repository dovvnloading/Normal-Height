import { expect, test } from '@playwright/test';

/**
 * Fast CI regression: catches camera-driven resource churn and unwanted PBR
 * regeneration. Detailed real-hardware RAF/VRAM benchmarking lives in
 * tests/perf/mesh-perf.spec.ts and is opt-in.
 */
test('adaptive 3D mesh stays idle and disposes replaced GPU buffers without rerunning PBR',
  async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto('/?meshBenchmark=adaptive');
    await expect(page.locator('.status-bar')).toContainText('Terrain ready', {
      timeout: 60_000,
    });
    const canvas = page.getByRole('img', { name: /^Interactive 3D terrain\./ });
    await expect(canvas).toHaveAttribute('data-material-status', 'ready', {
      timeout: 40_000,
    });
    const value = async (key: string) => Number(await canvas.getAttribute(key) ?? '0');
    const initialRequests = await value('data-pbr-request-count');
    const initialUploads = await value('data-pbr-upload-count');
    expect(initialRequests).toBeGreaterThan(0);
    expect(initialUploads).toBeGreaterThan(0);

    // A fully stationary 3D camera must not keep planning/reuploading
    // meshes just because the animation loop is alive.
    await page.waitForTimeout(750);
    const planCount = await value('data-mesh-plan-checks');
    const builds = await value('data-mesh-build-count');
    await page.waitForTimeout(800);
    expect(await value('data-mesh-plan-checks')).toBe(planCount);
    expect(await value('data-mesh-build-count')).toBe(builds);

    await page.getByRole('button', { name: 'Scene', exact: true }).click();
    await page.getByRole('combobox', { name: 'Terrain mesh fidelity' })
      .selectOption('ultra');
    await expect(canvas).toHaveAttribute('data-mesh-quality', 'ultra');
    const viewport = await canvas.boundingBox();
    expect(viewport).not.toBeNull();
    await page.mouse.move(viewport!.x + viewport!.width * 0.55,
      viewport!.y + viewport!.height * 0.55);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -220);
    await expect.poll(() => value('data-mesh-build-count'),
      { timeout: 25000 }).toBeGreaterThan(builds);
    await page.waitForTimeout(750);
    const closeupPlans = await value('data-mesh-plan-checks');
    await page.waitForTimeout(900);
    expect(await value('data-mesh-plan-checks')).toBe(closeupPlans);

    const buildCount = await value('data-mesh-build-count');
    const disposalCount = await value('data-mesh-dispose-count');
    expect(buildCount - disposalCount).toBe(1);
    expect(await value('data-mesh-vertices')).toBeLessThanOrEqual(1400000);
    expect(await value('data-mesh-buffer-bytes')).toBeLessThan(100_000_000);
    expect(await value('data-pbr-request-count')).toBe(initialRequests);
    expect(await value('data-pbr-upload-count')).toBe(initialUploads);
    expect(await value('data-mesh-renderer-geometries')).toBeLessThan(30);

    // Toggling the 3D display doesn't alter the source worker or accumulate
    // more GL allocations while retaining the same mesh.
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: '2D map', exact: true }).click();
      await page.getByRole('button', { name: '3D terrain', exact: true }).click();
    }
    await expect(page.locator('.nh-render-error')).toHaveCount(0);
    expect(await value('data-pbr-request-count')).toBe(initialRequests);
    expect(await value('data-pbr-upload-count')).toBe(initialUploads);
    expect(await value('data-mesh-renderer-geometries')).toBeLessThan(30);

    await testInfo.attach('mesh-resource-audit.json', {
      body: Buffer.from(JSON.stringify({
        initialPlanChecks: planCount,
        closeupPlanChecks: closeupPlans,
        buildCount,
        disposalCount,
        cpuGeometryBytes: await value('data-mesh-buffer-bytes'),
        rendererGeometries: await value('data-mesh-renderer-geometries'),
        rendererTextures: await value('data-mesh-renderer-textures'),
        pbrRequests: await value('data-pbr-request-count'),
        pbrUploads: await value('data-pbr-upload-count'),
      }, null, 2)),
      contentType: 'application/json',
    });
  });
