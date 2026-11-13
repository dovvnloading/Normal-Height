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

## Hydraulic sediment transport, physical scale and hybrid refinement

Normal Height offers a default **landscape-evolution** solver, a separate
eight-neighbor **virtual-pipe fluid** solver, and an experimental **hybrid**
mode that runs both in sequence. These models are independent implementations
of artistic landscape evolution, not numerical reproductions of proprietary
terrain products or calibrated geologic/meteorological models.

### Landscape flow/solid transport

A priority flood from the open tile boundary produces an acyclic drainage
order. Each routed cell partitions runoff between all strictly downhill
earlier-ranked neighbors by `slope^1.7`. Flat or enclosed basins use the
priority-flood receiver. The same eight fractions are stored in a typed
array and reused in sediment advection, preventing a water network that
branches while sediments inexplicably follow a single D8 receiver.

The accumulation field represents rain-weighted source-cell contributions.
Each cell represents `worldSize² / resolution²` square meters for the
transport budget. Capacity uses a fixed 2,500 m² reference area (an artistic
coefficient) and cannot increase just because the same catchment was
resampled more finely. Surface gradients still use the distance between
elevation samples, `worldSize / (resolution - 1)`.

Channel incision depends on physical contributing area, slope, valley
confinement, and an artist-controlled strength. Sediment removal first takes
from a mobile soil/alluvium layer; remaining demand erodes bedrock with
resistance `1 - bedrockResistance`. The initial soil cover is *subtracted
from* the source surface when constructing the rock layer; it never raises
the original terrain. Riverbank geometry and paired conservative hillslope
transfers remain as before, with received material becoming mobile sediment.

Transported material deposits when the local capacity falls below its
incoming load, or reaches an open outlet. Eroded, deposited, and exported
volumes are accumulated directly from simulation-cell material exchanges.
The material is fully routed along the current topological drainage network
on each landscape-evolution cycle.

### Virtual-pipe hydraulic grid

