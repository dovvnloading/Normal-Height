"""Normal Height World import bridge, qualified with Blender 4.3.2.

Install this directory as a legacy add-on or import it from a headless script:
    from normal_height_world import import_world
    result = import_world('/path/to/world.zip')
"""

bl_info = {
    "name": "Normal Height World",
    "author": "Normal Height contributors",
    "version": (1, 0, 0),
    "blender": (4, 3, 0),
    "location": "File > Import > Normal Height World (.zip)",
    "description": "Import verified terrain tiles with physical coordinates and packed PBR maps",
    "category": "Import-Export",
}

from dataclasses import dataclass
import json
import math
from pathlib import Path
import re

import bpy
from bpy.props import BoolProperty, IntProperty, StringProperty
from bpy_extras.io_utils import ImportHelper
import numpy as np

from .archive import MAX_EXPANDED_BYTES, MAX_VERTICES, WorldArchive, WorldImportError


@dataclass
class ImportResult:
    collection: bpy.types.Collection
    objects: list
    archive: WorldArchive
    meters_per_unit: float
    coordinate_offset_meters: tuple[float, float, float]


class _OwnedData:
    """Record only newly allocated data; failure never removes a user's data."""

    def __init__(self):
        self.objects, self.meshes, self.materials = [], [], []
        self.images, self.texts, self.collections = [], [], []

    def rollback(self):
        for pool, owned in (
            (bpy.data.objects, self.objects),
            (bpy.data.collections, self.collections),
            (bpy.data.meshes, self.meshes),
            (bpy.data.materials, self.materials),
            (bpy.data.images, self.images),
            (bpy.data.texts, self.texts),
        ):
            for item in reversed(owned):
                try:
                    pool.remove(item, do_unlink=True)
                except (ReferenceError, RuntimeError):
                    pass


def _packed_image(archive, record, channel, width, height, owned):
    label = f"NH_{Path(record['path']).stem}"
    image = bpy.data.images.new(label, width=width, height=height, alpha=True)
    owned.images.append(image)
    # Source FILE must precede pack: a GENERATED source continues to expose
    # its blank generated buffer. Packed bytes need no temporary extraction.
    image.source = "FILE"
    image.filepath = f"//normal-height-packed/{label}.png"
    image.colorspace_settings.name = "sRGB" if channel == "basecolor" else "Non-Color"
    image.alpha_mode = "CHANNEL_PACKED"
    data = archive.images[record["path"]]
    image.pack(data=data, data_len=len(data))
    image["nh_archive_path"] = record["path"]
    image["nh_crc32"] = record["crc32"]
    image["nh_channel"] = channel
    if not image.packed_file or tuple(image.size) != (width, height):
        raise WorldImportError(f"Blender could not decode and pack {record['path']}.")
    return image


def _material(archive, tile, name, owned):
    material = bpy.data.materials.new(f"{name}_material")
    owned.materials.append(material)
    material.use_nodes = True
    material.diffuse_color = (0.35, 0.38, 0.31, 1.0)
    tree = material.node_tree
    principled = tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.35, 0.38, 0.31, 1.0)
    principled.inputs["Roughness"].default_value = 0.85
    principled.inputs["Metallic"].default_value = 0.0
    principled.location = (380, 100)
    uv = tree.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "NH_TileUV"
    uv.location = (-850, 100)
    material["nh_normal_policy"] = "Only detailNormalGL is applied to displaced geometry; macro terrain normals are not applied twice."
    material["nh_ao_policy"] = "ORM red is available as AO data; reflectance is not multiplied by baked occlusion."
    for index, channel in enumerate(("basecolor", "orm", "detailNormalGL")):
        record = tile.files.get(channel)
        if record is None:
            continue
        image = _packed_image(archive, record, channel, *tile.samples, owned)
        texture = tree.nodes.new("ShaderNodeTexImage")
        texture.name = f"NH_{channel}"
        texture.label = channel
        texture.image = image
        texture.interpolation = "Linear"
        texture.extension = "EXTEND"
        texture.location = (-580, 350 - index * 300)
        tree.links.new(uv.outputs["UV"], texture.inputs["Vector"])
        if channel == "basecolor":
            tree.links.new(texture.outputs["Color"], principled.inputs["Base Color"])
        elif channel == "orm":
            split = tree.nodes.new("ShaderNodeSeparateColor")
            split.mode = "RGB"
            split.label = "AO available / roughness / metallic"
            split.location = (-180, 60)
            tree.links.new(texture.outputs["Color"], split.inputs["Color"])
            tree.links.new(split.outputs["Green"], principled.inputs["Roughness"])
            tree.links.new(split.outputs["Blue"], principled.inputs["Metallic"])
        else:
            normal = tree.nodes.new("ShaderNodeNormalMap")
            normal.space = "TANGENT"
            normal.uv_map = "NH_TileUV"
            normal.inputs["Strength"].default_value = 1.0
            normal.location = (-180, -250)
            tree.links.new(texture.outputs["Color"], normal.inputs["Color"])
            tree.links.new(normal.outputs["Normal"], principled.inputs["Normal"])
    return material


