# Procedural PBR export profiling

The studio's material export budget is deliberately a conservative **preflight estimate**, not a
promise about browser memory use. This document records reproducible measurements rather
than equating theoretical array sizes with real allocation peaks.

## Baseline measurement — November 9, 2026

[GitHub Actions profiling workflow](https://github.com/dovvnloading/Normal-Height/actions/runs/42725225673)
ran three independent jobs using Node v24.22.2 on GitHub-hosted Linux runners. Each generated
a deterministic synthetic terrain heightfield plus flow/wear/deposition signals and exported
a complete ZIP by calling the **same production `makeExport(field, project, 'pbr', false)` code**
used by the browser's encoding Worker. No scans, imported textures or other source images
were involved.

| Export size | Preflight estimate | Initial RSS | Sampled peak RSS | Incremental RSS | PBR synth + encoding | ZIP size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 512² | 102 MiB | 68.9 MiB | 144.9 MiB | 76.0 MiB | 0.85 s | 2.8 MiB |
| 1024² | 214 MiB | 69.5 MiB | 207.1 MiB | 137.6 MiB | 5.03 s | 15.8 MiB |
| 2048² | 664 MiB | 70.6 MiB | 456.6 MiB | 386.1 MiB | 18.55 s | 63.1 MiB |

**Method:** a separate Node worker thread sampled process-wide `process.memoryUsage().rss`
approximately every 25 ms while the main test thread executed synchronous PBR generation
and PNG/ZIP encoding. The sampled high-water value can miss spikes shorter than 25 ms.
"Incremental" means peak RSS minus the measurement's initial RSS, not a precise allocation
breakdown. Results include Node, Vitest and other runtime overhead; the synthetic field
is not a representative worst-case real terrain. Different terrain/material parameters
affect compression ratio and compute time.

**Interpretation:** All three tests completed and the sampled *incremental Node process*
allocation stayed below the respective preflight estimate on this runner. This does **not**
prove a safe 2K export in every browser. In-browser WebGL textures, worker input clones,
GPU memory, storage/Blob conversions, OS/browser process layout and concurrent application
tabs are absent from this measurement. The preflight continues to reject larger requests
on devices with a small or missing memory hint.

## Reproduce

The opt-in `Profile PBR ZIP allocation` workflow runs independent 512/1024/2048 jobs
and uploads `pbr-memory-<resolution>.json` machine-readable artifacts. Locally:

```bash
npm ci
PBR_BENCH_SIZE=512 npx vitest run --config vitest.profile.config.ts
PBR_BENCH_SIZE=1024 npx vitest run --config vitest.profile.config.ts
PBR_BENCH_SIZE=2048 npx vitest run --config vitest.profile.config.ts
```

The benchmark is not part of normal commit CI: high-resolution profiling can consume
substantial CPU and RAM.

## Remaining acceptance work (#11)

- Capture browser/process/GPU peak memory and completion time at 512/1024/2048 on
  Chromium, Firefox and WebKit where supported, including low-memory devices
- Exercise cancellation while graph generation, material synthesis and ZIP encoding
  are actively running, checking that workers terminate and subsequent exports recover
- Profile a representative set of real generated terrain fields and verify that the
  preflight margin remains conservative under worst-case compression and concurrent 3D views
- Preserve clear user-facing 2K limitations; do not enable 4K/8K until bounded encoding is proven

These are **open** tasks, not implied by the completed Node profiles.
