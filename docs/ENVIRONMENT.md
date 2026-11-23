# Atmospheric scene & expanded meadow

## Adaptive terrain geometry and close-up fidelity

The 3D renderer uses one indexed mesh. The planner partitions the terrain into 8 to 64 tiles per side according to the tile width in meters and the authored material spacing. Each tile can refine independently to 256 segments per side. An 8 km project with 24 m detail uses an 8 × 8 grid. The 36 km Dissected uplands preset uses 32 × 32, allowing nearby ground to resolve the same features. The camera projection and distance determine where to spend the vertex budget. **Terrain mesh fidelity** caps the budget at 340,000 vertices for Balanced, 680,000 for High and 1,400,000 for Ultra.

**Sub-polygon displacement.** The material worker supplies signed vertical relief in meters and the coverage of each substrate, including painted areas. All four terrain materials use the same displaced surface. At the working resolution, the surface height in meters is the terrain elevation plus the baked relief. Where a tile subdivides below one source cell, it evaluates the seeded material fabric at the finer vertex spacing. Each level uses its own sampling footprint so that smaller features emerge as the camera approaches.

**Surface lighting.** A source-resolution slope texture carries the gradients of elevation and baked relief. Refined vertices supply the extra slope from sub-cell displacement. The combined slopes drive terrain lighting across mesh fidelities. PBR also adds close-up shading for fine surface texture.

**Prefiltered geometry.** Each coarse tile samples the combined heights filtered to its vertex spacing. The filter preserves a planar slope at the tile border. Coarse silhouettes stay stable as finer tiles resolve additional detail.

The renderer samples a monotonic bicubic Hermite reconstruction of source heights and clamps to each source cell's corner extrema to prevent ringing over steep erosion banks and authored terraces. Vertex normals still come from smoothed source-grid physical derivatives (used for shadow bias and the meadow seam). **The mesh is watertight by construction:** every vertex shared by two tiles is computed from the shared feature alone. Tile corners take the coarsest touching tile's surface; edge vertices lie exactly on the coarser side's edge polyline; transition bands toward coarser neighbours move interior vertices only. A unit test checks every shared edge of a mixed 8–64-segment plan to 1e-6.

The terrain maintains one renderable/raycastable BufferGeometry and the original PBR/lighting pipeline. Its skirt is built from the actual adaptive perimeter, and expanded ground uses the same edge samples for its first apron ring, including elevation, normals, and albedo. Shader and material texture buffers are reused when only camera LOD changes. Camera movement is debounced: triangles are rebuilt after controls settle rather than on every orbit frame. **Idle camera frames no longer recompute the LOD plan**; moving cameras use threshold hysteresis to prevent repeat allocations. Instrumentation and reproducible reference-vs-adaptive benchmarking are described in [mesh performance QA](MESH_PERFORMANCE.md). New mesh statistics (`data-mesh-vertices`, `data-mesh-triangles`, `data-mesh-max-segments`) support browser QA and performance regression checks.

**Terrain mesh fidelity** controls the 3D vertex budget. **Scene → Surface & light → Sub-polygon displacement** controls the authored relief strength and is saved with the project. Set it to 0× to inspect the underlying terrain. The 16-bit terrain height and signed material relief remain separately available in the PBR export.

The 3D preview has an optional, coupled sky/lighting and landscape-context system. These features only affect **presentation**. Terrain height samples, erosion, generated PBR maps, project graphs, and exported files are unchanged.

## Artist workflow

In the **3D terrain → Display** panel:

1. Pick **Clear day**, **Golden hour**, or **Overcast** to enable the atmospheric sky with coordinated lighting.
2. Move sun azimuth/elevation; adjust atmospheric haze, scattering, and camera exposure.
3. Tune cloud cover, shadow strength, and wind. Animated cloud silhouettes attenuate **direct** terrain/meadow sunlight, not indirect ambient fill.
4. Enable **Expand ground** for a flat, grass-textured meadow surrounding the heightmap. Adjust ground reach. The terrain tile's outer rendered material fades into the meadow instead of showing an abrupt PBR square; **no individual grass blades, sprites or tufts are rendered**.
5. Zero wind pauses autonomous weather redraws. All settings survive browser reloads using a validated, separate view-preferences key.

These controls are independent of the procedural graph and material-export parameters. **Reset display** restores defaults and disables both optional environments.

## Implementation

- `Atmosphere.ts`: Three.js analytic Sky shader; physically coordinated directional/hemisphere light and fog; separate cloud layer; debounced PMREM illumination that includes cloud radiance. Sunset/overcast presets tune sun color and fill.
- `weather.ts`: seeded periodic RGBA cloud field built once in a WebGL DataTexture. A shared density function drives both the visible cloud shell and moving ground shadows. Shadow modulation is composed into `MeshStandardMaterial` *after* physically based direct-light evaluation; indirect illumination is untouched.
- `GroundExtension.ts`: terrain-apron rings follow the heightmap boundary vertex-for-vertex, fade high-frequency edge variation into a flat meadow, and preserve a level outer pair of rings. Matched normals and the repeating procedural ground texture provide continuity, with no instanced foliage geometry.
- `TerrainScene.ts`: preview-only material crossfade in the outer tile band, shared meadow map coordinates, lazy allocation/disposal and shadow shader registration. Autonomous weather rendering adapts from roughly 24 FPS on fast GPUs to a slower cadence on software WebGL.
- `viewSettings.ts`: versioned and range-validated presentation preferences, stored separately from terrain projects, with safe corrupt-storage and private-mode fallbacks.

### Performance safeguards

- The default display keeps the neutral studio backdrop; sky/meadow allocate GPU resources only when enabled.
- Terrain mesh budgets depend on **Balanced/High/Ultra** adaptive view settings, with a hard bounded vertex count. PBR textures retain their separate worker/memory budget. Cloud structure is precomputed, not fractal-noise evaluated per fragment each frame.
- Environment prefiltering is debounced, not regenerated continuously on every slider tick.
- The meadow is a static textured mesh; removing instanced grass eliminates per-blade shaders, instance buffers and wind animation draws.
- Shader overrides, geometry, textures, PMREM targets and pending timers are disposed when effects are disabled.
- Hidden tabs do not render weather. Camera edits render immediately even under a reduced animation budget.

## Verification and acceptance

- `npm test`: material and geometry math, apron edge conformance including negative relief, shared weather fields, shader injection, preview-settings sanitization, export correctness.
- `npm run build`: TypeScript and production bundling.
- `npm run test:e2e` (after `npm run build`): optional, manually triggered Chromium/WebGL snapshots for sky and textured-ground toggles, preset looks, cloud-shadow controls, reload persistence, 2D split view, and absence of console errors. The full browser suite is **never a routine per-push CI gate**; request it from the manual Extended terrain QA workflow.
- Visual review: ensure no hard source-tile boundary, no outer apron line, visible directional lighting at golden hour, readable overcast atmospheric contrast, no hard meadow cutoff, and no small individual grass sprites.
- Runtime review: test on actual discrete and integrated GPUs; software WebGL alone is not a substitute for frame-time profiling on consumer hardware.

### Scope boundary

The cloud shell is a lightweight procedural approximation, **not** a full ray-marched volumetric weather solver. The environment is a **terrain preview**, not a new terrain-generation stage or a game-engine world-streaming system. These limits should be preserved in feature descriptions rather than claiming that an automated test guarantees photorealism.
