# World Genesis

World Genesis is an opt-in geological formation stage for the World workspace. It evolves the authored terrain through a sequence of whole-domain resolutions, combines tectonic uplift with layered rock resistance and connected stream-power incision, and retains physical geology and drainage fields for inspection and delivery.

This release implements the geological erosion milestone. It builds on the durable projects, rectangular World materials, headless CLI and Blender bridge in the production foundation. It does not claim completion of the entire environment-production roadmap or independent AAA quality certification.

## Start with a complete example

Open one of these project files in Normal Height:

- [`examples/genesis-alpine.nhterrain.json`](../examples/genesis-alpine.nhterrain.json): an 8 × 8 km mountain scaffold, folded beds, uplift belt and connected incision.
- [`examples/genesis-badlands.nhterrain.json`](../examples/genesis-badlands.nhterrain.json): a rectangular 6 × 4 km plateau with thinner strata and stronger contrasts between rock classes.

Both examples use native Noise Studio sources, an open boundary and an enabled, explicitly versioned Genesis configuration. Their saved global resolution is 256 samples along the longest side. The logical World/output grid is independent of the simulation grid.

### Artist workflow

1. Enter **World → Simulate** and enable **World Genesis**. The input can be an existing procedural graph or imported heightfield. The original graph remains editable.
2. Choose **Alpine uplift**, **Layered badlands**, or **Tectonic plateau**. These presets change the geological stage. Existing graph nodes, material paint and World transport settings remain authored independently.
3. Begin with **Draft** or **Balanced** build quality. The panel shows the actual formation dimensions and physical spacing. Increase quality when the overall landform works.
4. Adjust **Peak uplift**, **Formation duration**, **Rainfall multiplier** and **Rock hardness**. Use the detailed controls for the uplift direction, strata thickness/dip/strike, folds, fault throw and hillslope diffusivity.
5. Build the overview. Inspect **Lithology**, **Hardness**, **Uplift**, **Incision**, **Drainage area** and **Channels**, alongside the existing terrain layers. These displays use the completed build; stale results remain labeled while settings change.
6. Pin a completed baseline and compare the same footprint after an edit. Crop previews sample the same prepared full-world result, so a region boundary does not become a new drainage outlet.
7. In **Deliver**, enable **Genesis geological fields** to include the six physical maps. PBR maps and terrain normals remain available in the same package. The manifest records the algorithm, settings, reference spacing, encoding and numerical report.

The **Analyze** panel reports Genesis measurements from the completed field. A larger export sample count produces denser samples of the authored terrain and reconstructed formation; it does not imply another erosion solve at that resolution.

## What controls the formation

Genesis settings are stored in `world.genesis`. Schema `version: 1` selects algorithm `world-genesis-1`. Missing settings preserve existing terrain behavior; disabled settings are retained for later edits without changing evaluated terrain. Unsupported versions and malformed settings fail validation instead of silently changing the recipe.

| Control                         | Units            | Meaning                                                                                                                                          |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Formation duration              | model years      | Total evolution time shared across refinement levels. More iterations refine the evolution steps rather than multiplying the requested duration. |
| Peak uplift                     | m                | Peak accumulated uplift across the formation. The signed fault term can also lower one side of the domain.                                       |
| Uplift axis / width             | degrees / m      | Direction and physical breadth of the uplift belt.                                                                                               |
| Incision efficiency             | 1/year           | Stream-power coefficient for fixed area exponent 0.5 and slope exponent 1.                                                                       |
| Rainfall multiplier             | unitless         | Relative runoff multiplier. This is not a measured rainfall depth or a water-volume simulation.                                                  |
| Rock hardness                   | 0–1              | Overall resistance to incision. Higher hardness reduces erodibility.                                                                             |
| Layer contrast                  | 0–1              | Variation in resistance between the four stylized rock classes.                                                                                  |
| Strata thickness / dip / strike | m / degrees      | Physical geological layering independent of export tile boundaries.                                                                              |
| Fold amplitude / wavelength     | m                | Warping of the stratigraphic coordinate.                                                                                                         |
| Fault throw / direction         | m / degrees      | Signed displacement across the fault structure.                                                                                                  |
| Hillslope diffusivity           | m²/year          | Redistribution down terrain gradients; the numerical exchange is bounded and measured.                                                           |
| Formation iterations            | iterations/level | Evolution steps per refinement level.                                                                                                            |

