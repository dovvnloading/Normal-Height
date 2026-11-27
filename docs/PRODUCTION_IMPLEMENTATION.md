# Production implementation and qualification

This work starts from `ba4ac3ee11fa43d73b108cc79633b02f19ca1844` (the material-quality merge). It carries the prototype-to-production roadmap forward as working, testable capabilities. **Implemented capability, automated verification, application import qualification, and research completion are separate statuses.** A passing height exporter does not establish native-resolution erosion, a successful browser test does not establish every GPU's performance, and an import profile is not editor certification.

## Implemented workflow

### Durable projects and revisions

The **Projects & revisions** dialog saves multiple projects and explicit checkpoints in IndexedDB. Snapshots are addressed and checked by SHA-256; revision metadata and payloads commit in one transaction. Save conflict detection protects a project opened in two tabs. Restoring a revision first protects current work, and Undo retains the correct project identity. Retention and storage limits are explicit; saving one project does not silently evict another. A corrupt revision can be rejected while an older healthy revision remains recoverable.

See [PROJECT_LIBRARY.md](PROJECT_LIBRARY.md) for retention, browser storage behavior, recovery and the transaction tests. Downloaded `.nhterrain.json` remains the portable backup; browser persistence is not a substitute for an external copy.

### One graph validation contract

The importer, planner and editor now share graph limits, normalized handles, structural validation and cycle/input rules. Imported Blend nodes use the same default A input as evaluation. Existing diagnostic routes remain visible and survive a project round trip. Invalid project/snippet edits fail before the active graph changes.

The retained limits are **128 nodes and 512 connections**. Raising capacity requires resource qualification; this change does not silently double the supported graph size.

Selected subgraphs can be copied between projects or saved as portable `.nhgraph.json` files. Groups retain their descendants, internal connections, splines, rasters and annotations. Insertion validates the combined destination budgets, remaps identifiers and creates one undo operation. Destination seed, physical scale and material settings remain the destination's. See [GRAPH_REUSE.md](GRAPH_REUSE.md).

### World import, coast and named-mask parity

Imported rasters are sampled from their original payload in the physical World rectangle. Coastal connectivity and distances are solved once over the full domain, with physically rectangular spacing, then reconstructed over native input. They do not restart at tile boundaries. Named mask outputs preserve fixed 0–1 semantics, including bypass, and can be selected in Deliver. Imported raster content has a stable cryptographic cache identity across workers and sessions.

Coast and erosion still disclose their actual reference resolution. Sub-reference channels and islands are not created by requesting more output samples. Periodic imported rasters remain explicitly unsupported until opposite-border behavior is qualified.

### Shared physical material synthesis

`src/engine/fields.ts` defines a physical rectangular raster and canonical coordinate contract. The existing material model now accepts that contract; Terrain retains its legacy square adapter. World delivery synthesizes the same material response with whole-export reference ranges and physical analysis halos across tile boundaries. Recursive paint blending is included in the halo budget.

**Deliver → PBR material maps** includes:

| Map                | Encoding and meaning                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `basecolor`        | RGBA8 PNG, sRGB unlit reflectance                                                 |
| `roughness`        | RGBA8 PNG, linear perceptual roughness                                            |
| `ao`               | RGBA8 PNG, linear terrain/material occlusion                                      |
| `orm`              | RGBA8 PNG, R=AO, G=roughness, B=0 metallic, A=255                                 |
| `splat`            | RGBA8 PNG, rock/soil/vegetation/snow coverage; channels sum to 255; alpha is data |
| `curvature`        | RGBA8 PNG, linear signed-landform visualization                                   |
| `materialNormalGL` | RGBA8 PNG, OpenGL +Y terrain plus material-relief normal                          |
| `materialNormalDX` | RGBA8 PNG, exact green-channel inverse of GL                                      |
| `detailNormalGL`   | RGBA8 PNG, material relief relative to the terrain tangent frame                  |
| `relief`           | Little-endian Float32 RAW, signed vertical material relief in metres              |

The existing `normalGL` map continues to describe terrain geometry alone. Use `detailNormalGL` on an already displaced mesh to avoid applying the large terrain slope twice.

Saved paint remains anchored to normalized **whole-world** coordinates, including rectangular domains, masked layers, grain, Replace and Blend. It is never stretched independently to each tile. Non-finite height or diagnostic samples fail before byte conversion can conceal corruption. A material model version of 4 is now written explicitly. Old projects without a version adopt the current model; unknown explicit versions are rejected. Historical material models 1–3 are not reconstructed.

Materials currently require open or closed World boundaries. Coverage normalization is shared over the selected export region: changing the crop can change climate-dependent coverage. Very fine output over a small physical region can require a large physical halo and is rejected when it exceeds the bounded allocation contract. Close shader-only microdetail is not baked into these terrain maps.

