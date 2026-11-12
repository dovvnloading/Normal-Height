# Adaptive terrain mesh: real-device performance and visual validation

Issue: [#34](https://github.com/dovvnloading/Normal-Height/issues/34). The [adaptive terrain mesh](../src/render/terrainMesh.ts) renders an 8 × 8 tile mesh with bounded per-tile LOD. This document defines a **repeatable hardware acceptance procedure**, not an assertion that CI SwiftShader measurements represent a physical GPU.

## What is now instrumented

- Mesh LOD is **event-driven**. No 300 ms plan recalculation takes place when the camera is motionless. Camera motion triggers a settling/debouncing interval and a bounded mesh plan refresh; auto-rotation is checked periodically. Rebuilds happen only for a changed plan.
- Per-tile **LOD hysteresis** prevents oscillating between resolutions on small camera movements across power-of-two thresholds.
- A reproducible `?meshBenchmark=uniform512` reference uses 64 segments per tile (8 × 8), exactly **524,288 triangles**, with the *same interpolation, material shaders and physical normal generation* as `?meshBenchmark=adaptive`. Both start from the same camera transform. This isolates the cost of adaptive geometry topology, rather than pretending the reference is identical to the pre-PR #33 renderer.
- Diagnostic canvas attributes track `data-mesh-plan-checks`, `data-mesh-build-count`, `data-mesh-dispose-count`, `data-mesh-buffer-bytes`, `data-pbr-request-count`, `data-pbr-upload-count`, `data-mesh-plan-ms`, `data-mesh-build-ms`, `data-mesh-render-cpu-ms`, `data-mesh-renderer-geometries`, `data-mesh-renderer-textures`, and benchmark camera position/target.
- An **optional WebGL2 timer query** collects elapsed GPU draw-submission command time when `EXT_disjoint_timer_query_webgl2` is present. Queries are polled asynchronously; invalid/disjoint samples are excluded. If unsupported, the report says *unavailable*—never zero.
- The benchmark collects requestAnimationFrame interval percentiles and the browser's `longtask` entries for orbit, pan, zoom, focus and idle. These are **responsiveness/jank signals**, not a substitute for measured GPU render times.
- `data-mesh-buffer-bytes` is the distinct underlying CPU-side geometry buffer sizes, **not GPU VRAM**. `renderer.info.memory` counts live geometries/textures but does not provide true VRAM bytes. `performance.memory` may be unavailable on some browsers.

## Run on real hardware

Install Node ≥22.12 and dependencies:

```bash
npm ci
npx playwright install chromium
# If using MESH_BENCH_CHROME=1 in the examples below, install
# Google Chrome stable on the machine (or: npx playwright install chrome).
```

On an integrated-GPU laptop and a discrete-GPU desktop, run both the optimized and reference cases on exactly the same hardware/browser build, screen resolution, device-pixel ratio and project. Example quick pass:

```bash
MESH_BENCH_CHROME=1 MESH_BENCH_DEVICE="Laptop iGPU / driver version" \
MESH_BENCH_RESOLUTIONS=512 \
MESH_BENCH_QUALITIES=high \
MESH_BENCH_MATERIALS=clay,pbr \
npm run test:mesh-perf
```

For the full matrix requested in issue #34:

```bash
MESH_BENCH_CHROME=1 MESH_BENCH_DEVICE="Desktop dGPU / driver version" \
MESH_BENCH_RESOLUTIONS=128,256,512,1024 \
MESH_BENCH_QUALITIES=balanced,high,ultra \
MESH_BENCH_MATERIALS=clay,pbr \
npm run test:mesh-perf
```

The full matrix is **48 tests** (4 grid sizes × 3 mesh qualities × 2 materials × 2 topologies), so allow hardware-dependent time and disk space. Test both `MESH_BENCH_EXAGGERATION=1` and `MESH_BENCH_EXAGGERATION=1.8` in separate runs. Use `MESH_BENCH_VIDEO=1` for videos and inspect the still captures for ridge silhouettes, nearby gullies, terrain/meadow boundary and zoom jumps.

Hardware is required by default. If the browser reports SwiftShader/llvmpipe or the GPU renderer is hidden, the **hardware-mode test fails** to prevent falsely declaring real GPU validation. Record the device GPU name, driver, OS, browser build, display refresh rate and power mode before comparing.

For a *non-hardware* CI smoke run that only verifies the recording pipeline:

```bash
MESH_BENCH_SOFTWARE=1 MESH_BENCH_HEADLESS=1 \
MESH_BENCH_RESOLUTIONS=128 MESH_BENCH_QUALITIES=balanced \
MESH_BENCH_MATERIALS=clay npm run test:mesh-perf
```

This uses SwiftShader and **must not** be used to approve hardware FPS performance. The normal GitHub CI runs this limited software smoke test; its artifacts are named `terrain-mesh-benchmark-smoke`.

## Evidence and acceptance rubric

Per-test JSON appears in `mesh-benchmark-results/summary/`, with screenshots and optionally video/trace files under `mesh-benchmark-results/`. The test records `rafGapsMs`, `mainThreadLongTasksMs`, optional `gpuDrawTimeMs`, CPU times for plan/build/PBR packing, geometry and texture counts, mesh triangles, and requested/executed PBR uploads.

For each hardware device, compare the **reference** and **adaptive** JSONs at identical viewport/camera configurations, and include:

1. **Responsiveness:** report p50/p95/p99/worst RAF intervals for orbit, pan, zoom, focus, idle; note outliers from thermal throttling. No repeated periodic plan work while the camera is idle.
2. **GPU performance:** report actual timer-query p50/p95/p99/worst **only if supported**, otherwise state "not available." Check for shader-compile and upload stalls separately rather than mislabelling CPU submission as GPU time.
3. **Memory/lifetime:** no cumulative growth of Three.js live geometry/texture counters across repeated camera moves and 3D/2D switches; `meshBuildCount - meshDisposeCount === 1` for the live main terrain; mesh buffer estimates remain below 100 MB even at Ultra. Real VRAM requires an OS GPU profiler.
4. **Visual quality:** visually inspect silhouettes on hard mountain ridges, steep cliffs, river banks, tile seams, expanded-ground transition, and both normal/1.8× exaggeration. No new T-junction holes, normal seams, oscillation, popping, persistent serration or fake elevation changes.
5. **Data fidelity:** worker-generated Float32 field stays identical while only camera/LOD/material view settings change. Source 128² cannot display real sub-sample detail regardless of tessellation.

**Proposed initial targets (not yet certified on hardware):** p95 RAF interval under 33.3 ms during camera interactions on a supported desktop GPU at High, no recurrent >250 ms stalls after warmup, no leaks/redundant PBR uploads, and stable silhouettes. Hardware measurements should determine final per-device budgets. A per-test orbit p95 can be automatically gated by `MESH_BENCH_MAX_RAF_P95_MS=33.3`, but do not label the target achieved until a real run passes.

## CI versus hardware coverage

- Unit tests cover mesh plan hysteresis, source consistency, seam geometry, buffer accounting and percentile math.
- Chromium CI covers idle camera stability, geometry disposal, bounded buffers, and no unnecessary PBR generation/upload from LOD updates.
- CI runs a **single software-rendered benchmark smoke pair** to ensure the hardware benchmark's output format and execution path are valid.
- **Hardware sign-off requires an actual integrated and discrete GPU run**, attaching both matrix outputs and GPU/driver metadata to issue #34. No connector available in this conversation exposes such a physical GPU. Leave the issue open until that step is completed; successful CI is a software regression gate, not a hardware acceptance certificate.
