# Procedural PBR material studio

Normal Height can turn a single evaluated terrain graph into a coordinated set of physically based material textures. The material model is deliberately **separate from heightfield generation**: editing snow, rock, surface moisture, or microdetail does not rerun hydraulic erosion.

## Author

1. Build a terrain in the normal graph.
2. Open **Scene** in the right inspector. Under **PBR material studio**, choose a biome (Alpine/temperate, Arid/desert, or Volcanic) and adjust the snow-line (fraction of local height range), exposed-rock slope, moisture, detail scale in meters, microdetail depth, and cavity AO strength.
3. Select **PBR** in the 3D Display panel. The mesh uses sRGB base color and separate linear roughness, occlusion and micro-normal maps. Clay, alpine vertex colors, and height previews remain available.
4. Switch to **2D map** and select Base color, Roughness, Occlusion, Material weights, Curvature, or ORM to inspect actual export data.
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

PNG rows begin at the north edge of the tile and continue toward the south; columns increase east/right. Map resolution is currently 256–2048 pixels. The original normal and diagnostic export options are still supported separately.

**Color spaces:** Set base color to **sRGB** and all other channels to **Non-Color / Linear**. Never apply sRGB conversion to normal, roughness, AO, metallic, height, or weight data. Metallic is zero for the included organic/geological materials.

**Normal maps:** Normal exports use physical terrain dimensions, not viewport exaggeration. The combined normal is appropriate when the 3D mesh lacks the matching displaced geometry. If your mesh already reproduces the heightfield surface normals, use the **detail-normal** instead. DirectX flips only green relative to OpenGL; confirm any engine's tangent-space and UV conventions.

**Weights:** The splat file's alpha is data for snow, **not** transparency. The 2D map visualizer shows an opaque interpretation so that snow weight remains visible.

## What the generator does and does not do

The material pipeline deterministically combines physical terrain slope, elevation, water-flow visits, erosion wear and deposition with seeded coherent spatial detail. It derives rock/soil/vegetation/snow weights, color, roughness, curvature and local multi-radius cavity occlusion. All maps share the same input grid and remain reproducible from the saved project.

It is an artist-directed **100% procedural foundation**, not a calibrated geological/soil classifier. Flow and sediment diagnostics are heuristic weights rather than absolute physical measurements. AO is **not** a ray-traced bake; it uses a plane-corrected local horizon approximation. The three biome palettes are authored starter values, **not** measured albedo from a specific real location. The current preview still uses whole-tile UVs; material-specific 3D procedural patterns, triplanar projection and 4K/8K streaming are future improvements.

### Permanent constraint: no external material inputs

Normal Height must **never require scanned/photogrammetry inputs or any external source PBR maps**. There will be no material-map upload workflow, paid/free asset library, bundled scan pack, or dependency on fetching images. All albedo, normals, roughness, cavity/AO, masks, and detail-height signals will be authored within the app from the terrain/erosion data, deterministic procedural fields and user-controlled parameters. Generated exports for Blender, Unreal, Unity and other tools remain the goal.

To improve close-up fidelity procedurally, develop a material-specific layer stack: fractured and stratified rock (domain-warped ridges, Voronoi cracks), sediment and soil granules, dune ripples, snow crust/drifts, and vegetation-density breakup. Each feature should influence albedo, micro-height/normal and roughness **coherently**. Implement physically scaled procedural detail, multiple frequencies, anisotropy, height-aware blending, triplanar projection on cliffs, and distance-aware antialiasing to prevent texture swimming, repetition or stretching. This work is tracked in [issue #7](https://github.com/dovvnloading/Normal-Height/issues/7).

There is a real sampling limit: a 2K map spanning kilometers cannot encode centimeter-scale geometry. The correct solution is **procedural surface detail evaluated at finer physical scale in the renderer or at target export resolution**, paired with truthful metadata and optional streamed/high-resolution generation—**not** a requirement for externally sourced textures. Higher-resolution export engineering is tracked in [issue #8](https://github.com/dovvnloading/Normal-Height/issues/8).

## Validation

Run \`npm test\`, \`npm run build\` and \`npm run test:e2e\`. PBR-specific unit tests verify deterministic output, map alignment, unit length/normal conventions, flat-surface behavior, packed channels, project compatibility, and ZIP content. The full export encoder runs in a separate cancellable Web Worker to avoid blocking the editing interface.