World 3D now previews this authored material through a dedicated cancellable worker. Material-only edits reuse the retained height field; rectangular paint coordinates and texture sample centers match the physical grid. The visible renderer and camera survive completed terrain rebuilds, hidden views release their graphics resources, and a lost graphics context can be recovered. Interactive ambient occlusion is explicitly labeled as a regional approximation.

### Reliable package delivery and automation

World archives use the same compact project serializer and 32 MiB project limit as standalone saves. Preflight includes the actual project payload, imports, material halos, graph sampling chunks, archive retention and ZIP32 file-count limits. Output requests are snapshotted before asynchronous work. Shared-edge derivatives retain all legal final samples even on non-binary export grids.

The production CLI validates and inspects projects, builds packages through the same World exporter, then verifies package structure, sizes, CRCs, manifest/project agreement and tile coverage before atomic publication. It refuses to replace an existing output unless `--force` is provided. Cancellation and failure remove incomplete temporary output. Verification never extracts arbitrary paths.

```sh
npm ci
node scripts/nh.mjs validate examples/production-alpine.nhterrain.json --json
node scripts/nh.mjs inspect examples/production-alpine.nhterrain.json --json
node scripts/nh.mjs build examples/production-alpine.nhterrain.json \
  --out alpine-world.zip --samples 1024 --format raw32 \
  --maps basecolor,roughness,ao,orm,splat,curvature,materialNormalGL,materialNormalDX,detailNormalGL,relief
node scripts/nh.mjs verify alpine-world.zip --json
```

See [CLI.md](CLI.md) for argument semantics, machine-readable results and exit codes. CPU reference builds are deterministic under the documented algorithm and source revision. Byte reproducibility across different source revisions or numerical backends is not assumed.

### Qualified Blender delivery

The installable Blender bridge reads World archives directly, validates paths, sizes, checksums, PNG channels, tile coverage and shared borders, and imports physical terrain with consistent edge normals. It packs base color, ORM and detail-normal textures into the scene, uses the correct color spaces, and removes only newly allocated data if an import fails. Large horizontal or vertical translations require explicit local rebasing before Blender's Float32 placement would lose meaningful detail.

The qualification runs a real Blender **4.3.2** process for RAW32, RAW16 and PNG16 exports, renders the result, saves a `.blend`, hides the source archives, and reopens the scene in a second process. Packed pixels and geometry must remain identical. The four-tile fixture checks 884 vertices, 825 unique samples and 59 shared-sample comparisons; the measured maximum geometry discrepancy was **0.000010223 m** and maximum normal-angle discrepancy **0.02803°**. Corrupt archives and injected allocation failures must leave the existing scene unchanged. These are fixture-specific measurements, not general accuracy guarantees.

Run `npm run package:blender` to create `dist/normal-height-blender.zip`, then install it through Blender's add-on preferences. See [BLENDER.md](BLENDER.md) for import instructions, limits, rebasing and repeatable qualification. Unreal and Unity profiles remain experimental until actual editor round trips are qualified.

## Verification strategy

The initial untouched baseline passed **604 tests**, with five explicitly skipped qualification tests. New tests exercise defects and boundary contracts rather than merely reflecting implementation structure:

- Project reload and Blend/diagnostic port compatibility; cycles, duplicate inputs and group ancestry.
- Real IndexedDB transaction failure, corruption, deduplication, retention, concurrent save conflicts and blocked upgrades.
- Real browser save/restore/download, cross-tab conflict, quota injection, mobile layout and keyboard focus restoration.
- Native raster samples, rectangular coastal distances, cross-tile masks and content-identity cache invalidation.
- Rectangular material output against whole-field synthesis for every channel, including paint and normal halos.
- Actual ZIP decoding across different tile partitions; coverage alpha, normal conventions and checksums.
- Multi-megabyte compact project round trips; size/file-count rejection before output; fractional-grid outer borders.
- CLI validation, atomic publication, no-clobber, cancellation, malformed ZIPs and expanded-size limits.

The dedicated CI workflows retain numerical and browser evidence. Firefox and WebKit workflow gates exercise portable authoring/storage/export separately from Chromium/Metal GPU fidelity. A workflow definition is not evidence that its jobs passed; consult the actual run results for the commit under review.

### Local qualification results

The implementation was qualified locally on 27 November 2026 with Node 24.22.3, Chromium 158 software rendering, and Blender 4.3.2:

