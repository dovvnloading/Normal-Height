"""Import, measure, and render a Genesis World archive with physical heights.

Run with Blender 4.3.2 from any working directory:
    blender --background --factory-startup --python-exit-code 1 \
      --python integrations/blender/render-genesis-example.py -- \
      --archive world.zip --directory output-directory

The archive must include basecolor, orm, and detailNormalGL on every tile.
All three are exported with CLI --maps basecolor,orm,detailNormalGL (additional
Genesis and PBR maps may be included).

The archive and bridge determine every terrain vertex and material. This script
adds a camera and restrained lighting, records measured precision (including
Blender's decoded custom-normal error), and saves the packed .blend and render.
The reference small-fixture normal thresholds are retained as observations;
they are never silently reclassified as passed for a larger terrain.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

import bpy
from mathutils import Vector
import numpy as np

parser = argparse.ArgumentParser(
    description="Measure and render the delivered physical Genesis terrain in Blender.",
    epilog="Required archive maps: basecolor, orm, detailNormalGL on every tile.",
)
parser.add_argument("--archive", required=True)
parser.add_argument("--directory", required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
archive_path = Path(args.archive).resolve()
directory = Path(args.directory).resolve()
directory.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import normal_height_world as bridge
from normal_height_world.archive import decode_png

def object_vertices(obj):
    values = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
    obj.data.vertices.foreach_get("co", values)
    local = values.reshape(-1, 3).astype(np.float64)
    matrix = np.array(obj.matrix_world, dtype=np.float64)
    return local @ matrix[:3, :3].T + matrix[:3, 3]

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
started = time.perf_counter()
result = bridge.import_world(archive_path)
import_seconds = time.perf_counter() - started
archive = result.archive
for tile in archive.tiles:
    missing = {"basecolor", "orm", "detailNormalGL"}.difference(tile.files)
    if missing:
        raise ValueError(f"Render requires basecolor, orm, and detailNormalGL on every tile; tile {tile.address} is missing {sorted(missing)}.")
manifest = archive.manifest
dimensions = manifest["dimensions"]
dx, dz = dimensions["sampleSpacingMeters"]
ox, oz = dimensions["originMeters"]
south, east = np.gradient(archive.heights, dz, dx)
expected_normals = np.stack((-east, south, np.ones_like(east)), axis=-1)
expected_normals /= np.linalg.norm(expected_normals, axis=-1, keepdims=True)
maximum = dict(geometryMeters=0.0, normalAngleDegrees=0.0, uv=0.0, decodedTexture=0.0,
               sharedPositionMeters=0.0, sharedNormalComponent=0.0)
shared = {}
shared_count = 0
face_count = 0
packed_images = 0
lower = np.full(3, np.inf)
upper = np.full(3, -np.inf)
geometry_digest = hashlib.sha256()
normal_angles = []
shared_angles = []
worst_normal = None
source_float32_max_error = 0.0
for obj, tile in zip(result.objects, archive.tiles):
    width, height = tile.samples
    x0, z0 = tile.offset
    world = object_vertices(obj) * result.meters_per_unit
    offset = result.coordinate_offset_meters
    world += np.array((offset[0], -offset[1], offset[2]))
    xs, zs = np.meshgrid(np.arange(width), np.arange(height))
    expected = np.column_stack(((ox + (xs + x0) * dx).ravel(),
                                -(oz + (zs + z0) * dz).ravel(),
                                archive.heights[z0:z0 + height, x0:x0 + width].ravel()))
    maximum["geometryMeters"] = max(maximum["geometryMeters"], float(np.max(np.abs(world - expected))))
    lower = np.minimum(lower, world.min(axis=0))
    upper = np.maximum(upper, world.max(axis=0))
    geometry_digest.update(world.astype("<f8").tobytes())
    loops = np.empty(len(obj.data.loops), dtype=np.int32)
    obj.data.loops.foreach_get("vertex_index", loops)
    normals = np.empty(len(loops) * 3, dtype=np.float32)
    obj.data.corner_normals.foreach_get("vector", normals)
    normals = normals.reshape(-1, 3)
    target = expected_normals[z0:z0 + height, x0:x0 + width].reshape(-1, 3)
    unit = normals.astype(np.float64) / np.linalg.norm(normals.astype(np.float64), axis=1, keepdims=True)
    angle = np.degrees(np.arccos(np.clip(np.sum(unit * target[loops], axis=1), -1, 1)))
    normal_angles.append(angle.astype(np.float32))
    source_float32 = target[loops].astype(np.float32).astype(np.float64)
    source_float32 /= np.linalg.norm(source_float32, axis=1, keepdims=True)
    source_error = np.degrees(np.arccos(np.clip(np.sum(source_float32 * target[loops], axis=1), -1, 1)))
    source_float32_max_error = max(source_float32_max_error, float(np.max(source_error)))
    index = int(np.argmax(angle))
    if float(angle[index]) > maximum["normalAngleDegrees"]:
        vertex = int(loops[index])
        vz, vx = divmod(vertex, width)
        worst_normal = {"tile": list(tile.address), "loop": index, "vertex": vertex,
                        "sample": [x0 + vx, z0 + vz], "worldMeters": world[vertex].tolist(),
                        "sourceFloat64Normal": target[vertex].tolist(),
                        "sourceFloat32Normal": target[vertex].astype(np.float32).tolist(),
                        "decodedBlenderNormal": normals[index].tolist(),
                        "decodedBlenderUnitNormal": unit[index].tolist(),
                        "angleDegrees": float(angle[index])}
    maximum["normalAngleDegrees"] = max(maximum["normalAngleDegrees"], float(np.max(angle)))
    uv = np.empty(len(loops) * 2, dtype=np.float32)
    obj.data.uv_layers["NH_TileUV"].data.foreach_get("uv", uv)
    target_uv = np.column_stack((((xs + 0.5) / width).ravel(), (1 - (zs + 0.5) / height).ravel()))
    maximum["uv"] = max(maximum["uv"], float(np.max(np.abs(uv.reshape(-1, 2) - target_uv[loops]))))
    unique, first = np.unique(loops, return_index=True)
    vertex_normals = np.empty((width * height, 3), dtype=np.float32)
    vertex_normals[unique] = normals[first]
    boundary = np.flatnonzero(((xs == 0) | (xs == width - 1) | (zs == 0) | (zs == height - 1)).ravel())
    for index in boundary:
        z, x = divmod(int(index), width)
        key = (x0 + x, z0 + z)
        if key in shared:
            shared_count += 1
            a = vertex_normals[index].astype(np.float64)
            b = shared[key][1].astype(np.float64)
            a /= np.linalg.norm(a)
            b /= np.linalg.norm(b)
            shared_angles.append(float(np.degrees(np.arccos(np.clip(np.dot(a, b), -1, 1)))))
            maximum["sharedPositionMeters"] = max(maximum["sharedPositionMeters"], float(np.max(np.abs(world[index] - shared[key][0]))))
            maximum["sharedNormalComponent"] = max(maximum["sharedNormalComponent"], float(np.max(np.abs(vertex_normals[index] - shared[key][1]))))
        else:
            shared[key] = (world[index].copy(), vertex_normals[index].copy())
    face_count += len(obj.data.polygons)
    for channel in ("basecolor", "orm", "detailNormalGL"):
        image = obj.data.materials[0].node_tree.nodes[f"NH_{channel}"].image
        assert image.packed_file is not None
        expected_space = "sRGB" if channel == "basecolor" else "Non-Color"
        assert image.colorspace_settings.name == expected_space
        pixels = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        decoded = decode_png(archive.images[tile.files[channel]["path"]], width, height, 8, 6)
        target_pixels = np.flip(decoded, axis=0).astype(np.float32).ravel() / 255
        maximum["decodedTexture"] = max(maximum["decodedTexture"], float(np.max(np.abs(pixels - target_pixels))))
        packed_images += 1

samples_x, samples_z = dimensions["samples"]
unique_samples = samples_x * samples_z
assert len(result.objects) == len(archive.tiles)
assert sum(len(obj.data.vertices) for obj in result.objects) == archive.total_vertices
assert shared_count == archive.total_vertices - unique_samples
assert face_count == (samples_x - 1) * (samples_z - 1)
assert maximum["geometryMeters"] < 0.001
assert maximum["uv"] < 1e-7
assert maximum["decodedTexture"] < 2e-7
assert maximum["sharedPositionMeters"] < 0.001

angles = np.concatenate(normal_angles)
normal_report = {
    "input": "Canonical whole-region physical-height gradient, normalized and converted to float32 before normals_split_custom_set_from_vertices.",
    "decodedLoopCount": len(angles),
    "angleDegrees": {str(q): float(np.percentile(angles, q)) for q in (0, 50, 95, 99, 100)},
    "sharedBorderComparisons": shared_count,
    "sharedBorderAngleDegrees": {str(q): float(np.percentile(shared_angles, q)) if shared_angles else None for q in (0, 50, 95, 99, 100)},
    "sourceFloat32MaxErrorDegrees": source_float32_max_error,
    "worstLoop": worst_normal,
    "originalSmallFixtureAngleThresholdDegrees": 0.06,
    "originalSmallFixtureAngleThresholdMet": maximum["normalAngleDegrees"] < 0.06,
    "originalSmallFixtureSharedComponentThreshold": 2e-4,
    "originalSmallFixtureSharedComponentThresholdMet": maximum["sharedNormalComponent"] < 2e-4,
    "status": "Measured independently; initial small-fixture thresholds are retained as observations and not silently reclassified as passed.",
}
preflight = {"maximumErrors": maximum, "normalPrecision": normal_report, "importSeconds": import_seconds}
(directory / "measurement-before-render.json").write_text(json.dumps(preflight, indent=2) + "\n")
print("NORMAL_HEIGHT_GENESIS_MEASUREMENTS " + json.dumps(preflight), flush=True)
assert np.all(np.isfinite(angles))

scene = bpy.context.scene
world = bpy.data.worlds.new("Alpine neutral studio")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.16, 0.19, 0.24, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.65
light = bpy.data.lights.new("Alpine sun", "SUN")
light.energy = 2.8
light.angle = 0.12
sun = bpy.data.objects.new("Alpine sun", light)
scene.collection.objects.link(sun)
sun.rotation_euler = (0.60, -0.75, -0.4)
camera_data = bpy.data.cameras.new("Alpine overview")
camera = bpy.data.objects.new("Alpine overview", camera_data)
scene.collection.objects.link(camera)
target = Vector(((lower[0] + upper[0]) / 2, (lower[1] + upper[1]) / 2, (lower[2] + upper[2]) / 2))
span = max(dimensions["widthMeters"], dimensions["depthMeters"])
camera.location = target + Vector((1.3125 * span, -1.625 * span, 1.6 * span))
camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = 1.65 * span
camera_data.clip_start = 1
camera_data.clip_end = max(100000, 20 * span)
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 48
scene.cycles.use_denoising = False
scene.cycles.seed = 1729
scene.render.resolution_x = 1280
scene.render.resolution_y = 960
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.view_settings.view_transform = "AgX"
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.filepath = str(directory / "genesis-pbr-overview.png")
render_started = time.perf_counter()
bpy.ops.render.render(write_still=True)
render_seconds = time.perf_counter() - render_started
bpy.ops.wm.save_as_mainfile(filepath=str(directory / "genesis-delivered.blend"))
report = {
    "schemaVersion": 1,
    "completion": {"archiveImported": True, "geometryAndUVChecksPassed": True,
                   "packedTextureChecksPassed": True, "rendered": True, "blendSaved": True},
    "strictSmallFixtureNormalThresholdsPassed": bool(normal_report["originalSmallFixtureAngleThresholdMet"] and normal_report["originalSmallFixtureSharedComponentThresholdMet"]),
    "normalInterpretation": {
        "observation": "Compare canonical float64/float32 source vectors with Blender-decoded custom normals and shared-border results recorded below.",
        "inference": "A decoded error substantially above source float32 conversion error arises after the canonical normal is sent through Blender's custom-normal storage/decoding; it does not identify an input height or source-gradient seam.",
        "qualification": "The small analytical fixture's normal thresholds remain separate and unchanged; rendering completion is not a pass of those thresholds for this larger terrain.",
    },
    "archive": str(archive_path), "archiveSHA256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
    "build": manifest.get("build"),
    "scriptSHA256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "blenderVersion": bpy.app.version_string, "numpyVersion": np.__version__,
    "importSeconds": import_seconds, "renderSeconds": render_seconds,
    "samples": dimensions["samples"], "tiles": len(result.objects),
    "verticesIncludingSharedBorders": archive.total_vertices, "uniqueSamples": unique_samples,
    "quadFaces": face_count, "trianglesAtRender": face_count * 2,
    "sharedSampleComparisons": shared_count, "packedImages": packed_images,
    "boundsMeters": [lower.tolist(), upper.tolist()],
    "maximumErrors": maximum, "normalPrecision": normal_report, "geometrySHA256": geometry_digest.hexdigest(),
    "physicalVerticalScale": 1,
    "render": {
        "engine": "Cycles", "device": "CPU", "samples": 48, "seed": 1729,
        "resolution": [1280, 960], "denoising": False,
        "viewTransform": scene.view_settings.view_transform, "look": scene.view_settings.look,
        "exposure": scene.view_settings.exposure, "gamma": scene.view_settings.gamma,
        "cameraType": "ORTHO", "cameraLocationMeters": list(camera.location),
        "cameraTargetMeters": list(target), "orthoScaleMeters": camera_data.ortho_scale,
        "sunEnergy": light.energy, "sunAngleRadians": light.angle, "sunEulerRadians": list(sun.rotation_euler),
        "worldColor": [0.16, 0.19, 0.24], "worldStrength": 0.65,
        "renderedMaterialMaps": ["basecolor", "orm", "detailNormalGL"],
        "geometryChanges": "None; all imported physical heights preserved, no displacement modifiers or vertical exaggeration.",
    },
    "files": {"image": str(directory / "genesis-pbr-overview.png"), "blend": str(directory / "genesis-delivered.blend")},
}
(directory / "qualification.json").write_text(json.dumps(report, indent=2) + "\n")
print("NORMAL_HEIGHT_GENESIS_DELIVERY " + json.dumps(report), flush=True)
