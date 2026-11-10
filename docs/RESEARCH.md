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

## Hydraulic erosion: watershed and legacy solvers

**Why the first implementation looked artificial.** The original particle model starts individual droplets at random grid points, integrates local bilinear gradients and deposited/eroded material, then adds their footprint into a flow diagnostic. This can leave discontinuous, statistically distributed grooves rather than a consistent dendritic runoff network. Its flow signal is accumulated droplet visits, not the actual area of the upstream watershed.

**New default — connected drainage / stream power.** `hydrology.ts` implements a deterministic, seed-tie-broken **priority flood** from all four open boundaries, recording the minimum *spill surface* needed to connect every cell to an outlet. The source elevation is not filled or mutated for routing. Every receiver is earlier in the flood's topological ordering, so the network is acyclic. A second step selects the steepest *actual* downhill neighbor among earlier cells when possible, retaining the flood receiver through otherwise enclosed pits. This is an eight-neighbor (D8) grid, not continuous D-infinity flow.

For each pixel, a full uniform rainfall unit plus all upstream units is accumulated downstream (with a physical-distance transmission-loss factor from the evaporation control). With zero loss, the sum of all exported outlet contributions equals the number of terrain pixels; interior catchment area monotonically increases towards an outlet. The resulting `flow` output represents catchment-weighted runoff, logarithmically normalized for the map and graph as before.

`watershed.ts` then processes each topological level **upstream to downstream**, enforcing an approximately stream-power-based law:

`E ∝ K (A / tileArea)^0.45 max(S,0)^0.9`,

where `A` is contributing upstream raster area, `S` is the local physical downstream gradient in m/m, and `K` absorbs authored erosion strength, duration, runoff, and gravity factors. The model limits incision per pass relative to the downstream head and provides catchment-dependent channel width in physical meters. Incoming sediment limits additional incision through transport capacity; overloaded or ponded channels deposit sediment into short fans, and remaining load passes to the downstream receiver. Open outlets export remaining material. Actual Float32 elevation changes are recorded into the wear/deposition maps and balanced against escaped sediment. The surface mask changes actual bed exchange, not runoff routing; a zero mask preserves the terrain.

The multiscale option runs three full-resolution iterations from major drainage to smaller tributaries; two otherwise. It reroutes after each iteration, so changing the relief can alter subsequent flow. No random particle tracks or arbitrary 2D noise are painted onto the erosion result.

The original **Legacy · particle droplets** mode remains selectable. It still uses seeded bilinear particle advection, local carrying capacity, erosion brushes and deposition. Existing saved graph nodes with no method field now choose the watershed default, not the old particle output. Explicitly selecting `method=droplet` reproduces legacy behavior.

**Limitations (important):** this is a phenomenological, drainage-aware artistic landscape evolution model. It does *not* numerically solve Saint-Venant/shallow-water equations, full hydrographs, groundwater, real lithology stratification, bank stability or sediment grain classes, measured erodibility, calibrated rainfall units, or geologic-year time stepping. D8 flow can cause pixel-aligned patterns, and open boundaries are an assumed outlet geometry; closed or endorheic landscapes require different boundary conditions. Erosion duration and erodibility controls are dimensionless. Neither improved drainage connectivity nor strict mass accounting proves a photographically convincing valley; reference-height comparisons across contrasting landscapes remain a necessary visual QA step.

Thermal settling remains a separate conservative talus relaxation pass.

Primary implementation references and related research:

- [Barnes, Lehman & Mulla: Priority-Flood for depression handling (2014)](https://doi.org/10.1016/j.cageo.2013.04.024) — routing a DEM to boundary outlets with depression conditioning.
- [Landlab: Shared Stream Power and Erosion–Deposition](https://landlab.csdms.io/generated/api/landlab.components.erosion_deposition.shared_stream_power.html) — catchment-area and slope-dependent incision with sediment-flux feedback. Normal Height has its own artistic, bounded implementation rather than using Landlab.
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
