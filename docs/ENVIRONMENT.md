# Atmospheric scene & expanded meadow

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
- The terrain's 512-mesh limit and worker-generated textures retain their existing budget. Cloud structure is precomputed, not fractal-noise evaluated per fragment each frame.
- Environment prefiltering is debounced, not regenerated continuously on every slider tick.
- The meadow is a static textured mesh; removing instanced grass eliminates per-blade shaders, instance buffers and wind animation draws.
- Shader overrides, geometry, textures, PMREM targets and pending timers are disposed when effects are disabled.
- Hidden tabs do not render weather. Camera edits render immediately even under a reduced animation budget.

## Verification and acceptance

- `npm test`: material and geometry math, apron edge conformance including negative relief, shared weather fields, shader injection, preview-settings sanitization, export correctness.
- `npm run build`: TypeScript and production bundling.
- `npm run test:e2e`: real Chromium/WebGL snapshots for sky and textured-ground toggles, preset looks, cloud-shadow controls, reload persistence, 2D split view, and absence of console errors. Browser evidence is uploaded as a GitHub Actions artifact.
- Visual review: ensure no hard source-tile boundary, no outer apron line, visible directional lighting at golden hour, readable overcast atmospheric contrast, no hard meadow cutoff, and no small individual grass sprites.
- Runtime review: test on actual discrete and integrated GPUs; software WebGL alone is not a substitute for frame-time profiling on consumer hardware.

### Scope boundary

The cloud shell is a lightweight procedural approximation, **not** a full ray-marched volumetric weather solver. The environment is a **terrain preview**, not a new terrain-generation stage or a game-engine world-streaming system. These limits should be preserved in feature descriptions rather than claiming that an automated test guarantees photorealism.