The fluid solver is informed by [Mei, Decaudin & Hu (2007)](https://doi.org/10.1109/PG.2007.15)
and [Šťava et al. (2008)](https://diglib.eg.org/items/60afda0c-a666-4df8-90dd-9b80afc554c2).
Each iteration computes pressure differences from surface elevation plus
water depth; retains approximate directional momentum; scales all outgoing
links to available water; advects suspended solids using pre-transport water
concentration; and erodes or deposits according to slope and transport
capacity. Water and solids drain at open boundaries.

Erosion suppresses incision on a level surface, but *does not suppress
deposition*: existing suspended sediment can settle when the slope and
carrying capacity become small. Material exchanged with the terrain is
split into mobile sediment and underlying rock. Rainfall is expressed as
an artistic physical depth per evolution step (relative to the configured
terrain height scale), rather than as a fraction of initial relief.

The solver limits its simulation to 512² cells. It uses smaller substeps
where the physical grid spacing is small (up to four substeps per nominal
time step), reducing pressure/transfer steps while preserving the nominal
rainfall and boundary-loss rate. Coarse-to-fine stages interpolate actual
terrain displacement while carrying water, suspended sediment, and loose
sediment as conserved area densities. Momentum links are reinitialized at
each refinement; hydrodynamic state continuity is approximate.

### Hybrid mode and conservation budget

Hybrid runs the landscape model with a portion of the selected cycles,
passes the evolved terrain and physical mobile layer into a fluid-grid pass,
then returns the signed net elevation change relative to the original input.
It retains the fluid flow diagnostic and adds both stages' independently
measured transport budgets. It is intentionally opt-in while visual and
performance characterization continues.

Each landscape and fluid result includes `sedimentBudget` with
`erodedVolumeM3`, `depositedVolumeM3`, `exportedVolumeM3`,
`suspendedVolumeM3` and `balanceErrorM3`. The last value is

`erosion - deposition - boundary export - terminal suspended`.

Only independently measured transport fluxes enter this budget; hillslope
rearrangement is conservative and excluded from the waterborne balance.
The legacy `exportedSediment` API field still uses net signed final-grid
height differences for compatibility with existing graph statistics.
The two figures are not equivalent where output reconstruction, masks,
resampling or source-detail preservation alter the integrated result.

### Limitations and validation

This is a bounded CPU erosion approximation, not Navier–Stokes, a calibrated
sediment-size distribution, measured rock competence, true groundwater,
or geologic time. Eight-neighbor raster anisotropy, the open-tile boundary,
and the 512-cell maximum simulation grid constrain geometry. Transport
density uses equal-area finite-volume samples; the exported high-resolution
heightfield interpolates the coarse-stage displacement. This can alter
final-grid integrated terrain mass even when the **simulated transport**
budget balances. The UI's physical scales improve reproducibility, not
ground-truth realism.

Tests verify connected runoff, matching water/sediment routing fractions,
relative physical-resolution consistency, bedrock resistance, no spurious
erosion on level terrain, masks, determinism, and actual transport ledger
balance. The final acceptance gate is comparison of **heightfield geometry**
and shaded relief on diverse terrain presets. A plausible-looking water
flow mask is not sufficient.

---

## Orogenic mountain source: connected, incised valley geometry

The user-supplied real topography reference has densely branching **dark
drainage valleys** with bright high interfluves. The original Normal Height
source generated broad uplift envelopes and the early stream-power
equilibrium prototype in PR #31 produced light, raised channel-like patterns.
Simply accumulating discharge or integrating downstream stream elevation
directly into a grid did **not** construct the correct valley cross-sections.

### Method and research

- Cordonnier et al. (2016), [Large Scale Terrain Generation from Tectonic
  Uplift and Fluvial Erosion](https://doi.org/10.1111/cgf.12820), couple
  a drainage graph with uplift and construct the digital terrain via
  landform-feature kernels.
- Génevaux et al. (2013), [Terrain generation using procedural models
  based on hydrology](https://doi.org/10.1145/2461912.2461996),
  construct networks before blending and carving terrain patches.
- Braun & Willett (2013), [Fastscape erosion methods](https://doi.org/10.1016/j.geomorph.2012.10.008),
  provide a reference for upstream contributing area, flow connectivity,
  and stream-power-driven geomorphology.

`src/engine/streamCarving.ts` is our independent **procedural
feature-kernel reconstruction**, not the proprietary or exact algorithms
described above. It corrects the earlier inverted appearance by:

1. Starting from the artist's classic mountain envelope as uplift/relief
   context, while constructing a separate *routing-only* DEM with
   low-amplitude, smooth, seed-stable geological heterogeneity at
   four physical-relative wavelengths.
2. Applying the existing outlet-connected priority-flood routing,
   followed by strict downhill receiver selection where possible.
   Accumulating area **upstream to downstream** provides continuous,
   branching catchments, not disconnected droplet visitation dots.
3. Sampling subcell-jittered centerline locations to avoid uniformly
   repeating eight-way pixel angles. Every segment is connected to its
   actual downstream receiver, including through depression spill paths.
4. Carving **negative elevation** along those connected line segments.
   A narrow high-contrast riverbed and a separately tapered broad valley
   cross-section are both functions of contributing area. Overlap uses
   maximum incision, avoiding unbounded pit depth at confluences.
5. Attenuating cuts in effectively flat lowlands and at map boundaries,
   preserving the authored source for unaffected slopes. Strength zero
   reproduces the original mountain samples *bit-for-bit*.
6. Returning one physical Float32 source DEM for viewport, export, and
   subsequent sediment/fluid nodes. The dissection source does not
   fabricate material mass conservation: the standard hydraulic node
   remains a separate process for sediment removal and deposition.

This improves the valley/ridge relationship while keeping `O(n²)`
buffers; the reconstruction works up to 1024² and applies its continuous
incision delta to the original height samples at larger export sizes.

### Protecting bedrock valleys downstream

The first end-to-end 384² audit revealed a critical coupling bug: the new
source generated fine-scale incision comparable in local-height contrast to
the supplied reference, but the default Alpine/Folded-highlands downstream
warp and talus relaxation smoothed most of it away before export. The
thermal operator currently relaxes all steep *solid* height differences,
including hard-rock river walls, as if they were loose scree; this is not a
realistic regolith model. A large domain warp also resamples one-cell-wide
tributaries and blurs them before subsequent water transport.

The **new orogenic presets** therefore begin with zero additional domain
warp (the source already jitters the drainage graph), low hillslope-motion
settings in the hydraulic stage, and a restrained final thermal pass with
higher bank-repose threshold. These settings are editable: users can still
increase warp, hillslope and scree settling, and classic non-orogenic
presets are unchanged. This is an art-directed protection measure, not a
claim of physically solved sediment mechanics.

The Chromium test now captures the intermediate hydraulic node and
**asserts that the final exported terrain retains at least 55% of the
source's measured fine relief**, alongside the same signed riverbed tests.
This prevents a green unit-test suite from hiding a downstream
geometry-destruction regression.

### Bedrock-safe sediment filtering

The full-graph acceptance audit showed that lowering talus transport and
turning off the redundant post-source warp was not sufficient: Highland
source gullies retained only **49%** of fine relief after the landscape
hydraulic stage. The `Landscape evolution` algorithm was simulating
large-scale sediment exchange directly on the fine original DEM and
therefore also smoothing mature hard-rock gullies.

An explicit opt-in **Preserve incised bedrock** switch now operates at the
*final displacement-composition* step of landscape evolution.
The hydraulic transport simulation still runs normally, with physical
runoff, sediment capacity and valley-scale height changes. Only the
simulated *net displacement* is spatially filtered over roughly several
raster cells before adding it to the **unmodified original high-frequency
bedrock field**. This is a two-pass separable Gaussian; it does not
stamp extra noise or claim to create new sediment. The final actual
height differences continue to determine the reported wear/deposition
buffers. Saved projects without this flag retain their previous
behavior; it is enabled for the newly dissected Alpine and Highlands
presets, and users can turn it off to study fully mobile loose material.

This is an artistic two-material approximation. A fully physical model
would explicitly transport regolith and bedrock with separate erodibility
and armoring parameters. The user-facing choice makes that limitation
inspectable rather than hiding it behind a cosmetic map.

### Acceptance and limitations

Unit checks now require **lower river centerlines relative to banks**,
outlet-connected flow paths, deterministic seeds, non-mutating source
inputs, and stronger fine-scale relief without elevated white river
artifacts. Chromium attaches *untextured* old/new heightfields and
shaded-relief evidence; the real reference is compared at the same
resolution using multi-scale local-height statistics.

A branched river network and good frequency statistics do not prove
accurate geological formation, sediment physics or commercial-grade
quality. This is still a raster graph with subcell jitter; it is not
continuous D-infinity flow, tracked strata, groundwater or calibrated
climate/geologic time. Dense gullies in the actual source reference
may remain finer than the 1024² bounded computation. More broad uplift
variety and reference-calibrated valley depth/width distributions can
be developed without replacing this corrected valley geometry with
another arbitrary random texture.

---

## Fluvial uplands: relief formed by uplift and stream-power erosion

Compared numerically with the real DEM reference, the carved orogenic
source still read as a valley network drawn onto a smooth envelope:
fine relief was 2–3× too weak, curvature was strongly skewed toward
grooves cut into round hills (Laplacian skew +0.92 against −0.05 for the
real terrain), most of the tile was a flat lowland, and every channel was
the same thin line. In real uplands the drainage *forms* the surface. The
**Fluvial uplands** landform (`src/engine/fluvial.ts`, mountain node,
now the default landform and used by the Dissected uplands, Alpine and
Folded highlands presets) does that.

### Method

1. **Steady-state stream power on a self-consistent network.** For the
   detachment-limited law dz/dt = U − K·A^m·S (slope exponent 1), the
   steady state is S = U / (K·A^m). Route drainage (priority flood), then
   integrate that slope upstream from the outlets:
   z_i = z_receiver + U_i·d_i / (K_i·A_i^m). Reroute on the new surface
   and repeat until network and surface agree. This is the state that
   implicit time stepping (Braun & Willett 2013) converges to, reached
   in 4–14 routing passes per resolution level instead of hundreds of
   time steps.
2. **Artist control.** Uplift follows the classic range envelope; the
   erodibility K is fitted by least squares each pass so the formed
   surface tracks the envelope's large-scale shape.
3. **Coarse to fine.** Levels 128 → 256 → 512 → 1024: trunk rivers
   organise first; tributaries emerge at each finer scale.
4. **Raster-free channel courses.** Random-D8 receivers (Fairfield &
   Leymarie 1991): each cell drains to a downhill, earlier-ranked
   neighbour with probability ∝ slope^1.4, which keeps the graph acyclic
   but removes valleys locked to the eight grid directions.
5. **Channel initiation.** Below a critical catchment (Montgomery &
   Dietrich 1988), slopes are hillslopes, not channels; the area varies
   smoothly with a seeded soil/rock field, giving densely gullied
   regions beside smoother ones. Seeded lithology also varies K: hard
   rugged uplands, soft gentle basins, and perched basins behind hard-rock
   gorges.
6. **Finishing steps for real uplands** (geomorphic, not simulated
   processes):
   - *Upland accordance*: only the broad component of the surface is
     compressed above its upland level (monotonic, C¹ at the knee), so
     interfluve summits reach a common level as on an uplifted surface
     rivers are still cutting into.
   - *Interfluve height*: relative to the broad surface, only crests are
     lowered; valleys keep their full incision, so channels read as
     crisp incisions into smoother slopes, not coral-like ridges.
   - *Valley floors*: rivers above 0.2% of the tile plane flat floors
     whose width grows with √area (hydraulic geometry, Leopold &
     Maddock 1953). Each cell takes the floor of its Euclidean-nearest
     river cell, so the floor outline is a smooth offset of the river
     rather than a union of stamped discs; walls blend in through a
     concave toe slope (at physical scale, see below, they retreat
     parallel to themselves). Floors only ever lower the surface and
     tilt downstream with their river, so they still drain.

Strength (Stream-network dissection) 0 returns the classic range exactly.
Above 1024² the landscape is formed at 1024² and its relief change is
resampled onto the full-size source.

### Comparison with the real DEM reference (1024², min–max normalised)

| Measure | Reference DEM | Before: Alpine (carved) | Dissected uplands |
|---|--:|--:|--:|
| Mid-scale relief σ4 / σ8 (÷ range) | 0.030 / 0.037 | 0.017 / 0.024 | 0.028 / 0.038 |
| Fine relief σ1 / σ2 (÷ range) | 0.026 / 0.023 | 0.009 / 0.011 | 0.015 / 0.018 |
| Curvature (Laplacian) skew | −0.05 | +0.92 | +0.17 |
| Relief around channels (15-cell window) | 0.28 | 0.15 | 0.20 |
| Median elevation | 0.49 | 0.16 | 0.36 |
| Raster direction bias (peak / mean) | 1.07 | 1.14 | 1.04 |
| Flat area | 4% | 18% | 1.4% |

The full Dissected uplands pipeline runs in ~12–14 s at 1024² in Node
(~5.5 s at the default 512²), including the physical hillslope laws
below.

### Validation

Unit tests check: exact identity at zero strength; determinism and
non-mutation; zero interior pits at steady state; the fitted slope–area
exponent within ±0.12 of the configured concavity (S ∝ U·A^−m);
channels lower than their surroundings; broad structure consistent
between 128² and 256²; floodplains that only lower the surface, are flat
beside the river and leave walls beyond the floor untouched; accordance
that leaves lowlands and fine relief untouched; registry defaults equal
to engine defaults; and 2048² graphs inside the memory preflight.

### Threshold hillslopes and physical scale

The comparison above is scale-free: a normalised grayscale DEM has no
angles. Rendered in 3D at the project's real scale, the first version was a
forest of needles. On an 8 km tile with 2.4 km height scale (7.8 m per
sample), the measured median slope was **74°**, and 78% of the surface was
steeper than 60°. The old carved Alpine source was no better (median 74°).
Real mountains at this resolution have median slopes around 25–35°,
because soil and rock fail above roughly 35–45°.

The solver now knows the physical scale and applies real hillslope and
channel laws:

- **Threshold hillslopes.** Soil and rock fail above a critical angle
  (*Hillslope angle*, default 36°; harder rock may stand up to ~1.5×
  steeper, softer rock gentler). Slopes are bounded isotropically: the
  surface becomes its maximal Lipschitz minorant (Fast Marching on
  |∇z| ≤ tan θc, the surface as an obstacle), so limited slopes form cones
  whose intersections follow the terrain. The first version used a
  two-way chamfer sweep, whose eight raster directions cut octagonal
  facets and straight 0/45/90° creases into the hillshade. The bound only
  lowers; where it binds, channels steepen to carry the authored relief.
- **Soil creep.** Unchannelled slopes follow steady-state nonlinear creep
  (Roering et al. 1999), S / (1 − (S/Sc)²) = a / L, with a the specific
  catchment area and L = D/U the creep length (*Crest rounding*): slopes
  rise from zero at the divide toward Sc downslope. On hillslopes the
  catchment is dispersive (multiple flow direction, Quinn et al. 1991),
  and each hillslope cell stands above the flow-weighted mean of the
  cells it drains to. Single-direction area is a per-cell lottery on
  hillslopes; driving a transport law with it pitted the surface with
  one-cell notches.
- **Hilltops.** A steady-state hilltop has curvature U/D = 1/L and none
  can be sharper. The surface is opened (mathematical morphology) by the
  paraboloid of that curvature, an exact O(n²) operation (separable lower
  envelopes of parabolas; Felzenszwalb & Huttenlocher 2012) that rounds
  only crests, such as the crease where the two sides of a divide, formed
  along separate flow paths, meet. Alpine uses L ≈ 30 m (rock, fast
  erosion), the other presets ~100 m (soil-mantled), within the hilltop
  curvatures of 0.005–0.05 1/m measured across erosion rates (Hurst et
  al. 2012).
- **Channel heads.** Channels start where routed (concentrated) flow
  reaches a real catchment area (2 ha, not a raster cell count: 18 cells
  is 1,100 m² at 8 km but 22,000 m² at 36 km), scaled as S⁻²
  (Montgomery & Dietrich 1992; reference slope 20°) so steep faces carry
  dense chutes while gentle slopes stay smooth, and never within the
  creep length of a divide.
- **Debris-flow valleys.** Steep small channels are scoured by debris
  flows, not water: a valley starts at the hillslope angle at its head
  and flattens as A^−0.3 (Stock & Dietrich 2003) until the fluvial
  stream-power slope is gentler. Gullies begin as shallow swales and
  deepen downstream. Channels that saturated at the full hillslope
  angle merged with their slopes into planar, comb-like facets.
- **Valley walls.** Beside planed floors the undercut wall retreats
  parallel to itself just under the threshold, through a concave
  colluvial toe, instead of being cut back by the slope bound from the
  floor's outline (which scalloped and stair-stepped the walls). The
  lowered zone is relaxed by three averaging passes, which smooth the
  cell-by-cell steps of river level without raising anything.

Dense pixel-scale dissection, as in the reference DEM, is only physically
possible when each sample spans tens of meters, so **Dissected uplands is a
36 km regional tile**. Alpine uses 46° hard-rock faces and Folded
highlands 32° weathered slopes, both on 8 km tiles.

| Preset (1024², full graph) | Median slope | p90 | p99 | Hilltop curvature | Relief |
|---|--:|--:|--:|--:|--:|
| Dissected uplands, 36 km | 22° | 34° | 39° | −0.016 1/m | 1,670 m |
| Alpine, 8 km, 46° | 34° | 45° | 51° | −0.045 1/m | 1,052 m |
| Folded highlands, 8 km, 32° | 20° | 29° | 34° | −0.014 1/m | 736 m |

With the chamfer bound and single-direction hillslopes the same presets
measured 26° / 38° / 43° (uplands), 35° / 47° / 55° (Alpine) and
22° / 31° / 37° (highlands), with hilltop curvature −0.020, −0.109 and
−0.049 1/m: knife-edge crests. Before any physical scale, the uplands
on an 8 km tile measured 74° / 83° / 86°. Hilltop curvature here is the
Laplacian at 5×5 local maxima; slopes are central differences in metres.

Unit tests require the steepest neighbour difference to stay within the
hard-rock bound and the median below the critical angle at real scale,
and full crest rounding to lower hilltop curvature by more than 30%;
without a physical scale the dimensionless solver is unchanged.

### Limitations

- A steady state, not a transient history: no knickpoints migrating
  through time, no capture events, no glacial or arid processes.
- Accordance, interfluve height and valley floors are geomorphically
  motivated finishing steps tuned against one real reference, not
  simulated hillslope, lateral-migration or sediment physics. Real
  basins and lakes fill with sediment; this stage does not deposit (the
  downstream landscape node does), so flat area remains below the
  reference's.
- Random-D8 is still an eight-neighbour raster model; rivers do not
  meander.
- Hillslopes follow the creep law along flow paths plus a curvature
  bound, not a 2D diffusion solve: divides are not migrated until both
  sides stand equally high. The hilltop opening rounds the resulting
  crease.
- Straight drainage divides inherited from the coarsest level can
  survive refinement as long, straight crests.
- Pixel-scale roughness stays below the reference's, part of which is
  sensor noise and compression in that image.

References: Braun & Willett (2013),
[doi:10.1016/j.geomorph.2012.10.008](https://doi.org/10.1016/j.geomorph.2012.10.008);
Whipple & Tucker (1999), stream-power incision model,
[doi:10.1029/1999JB900120](https://doi.org/10.1029/1999JB900120);
Fairfield & Leymarie (1991), random eight-node drainage,
[doi:10.1029/90WR02658](https://doi.org/10.1029/90WR02658);
Montgomery & Dietrich (1988), channel initiation,
[doi:10.1038/336232a0](https://doi.org/10.1038/336232a0);
Leopold & Maddock (1953), hydraulic geometry,
[doi:10.3133/pp252](https://doi.org/10.3133/pp252);
Cordonnier et al. (2016),
[doi:10.1111/cgf.12820](https://doi.org/10.1111/cgf.12820);
Montgomery & Dietrich (1992), channel initiation and landscape scale,
[doi:10.1126/science.255.5046.826](https://doi.org/10.1126/science.255.5046.826);
Roering, Kirchner & Dietrich (1999), nonlinear hillslope transport,
[doi:10.1029/1998WR900090](https://doi.org/10.1029/1998WR900090);
Quinn et al. (1991), multiple-flow-direction hillslope routing,
[doi:10.1002/hyp.3360050106](https://doi.org/10.1002/hyp.3360050106);
Stock & Dietrich (2003), debris-flow valley incision,
[doi:10.1029/2001WR001057](https://doi.org/10.1029/2001WR001057);
Hurst et al. (2012), hilltop curvature and erosion rate,
[doi:10.1029/2011JF002057](https://doi.org/10.1029/2011JF002057);
Felzenszwalb & Huttenlocher (2012), distance transforms of sampled
functions, [doi:10.4086/toc.2012.v008a019](https://doi.org/10.4086/toc.2012.v008a019).

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
