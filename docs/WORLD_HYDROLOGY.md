# World drainage and conservative transport

World Studio includes an optional **World transport** stage after the terrain graph. It runs one bounded, rectangular CPU reference simulation, then reconstructs its terrain displacement over the graph's native world-space detail. It is an experimental artistic model, not a calibrated geophysical simulation. Existing projects leave it disabled.

The implementation is in [hydrology.ts](../src/engine/world/hydrology.ts); its integration and stage reporting are in [world/index.ts](../src/engine/world/index.ts). Tests are in [world-transport.test.ts](../tests/world-transport.test.ts).

## Spatial and execution contract

The global reference uses the selected number of samples on each axis. A 256 × 256 reference over a 4,000 × 2,500 metre rectangle has spacings of 4,000/255 and 2,500/255 metres. The two spacings remain distinct throughout flow, slope, face-width and area calculations.

Samples define vertex-centred control volumes. Interior areas are `dx * dz`; true outer-edge areas are half that amount and corner areas are one quarter. Their sum equals the exact physical domain area. Shared output borders do not introduce extra volume into the simulation.

Tiles partition the preparation of face fluxes. The solver reconciles faces in a canonical global order after all tile buckets have prepared their proposals. Every interior face is visited exactly once; the donor loses precisely the water and suspended sediment that its neighbour receives. Changing the partition size or reversing tile traversal produces identical reference arrays. Internal tile edges are never treated as outlets.

The current implementation retains the complete **bounded global reference** in memory. It is not an out-of-core solver running native erosion at the export resolution. Scratch estimates are checked before allocation; 1024² World transport exceeds the configured 128 MiB reference budget and is rejected. Use a smaller global reference resolution for that stage.

## Global drainage analysis

A deterministic priority flood establishes depression-fill elevations, a receiver tree, basin labels and contributing area in square metres. Equal priorities use the global sample index as a stable tie breaker. Open domains seed only their actual perimeter; closed domains use their single lowest sample as an internal terminal sink. Every receiver chain terminates, and contributing areas account for fractional edge/corner control volumes.

This routing tree is an **analysis product**. Hydraulic transport follows the instantaneous terrain-plus-water surface gradients, rather than forcing water to follow the receiver tree. The priority flood does not silently raise the authored terrain.

## Water and sediment exchange

Each iteration adds rainfall depth multiplied by physical control-volume area. For a shared face, the provisional signed water volume is:

```text
conductivity * (surface_i - surface_j) / centre_distance * face_width
```

Here, `surface = terrain elevation + water volume / area`. Hydraulic conductivity is an artistic parameter measured in square metres per iteration. The calculation therefore produces cubic metres per iteration.

The donor's total proposed outflow is limited by the water it actually contains. Suspended sediment follows the identical scaled water links, using the donor's pre-exchange concentration. Water and sediment changes are staged and applied simultaneously; the order in which neighbouring cells are visited cannot change which state they read.

For open domains, true perimeter faces drain against the local boundary terrain elevation. Closed domains have no boundary water or sediment export. Evaporation removes water after transport and leaves suspended solids in the domain.

Transport capacity is an artistic function of water volume, outgoing discharge and local downhill slope. When capacity exceeds the suspended volume, the erosion fraction transfers material from the finite mobile cover to suspension. Otherwise, the deposition fraction transfers suspended material back to terrain. The initial cover is inside the original surface; it does not add elevation. Soil depth zero prevents erosion and thermal removal from the initial surface.

Thermal relaxation operates on the same global neighbour relationships. It proposes transfers only where height differences exceed the specified talus angle, limits donors to their available cover, and applies equal/opposite solid transfers. Thermal material stays inside both open and closed domains; boundary export refers specifically to water-borne suspended sediment.

## Settings

| Setting      | Default | Interpretation                                               |
| ------------ | ------: | ------------------------------------------------------------ |
| Enabled      |     Off | Explicitly opt into the post-graph stage                     |
| Iterations   |      24 | Synchronized global exchange steps; allowed 1–128            |
| Rainfall     |  0.08 m | Depth added per iteration                                    |
| Evaporation  |    0.02 | Fraction of remaining water removed per iteration            |
| Conductivity | 0.35 m² | Provisional hydraulic conductance per iteration              |
| Capacity     |     1.5 | Artistic suspended-material capacity coefficient             |
| Erosion      |    0.35 | Fraction of the capacity deficit supplied by available cover |
| Deposition   |    0.30 | Fraction of excess suspended material deposited              |
| Soil depth   |     3 m | Initial finite erodible layer below the original surface     |
| Talus        |     38° | Thermal-transfer threshold                                   |
| Thermal      |    0.12 | Fractional thermal relaxation strength                       |

These settings specify a reproducible numerical model. They do not define a calibrated number of years, natural rainfall event, lithology or sediment grain distribution.

## Conservation ledger

`transportBudget` reports actual reference-grid measurements in cubic metres:

- rainfall, evaporation, exported water and final retained water;
- eroded, deposited, boundary-exported and still-suspended sediment;
- thermal material transferred internally;
- water exchanged across the configured simulation bucket boundaries.

The water residual is `rainfall - evaporation - boundary export - final water`. The solid residual is measured from the actual physical terrain-volume change plus still-suspended and boundary-exported sediment. It therefore includes roundoff in the stored terrain updates, rather than checking only counters that were incremented together.

Tests exercise open and closed sloped valleys, a closed basin, shared faces, reversed traversal, different bucket sizes, finite cover, cancellation and zero-effect identity. Synthetic fixtures require an absolute solid residual below 1e-7 m³ and a water residual below 1e-12 of added rainfall. The full World graph reconstruction fixture uses a 1e-4 m³ absolute reference-ledger bound.

The ledger describes the coarse simulation. Fine-grid reconstruction, Float32 storage and a different output grid may change the integral of the exported surface. The exported map's resampled cut/fill must not be presented as the solver's conservation ledger.

## Preview, reconstruction and exports

The graph is sampled once over the full domain at the selected reference resolution. The model produces a displacement relative to that input. World tiles and ROI requests reconstruct that common displacement over their native input field. This preserves newly sampled source detail and prevents each export tile from inventing a separate watershed.

The transport flow channel is accumulated transported water volume at reference resolution, normalized once over the whole domain for display/export. The displayed 0–1 flow map is a diagnostic weight, not discharge in cubic metres per second. Wear and deposition are converted back to the graph's normalized height units before combining with upstream channels.

Intermediate and mask previews show their authored branch **before** optional post-graph transport. Named mask exports are never treated as terrain elevations or eroded. The stage manifest records its actual reference spacing and the independent conservation ledger.

Periodic boundaries are not implemented for this transport reference and are rejected explicitly. Native World noise, remap, terrace, blend, warp and slope-mask sampling can use periodic domains when the global transport/legacy stages are disabled. Legacy global mountain, spline and erosion stages retain their own boundary rules and square-domain requirements; enabling World transport does not retrofit those algorithms.

## Reproduce the numerical report

```bash
WORLD_REFERENCE_REPORT=1 WORLD_REFERENCE_REPORT_DIR=docs/benchmarks \
  npx vitest run tests/world-reference-report.test.ts
```

The report records three actual CPU runs at 64², 128² and 256² for both open and closed boundaries, including runtime/CPU, source hashes, physical spacing, output hashes, timings and every conservation counter. It is skipped during routine unit testing. These measurements establish reproducibility and reference cost; they are not browser responsiveness, GPU speedup or physical-validation evidence.
