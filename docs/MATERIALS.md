# Procedural PBR material studio

Normal Height can turn a single evaluated terrain graph into a coordinated set of physically based material textures. The material model is deliberately **separate from heightfield generation**: editing snow, rock, surface moisture, or microdetail does not rerun hydraulic erosion.

## Author

1. Build a terrain in the normal graph.
2. Open **Scene** in the right inspector. Under **PBR material studio**, choose a biome (Alpine/temperate, Arid/desert, or Volcanic) and adjust the snow-line (fraction of local height range), exposed-rock slope, moisture, detail scale in meters, microdetail depth, and cavity AO strength.
3. Select **PBR** in the 3D Display panel. The mesh uses sRGB base color and separate linear roughness, occlusion and micro-normal maps. Clay, alpine vertex colors, and height previews remain available.
4. Switch to **2D map** and select Base color, Roughness, Occlusion, Material weights, **Rock coverage, Soil coverage, Vegetation coverage, Snow coverage**, Curvature, or ORM to inspect the exact worker-produced channels. Individual coverage views are opaque grayscale (black 0%, white 100%) with an exact percentage on pixel hover; all four are derived directly from the exported RGBA splat.
5. Choose **Export maps → Complete PBR material set (ZIP)** and a resolution.

Existing \`.nhterrain.json\` files remain valid. The optional \`surface\` project property uses the original v1 project format and is validated on import.

## Maps in a PBR ZIP

| Suffix | Encoding / channels | Intended usage |
| --- | --- | --- |
| \`-height16.png\` | 16-bit grayscale, min/max remapped | Displacement; reconstruct physical meters using JSON metadata |
| \`-basecolor.png\` | 8-bit RGBA, sRGB | Unlit albedo without AO or sunlight |
| \`-normal-gl.png\` | 8-bit RGBA normal, +Y green | Low-resolution/non-displaced flat meshes with terrain + micro normals |
| \`-normal-dx.png\` | 8-bit RGBA normal, -Y green | DirectX-style tangent map; G = 255 - OpenGL G |
| \`-detailnormal-gl.png\` | 8-bit RGBA normal, microdetail only | Physically displaced meshes; avoids doubling the large-scale terrain normal |
| \`-roughness.png\` | 8-bit linear grayscale (stored in RGB) | Standard PBR roughness; wet areas become smoother |
| \`-ao.png\` | 8-bit linear grayscale (stored in RGB) | Approximate terrain local-horizon/cavity occlusion |
| \`-metallic.png\` | 8-bit linear black (stored in RGB) | Natural soil, stone, snow, vegetation are non-metals |
| \`-orm.png\` | R AO, G roughness, B metalness, A 255 | glTF-style packed texture |
| \`-splat-rgba.png\` | R rock, G soil, B vegetation, A snow; sum 255 | Layer blending / masks for landscape materials |
| \`-curvature.png\` | 8-bit linear grayscale; ~128 neutral, low concave, high convex | Edge wear / cavity material authoring |
| \`-unity-hdrp-mask.png\` | R metallic, G AO, B detail mask (full 255), A smoothness | Unity HDRP mask layout |
| \`-material-metadata.json\` | JSON | Map conventions, scale, physical dimensions and authoring parameters |
| \`.nhterrain.json\` | JSON | Exact reproducible terrain graph and material settings |

PNG rows begin at the north edge of the tile and continue toward the south; columns increase east/right. Export choices are 256, 512, 768, 1024, and 2048 pixels; device-memory preflight may restrict large PBR bundles. The original normal and diagnostic export options are still supported separately.

**Color spaces:** Source palette colors are decoded to linear reflectance, blended in linear light, then encoded as sRGB once. Set base color to **sRGB** and all other channels to **Non-Color / Linear**. Never apply sRGB conversion to normal, roughness, AO, metallic, height, or weight data. Metallic is zero for the included organic/geological materials.

**Normal maps:** Normal exports use physical terrain dimensions, not viewport exaggeration. The combined normal is appropriate when the 3D mesh lacks the matching displaced geometry. If your mesh already reproduces the heightfield surface normals, use the **detail-normal** instead. DirectX flips only green relative to OpenGL; confirm any engine's tangent-space and UV conventions.

**Weights:** The splat file's alpha is data for snow, **not** transparency. The 2D map visualizer shows an opaque interpretation so that snow weight remains visible.

## What the generator does and does not do

The material pipeline deterministically combines physical terrain slope, aspect, elevation, curvature, water-flow visits, erosion wear and deposition with seeded coherent spatial detail. It derives rock/soil/vegetation/snow weights, color, roughness, signed curvature and local multi-radius cavity occlusion. All maps share the same input grid and remain reproducible from the saved project.

### Geomorphology-driven layering (material algorithm v2)

This stage is a **terrain interpretation**, not four elevation ramps:

- **Physical gradient and aspect:** central differences use `heightScale / (worldSize / (resolution - 1))` to obtain slope in degrees and determine the north/south exposure proxy. The same physical terrain has the same slope at different export resolutions.
- **Valley / ridge position:** symmetric bilinear elevation samples at **50, 150 and 425 meters** are compared with the tangent plane at each pixel. Positive residuals indicate locally concave bowls/channels and negative residuals indicate exposed crests. A sloping plane has zero residual; incomplete border pairs are excluded. The exported curvature map represents this signed, multiscale landform value (128 is approximately neutral).
- **Deposition vs. erosion:** positive erosion and deposition diagnostics are scaled by the approximate **90th percentile of each field's non-zero values**, so a fixed 0.016-unit cutoff does not silently determine whether an entire landscape is bare rock or soil. These are *relative* solver signals, not calibrated sediment depths.
- **Substrate evidence:** steepness, convex ridges and erosion wear expose rock. Gentle or concave slopes and deposition retain soil. Vegetation requires soil, a suitable elevation range and a moisture-supported biome; runoff and concavity modulate surface wetness. Substrate scores are normalized first, and retained snow occupies a fraction of that mixture. The exported RGBA splat always sums to 255.
- **Snow placement:** the authored relative snow line establishes the altitude envelope; slopes too steep for stable coverage and convex wind-scoured ridges retain less snow, while concave and north-facing shelves retain more. This is a *heuristic*, not computed sun-hours or a snow-transport simulation.
- **Material-specific procedural signals:** coherent fractures and geological bedding only affect exposed rock; transported-soil grain, vegetation patchiness and snow drift/crust have distinct signals. Each signal participates consistently in the material's **linear-light albedo**, **roughness** and **micro-height** so cracks are not just dark paint. Bedrock fracture fields are evaluated **triplanarly in world XYZ meters**, weighted by physical surface normals; this reduces sideways stretching on steep faces even in the exported heightfield-aligned UV textures. The frequency guard additionally considers local surface-arc distance, not just horizontal grid spacing. Bedding thickness and fracture spacing are physical meters, exposed as editable Scene controls.

The renderer and exported maps use the same worker-synthesized material buffers. At a source resolution unable to resolve a wavelength, that contribution fades by a smooth grid-spacing guard rather than aliasing into a plausible-looking but false frequency. The main material controls remain **snow-line fraction**, **rock-exposure slope**, **environment moisture**, **microdetail wavelength/depth**, **AO strength**, plus the new **rock bedding separation** and **fracture spacing**. Project v1 files still open; both new controls are optional and have validated defaults.

**Interpretation boundaries:** the erosion channels are generated by an artistic particle solver. There is no absolute geographic altitude, lithologic field survey, soil-depth model, radiation/weather solver, river-basin groundwater calculation or realistic snowpack time evolution. The north-facing proxy assumes northern-hemisphere conditions. Color palettes remain authored sRGB references rather than measured spectral albedos. The physical meter scales constrain the *computation*, not the provenance of geology.

It is an artist-directed **100% procedural foundation**, not a calibrated geological/soil classifier. Flow and sediment diagnostics are heuristic weights rather than absolute physical measurements. AO is **not** a ray-traced bake; it uses a plane-corrected local horizon approximation. The three biome palettes are authored starter values, **not** measured albedo from a specific real location. The preview still uses whole-tile UVs for its baked maps, although rock joint detail is evaluated from triplanar world-space coordinates during synthesis. Close-up procedural microstructure now uses 3D world-space sampling directly in the fragment shader. A general streamed 4K/8K material system, full lithology-aware per-fragment procedural shading in external engines, and non-heightfield 3D overhang materials remain future improvements.

### Permanent constraint: no external material inputs

Normal Height must **never require scanned/photogrammetry inputs or any external source PBR maps**. There will be no material-map upload workflow, paid/free asset library, bundled scan pack, or dependency on fetching images. All albedo, normals, roughness, cavity/AO, masks, and detail-height signals will be authored within the app from the terrain/erosion data, deterministic procedural fields and user-controlled parameters. Generated exports for Blender, Unreal, Unity and other tools remain the goal.

To improve close-up fidelity procedurally, develop a material-specific layer stack: fractured and stratified rock (domain-warped ridges, Voronoi cracks), sediment and soil granules, dune ripples, snow crust/drifts, and vegetation-density breakup. Each feature should influence albedo, micro-height/normal and roughness **coherently**. Implement physically scaled procedural detail, multiple frequencies, anisotropy, height-aware blending, triplanar projection on cliffs, and distance-aware antialiasing to prevent texture swimming, repetition or stretching. This work is tracked in [issue #7](https://github.com/dovvnloading/Normal-Height/issues/7).

There is a real sampling limit: a 2K map spanning kilometers cannot encode centimeter-scale geometry. The correct solution is **procedural surface detail evaluated at finer physical scale in the renderer or at target export resolution**, paired with truthful metadata and optional streamed/high-resolution generation—**not** a requirement for externally sourced textures. Higher-resolution export engineering is tracked in [issue #8](https://github.com/dovvnloading/Normal-Height/issues/8).

## Validation

Run \`npm test\`, \`npm run build\` and \`npm run test:e2e\`. PBR-specific unit tests verify deterministic output, map alignment, unit length/normal conventions, flat-surface behavior, packed channels, project compatibility, and ZIP content. The full export encoder runs in a separate cancellable Web Worker to avoid blocking the editing interface.


### Live 3D near-field surface detail (display-only)

The Scene inspector offers **Live close-up microdetail** (on by default). It has a
different job from the downloadable PBR maps: the Worker computes material
coverage, rock exposure, snow, soil, slope and macroscopic texture at the exact
heightfield grid resolution. The **fragment shader** then adds finer shading
only when close enough to see it, without changing or inventing terrain
geometry:

- The entire added signal is sampled in **world-space XYZ meters** at scales
  derived from the authored `detailMeters` control. Coherent 3D noise does not
  stretch on a nearly vertical cliff or drift as the camera moves.
- Four material-specific height/color/roughness responses use the **same
  calculated splat weights** as the 2D material preview. Narrow rock-joint
  recesses, soil grain, heterogeneous vegetation and restrained snow crust
  alter albedo (in linear light), roughness and micro-normals together.
- Screen-space derivatives attenuate frequencies that exceed the pixel
  sampling limit. A camera-distance preflight disables the shader's extra
  work altogether at ordinary full-tile zoom; there is no scene-wide
  high-frequency checkerboard or shimmering.
- The shader modifies the existing **MeshStandardMaterial** BRDF rather than
  replacing its lighting, AO, environment maps, terrain normals or shadows.
  Geometry and 16-bit height exports are unchanged.
- There are still **three GPU PBR textures**. During *preview only*, spare
  channels encode rock/soil in packed AO+roughness B/A and vegetation in the
  detail-normal alpha. Snow = 1 - other three layers. The worker's ordinary
  `splat-rgba` remains independent. **Exported ORM still has metallic=0,
  alpha=255**, and exported detail normals still have alpha=255. Never use
  these specially packed preview images as standard glTF/Unity assets.

**Preview versus export:** Subpixel procedural shading is not baked into
`-basecolor.png`, `-roughness.png` or `-detailnormal-gl.png` at a resolution
that cannot encode it. The export remains a reproducible physically scaled
representation of its requested grid. For equivalent close-up detail in
another renderer, that renderer must evaluate comparable physical-frequency
procedural shaders or use a sufficiently high resolution/streamed material
layer. The on/off control is a local View preference, not part of the
portable terrain project, to avoid changing exported geometry or maps.

### Follow-up QA and preview performance

The 3D PBR preview now updates the existing four WebGL DataTexture objects in place when the texture dimensions and color spaces are unchanged. This reduces GPU allocation churn during biome and surface edits. The underlying synthesized RGBA data still comes from the worker and is shared between 2D/3D consumers; the original erosion field is not regenerated.

High-resolution browser acceptance is intentionally split from routine CI: the opt-in PBR workflow performs a **real 2048 × 2048 material ZIP export** with a simulated adequate device-memory hint, decodes the actual 16-bit height and representative RGBA maps, and checks GL/DX normal conventions and channel dimensions. The routine workflow still checks the low-memory **2K rejection before any Worker starts**. A device-memory hint is only a preflight input, **not** a simulated physical RAM limit or a promise of success on every GPU. Performance and peak-RSS profiling on actual low-memory devices remain outstanding.

## Repair notes: material scale, caching and export safety

New badlands and volcano scene presets initialize arid and volcanic procedural materials; other presets initialize alpine. Switching presets starts a new scene with new material defaults, while importing a previously saved project preserves its surface overrides. A legacy project without explicit surface settings is saved with its resolved defaults.

Microdetail frequency is specified in physical meters. Wavelengths that cannot be resolved at the selected grid spacing fade out instead of being silently scaled up. The approximate AO samples at 50 m, 150 m and 425 m, using fractional-pixel interpolation at different resolutions.

Live 2D and 3D PBR previews request the same cached material result from a cancellable Web Worker. A stale worker result is never painted over a more recent change; editing materials does not rerun erosion.

The PBR ZIP memory preflight estimates peak allocations (including temporary PNG/ZIP and worker buffers) against a conservative device-memory budget before running the export terrain simulation; the encoding Worker also enforces it. A 2K request may be rejected on lower-memory or unidentified devices. This is a heuristic, not a guarantee of peak RAM: real-device profiling and streaming 4K/8K exports remain open work.

Export metadata now includes resolved, versioned surface parameters, per-map color spaces and channel semantics, exact OpenGL/DirectX normal orientations, and physical AO sampling radii. The material ZIP includes a reproducible project with the resolved surface values.

## Verified performance/QA improvements (2026-11-10, #10 and #17)

- The terrain's 3D preview now uploads **three PBR textures**, not four: albedo (sRGB), packed AO in red/roughness in green (non-color), and detail-only normals (non-color). Three.js samples the documented AO/red and roughness/green channels from the **same** GPU resource. The full-resolution exported maps and physics data remain unchanged.
- Real accelerated browser profiling uses a GitHub-hosted Apple Silicon macOS runner and asserts that WebGL reports **ANGLE Metal / Apple Paravirtual**, not SwiftShader. In the first verified run, rapid 512² edits measured **66.7 ms maximum frame gap**, and 1024² edits **83.3 ms**. Initial PBR first-render wall times were **2.9 ms** and **11.2 ms** respectively. Worker synthesis took 0.99–1.52 seconds **off the UI thread**. These are CI measurements, not guarantees for every consumer GPU.
- The reproducible fixed-studio-light 512² 3D PBR golden records the actual canvas image and compares an 8 × 6 RGB grid with a versioned reference. The recorded mean and p95 color errors were both **zero** under pinned Chromium/SwiftShader, guarding major changes in terrain shading and texture orientation.
- The positive **2048² full PBR ZIP** test now runs under a verified **2 GiB Linux cgroup memory+swap cap**, rather than a simulated browser memory hint alone. A representative successful run peaked at **1,986,625,536 bytes**, with no OOM or OOM-kill events. A second scenario cancels a 2K export, observes Worker termination, and then verifies a smaller export can succeed under the same cap.
- The large verification jobs are **manual / feature-branch opt-in**, not mandatory for every routine PR. The normal CI still runs TypeScript, unit tests and standard Chromium behavior. Large PBR export failures remain possible on actual hardware with less than this measured memory footprint.