The lithology ordering is deliberately artistic: **0 Mudstone**, **1 Siltstone**, **2 Sandstone**, **3 Limestone**. The names identify stylized competence classes, not measured material properties, laboratory rock strengths or a particular geological formation. Rock classes influence terrain through erodibility. The existing four-substrate PBR system continues to synthesize its own rock, soil, vegetation and snow coverage; the additional geological maps can also drive custom shaders in downstream tools.

## Numerical architecture

The stage runs after the reachable authored graph and before optional World water/sediment transport. Intermediate graph previews and authored mask branches bypass both post-graph stages, so scalar mask values are never mistaken for physical elevations.

The implementation consists of a rectangular physical geology sampler, a deterministic drainage graph and a multiscale CPU evolution solver. It preserves the source terrain's small-scale residual as it moves between reference levels. Each evolution level uses the entire domain. Crops and export tiles sample the final prepared result; the engine does not independently erode tiles and hide their boundaries with blending.

### Connected drainage

Routing uses a priority-flood context with deterministic ordering and physical neighbor distances. The drainage graph carries a primary receiver and basin label for each sample, together with weighted contributing area. Open worlds use the true outer edge as the boundary; closed worlds retain an internal terminal. Internal tile edges have no hydrological meaning.

The routing spill surface is an analysis surface. Constructing it does not add the flood-filled volume to the terrain. In particular, routing a depression must not silently create material. The incision operator only removes rock where its downstream relationship permits a positive descent.

For area accumulation, runoff is divided among physically downhill neighbors that have already appeared in the priority-flood order. Each weight is proportional to `slope^1.1`, normalized over the receiving neighbors. The last receiver receives the floating-point remainder so the full area is accounted for. Flats and depressions fall back to the connected flood receiver. This reduces the directional streaking of a single-direction accumulation map while preserving an acyclic ordering. Incision still follows the primary D8 receiver; weighted contributing area can cross its basin-label boundaries, so those labels are not a partition of exclusive contributing areas.

Contributing area integrates vertex-centered control areas. Interior vertices represent a complete rectangular cell area, edge vertices half that area and corner vertices one quarter. Their sum equals the authored physical footprint. The report includes the residual between total outlet area and domain area.

### Implicit incision

The fixed-exponent stream-power model uses the form

```text
dh/dt = U - K_eff * sqrt(A) * S
```

Here `h` is elevation in metres, `U` is uplift in metres per model year, `A` is contributing area in square metres and `S` is the dimensionless downstream slope. `K_eff` includes the authored incision efficiency, rock resistance and relative rainfall. The downstream-first implicit update resolves the receiving cell before its upstream donors. Incision is bounded to avoid raising the terrain or crossing the updated receiver elevation.

This method is useful for controlled geological landform synthesis. The settings are not calibrated for forecasting a real catchment. The release has no coupled soil-cover/suspended-sediment deposition equation inside Genesis, glacier dynamics, bedload sorting or physically simulated river water surface.

### Reconstruction and accounting

The solver records uplift, rock removed by incision, hillslope redistribution, the measured hillslope volume residual and the volume change introduced by coarse-to-fine reconstruction. These quantities are reported separately. **Incised rock volume is not exported sediment volume.** A closed world does not imply that Genesis is depositing every removed cubic metre in its terminal basin.

The final World displacement is reconstructed over the source field. Consequently, the Genesis volume report describes its simulation hierarchy, and does not certify a sediment balance for a denser exported mesh. Optional World transport retains its own separate water/sediment budget and reference spacing.

Hardness and lithology are sampled from physical geology at each requested world coordinate using the reconstructed Genesis elevation and actual uplift. Lithology IDs are never bilinearly interpolated. Accumulated uplift, incision, drainage area and channel weights are bilinearly reconstructed from the reported final formation grid. Denser output can reveal finer native source/geology detail without fabricating a finer drainage simulation.

### Boundaries and reproducibility

