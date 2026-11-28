"""Run inside Blender with --python-exit-code 1; produces measured QA evidence."""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

import bpy
from mathutils import Vector
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import normal_height_world as bridge
from normal_height_world.archive import WorldArchive, WorldImportError, decode_png
from decoder_checks import run_decoder_checks


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True)
    parser.add_argument("--reopen", action="store_true")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def fingerprint(data):
    return hashlib.sha256(data).hexdigest()


def scene_state():
    return {
        "data": {name: sorted((item.name, item.as_pointer()) for item in getattr(bpy.data, name))
                 for name in ("objects", "meshes", "materials", "images", "collections", "texts")},
        "children": sorted(child.name for child in bpy.context.scene.collection.children),
        "active": bpy.context.view_layer.objects.active.name if bpy.context.view_layer.objects.active else None,
        "selected": sorted(item.name for item in bpy.context.selected_objects),
        "unit_scale": bpy.context.scene.unit_settings.scale_length,
    }


def object_vertices(obj):
    values = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
    obj.data.vertices.foreach_get("co", values)
    local = values.reshape(-1, 3).astype(np.float64)
    matrix = np.array(obj.matrix_world, dtype=np.float64)
    return local @ matrix[:3, :3].T + matrix[:3, 3]


def collection_signature(collection):
    objects = []
    for obj in sorted(collection.objects, key=lambda item: tuple(item["nh_tile"])):
        images = []
        for node in obj.data.materials[0].node_tree.nodes:
            if node.type != "TEX_IMAGE":
                continue
            image = node.image
            assert image.packed_file is not None, f"Missing packed image: {image.name}"
            pixels = np.empty(len(image.pixels), dtype=np.float32)
            image.pixels.foreach_get(pixels)
            images.append({
                "map": image["nh_channel"], "colorspace": image.colorspace_settings.name,
                "size": list(image.size), "encodedSHA256": fingerprint(image.packed_file.data),
                "pixelsSHA256": fingerprint(pixels.tobytes()),
            })
        world = object_vertices(obj)
        objects.append({
            "tile": list(obj["nh_tile"]), "vertices": len(obj.data.vertices),
            "faces": len(obj.data.polygons), "geometrySHA256": fingerprint(world.astype("<f4").tobytes()),
            "bounds": [world.min(axis=0).tolist(), world.max(axis=0).tolist()],
            "images": sorted(images, key=lambda image: image["map"]),
        })
    manifest = json.loads(bpy.data.texts[collection["nh_manifest_text"]].as_string())
    return {"format": manifest["encoding"]["heightFormat"], "objects": objects}


