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

## Conservative virtual-pipe hydraulic grid (experimental)

**Motivation.** The preceding particle, D8 watershed and MFD landscape-evolution
solvers still do not reproduce the deep, feathered dendritic incision and
sediment-filled banks visible in professional heightfield erosion outputs.
The issue is partly structural: they infer rivers directly from a static
flow network and then modify height by scalar stream power, instead of
simulating moving water *and sediment* as interacting spatial fields.

**Research basis.** Unlike the earlier heuristics, this module follows the
well-described column/virtual-pipe families in
[Mei, Decaudin & Hu (2007), Fast Hydraulic Erosion Simulation and Visualization
on GPU](https://doi.org/10.1109/PG.2007.15) and
[Šťava et al. (2008), Interactive Terrain Modeling Using Hydraulic Erosion]
(https://diglib.eg.org/items/60afda0c-a666-4df8-90dd-9b80afc554c2).
Houdini [Erode 3.0](https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode)
and Gaea [Erosion2](https://docs.gaea.app/using/using-gaea/understanding-erosion/erosion_2/)
independently corroborate the importance of *iterating fluid transport and
bed exchange at several physically defined feature sizes*. Those products'
internal algorithms are not represented as available or reproduced.

**Implementation.** `src/engine/fluid.ts` supplies an opt-in **Hydraulic
fluid grid · experimental** erosion mode, leaving `Landscape evolution` as
the untouched default. Four persistent signed link-flux fields connect each
raster cell to eight neighbors (cardinal and diagonal). Each step:

1. Adds deterministic, spatially coherent rainfall.
2. Computes pressure gradients from **terrain plus water surface** and
   integrates prior-flow inertia to predict link discharge.
3. Normalizes outgoing link discharge **by the water actually available** in
   each source cell, then performs paired water and suspended-sediment exchange
   using pre-transport concentrations. This is a true advection step; it is
   not random stamped gully noise.
4. Evaluates sediment transport capacity from local water flux and physical
   slope. Transport deficits erode solid height; overload deposits existing
   suspended material onto the same elevation grid.
5. Runs conservative, simultaneous bank slippage for slopes exceeding a
   physical repose angle.
6. Drains surface water and suspended sediment at open tile boundaries;
   evaporates remaining water, and repeats.

Coarse-to-fine 128/256/512-cell stages share actual *net terrain displacement*
while retaining original source high-frequency relief. 4 fluid steps per
existing evolution-step control are used to reduce interface clutter.
At output, height, wear, deposition and flow are resampled consistently and
net eroded/deposited heights are computed from actual Float32 differences.

**Important limitations.** This is a CPU-limited shallow-water-inspired
virtual-pipe approximation. It is neither a full Navier–Stokes solver nor
equivalent to commercial Gaea/Terragen. The fluid model does not infer true
groundwater, grainsize, lithology or geologic time. Its sediment flux is
tracked at the simulation resolution, while output terrain maps may be
upscaled; the final `exportedSediment` is a reconciliation of net solid
height differences, not an independent measurement of waterborne mass.
Temporal steps are artistic and spatial rain is statistical. A 512-cell grid
cannot produce centimeter-scale ground-truth gully geometry, and a poor input
mountain remains a poor input mountain. No visual fidelity claim should be
accepted from passing tests without inspecting the actual heightfield.

**Validation criteria.** Unit tests check that a flat surface does not
manufacture channels, zero erodibility masks preserve elevations, material
changes are deterministic and statistically significant, and net solid
changes agree with signed wear/deposition. Browser QA attaches comparable
source/previous/fluid **height**, shaded relief, runoff, wear and deposition
PNGs for three terrain profiles. Tests demonstrate functional invariants,
not realistic geomorphology or matching a user-provided visual reference.

---

## Orogenic mountain source: stream graph and uplift (new)

**Problem addressed.** Previous normal-height mountains begin as a broad
Gaussian ridge envelope multiplied by fractal noise. Repeating stream-power
erosion or a simple fluid-grid filter on such a source made grooves without
producing a coherent hierarchy of *ridges between connected valleys*.
The provided real-terrain reference instead shows basin-scale organization
and multiple generations of tributaries and interfluves.

**Scientific approach.** [Cordonnier et al. (2016)](https://doi.org/10.1111/cgf.12820)
demonstrated constructing visually plausible large-scale landscapes by
coupling tectonic uplift and fluvial incision along a stream graph.
[Braun & Willett (2013)](https://doi.org/10.1016/j.geomorph.2012.10.008)
derive an efficient implicit method for stream-power landscape evolution.
[Landlab Fastscape](https://landlab.csdms.io/generated/api/landlab.components.stream_power.fastscape_stream_power.html)
documents the n=1 numerical stream-power component.

This repository now has an independently written *equilibrium source model*
in `src/engine/orogeny.ts`. It does not copy the above implementations.
It uses the existing classic mountain envelope as a **regional uplift
constraint**, but recomputes the actual mountain relief as follows:

1. Calculate smoothed uplift and a second, finer routing surface at physically
   relative tile scales. Small deterministic heterogeneity influences runoff
   routing, never a pasted-on albedo/noise pattern in the output elevations.
2. Use **priority flood** to ensure outlet-connected, acyclic drainage through
   closed basins; do not fill/raise the output DEM.
3. Perturb each graph node's *sampling coordinates* by a bounded, smooth,
   seeded field (sub-cell). Unlike an eight-direction texture raster,
   local physical distances can vary continuously and runoff can split between
   several strictly downhill neighbors in proportion to slope^3.5.
4. Accumulate upstream contributing area, then integrate the **n=1 steady
   stream-power relationship `U = K A^m S`** from outlets upstream with
   `m = 0.5`, using local uplift, contributing area and physical sample
   spacing. This produces relief *between* tributaries and a descending
   outlet-connected stream network from the same graph.
5. Reproject the irregular graph's elevation onto the output raster, apply
   only a subpixel filter for raster artifacts, robustly normalize its
   regional relief back into the authored mountain range, and blend it by the
   **Stream-network dissection** control. Zero returns the classic source
   *exactly*. The standard hydraulic node can subsequently weather or
   deposit sediment onto this source, as before.

The source is deterministic, has O(n²) scratch memory, retains physical
source detail for exports larger than the currently bounded 1024² graph,
and does not spawn more workers or introduce new GPU textures.

**Caveats.** This source is an artistic equilibrium construction, not a
geologic time integration, real tectonic crust mechanics, weather forecast,
deposition budget, or complete fluid simulation. Its stream graph retains
a square-grid neighborhood and an outlet-boundary assumption; jitter and
multi-flow reduce visible alignment but do not remove all raster bias.
A 1024² bounded graph cannot directly simulate 2K-scale microchannels;
those would need adaptive or tiled high-resolution erosion. The user-provided
reference image remains a **visual quality target**, not a training set or
mathematically exact pixel template. A green test suite is not proof of
commercial-software realism.

**Acceptance evidence.** `src/engine/orogeny.test.ts` checks determinism,
nonmutating source inputs, flat-land invariance, valid runoff, seed behavior,
and exact zero-strength compatibility. Chromium
`tests/e2e/orogeny-visual.spec.ts` saves actual native Float32 field
heightmaps and shaded relief for classic/orogenic sources and the full graph.
It measures a local fine-relief metric and requires an actual geometric
improvement over the classic source before the feature can be accepted.
Visual inspection of the generated PNGs is still required.

---

## Multi-resolution landscape evolution (experimental)

Normal Height's **Landscape evolution · multi-scale** is a new *research-backed,
independently implemented artistic model*, not the internal Terragen, Gaea or
Houdini solver. It is not a calibrated rainfall, rock or groundwater simulation.

The earlier watershed v1 improves connected flow but is restricted to a few
same-resolution passes and erodes mostly pre-existing concavities. Its maps can
show intricate dendritic drainage without actually creating deep ravines and
broad ridgelines. The appearance of the *heightfield* therefore remains the
acceptance criterion, not merely a pretty flow mask.

### Methods that informed this change

- **Terragen Heightfield Erode v3:** separate duration, erosion power, flow
  distance, deposition/deposition-rate, slope-sensitive diffusion and
  slip-at-angle. [Official manual](https://docs.planetside.co.uk/wiki/Heightfield_Erode_v3).
- **Gaea Erosion2:** large erosion-scale passes precede finer gully passes;
  downcutting, suspended load, bed load, heavy sediment and hillslope shape
  controls interact rather than being one opaque strength slider.
  [Official documentation](https://docs.gaea.app/using/using-gaea/understanding-erosion/erosion_2/).
- **Houdini HeightField Erode 3.0:** feature size is in terrain meters,
  coupled hydro/thermal steps use stream-width/bank-angle and sediment
  transport parameters, and multiple operators can be chained for distinct
  scales. [SideFX docs](https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode).
- **Landlab SPACE / Braun-Willett stream power:** established erosion/transport
  formulations use discharge and bed slope, with finite sediment supply and
  stable routed updates. [Landlab](https://landlab.readthedocs.io/en/latest/generated/api/landlab.components.erosion_deposition.shared_stream_power.html);
  [Braun & Willett (2013)](https://doi.org/10.1016/j.geomorph.2012.10.008).

### Independent algorithm in this branch

1. Build an outlet-connected depression-aware drainage graph by priority
   flood. Its surface is for *routing* only and does not fill the terrain.
2. On the resulting acyclic heightfield order, divide discharge across all
   strictly downhill earlier-ranked neighbors, weighted by physical gradient
   to power 1.7. This multiple-flow-direction step reduces D8 striping; the
   priority-flood receiver handles enclosed and flat basins.
3. Evolve the landscape in **coarse-to-fine physical scales** (128→256→512
   cells where source resolution supports them). The coarse delta is
   transferred between stages while retaining the original high-frequency
   source relief; extra export pixels are not claimed to be physical erosion.
4. Begin channel formation only where upstream contributing area exceeds a physical threshold tied to the active valley scale. Large trunk drainage develops at coarse resolution; tributaries emerge at smaller physical scales. Eroding every small accumulated flow would produce false raster grooves.
5. Recompute drainage each evolution step. Incise channel beds and retreat
   banks using contributing drainage area, slope, width in meters, and an
   explicit bank angle. Cap individual downcutting steps to preserve the
   downstream gradient and a bounded bedrock base level.
6. Transport eroded material downstream; low-capacity areas deposit shallow
   alluvial fans. Weather oversteepened hillslopes through paired conservative
   transfers, resulting in wear and deposition that modify actual height
   samples, not a color mask.
7. Return the original-grid elevation with signed landscape-evolution delta,
   and derive final net wear/deposition from the actual resulting grid.
   Exports and viewport continue to use the same computed field.

### What this does *not* yet do

- No shallow-water PDE solver, hydraulic jumps, groundwater, per-grain
  suspended vs bed/coarse loads, calibrated geological time or uplift.
- No true fractional-channel topology or river meandering. D8 remains the
  depression-basin fallback, and raster anisotropy may persist at close zoom.
- No automatic rock-type map. Artist-authored masks control relative erosion,
  and hardness is not inferred from inaccessible real stratigraphy.
- As in professional tools, good source relief matters: a simplistic broad
  mountain envelope cannot become an accurate natural orogenic province
  merely by running more erosion iterations.
- The physical width must be sampled by several raster cells. Very fine
  gullies require adequate working resolution; coarse-to-fine processing
  maintains broad-scale consistency but is not a license to invent detail.

### Validation

Unit tests target zero-loss water conservation, physical transmission loss,
determinism, non-mutating source inputs, sediment/net-height accounting, mask
invariance, and broad source-resolution consistency. Chromium visual QA
preserves for Alpine, Badlands and Volcano: original source, legacy watershed,
multi-scale evolved height, flow, wear/deposition, and signed differences.
Review the **actual heightmap** before judging the change ready; these tests
do not establish photographic realism.

## Hydraulic erosion: watershed and legacy solvers

**Why the first implementation looked artificial.** The original particle model starts individual droplets at random grid points, integrates local bilinear gradients and deposited/eroded material, then adds their footprint into a flow diagnostic. This can leave discontinuous, statistically distributed grooves rather than a consistent dendritic runoff network. Its flow signal is accumulated droplet visits, not the actual area of the upstream watershed.

**New default — connected drainage / stream power.** `hydrology.ts` implements a deterministic, seed-tie-broken **priority flood** from all four open boundaries, recording the minimum *spill surface* needed to connect every cell to an outlet. The source elevation is not filled or mutated for routing. Every receiver is earlier in the flood's topological ordering, so the network is acyclic. A second step selects the steepest *actual* downhill neighbor among earlier cells when possible, retaining the flood receiver through otherwise enclosed pits. This is an eight-neighbor (D8) grid, not continuous D-infinity flow.

For each pixel, a full uniform rainfall unit plus all upstream units is accumulated downstream (with a physical-distance transmission-loss factor from the evaporation control). With zero loss, the sum of all exported outlet contributions equals the number of terrain pixels; interior catchment area monotonically increases towards an outlet. The resulting `flow` output represents catchment-weighted runoff, logarithmically normalized for the map and graph as before.

`watershed.ts` then processes each topological level **upstream to downstream**, enforcing an approximately stream-power-based law:

`E ∝ K (A / tileArea)^0.45 max(S,0)^0.9`,

where `A` is contributing upstream raster area, `S` is the local physical downstream gradient in m/m, and `K` absorbs authored erosion strength, duration, runoff, and gravity factors. The model limits incision per pass relative to the downstream head and provides catchment-dependent channel width in physical meters. Incoming sediment limits additional incision through transport capacity; overloaded or ponded channels deposit sediment into short fans, and remaining load passes to the downstream receiver. Open outlets export remaining material. Actual Float32 elevation changes are recorded into the wear/deposition maps and balanced against escaped sediment. The surface mask changes actual bed exchange, not runoff routing; a zero mask preserves the terrain.

The multiscale option runs three full-resolution iterations from major drainage to smaller tributaries; two otherwise. It reroutes after each iteration, so changing the relief can alter subsequent flow. No random particle tracks or arbitrary 2D noise are painted onto the erosion result.

**Channel initiation and cross-section:** On a perfectly sloping plane, D8 raster routing alone produces parallel stripes of accumulated water. Blindly incising those stripes would create an obvious artificial heightmap. For this reason, the incision law is additionally weighted by physically sampled **cross-slope bank rise** on either side of the local downstream direction (approximately a 90 m scale where resolvable), and upstream contributing area can strengthen incision only where measured valley concavity is present. An analytic tilted plane has zero cross-slope bank rise and does not spontaneously acquire regularly spaced D8 trenches. Channels carve convergent valleys and larger stream stems preferentially. The bed-incision kernel is a tapered lateral profile whose peak depth does not disappear when its bank radius grows; actual removal from every affected cell is added to sediment flux, maintaining the material budget. Sediment capacity is increased with the stronger, widened valley exchange so broad channels do not immediately fill themselves.

This remains a *phenomenological* valley-confined incision rule, not measured bank mechanics or a formal shallow-water transport solution. Multi-meter valley shape depends on source relief, available samples, and authored erosion duration; at insufficient grid resolution a river narrower than one terrain pixel cannot have a faithful riverbed cross-section.

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