- Open and closed rectangular domains are supported. Periodic Genesis is explicitly rejected.
- Physical X and Z distances are handled independently; changing aspect ratio does not treat diagonal distances as square cells.
- Seed, geological settings, domain and algorithm version participate in World cache identity. Changing a formation control invalidates the affected prepared result.
- Prepared evaluators own an immutable authored snapshot. Cancellation publishes no partial terrain or archive.
- Geological diagnostic arrays pass through the worker and durable preview-cache contracts together with their numerical report.
- Existing projects without enabled Genesis retain their prior evaluation path.

## Delivery contract

Height encoding remains selectable as PNG16, UInt16 RAW or Float32 RAW. Genesis maps use their own fixed encodings so physical magnitudes and categorical IDs survive export independently of tile extrema or the selected height format.

| Map            | Storage / filename                                  | Units                | Sampling                                     |
| -------------- | --------------------------------------------------- | -------------------- | -------------------------------------------- |
| `hardness`     | Float32 little endian, `hardness_x0_y0.f32.raw`     | 0–1 resistance       | Native physical geology                      |
| `lithology`    | UInt8, `lithology_x0_y0.u8.raw`                     | categorical ID 0–3   | Native physical geology; no ID interpolation |
| `uplift`       | Float32 little endian, `uplift_x0_y0.f32.raw`       | signed m             | Reference reconstruction                     |
| `incision`     | Float32 little endian, `incision_x0_y0.f32.raw`     | m of removed rock    | Reference reconstruction                     |
| `drainageArea` | Float32 little endian, `drainageArea_x0_y0.f32.raw` | m²                   | Reference reconstruction                     |
| `channel`      | Float32 little endian, `channel_x0_y0.f32.raw`      | 0–1 selection weight | Reference reconstruction                     |

RAW maps have no header. Row zero is north, X increases east and Z increases south. The `samples` pair for each tile gives the dimensions. All interval endpoints are included, so adjacent tiles duplicate identical border samples. Remove the first row/column of later tiles when assembling one raster; do not count those duplicates in volume calculations.

The optional `manifest.genesis` section includes:

- `schemaVersion`, `algorithm`, the exact saved `settings`, and `report`;
- `fieldStage: "before-world-transport"`, even when a later transport stage also modifies the delivered height;
- per-channel semantic, physical units, storage, byte order, measured range and sampling mode;
- the categorical lithology legend and explicit reconstruction description.

The reported ranges are descriptive. RAW bytes are **not** normalized through those ranges. For example, a `drainageArea` value of `400000` decodes directly as 400,000 m². A `lithology` byte of `2` is Sandstone. Read both as data textures, without sRGB conversion.

Every enabled Genesis build includes its settings and report in the manifest, including height-only builds. The portable project retains the same versioned recipe. Existing project revision, archive CRC, cancellation and atomic CLI output behavior are reused. Field values are reproducible for the same versioned recipe and sample footprint; timing measurements in a generation report can change between runs, so complete archive bytes are not claimed to be identical.

### CLI examples

Run from the repository root after `npm ci`:

```sh
node scripts/nh.mjs validate examples/genesis-alpine.nhterrain.json --json
node scripts/nh.mjs inspect examples/genesis-alpine.nhterrain.json --json

node scripts/nh.mjs build examples/genesis-alpine.nhterrain.json \
  --out genesis-alpine.zip --samples 1024 --global-resolution 128 \
  --format raw32 \
  --maps hardness,lithology,uplift,incision,drainageArea,channel

node scripts/nh.mjs verify genesis-alpine.zip --json
```

For a combined terrain/material/geology package:

```sh
node scripts/nh.mjs build examples/genesis-badlands.nhterrain.json \
  --out genesis-badlands.zip --samples 513x343 --global-resolution 128 \
  --format raw32 \
  --maps hardness,lithology,uplift,incision,drainageArea,channel,basecolor,roughness,ao,orm,splat,materialNormalGL,relief
```

Omit `--global-resolution` to use the saved 256-sample setting. The CLI uses CPU reference evaluation. The sample count and reference resolution have distinct roles. A build refuses an unsafe estimated allocation before starting; reducing output samples cannot necessarily fix an oversized global solve.

The archive verifier validates Genesis provenance against the embedded project, map descriptors, units, storage formats, exact dimensions and map coverage. It also checks finite physical values, normalized ranges where applicable and recognized rock IDs after validating file checksums. This is data-contract verification, not a claim that a particular engine imported or rendered every extra channel.