def check_import(result):
    archive = result.archive
    manifest = archive.manifest
    dimensions = manifest["dimensions"]
    dx, dz = dimensions["sampleSpacingMeters"]
    ox, oz = dimensions["originMeters"]
    south_slope, east_slope = np.gradient(archive.heights, dz, dx)
    expected_normals = np.stack((-east_slope, south_slope, np.ones_like(east_slope)), axis=-1)
    expected_normals /= np.linalg.norm(expected_normals, axis=-1, keepdims=True)
    shared, max_geometry_error, max_normal_error, max_uv_error, max_pixel_error = {}, 0.0, 0.0, 0.0, 0.0
    max_normal_angle = 0.0
    bounds = []
    shared_comparisons = 0
    for obj, tile in zip(result.objects, archive.tiles):
        width, height = tile.samples
        x0, z0 = tile.offset
        world = object_vertices(obj) * result.meters_per_unit
        offset = result.coordinate_offset_meters
        world += np.array((offset[0], -offset[1], offset[2]))
        xs, zs = np.meshgrid(np.arange(width), np.arange(height))
        expected = np.column_stack((
            (ox + (xs + x0) * dx).ravel(), -(oz + (zs + z0) * dz).ravel(),
            archive.heights[z0:z0 + height, x0:x0 + width].ravel(),
        ))
        max_geometry_error = max(max_geometry_error, float(np.max(np.abs(world - expected))))
        bounds.append(world)
        loops = np.empty(len(obj.data.loops), dtype=np.int32)
        obj.data.loops.foreach_get("vertex_index", loops)
        normals = np.empty(len(loops) * 3, dtype=np.float32)
        obj.data.corner_normals.foreach_get("vector", normals)
        normals = normals.reshape(-1, 3)
        target_normals = expected_normals[z0:z0 + height, x0:x0 + width].reshape(-1, 3)
        max_normal_error = max(max_normal_error, float(np.max(np.abs(normals - target_normals[loops]))))
        measured_unit = normals.astype(np.float64) / np.linalg.norm(normals.astype(np.float64), axis=1, keepdims=True)
        angles = np.degrees(np.arccos(np.clip(np.sum(measured_unit * target_normals[loops], axis=1), -1, 1)))
        max_normal_angle = max(max_normal_angle, float(np.max(angles)))
        uv = np.empty(len(loops) * 2, dtype=np.float32)
        obj.data.uv_layers["NH_TileUV"].data.foreach_get("uv", uv)
        target_uv = np.column_stack((((xs + 0.5) / width).ravel(), (1 - (zs + 0.5) / height).ravel()))
        max_uv_error = max(max_uv_error, float(np.max(np.abs(uv.reshape(-1, 2) - target_uv[loops]))))
        vertex_normal = {}
        for loop, vertex in enumerate(loops):
            vertex_normal.setdefault(int(vertex), normals[loop])
        for z in range(height):
            for x in range(width):
                key = (x0 + x, z0 + z)
                index = z * width + x
                normal = vertex_normal[index]
                if key in shared:
                    shared_comparisons += 1
                    assert np.max(np.abs(world[index] - shared[key][0])) < 1e-4, "Shared vertex crack"
                    assert np.max(np.abs(normal - shared[key][1])) < 2e-4, "Shared vertex shading discontinuity"
                else:
                    shared[key] = (world[index], normal)
        material = obj.data.materials[0]
        principled = material.node_tree.nodes.get("Principled BSDF")
        assert principled.inputs["Normal"].links[0].from_node.type == "NORMAL_MAP"
        assert principled.inputs["Roughness"].links[0].from_socket.name == "Green"
        assert principled.inputs["Metallic"].links[0].from_socket.name == "Blue"
        for channel in ("basecolor", "orm", "detailNormalGL"):
            texture = material.node_tree.nodes[f"NH_{channel}"]
            image = texture.image
            expected_space = "sRGB" if channel == "basecolor" else "Non-Color"
            assert image.colorspace_settings.name == expected_space
            assert image.packed_file is not None
            pixels = np.empty(width * height * 4, dtype=np.float32)
            image.pixels.foreach_get(pixels)
            decoded = decode_png(archive.images[tile.files[channel]["path"]], width, height, 8, 6)
            expected_pixels = np.flip(decoded, axis=0).astype(np.float32).ravel() / 255
            max_pixel_error = max(max_pixel_error, float(np.max(np.abs(pixels - expected_pixels))))
    assert len(result.objects) == 4
    assert archive.total_vertices == 884
    assert shared_comparisons == 59
    assert max_geometry_error < 1e-4, max_geometry_error
    # Blender stores custom loop normals in its own compact normal-space
    # representation. Qualify the decoded angular error, not exact float bits.
    assert max_normal_angle < 0.06, max_normal_angle
    assert max_uv_error < 1e-7, max_uv_error
    assert max_pixel_error < 2e-7, max_pixel_error
    all_vertices = np.vstack(bounds)
    assert np.allclose(all_vertices.min(axis=0)[:2], [120, -290], atol=1e-4)
    assert np.allclose(all_vertices.max(axis=0)[:2], [1080, 350], atol=1e-4)
    return {
        "tiles": 4, "verticesIncludingBorders": 884, "uniqueSamples": 825,
        "sharedSampleComparisons": shared_comparisons,
        "maxGeometryErrorMeters": max_geometry_error,
        "maxNormalComponentError": max_normal_error,
        "maxNormalAngleDegrees": max_normal_angle,
        "maxUVError": max_uv_error, "maxDecodedTextureError": max_pixel_error,
        "measuredBoundsMeters": [all_vertices.min(axis=0).tolist(), all_vertices.max(axis=0).tolist()],
    }