def _mesh(tile, archive, normals, name, elevation_anchor, meters_per_unit, owned):
    width, height = tile.samples
    x0, z0 = tile.offset
    dx, dz = archive.manifest["dimensions"]["sampleSpacingMeters"]
    xs, zs = np.meshgrid(np.arange(width, dtype=np.float64), np.arange(height, dtype=np.float64))
    local_heights = archive.heights[z0:z0 + height, x0:x0 + width]
    coordinates = np.column_stack((
        (xs * dx / meters_per_unit).ravel(),
        (-zs * dz / meters_per_unit).ravel(),
        ((local_heights - elevation_anchor) / meters_per_unit).ravel(),
    )).astype(np.float32)
    rows, columns = np.meshgrid(np.arange(height - 1), np.arange(width - 1), indexing="ij")
    northwest = (rows * width + columns).ravel().astype(np.int32)
    faces = np.column_stack((northwest, northwest + width, northwest + width + 1, northwest + 1))
    mesh = bpy.data.meshes.new(name)
    owned.meshes.append(mesh)
    mesh.vertices.add(width * height)
    mesh.vertices.foreach_set("co", coordinates.ravel())
    mesh.loops.add(faces.size)
    mesh.loops.foreach_set("vertex_index", faces.ravel())
    mesh.polygons.add(len(faces))
    mesh.polygons.foreach_set("loop_start", np.arange(len(faces), dtype=np.int32) * 4)
    mesh.polygons.foreach_set("loop_total", np.full(len(faces), 4, dtype=np.int32))
    mesh.polygons.foreach_set("use_smooth", np.ones(len(faces), dtype=np.bool_))
    mesh.update(calc_edges=True)
    # Every border uses the same full-region neighbor stencil, not a clamped
    # per-tile derivative. Neighbors thus receive exactly identical normals.
    vertex_normals = normals[z0:z0 + height, x0:x0 + width].reshape(-1, 3)
    mesh.normals_split_custom_set_from_vertices(vertex_normals)
    uv = mesh.uv_layers.new(name="NH_TileUV")
    # Both endpoints are real exported pixels. Register mesh samples to pixel
    # centers; row zero is north/top while Blender's V axis points north/up.
    vertex_uv = np.column_stack((((xs + 0.5) / width).ravel(), (1 - (zs + 0.5) / height).ravel())).astype(np.float32)
    uv.data.foreach_set("uv", vertex_uv[faces.ravel()].ravel())
    mesh["nh_samples"] = list(tile.samples)
    mesh["nh_sample_offset"] = list(tile.offset)
    return mesh