The existing Blender bridge can import the package's terrain and PBR maps. Geological RAW maps are validated optional data for custom material or analysis workflows; they do not automatically create a Blender procedural geology shader or packed image. Retain the source archive when those extra payloads are needed. The Blender qualification fixture now exercises nonzero Genesis with all six fields, PBR maps and all three height formats through real import, render, save and offline reopen. Unreal and Unity profile status remains experimental until their editor round trips are separately qualified.

## Validation and performance evidence

The meaningful regression boundaries are numerical behavior, reproducibility and delivery, rather than screenshots alone:

- zero-evolution identity and non-mutating inputs;
- deterministic receiver topology and physical contributing-area closure;
- uplift-only behavior, hardness-dependent incision, depression handling and finite results;
- rectangular geometry, boundary rules and measured numerical budgets;
- identical shared borders and matching whole-world/crop outputs;
- correct worker/cache identity and preservation of diagnostic fields;
- byte-identical geology maps across different tile partitions;
- correct physical map delivery when PBR analysis halos span several engine chunks;
- explicit units, categorical IDs, source recipe/provenance and CLI verification;
- rejection of semantic corruption even when the corrupted archive has valid CRCs.

Relevant tests are in `tests/genesis-*.test.ts` and `tests/e2e/world-genesis.spec.ts`. Run the full type/build and existing World suites when changing these contracts. A local visual preview and a small CLI package are useful additional checks; neither substitutes for these numerical tests.

A reproducible cold-run harness records source/input hashes, environment, actual
formation levels, preparation and sampling time, process peak RSS and field hashes:

```sh
node scripts/genesis-benchmark.mjs examples/genesis-alpine.nhterrain.json \
  --resolution 256 --samples 257 --out test-results/genesis-alpine-256.json \
  --fields test-results/genesis-alpine-256-fields
```

The optional fields directory contains raw before/after heightfields and diagnostic
maps plus `fields.json`, suitable for independently rendered comparisons. The input
terrain is sampled after the measured run so that comparison work does not change
the recorded timing or peak RSS. Use a new output directory per run; the harness
does not overwrite existing reports. Run separate processes for each resolution
and record repeated runs when reporting distributions.

Performance depends on the complete upstream graph, physical aspect ratio, formation resolution, iterations, optional transport and requested materials. Report warm/cold preparation separately from region sampling and archive encoding. Record exact revision, input hash, CPU/runtime, model settings, measured process memory and the reported live-data estimate. The estimate is not an operating-system memory cap. This release does not claim native 8K erosion, a GPU acceleration factor, or measured throughput on hardware that was not tested.

## Research basis and next boundaries

The implementation is an independent, bounded application of established ideas:

1. **Braun & Willett (2013), _A very efficient O(n), implicit and parallel method to solve the stream power equation governing fluvial incision and landscape evolution_.** [DOI](https://doi.org/10.1016/j.geomorph.2012.10.008) · [ETH research record](https://www.research-collection.ethz.ch/items/6c13ed83-705c-46c3-9743-d5c8f51e0d8c). The downstream implicit stream-power formulation informs the incision step; this implementation fixes its exponents and documents its own constraints.
2. **Barnes, Lehman & Mulla (2014), _Priority-Flood: An Optimal Depression-Filling and Watershed-Labeling Algorithm for Digital Elevation Models_.** [DOI](https://doi.org/10.1016/j.cageo.2013.04.024) · [author paper](https://richard.science/sci/2014_depressions.pdf). Priority-flood context informs deterministic routing through depressions without making an export tile into a watershed boundary.
3. **Schott et al. (2024), _Terrain Amplification using Multi-Scale Erosion_.** [Author project page](https://h-schott.github.io/p/mserosion/) · [DOI](https://doi.org/10.1145/3658200). Its combination of physics-inspired erosion and control at multiple scales motivates the geological amplification direction. Normal Height does not claim to reproduce the complete paper or its reported performance.

The subsequent production milestones remain explicit: conservative regional refinement with reconciled boundary fluxes; GPU-resident erosion qualified against this CPU reference; river/lake authoring and water meshes; physical climate fields and richer material layering; deterministic ecosystem scatter; and volumetric rock/cliff/cave assets. These require their own numerical, visual, performance and DCC qualification. They are not implied by exporting a denser heightfield.