def copy_bad_archive(source, target, change):
    with zipfile.ZipFile(source) as archive:
        entries = {info.filename: archive.read(info.filename) for info in archive.infolist()}
    change(entries)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for path, data in entries.items():
            archive.writestr(path, data)


def assert_rollback(directory):
    source = directory / "world-raw32.zip"
    corrupt = directory / "corrupt-world.zip"

    def damage(entries):
        path = next(path for path in entries if path.startswith("tiles/height"))
        data = bytearray(entries[path])
        data[0] ^= 1
        entries[path] = bytes(data)

    copy_bad_archive(source, corrupt, damage)
    before = scene_state()
    try:
        bridge.import_world(corrupt)
        raise AssertionError("A corrupt manifest CRC was accepted")
    except WorldImportError as error:
        assert "CRC32" in str(error)
    assert scene_state() == before, "A rejected archive changed scene data"

    traversal = directory / "unsafe-world.zip"
    copy_bad_archive(source, traversal, lambda entries: entries.update({"../outside.py": b"raise RuntimeError('must never execute')"}))
    try:
        bridge.import_world(traversal)
        raise AssertionError("An unsafe archive path was accepted")
    except WorldImportError as error:
        assert "unsafe" in str(error)
    assert scene_state() == before

    # Also verify rollback after geometry and packed images have been allocated,
    # rather than exercising only the decoder's preflight rejection path.
    original = bridge._material
    calls = 0

    def fail_after_first_tile(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("Injected Blender allocation failure")
        return original(*args, **kwargs)

    bridge._material = fail_after_first_tile
    try:
        try:
            bridge.import_world(source)
            raise AssertionError("Injected allocation failure did not fail")
        except RuntimeError as error:
            assert "Injected Blender allocation failure" in str(error)
    finally:
        bridge._material = original
    assert scene_state() == before, "Failed Blender construction leaked or altered datablocks"
    return ["manifest CRC rejection", "unsafe member path rejection", "post-allocation rollback"]


def check_large_datum(directory):
    source = directory / "world-png16.zip"
    target = directory / "large-datum-world.zip"

    def translate(entries):
        manifest = json.loads(entries["manifest.json"])
        project = json.loads(entries["project.nhterrain.json"])
        manifest["world"]["domain"]["datum"] += 1e9
        project["world"]["domain"]["datum"] += 1e9
        manifest["encoding"]["elevationMinMeters"] += 1e9
        manifest["encoding"]["elevationMaxMeters"] += 1e9
        entries["manifest.json"] = json.dumps(manifest).encode()
        entries["project.nhterrain.json"] = json.dumps(project).encode()

    copy_bad_archive(source, target, translate)
    before = scene_state()
    try:
        bridge.import_world(target)
        raise AssertionError("Large vertical datum was accepted without rebasing")
    except WorldImportError as error:
        assert "vertical precision" in str(error)
    assert scene_state() == before
    result = bridge.import_world(target, rebase_origin=True)
    expected_offset = float(np.min(result.archive.heights))
    assert result.coordinate_offset_meters[2] == expected_offset
    assert result.collection["nh_coordinate_offset_m"][2] == expected_offset
    error = 0.0
    for obj, tile in zip(result.objects, result.archive.tiles):
        x0, z0 = tile.offset
        width, height = tile.samples
        actual = object_vertices(obj)[:, 2] * result.meters_per_unit + expected_offset
        expected = result.archive.heights[z0:z0 + height, x0:x0 + width].ravel()
        error = max(error, float(np.max(np.abs(actual - expected))))
    assert error < 1e-4, error
    # This synthetic datum case is measured but is not part of the comparison
    # scene that will be rendered and reopened.
    owned = bridge._OwnedData()
    owned.collections = [result.collection]
    owned.objects = list(result.objects)
    owned.meshes = [obj.data for obj in result.objects]
    owned.materials = [obj.data.materials[0] for obj in result.objects]
    owned.images = [node.image for material in owned.materials for node in material.node_tree.nodes if node.type == "TEX_IMAGE"]
    owned.texts = [bpy.data.texts[result.collection[key]] for key in ("nh_manifest_text", "nh_project_text")]
    owned.rollback()
    assert scene_state() == before
    return {"unrebasedRejected": True, "physicalOffsetMeters": expected_offset, "maxRebasedHeightErrorMeters": error}


def render_scene(directory):
    scene = bpy.context.scene
    for obj in scene.objects:
        if obj.type == "MESH" and "nh_tile" not in obj:
            obj.hide_render = True
    world = bpy.data.worlds.new("NH Qualification studio")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.18, 0.2, 0.24, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.45
    light = bpy.data.lights.new("NH Qualification sun", "SUN")
    light.energy = 3.0
    light.angle = 0.15
    sun = bpy.data.objects.new("NH Qualification sun", light)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (0.45, -0.55, -0.4)
    camera_data = bpy.data.cameras.new("NH Qualification camera")
    camera = bpy.data.objects.new("NH Qualification camera", camera_data)
    scene.collection.objects.link(camera)
    target = Vector((600, 30, 200))
    camera.location = target + Vector((1100, -1450, 1500))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 1280
    camera_data.clip_end = 10000
    scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.use_denoising = False
    scene.cycles.samples = 24
    scene.cycles.seed = 1729
    scene.render.resolution_x = 960
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(directory / "blender-world-import.png")
    bpy.ops.render.render(write_still=True)


def main():
    args = arguments()
    directory = Path(args.directory).resolve()
    if args.reopen:
        original = json.loads((directory / "qualification-initial.json").read_text())
        collections = [collection for collection in bpy.data.collections if "nh_bridge_version" in collection]
        visibility = [(collection, collection.hide_viewport) for collection in collections]
        # Blender intentionally leaves excluded collections unevaluated on file
        # load; expose them for one dependency-graph update before measuring
        # actual world transforms, then restore the comparison scene visibility.
        for collection in collections:
            collection.hide_viewport = False
        bpy.context.view_layer.update()
        actual = {collection.name: collection_signature(collection) for collection in collections}
        for collection, hidden in visibility:
            collection.hide_viewport = hidden
        bpy.context.view_layer.update()
        assert actual == original["signatures"], "Saved/reopened geometry, packed pixels, or color spaces changed"
        assert not any((directory / f"world-{format_}.zip").exists() for format_ in ("raw32", "raw16", "png16")), "Archive availability would weaken the packed-asset test"
        bpy.context.scene.render.filepath = str(directory / "blender-world-reopened.png")
        bpy.ops.render.render(write_still=True)
        report = {"ok": True, "blenderVersion": bpy.app.version_string, "collections": len(actual), "externalSourceArchivesAvailable": False, "packedAssetsAndGeometryIdentical": True}
        (directory / "qualification-reopened.json").write_text(json.dumps(report, indent=2) + "\n")
        print("NORMAL_HEIGHT_BLENDER_REOPEN " + json.dumps(report))
        return
    bridge.register()
    report = {"ok": True, "blenderVersion": bpy.app.version_string, "numpyVersion": np.__version__, "formats": {}, "signatures": {}}
    report["decoderChecks"] = run_decoder_checks(directory / "world-raw32.zip", directory)
    original_selection = scene_state()
    for format_ in ("raw16", "png16", "raw32"):
        result = bridge.import_world(directory / f"world-{format_}.zip")
        report["formats"][format_] = check_import(result)
        report["signatures"][result.collection.name] = collection_signature(result.collection)
        assert scene_state()["unit_scale"] == original_selection["unit_scale"]
        assert scene_state()["active"] == original_selection["active"]
        assert scene_state()["selected"] == original_selection["selected"]
        if format_ != "raw32":
            result.collection.hide_render = True
            result.collection.hide_viewport = True
    report["failureChecks"] = assert_rollback(directory)
    report["largeDatum"] = check_large_datum(directory)
    render_scene(directory)
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / "qualified-world.blend"))
    (directory / "qualification-initial.json").write_text(json.dumps(report, indent=2) + "\n")
    bridge.unregister()
    print("NORMAL_HEIGHT_BLENDER_IMPORT " + json.dumps({key: value for key, value in report.items() if key != "signatures"}))


if __name__ == "__main__":
    main()