def import_world(filepath, *, context=None, max_vertices=MAX_VERTICES,
                 max_expanded_bytes=MAX_EXPANDED_BYTES, rebase_origin=False):
    """Import one verified World into a new collection, or leave no new data.

    The existing scene's meters-per-unit setting is respected without changing
    it. By default world positions are preserved. Rebase explicitly subtracts
    the export origin and minimum elevation, recording that physical offset on
    the collection for far-origin workflows.
    """
    context = context or bpy.context
    if context.scene is None:
        raise WorldImportError("Choose a scene before importing a World archive.")
    if bpy.app.version < (4, 3, 0):
        raise WorldImportError("This bridge requires Blender 4.3 or newer; 4.3.2 is the qualified baseline.")
    archive = WorldArchive.read(filepath, max_vertices=max_vertices, max_expanded_bytes=max_expanded_bytes)
    dimensions = archive.manifest["dimensions"]
    dx, dz = dimensions["sampleSpacingMeters"]
    ox, oz = dimensions["originMeters"]
    elevation_anchor = float(np.min(archive.heights))
    meters_per_unit = float(context.scene.unit_settings.scale_length)
    if not math.isfinite(meters_per_unit) or not 1e-9 <= meters_per_unit <= 1e9:
        raise WorldImportError("The current scene has an unsupported unit scale.")
    offset = (ox, oz, elevation_anchor) if rebase_origin else (0.0, 0.0, 0.0)
    max_horizontal = max(abs(ox - offset[0]), abs(oz - offset[1]),
                         abs(ox + dimensions["widthMeters"] - offset[0]),
                         abs(oz + dimensions["depthMeters"] - offset[1]))
    if max_horizontal * np.finfo(np.float32).eps * 4 > min(dx, dz):
        raise WorldImportError("This far-origin World would lose sample precision in Blender. Enable Rebase origin; the original physical offset will be retained as metadata.")
    encoding = archive.manifest["encoding"]
    source_step = (encoding["elevationMaxMeters"] - encoding["elevationMinMeters"]) / 65535 if encoding["heightFormat"] != "raw32" else 0.0
    vertical_tolerance = max(0.001, min(dx, dz) * 1e-5, source_step)
    if abs(elevation_anchor - offset[2]) * np.finfo(np.float32).eps > vertical_tolerance:
        raise WorldImportError("The elevation datum would lose vertical precision in Blender. Enable Rebase origin; the exact physical elevation offset will be retained as metadata.")
    # Heightfield rows point south; Blender Y points north. Compute each normal
    # once on the canonical lattice before slicing it into independently editable tiles.
    south_slope, east_slope = np.gradient(archive.heights, dz, dx, edge_order=1)
    normals = np.stack((-east_slope, south_slope, np.ones_like(east_slope)), axis=-1)
    normals /= np.linalg.norm(normals, axis=-1, keepdims=True)
    normals = normals.astype(np.float32)
    label = str(archive.project.get("name", "World"))[:100]
    safe_label = re.sub(r"[^\w .-]", "_", label) or "World"
    owned = _OwnedData()
    try:
        collection = bpy.data.collections.new(f"NH_{safe_label}")
        owned.collections.append(collection)
        collection["nh_bridge_version"] = "1.0.0"
        collection["nh_source_archive"] = archive.source
        collection["nh_origin_east_m"] = ox
        collection["nh_origin_south_m"] = oz
        collection["nh_coordinate_offset_m"] = list(offset)
        collection["nh_meters_per_unit"] = meters_per_unit
        collection["nh_samples"] = dimensions["samples"]
        collection["nh_spacing_m"] = dimensions["sampleSpacingMeters"]
        collection["nh_axes"] = "Blender X=east, Y=north=-World south, Z=elevation"
        collection["nh_import_qualification"] = "Blender 4.3.2 bridge; heightfield geometry and packed material maps. Other engine profiles retain their original qualification status."
        for tile in archive.tiles:
            name = f"NH_{safe_label}_x{tile.address[0]}_y{tile.address[1]}"
            mesh = _mesh(tile, archive, normals, name, elevation_anchor, meters_per_unit, owned)
            material = _material(archive, tile, name, owned)
            mesh.materials.append(material)
            obj = bpy.data.objects.new(name, mesh)
            owned.objects.append(obj)
            obj.location = ((tile.origin[0] - offset[0]) / meters_per_unit,
                            -(tile.origin[1] - offset[1]) / meters_per_unit,
                            (elevation_anchor - offset[2]) / meters_per_unit)
            obj["nh_tile"] = list(tile.address)
            obj["nh_origin_east_south_m"] = list(tile.origin)
            collection.objects.link(obj)
        for suffix, contents in (("manifest", archive.manifest), ("project", archive.project)):
            text = bpy.data.texts.new(f"NH_{safe_label}_{suffix}.json")
            owned.texts.append(text)
            text.from_string(json.dumps(contents, ensure_ascii=False, indent=2, allow_nan=False))
            text.use_fake_user = True
            text.use_module = False
            collection[f"nh_{suffix}_text"] = text.name
        # Publish the collection only after every mesh, image, and material is
        # ready. Existing selection, unit settings, objects and worlds are intact.
        context.scene.collection.children.link(collection)
        context.view_layer.update()
        return ImportResult(collection, list(owned.objects), archive, meters_per_unit, offset)
    except BaseException:
        owned.rollback()
        raise


class NH_OT_import_world(bpy.types.Operator, ImportHelper):
    bl_idname = "import_scene.normal_height_world"
    bl_label = "Import Normal Height World"
    bl_options = {"REGISTER", "UNDO"}
    filename_ext = ".zip"

    filter_glob: StringProperty(default="*.zip", options={"HIDDEN"})
    rebase_origin: BoolProperty(
        name="Rebase origin",
        description="Place the export near the scene origin and retain its true east/south/elevation offset on the imported collection",
        default=False,
    )
    max_vertices: IntProperty(
        name="Maximum vertices",
        description="Admission limit including duplicated shared tile borders; export a smaller region for larger Worlds",
        default=MAX_VERTICES, min=4, max=MAX_VERTICES,
    )

    def execute(self, context):
        try:
            result = import_world(self.filepath, context=context, max_vertices=self.max_vertices,
                                  rebase_origin=self.rebase_origin)
        except (WorldImportError, OSError, MemoryError, RuntimeError, ValueError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        self.report({"INFO"}, f"Imported {len(result.objects)} terrain tiles, {result.archive.total_vertices:,} vertices, with verified packed maps")
        return {"FINISHED"}


def _menu_import(self, _context):
    self.layout.operator(NH_OT_import_world.bl_idname, text="Normal Height World (.zip)")


def register():
    bpy.utils.register_class(NH_OT_import_world)
    bpy.types.TOPBAR_MT_file_import.append(_menu_import)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(_menu_import)
    bpy.utils.unregister_class(NH_OT_import_world)


if __name__ == "__main__":
    register()