| Gate                                          | Observed result                                         |
| --------------------------------------------- | ------------------------------------------------------- |
| Complete enabled unit/API suite               | 692 passed; 5 intentionally skipped qualification tests |
| Production TypeScript/Vite build              | Passed; existing large main-chunk advisory remains      |
| World browser regression                      | 18 passed, one worker, no retries                       |
| Project checkpoint/recovery browser flows     | 3 passed                                                |
| Cross-project graph reuse browser flows       | 2 passed                                                |
| Blender import and offline scene reopening    | All three height formats passed                         |
| Runtime dependency audit                      | Zero reported vulnerabilities                           |
| Changed-file formatting and whitespace checks | Passed                                                  |

The Chromium runs exercise production workers and decoded package/image data. These local results do not qualify Firefox/WebKit, every GPU, the maximum admitted export size, or Unreal/Unity imports. Their dedicated CI/editor gates remain independently observable.

### Memory and performance interpretation

`WorldExportEstimate.peakBytes` is an estimate of live export allocations and retained archive data. It is **not** an OS process-memory cap. JavaScript runtime/source-loading overhead, garbage-collector timing, the renderer and GPU allocations are additional. CLI success output records elapsed time and process high-water RSS separately.

An exploratory dirty-tree 1024² Alpine build generated 64 tiles and 704 map files, verified a 21,037,044-byte package, took 45.13 seconds including CLI startup/verification, and reached 565,055,488 bytes of process RSS. Its live-data estimate was 99,107,388 bytes. This is a single CPU run, not a device-wide guarantee or a final-commit benchmark. Do not present the allocation estimate as measured memory or extrapolate it into an 8K PBR guarantee.

## Gap register

These IDs preserve the original roadmap. A status of **advanced** records shipped progress, not completion of every item in the long-term proposal.

| Gap                           | Status in this implementation                                                | Remaining exit condition                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| NH-01 Shared engine contracts | Advanced: shared graph and physical material contracts                       | General field-provider graph, incremental global-stage reuse and one complete renderer/evaluator architecture |
| NH-02 Project durability      | Implemented: local project/revision workflow                                 | Binary asset package and external/team asset management remain a separate expansion                           |
| NH-03 Reproducibility         | Advanced: material model pin, source provenance, stable raster identity, CLI | Complete per-algorithm version registry and golden migration corpus                                           |
| NH-04 World feature parity    | Implemented for open/closed imports, coast and named masks                   | Periodic raster/coast semantics and finer global simulation qualification                                     |
| NH-05 World material delivery | Implemented with bounded physical halos and saved paint                      | Large-output performance/device qualification and crop-independent global climate policy                      |
| NH-06 DCC/engine integration  | Advanced: verified archive contracts and Blender bridge                      | Real Unreal/Unity editor round trips on supported versions; other bridges                                     |
| NH-07 Compute scalability     | Advanced: bounded material sampling and headless builds                      | Native large-domain erosion, GPU residency and representative hardware benchmarks                             |
| NH-08 Geological fidelity     | Existing generators preserved                                                | Lithology, faults/folds, glacial/coastal/wind models and controlled artist comparisons                        |
| NH-09 Hydrology               | Existing conservative reference retained                                     | Connected river/lake authoring, water meshes and large-domain calibration                                     |
| NH-10 Material authoring      | Advanced: World synthesis and transferable paint                             | Arbitrary material stacks, imported PBR assets and broad biome authoring                                      |
| NH-11 Terrain sculpting       | Not implemented by this milestone                                            | Non-destructive height sculpt/stamps with World-aware edit storage                                            |
| NH-12 World viewport          | Advanced: persistent visible renderer and shared PBR preview                 | Streaming clipmap/quadtree geometry and full adaptive rendering parity                                        |
| NH-13 Graph workflow          | Advanced: consistent contracts and graph reuse                               | Versioned semantic macros, exposed parameters and multi-output build graphs                                   |
| NH-14 Designer UX             | Advanced: project recovery, delivery and graph controls                      | Broader accessibility/usability studies and workflow polish                                                   |
| NH-15 Release engineering     | Advanced: numerical, browser, CLI and DCC gates                              | Passed release matrix, owner-selected project license, supported-device policy and packaged release           |
| NH-16 Automation/SDK          | Implemented: validated headless build/verify CLI                             | Stable public plugin SDK and build-farm orchestration                                                         |
| NH-17 Ecosystems              | Not implemented by this milestone                                            | Deterministic scatter rules, asset instancing and instance delivery                                           |
| NH-18 GIS                     | Not implemented by this milestone                                            | CRS-aware GeoTIFF/EXR workflows and GIS import qualification                                                  |
| NH-19 Cinematic presentation  | Existing presentation preserved                                              | Broader capture/look-development workflows and qualified output                                               |
| NH-20 Beyond heightfields     | Research                                                                     | Overhang/cave geometry representation, authoring and export                                                   |

The remaining research/modeling and hardware/editor gates cannot honestly be marked complete because foundational code passes. The implementation is intended to make the next increments independently reviewable and testable, while retaining the working legacy numerical paths.
