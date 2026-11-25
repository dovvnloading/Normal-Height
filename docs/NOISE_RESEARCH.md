# Procedural noise: references, numerical contracts, and limits

Research checked on 2026-11-24. This document records the mathematical and implementation decisions behind the Studio noise work. It is not a claim that the application outperforms commercial authoring tools. That requires representative visual comparisons, reproducibility checks, and measured performance on stated hardware.

## Starting point and compatibility

The existing `src/engine/noise.ts` has two saved algorithm models. `legacy` preserves the original material and terrain generators. `v2` introduces bounded Perlin output, selected parameter corrections, and a nominal octave footprint rolloff. Both models remain compatibility contracts: adding noise choices must not silently reinterpret an existing project's seed, coordinates, normalization, or algorithm.

Studio noise is implemented separately so that its seed streams, kernels, and compositing rules can be versioned. The same saved settings must produce the same samples regardless of worker scheduling, preview history, or the order in which graph nodes are evaluated.

## Sources and provenance

| Source | What it establishes | Integration consequence |
| --- | --- | --- |
| [FastNoiseLite TypeScript, pinned commit](https://github.com/Auburn/FastNoiseLite/blob/785f37a9ad76e283586a379675085f2063ae03f7/JavaScript/src/FastNoiseLite.ts) | Reference implementations of OpenSimplex2, OpenSimplex2S, Perlin, Value, ValueCubic, fractal modes, and domain warp. | Use the actual named kernel; retain the file's MIT notice and its 2023 copyright attribution. |
| [FastNoiseLite documentation](https://github.com/Auburn/FastNoiseLite/wiki/Documentation) | API semantics, output conventions, weighted fractals, cellular return types, and the jitter restriction of its cellular implementation. | Configure kernel instances once, explicitly set frequency and fractal mode, and distinguish F1/F2 operations. |
| [KdotJPG/OpenSimplex2](https://github.com/KdotJPG/OpenSimplex2) | Distinguishes the faster and smoother variants, documents gradient-table changes, and describes torus-based tiling. | Do not relabel conventional simplex as OpenSimplex2S; do not claim arbitrary 2D coordinate wrapping is seamless. |
| [Worley, A Cellular Texture Basis Function, 1996](https://itn-web.it.liu.se/~stegu76/TNM084-2019/worley-originalpaper.pdf) | Nearest-feature distance functions, cell IDs, distance gradients, deterministic cell scattering, and geometric rejection of cells. | Search with support-distance bounds and validate the result against a wider independent search. |
| [Blender's Musgrave reference implementation](https://archive.blender.org/developer/differential/0005/0005616/D5616.id17614.html) | Separate multiplicative, hybrid, heterogeneous, and ridged recurrences and spectral weighting. | Implement the mathematical recurrences independently; do not copy Blender source into this project without considering its license. |
| [de Carpentier, Scape: Procedural extensions, 2012](https://www.decarpentier.nl/scape-procedural-extensions) | Swiss and Jordan turbulence with analytical Perlin derivatives, gradient feedback, and amplitude damping. | Describe these as erosion-inspired noise; derivative feedback is not a hydraulic or thermal simulation. |
| [Lagae et al., Procedural Noise using Sparse Gabor Convolution, 2009](https://graphics.cs.kuleuven.be/publications/LLDD09PNSGC/) | Gabor spectral controls, sparse convolution, and filtering. The linked PDF corrects equations 19–22. | Use the corrected paper and distinguish an independently implemented kernel from copied example code. |
| [Lagae et al., Improving Gabor Noise, 2011](https://graphics.cs.kuleuven.be/publications/LLD11IGN/LLD11IGN_paper.pdf) | Isotropic kernels and quantitative truncation-error analysis. | Finite support is an approximation to a Gaussian; document the truncation rule rather than claiming exact compact support. |

The pinned FastNoiseLite commit is `785f37a9ad76e283586a379675085f2063ae03f7`; its TypeScript source blob is `5790e7c79f694e0dcda219a08c5e398645019bb4`. The root license and individual source headers use different copyright years; preserve the source header actually distributed. KdotJPG's repository is predominantly CC0, with separately marked files under the Unlicense. The Scape and Gabor article pages do not by themselves establish a blanket permissive license for every downloadable source file. Mathematical methods may be independently implemented with attribution; copied source needs its own license check.

## Kernels, seeds, and derivatives

FastNoiseLite's TypeScript port explicitly uses `Math.imul` for integer hash products. This avoids treating JavaScript floating-point multiplication as exact 32-bit arithmetic. KdotJPG's current Java implementation instead includes 64-bit hashing. A 32-bit port is a distinct deterministic contract and must not promise identical values to that Java version. The pinned TypeScript implementation provides a clear reference for this application's OpenSimplex outputs.

FastNoiseLite Value uses Hermite interpolation; ValueCubic is a separate cubic interpolation kernel. Neither should be described as the existing quintic Value implementation. A kernel name is a useful artistic label, but reproducibility also requires the kernel version, seed derivation, coordinate transform, and output mapping.

Seed handling should use independent tagged streams for the main field, octave variations, and warp channels. A fixed seed must not accidentally depend on a node's array index or worker execution order. A saved stream identifier should make a variation reproducible. A locked or fixed seed needs explicit semantics relative to the global seed and randomize actions.

Studio differentiates the pinned FastNoiseLite 2D Perlin interpolant analytically, including its quintic interpolation weights and amplitude normalization. The interpolation derivative is `30 t² (t − 1)²`. Other continuous kernels use symmetric numerical differences at a local step of `0.0001`; these are approximations, with additional evaluation cost. Discontinuous white noise, Gaussian lattice noise, sawtooth waves, and cell-value outputs do not provide a meaningful ordinary gradient at their jumps; their derivative feedback is deliberately suppressed.

A base kernel's gradient is not automatically the gradient of a recursively warped fractal: that requires the chain rule through all feedback, including second derivatives where gradients drive displacement. The derivatives used for Swiss/Jordan feedback do not establish analytical normals for their final composite output.

## Cellular correctness

One point uniformly jittered within each grid cell is a useful deterministic distribution, but it is not an unconstrained Poisson point process. Worley's original method allows variable feature counts and discusses the compromises introduced by bounding those counts.

A fixed 3×3 neighborhood does not guarantee the nearest or second-nearest point when each point can occupy any location within its cell. Points in the next ring can beat all candidates in the initial neighborhood. The Studio search therefore needs a lower bound from the query to each cell's allowed feature support, and a stopping bound for all unvisited cells. Compare Euclidean, Manhattan, and Chebyshev results to an independent wide-neighborhood oracle, including jitter 0 and 1 and samples adjacent to integer boundaries.

For one feature per cell and jitter confined to the cell, the following are conservative bounds derived for this implementation:

- The center cell gives Euclidean F1 no larger than √2.
- The center cell plus the neighboring cell across the closest side give Euclidean F2 no larger than √(3.25), Manhattan F2 no larger than 2.5, and Chebyshev F2 no larger than 1.5.
- Any cell beyond a searched 7×7 square is at least three units away along one axis. Thus this square is a conservative fallback for F1/F2 under those three metrics; geometric rejection usually visits far fewer cells.

`F2 − F1` is a distance gap. It vanishes on a boundary but is not the physical distance to that boundary. For Euclidean sites, the signed distance to the bisector between the closest point `a` and a competitor `b` is

```text
dot((a + b) / 2 − p, (b − a) / length(b − a))
```

The minimum over competitors is the nearest Voronoi boundary distance. Competitors need their own safe search bound: the second-nearest site alone is insufficient. The triangle inequality gives a rejection bound `(distance(p, b) − distance(p, a)) / 2`. Euclidean bisector geometry must not be presented as an edge distance for Manhattan or Chebyshev cells.

## Fractal distinctions

Ordinary fBm adds octave contributions with decreasing amplitudes. A heterogeneous recurrence weights the next detail by accumulated height, creating smoother low regions. A hybrid recurrence keeps a separate bounded feedback weight, allowing detail to vary between peaks and valleys. Multiplicative cascades can produce a rapidly expanding or collapsing range. Bounded adaptations should state their normalization and feedback rules instead of implying exact compatibility with a historical Musgrave implementation.

For a spectral exponent `H`, octave amplitude is proportional to `lacunarity^(−H × octave)`. Explicit persistence is an alternative parameterization. If both appear in a UI, their relationship must be clear. A fractional octave should smoothly scale the final octave's contribution while leaving integer-octave results unchanged.

Ping-pong noise folds a signal with a triangle wave. Positive modulo makes the fold well defined for negative phases. Folding, squaring, and absolute values generate harmonics, so applying a frequency fade to the input before the fold can give the wrong unresolved mean. Studio fades the shaped output toward an estimated shaped mean. Its calibration uses a fixed 1,024-point lattice-space quadrature and a fixed calibration seed, shared across resolutions and authored seeds; it is an estimate rather than an exact integral of the complete recursive process.

Canonical signed billow is `2 × abs(noise) − 1`; turbulence is `abs(noise)`. Mapping both to a common 0–1 output makes them mathematically equivalent with zero detail weighting. With weighting enabled, the signed billow baseline and the unipolar turbulence baseline differ. These names should not be counted as two unrelated base noise kernels.

Swiss turbulence combines ridged values with gradient-driven displacement and height-dependent attenuation. Its smooth gradient feedback deliberately uses a noise-weighted gradient rather than the discontinuous derivative of `abs`. Jordan turbulence uses squared values and separate accumulated vectors for warping and damping. Studio implements a bounded adaptation with shared controls rather than every independent coarse/fine coefficient in the original. Jordan damping preferentially suppresses fine detail in flatter regions. Octave-rotation feedback is transformed into a common coordinate frame. These are procedural appearances, not evidence of physically modeled drainage.

## Sparse Gabor and filtering

An independently implemented Gabor kernel can be expressed as

```text
K × exp(−π a² |r|²) × cos(2π F0 dot(direction, r) + phase)
```

Its envelope controls bandwidth, its carrier controls frequency and orientation, and its impulse process controls the sparse convolution. Studio uses a fixed configurable number of jittered impulses per cell, independently hashed phases and orientations, and a smoothly truncated Gaussian envelope. This is jittered sparse Gabor, not an exact Poisson process. Its untruncated random-phase variance is `density / (4 a²)` for unit impulse amplitudes. Studio divides the sum by three times the corresponding standard deviation and applies `tanh` to obtain bounded values. This compression and the support window change the spectrum; the result is not an unmodified Gaussian random field. Normalization never uses the observed extrema of the current image.

A Gaussian has infinite support. A finite search radius truncates a small tail and can introduce a small discontinuity unless the envelope is smoothly windowed. Tail suppression, windowing, and exact analytical Gaussian filtering are different operations. The corrected 2009 paper provides the latter for its assumptions; nonlinear shaping and recursive warps require further treatment.

The application's nominal footprint rolloff is a useful approximation, not proof of band-limited output. Studio estimates the largest singular value of the external domain-warp mapping with forward differences. A scalar footprint loses direction information for anisotropic transforms, and the internal Swiss/Jordan feedback warp does not have an exact propagated Jacobian. The recursive warp's own filtering also uses a nominal footprint. Limited deterministic supersampling improves quality but cannot guarantee alias-free output for every frequency, derivative warp, cellular discontinuity, or extreme parameter combination. Filtered unresolved detail approaches an estimated mean of the shaped kernel without re-amplifying surviving coarse octaves.

Narrow features receive additional footprint-aware treatment. Cellular borders use the exact one-dimensional box convolution of their smoothstep border profile, interpreted as a local straight-border approximation. A rotated square pixel's projected footprint and Voronoi vertices do not satisfy that simplified geometry. Compact spots and crater bowls broaden through a moment-matched radial profile: for `(1 − r²/R²)^p`, the adjusted squared radius is `R² + (p + 2) footprint² / 6`, with amplitude multiplied by the original-to-adjusted area ratio. This preserves the isolated profile's integral and adds the box filter's per-axis variance. Crater rims use local Gaussian width broadening and approximate radial mass scaling. These are approximations to spatial convolution; nonlinear overlap, curved rims, and the final composed field still benefit from supersampling.

The quality choices use one filtered sample, four subpixel samples, or sixteen subpixel samples. Subpixel evaluations include output shaping, so a curve or levels adjustment benefits from the extra sampling too. These are fixed grids, not stochastic integration or adaptive error-bounded sampling.

## Validation and practical delivery criteria

1. Preserve existing model output with saved-project fixtures and fixed checksums.
2. Verify seed repeatability, stream separation, fixed/global seed behavior, and serialization round trips.
3. Compare named reference kernels with the pinned upstream implementation at nontrivial coordinates, negative coordinates, and boundary cases.
4. Check cellular nearest distances, identities, and edge distances against a wider independent oracle.
5. Check analytical base derivatives against central differences, and control sensitivity against fixed scenes.
6. Compare filtered results with a dense area-sampling reference; measure error and mean drift separately. Resolved samples at the same world coordinate should agree across resolutions; filtered samples need not be identical.
7. Measure median and tail generation times at relevant preview/export sizes. State the CPU, browser/runtime, thread count, and quality settings. Avoid per-pixel allocations and mutable random streams.
8. Inspect height, normal, and shaded material previews for clipping plateaus, directional artifacts, seam errors, and scale-dependent appearance.

## Seamless blend: implemented behavior

Studio's optional seamless blend evaluates the complete transformed, warped field at four translated positions, then combines those evaluations using quintic weights before wrapping the tile coordinates. The construction matches opposite boundary values and, for a differentiable underlying field, its first derivatives. This is a blend construction, not native lattice periodicity or a 4D torus embedding. Blending correlated fields changes the interior variance and distribution and costs up to four field evaluations per subpixel.

Intrinsically discontinuous generators retain their steps. Piecewise linear remap curves can also introduce derivative discontinuities. A universal claim of a continuously differentiable result would therefore be incorrect. Downstream erosion and normal-map boundaries need compatible boundary conditions; this source setting does not make every later operation periodic.

## Independent numerical checks

`src/engine/noiseStudio/cellular.test.ts` includes a 15×15 exhaustive nearest-site oracle, a squared-distance bisector oracle, and an independently bisected smooth-minimum equation. It exercises all three distance metrics, zero/full/intermediate jitter, negative coordinates, cell boundaries, and known outside-neighborhood regressions. All 17 tests passed when added. The wider probes found and corrected a half-cell error in the initial exterior search bound before delivery.

An additional 6,000-case independent probe produced zero F1/F2 disagreement and a maximum Euclidean edge disagreement of `2.52e-15` after that correction. A 2,000-point Perlin probe, including integer lattice boundaries and full-range seeds, differed from the pinned scalar implementation by at most `6.39e-16`; central differences at step `1e-5` differed from the analytical derivatives by at most `4.65e-9`. These checks establish the tested numerical contracts. They do not establish a performance ranking or eliminate the filtering approximations above.

`src/engine/noiseStudio/derivative-reference.test.ts` adds eight independent recurrence checks. Its oracle uses only the pinned vendor's scalar Perlin and central differences, rather than the engine's gradient or coordinate helpers. It covers rotated and fractional Swiss/Jordan octaves, full-range seeds, weighted feedback, zero-control reductions, and the bounded Jordan damping convention. A specific regression distinguishes common-frame displacement from the erroneous direct application of that vector in rotated local coordinates. Halving the numerical differentiation step checks the oracle's stability. All eight tests passed when added.

## Source export verification

The separate high-resolution source exporter samples the selected procedural source in bounded strips. It does not execute the downstream graph at that resolution. RAW stores the same Float32 scalar values as the source generator, using little-endian byte order. PNG first measures the Float32 range, then maps it to unsigned 16-bit grayscale. Its reconstruction error is bounded by half a quantization interval; a constant field decodes to the recorded minimum.

The implementation uses big-endian PNG samples and chunk lengths, row-local Sub filtering with two bytes per pixel, a single zlib stream across IDAT chunks, and a CRC over each chunk's type and data. These conventions follow the [W3C PNG specification](https://www.w3.org/TR/png-3/). `tests/noise-source-export.test.ts` independently checks the CRC, decompresses and reconstructs scanlines, compares RAW values exactly, and checks PNG quantization error. It also covers constant/negative fields and a non-power-of-two resolution whose final coordinate must be set explicitly to one.

Bounded generation buffers do not imply constant total browser memory: the download path retains the completed ZIP chunks, and Blob creation may copy them. An 8192² Float32 map alone occupies 256 MiB. Cancellation terminates the export worker, discards accumulated chunks, and rejects stale messages by job generation. That mechanism was reviewed in code; browser download/cancellation behavior requires the separate end-to-end test. Metadata retains horizontal scale, vertical scale, scalar range, physical elevation range, seed context, and sample orientation so the source can be reconstructed without guessing its units.
