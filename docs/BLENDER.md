# Blender World bridge

The Blender bridge imports the World export contract into editable terrain meshes and packed materials. The baseline qualification uses **Blender 4.3.2**, its installed Python 3.13.5 / NumPy 2.2.4, and actual archives produced by the Normal Height CLI. This qualification does not change the Unreal or Unity profiles' external import status.

## Install and import

Run these commands from the repository after `npm ci`:

```sh
npm run package:blender
```

This creates `dist/normal-height-blender.zip`, an installable legacy add-on containing only `normal_height_world/__init__.py` and its bounded archive decoder. In Blender's Preferences, use **Add-ons → Install from Disk**, choose that ZIP, and enable **Normal Height World**. The importer appears under **File → Import → Normal Height World (.zip)**.

Export a World archive from the application or the CLI. A representative delivery command is:

```sh
npm run nh -- build landscape.nhterrain.json \
  --out landscape-blender.zip \
  --samples 1025x1025 --tile-intervals 256 --format raw32 \
  --maps basecolor,orm,detailNormalGL
```

The height map is always included. `raw32` retains Float32 physical elevations; `png16` and `raw16` are also supported and decode with the single elevation range recorded in the manifest. Use a smaller region or lower sample count when a project exceeds the bridge's mesh budget.

Import creates one new collection with one independently editable mesh and material per terrain tile. The existing scene's objects, selection, active object, world, unit display, and meters-per-unit setting are preserved. Geometry is already displaced; do not add a second terrain displacement modifier from the same height map.

## Coordinate and shading contract

| Export data                                          | Blender interpretation                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| World east / +X                                      | Blender +X                                                                                         |
| World south / +Z                                     | Blender −Y; Blender +Y is north                                                                    |
| Physical elevation in meters                         | Blender +Z, divided by the scene's meters-per-unit scale                                           |
| Tile origin                                          | Object translation; vertices use coordinates relative to that tile and a common elevation anchor   |
| Shared border samples                                | Duplicated vertices with matching physical positions; no welding or decimation is silently applied |
| `basecolor`                                          | Packed image marked **sRGB**, connected to Principled Base Color                                   |
| `orm`                                                | Packed **Non-Color** image; green → roughness, blue → metallic                                     |
| `orm` red                                            | Preserved AO data, available on the Separate Color node; not multiplied into material reflectance  |
| `detailNormalGL`                                     | Packed **Non-Color** tangent normal map applied to displaced geometry                              |
| `normalGL` / `materialNormalGL` / `materialNormalDX` | Validated if present, but not applied on top of the geometry's existing macro slopes               |

Each sample maps to the corresponding exported pixel center, including both duplicated tile endpoints. V points north and correctly flips the top-first image-row convention into Blender UV coordinates. Textures use linear interpolation and extend at tile boundaries. RGB channels stay separate from coverage/alpha semantics; no splat alpha is treated as transparency.

The bridge computes physical height gradients once over the complete admitted export region, then assigns those normals to the tile meshes. Internal tile boundaries therefore use the same neighbors instead of clamped per-tile derivatives. Blender encodes custom corner normals internally; qualification measures the resulting angular error rather than claiming bit-identical stored normal vectors.

All imported textures are packed directly from validated PNG bytes in memory. Archive members are never extracted. The `.blend` also stores the manifest and portable project as JSON text datablocks with execution disabled. The source archive can be moved or removed after saving the `.blend`.

### Large coordinates and elevation datums

**Rebase origin** subtracts the export's east/south origin and minimum elevation, placing the mesh near Blender's scene origin. The exact physical offset is retained on the collection in `nh_coordinate_offset_m`, together with the source origin, sample spacing, and meters-per-unit conversion.

Without rebasing, the bridge rejects horizontal translations whose estimated Float32 spacing could consume a quarter of a sample interval. It also rejects an elevation translation whose estimated Float32 error exceeds the largest of 1 mm, one hundred-thousandth of a horizontal sample interval, or the source 16-bit height quantization step. These checks prevent an apparently successful import from silently losing a large datum's vertical detail. They do not add precision absent from the exported source values.

