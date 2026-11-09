# Terrain research and implementation notes

Normal Height is an independent terrain editor. It takes workflow inspiration from Terragen and the variety of procedural textures in Cinema 4D. It does not reproduce their proprietary algorithms or claim equivalent simulation/rendering fidelity.

## Reference workflow

Terragen's Power Fractal provides seeded noise, multiple feature scales, roughness, stretched coordinates, displacement, variation, and warping. Its documented families include Perlin, Perlin billows/ridges/mixes, and Voronoi billows/ridges. Feature width and displacement amplitude are separate controls.

- [Power Fractal Shader v3 — Planetside documentation](https://docs.planetside.co.uk/wiki/Power_Fractal_Shader_v3)
- [Heightfield generation from shaders](https://docs.planetside.co.uk/wiki/Heightfield_Generate_-_Use_Shader_Tab)

Planetside's terrain workflow starts with controllable forms, distorts them with procedural warps, samples the result into a heightfield, erodes it, and optionally adds restrained detail afterward. Built-in Erode v3 exposes duration, flow distance, erosion power, deposition, and diffusion. The separate DK Classic Erosion plugin adds other simulation modes and diagnostic outputs. The documented coarse-to-fine resampling approach is a useful reference for multiscale drainage.

- [Terrain Techniques: Detail, Warp, Erode](https://planetside.co.uk/blog/terrain-techniques-detail-warp-erode/)
- [Heightfield Erode v3](https://docs.planetside.co.uk/wiki/Heightfield_Erode_v3)

## Noise design

Normal Height independently implements seeded gradient Perlin, simplex, fractal Brownian motion, feedback-weighted ridged multifractal, billow, turbulence, Voronoi nearest-distance and distance-gap fields, cell values, directional waves, warped fBm, and an artistic Naki-inspired variant. These are different scalar constructions, not merely different display colors.

Maxon's documentation lists Naki among its many noise families but does not specify Naki's mathematical definition. Our Naki-inspired mode combines folded simplex lobes with nested coordinate distortion. It is **not** Maxon's Naki implementation. Seed, frequency, octaves, gain, lacunarity, rotation, stretch, amplitude, and offset make these fields editable and repeatable.

- [Maxon Noise inputs — official documentation](https://help.maxon.net/c4d/en-us/Content/html/COM_REDSHIFT3D_REDSHIFT4C4D_NODES_CORE_MAXONNOISE-NET_MAXON_NODE_BASE_GROUP_INPUTS.html)

### Mountain structure

The mountain generator separates the elevation of the broad spine or massif from its secondary ridge relief. Low-frequency fields vary the main crest and mountain shoulders; a rounded ridge kernel contributes smaller-scale relief on those forms. Applying the entire mountain elevation to every sharp ridged-noise intersection produces implausible needles, so the source limits that contribution before erosion. The separate Ridged Multifractal noise remains sharp for users who want that field explicitly.

The default 3D view uses physical horizontal and vertical scale. Adjustable vertical exaggeration affects only the display; it never changes simulation heights, normals exported from physical dimensions, or elevation files.

## Hydraulic erosion

The engine runs a deterministic droplet simulation in a Web Worker. Water parcels follow bilinearly sampled height gradients with inertia. Their carrying capacity depends on downhill travel, speed, and remaining water. A parcel removes material through a weighted circular brush when below capacity and deposits carried material as it slows, becomes oversaturated, or meets rising ground. Water evaporates; parcel lifetime is bounded. The solver records flow, wear, deposition, and material leaving the active simulation. Its `exportedSediment` statistic includes boundary runoff and carried sediment still unsettled when a terminal mask prevents local deposition; it is not strictly a measurement of boundary runoff. It uses actual float-buffer changes for erosion and deposition accounting.

This is an artistic, particle-based erosion model, not a calibrated hydrological forecast or full Navier–Stokes simulation. The multi-scale switch runs broader, longer-lived parcels before smaller-channel droplets **on the same full-resolution grid**. It does not simulate a lower-resolution field and claim interpolation creates additional erosion detail. Thermal settling is a separate conservative talus relaxation pass. Masks modulate actual material exchange, rather than merely overlaying a simulated-looking texture.

Primary implementation references and related research:

- [Nick McDonnell: Simple Particle-Based Hydraulic Erosion (2020)](https://nickmcd.me/2020/04/10/simple-particle-based-hydraulic-erosion/) — particle motion and equilibrium sediment exchange.
- [Nick McDonnell: Procedural Hydrology improvements (2023)](https://nickmcd.me/2023/12/12/meandering-rivers-in-particle-based-hydraulic-erosion-simulations/) — stream/pool feedback, momentum, and the importance of sediment avalanching.
- [Sebastian Lague: Hydraulic Erosion](https://github.com/SebLague/Hydraulic-Erosion) — another inspectable particle erosion implementation. The code here was written independently.
- [Šťava et al., Interactive Terrain Modeling Using Hydraulic Erosion (2008), author-hosted paper](https://cs.purdue.edu/homes/bbenes/papers/Stava08SCA.pdf) — a different, grid/pipe GPU simulation combining sediment transport, multiple materials, and slippage. This is a future research direction, not a method implemented by this app.

## Data and limits

Height computation uses Float32 samples throughout. Flow remains raw visit accumulation inside the graph and is logarithmically normalized once when presented as a final map or connected as a scalar height input. Wear and deposition in the result retain positive height amounts; connecting these channels as scalar node inputs normalizes them to 0–1. Domain warp resamples height and every diagnostic with the same coordinate mapping, preserving their spatial alignment.

Blend combines diagnostic arrays using the local contributions from A and B, including the optional mask. Add keeps A's contribution and adds weighted B; maximum/minimum use B only where it supplies the chosen height. Multiply uses the same A/B influence interpolation as Mix for its diagnostic visualization. These are artistic diagnostic combinations, not a new sediment simulation. Blend's wear/deposition summaries sum its resulting diagnostic maps; exiting sediment is weighted by the average input contributions.

Erosion statistics use normalized-height sample volumes; multiply by the terrain's vertical scale and grid-cell area to estimate volume in world units. Warping, remapping, and blending are artistic operations, so physical sediment conservation applies to the hydraulic/thermal operations themselves rather than arbitrary downstream graphs. A warped diagnostic's integrated amount can change with the coordinate deformation even though the preceding simulation statistics remain unchanged.

Generation is bounded to 2048 × 2048 samples. Before allocating terrain fields, a conservative memory estimate rejects connected graphs that exceed a 512 MiB working budget and recommends a smaller resolution. The estimate includes cached graph fields, diagnostic routing, simulation scratch, result buffers, and workspace overhead. It is a preflight safeguard rather than a guarantee of a browser's total process memory. Disconnected nodes do not increase the estimate. The same seed, resolution, graph, and parameters reproduce the same output; changing resolution changes the discrete simulation and therefore its result. Droplet counts scale with grid area, and travel length/brush size scale with resolution. Runtime and memory increase substantially at high resolution. The renderer may use a smaller display mesh while height exports preserve the generated data.

Meaningful automated checks cover deterministic results, distinct noise fields, nontrivial erosion, material accounting, thermal conservation, valid graph structure, selected-node preview, output-channel routing, and masks. Visual judgments about terrain composition remain a separate review task.


## Spline-based river and mountain controls (Normal Height 1.1)

A deterministic Catmull–Rom curve maps 2–24 saved control points into a tile-normalized path, keeping edits independent of the working grid resolution. The implementation rasterizes local nearest-segment distances and computes channel/ridge relief with smooth envelope functions. Each pixel receives one nearest-curve contribution to avoid repeated brush-stamp accumulation. For rivers, a downhill-constrained bed can cut through uphill terrain along the drawn headwater-to-outlet route; unchanged far terrain and no-deposition behavior are tested. The heightfield then passes into the existing droplet hydraulic and thermal stages; there is no claim that the spline path is the result of a fluid-grid watershed solve.