## Headless use

Add `integrations/blender` to Blender Python's module path, then use the same implementation as the UI:

```python
import sys
sys.path.insert(0, "/path/to/Normal-Height/integrations/blender")
from normal_height_world import import_world

result = import_world(
    "/path/to/landscape-blender.zip",
    rebase_origin=False,
    max_vertices=2_000_000,
)
print(result.collection.name, len(result.objects))
```

Run scripts with Blender's `--python-exit-code 1` option so a failed assertion or import produces a failing process exit code. `import_world` returns the new collection, its objects, the validated archive data, meters-per-unit scale, and retained coordinate offset.

## Admission, integrity, and rollback

The importer deliberately qualifies a bounded mesh workflow:

- At most **2,000,000 vertices including duplicated tile borders**.
- At most **512 MiB of declared expanded archive data**, 64 MiB per entry, 8 MiB for the manifest, and 32 MiB for the portable project.
- At most **8,192 members**, with a bounded central directory inspected before Python constructs its ZIP metadata objects.
- ZIP stored/DEFLATE entries, RAW16, Float32 RAW, and non-interlaced grayscale16/RGBA8 PNGs. All five PNG row filters are supported. Split archives and ZIP64 are rejected.

These are admission limits, not measured peak Blender memory guarantees. Building mesh connectivity and shader images can consume substantially more memory than the source archive. The bridge does not yet stream unbounded Worlds into a Blender scene or automatically decimate an oversized project.

Before creating Blender data, it checks safe paths, duplicate entries, encryption and symlink flags, every ZIP CRC, every declared per-map size/CRC, the manifest and project schema relationship, physical spacing/origins, PNG chunk CRCs and bounded decompression, complete tile coverage, finite Float32 values, and exact shared height samples. Unknown extra members are rejected. A corrupt DEFLATE payload becomes a normal recoverable import error.

Construction tracks every newly created object, mesh, material, image, text, and collection. If allocation or construction fails, those new datablocks are removed. The collection is attached to the scene only after construction is complete. This rollback is exercised after real geometry and packed images have already been allocated, as well as on preflight corruption failures.

## Reproduce qualification

```sh
npm run test:blender
# Optional executable and evidence directory:
NH_BLENDER_PATH=/path/to/blender npm run test:blender -- /path/to/evidence
```

The runner builds an asymmetric 960 × 640 m source with a 33 × 25 sample lattice and nonzero east/south/elevation origins. The actual CLI creates and verifies four tiles, including partial southern tiles, in all three height formats. The installed Blender imports each archive and measures coordinates, height values, cross-tile borders, custom normals, UV registration, texture pixels, color spaces, and material connections.

The suite also exercises all five PNG row filters, decompression/entry/vertex budgets, inconsistent origins, missing tiles, changed shared heights with valid CRCs, unsafe member paths, corrupt DEFLATE, post-allocation rollback, and a large elevation datum that must be rebased. It saves a `.blend`, makes the original World ZIP files unavailable, opens that `.blend` in a **second Blender process**, verifies packed pixels and geometry against recorded SHA-256 signatures, and renders again.

Evidence includes `qualification-initial.json`, `qualification-reopened.json`, the three CLI build reports, `qualified-world.blend`, and actual CPU renders before and after reopening. The fixture is an analytical integration test, not a terrain-art quality benchmark or a measurement at the two-million-vertex limit.

The implementation was checked against the installed Blender 4.3.2 RNA/API for `Image.pack`, image sources and color spaces, mesh bulk setters, UV layers, custom vertex normals, Principled inputs, and add-on registration. Relevant official API references: [Image](https://docs.blender.org/api/4.3/bpy.types.Image.html), [Mesh](https://docs.blender.org/api/4.3/bpy.types.Mesh.html), and [ImportHelper](https://docs.blender.org/api/4.3/bpy_extras.io_utils.html).
