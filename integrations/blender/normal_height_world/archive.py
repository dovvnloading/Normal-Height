"""Bounded, side-effect-free decoder for Normal Height World ZIP archives.

Only documented JSON, raw rasters, and non-interlaced PNG data are accepted.
No archive member is extracted, imported as code, or used as a filesystem path.
"""

from __future__ import annotations

from dataclasses import dataclass
import binascii
import json
import math
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import zipfile
import zlib

import numpy as np

MAX_VERTICES = 2_000_000
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_ENTRY_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 8192
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
GENESIS_FIELDS = {
    "hardness": "unitless", "lithology": "category-id", "uplift": "meters",
    "incision": "meters", "drainageArea": "square-meters", "channel": "unitless",
}


class WorldImportError(ValueError):
    """The input is invalid, unsupported, or outside the admitted import budget."""


def _object(value, label):
    if not isinstance(value, dict):
        raise WorldImportError(f"{label} must be an object.")
    return value


def _integer(value, label, low, high):
    if type(value) is not int or not low <= value <= high:
        raise WorldImportError(f"{label} must be an integer from {low} through {high}.")
    return value


def _number(value, label, low=-1e12, high=1e12):
    if type(value) not in (float, int) or not math.isfinite(value) or not low <= value <= high:
        raise WorldImportError(f"{label} must be finite and within the supported physical range.")
    return float(value)


def _pair(value, label, convert):
    if not isinstance(value, list) or len(value) != 2:
        raise WorldImportError(f"{label} must contain two values.")
    return tuple(convert(item, label) for item in value)


def _close(a, b):
    return math.isclose(a, b, rel_tol=1e-10, abs_tol=1e-7)


def _path(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 240 or
            not re.fullmatch(r"[A-Za-z0-9_./-]+", value) or
            value.startswith("/") or "//" in value or
            any(part in ("", ".", "..") for part in value.split("/")) or
            str(PurePosixPath(value)) != value):
        raise WorldImportError("The archive contains an unsafe or unsupported member path.")
    return value


def _json(data, label):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise WorldImportError(f"{label} contains a duplicate JSON key.")
            result[key] = value
        return result

    def constant(value):
        raise WorldImportError(f"{label} contains a non-finite JSON value: {value}.")

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise WorldImportError(f"{label} is not valid bounded UTF-8 JSON: {error}") from error


def _check_directory(file):
    """Bound central-directory allocations before Python's ZIP parser runs."""
    file.seek(0, 2)
    size = file.tell()
    if not 22 <= size <= 1024 * 1024 * 1024:
        raise WorldImportError("The World archive must be smaller than 1 GiB.")
    file.seek(max(0, size - 65557))
    tail = file.read(65557)
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        raise WorldImportError("The archive has no complete ZIP directory.")
    _, disk, start_disk, disk_count, count, directory_size, directory_offset, comment = struct.unpack_from("<4s4H2IH", tail, offset)
    if (disk or start_disk or disk_count != count or not 1 <= count <= MAX_ENTRIES or
            directory_size > 4 * 1024 * 1024 or
            directory_offset + directory_size != size - len(tail) + offset or
            offset + 22 + comment != len(tail)):
        raise WorldImportError("Unsupported, split, oversized, or inconsistent ZIP directory. ZIP64 is not supported.")
    file.seek(0)


def _read_member(archive, info):
    data = bytearray()
    checksum = 0
    with archive.open(info, "r") as member:
        while True:
            chunk = member.read(min(256 * 1024, info.file_size + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            checksum = binascii.crc32(chunk, checksum)
            if len(data) > info.file_size or len(data) > MAX_ENTRY_BYTES:
                raise WorldImportError(f"Expanded member exceeds its declared size: {info.filename}.")
    if len(data) != info.file_size or checksum & 0xFFFFFFFF != info.CRC:
        raise WorldImportError(f"ZIP size or CRC32 check failed: {info.filename}.")
    return bytes(data)


def decode_png(data, width, height, depth, color_type):
    """Decode all five PNG row filters, with a strict decompressed-size bound."""
    if not data.startswith(PNG_SIGNATURE):
        raise WorldImportError("A PNG map has an invalid signature.")
    offset, header, ended = 8, False, False
    compressed = bytearray()
    saw_idat, ended_idat = False, False
    while offset < len(data):
        if offset + 12 > len(data):
            raise WorldImportError("A PNG map has a truncated chunk.")
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + length
        if end > len(data):
            raise WorldImportError("A PNG chunk extends past its file.")
        payload = data[offset + 8:offset + 8 + length]
        checksum = struct.unpack_from(">I", data, offset + 8 + length)[0]
        if binascii.crc32(kind + payload) & 0xFFFFFFFF != checksum:
            raise WorldImportError("A PNG chunk failed its CRC32 check.")
        if not header and kind != b"IHDR":
            raise WorldImportError("A PNG map must begin with IHDR.")
        if kind == b"IHDR":
            if header or length != 13:
                raise WorldImportError("A PNG map has duplicate or invalid IHDR.")
            actual = struct.unpack(">IIBBBBB", payload)
            if actual != (width, height, depth, color_type, 0, 0, 0):
                raise WorldImportError("PNG dimensions, channels, or encoding disagree with the manifest. Only non-interlaced grayscale16 and RGBA8 maps are supported.")
            header = True
        elif kind == b"IDAT":
            if ended_idat:
                raise WorldImportError("PNG IDAT chunks must be consecutive.")
            saw_idat = True
            compressed.extend(payload)
        elif kind == b"IEND":
            if length or not saw_idat or end != len(data):
                raise WorldImportError("A PNG map has an invalid ending.")
            ended = True
        else:
            if saw_idat:
                ended_idat = True
            # Unknown critical chunks change raster interpretation.
            if not (kind[0] & 0x20):
                raise WorldImportError(f"Unsupported critical PNG chunk: {kind!r}.")
        offset = end
    if not ended:
        raise WorldImportError("A PNG map is incomplete.")
    bytes_per_pixel = 2 if depth == 16 and color_type == 0 else 4
    stride = width * bytes_per_pixel
    expected = (stride + 1) * height
    decoder = zlib.decompressobj()
    try:
        raw = decoder.decompress(bytes(compressed), expected + 1)
    except zlib.error as error:
        raise WorldImportError("A PNG map has invalid compressed pixels.") from error
    if len(raw) != expected or not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
        raise WorldImportError("A PNG map exceeds or disagrees with its decoded sample count.")
    pixels = bytearray(stride * height)
    for row in range(height):
        base = row * (stride + 1)
        method = raw[base]
        if method > 4:
            raise WorldImportError("A PNG map uses an unknown row filter.")
        target = row * stride
        if method == 0:
            pixels[target:target + stride] = raw[base + 1:base + 1 + stride]
            continue
        for col in range(stride):
            left = pixels[target + col - bytes_per_pixel] if col >= bytes_per_pixel else 0
            up = pixels[target + col - stride] if row else 0
            upper_left = pixels[target + col - stride - bytes_per_pixel] if row and col >= bytes_per_pixel else 0
            if method == 1:
                predictor = left
            elif method == 2:
                predictor = up
            elif method == 3:
                predictor = (left + up) // 2
            else:
                estimate = left + up - upper_left
                dl, du, dul = abs(estimate - left), abs(estimate - up), abs(estimate - upper_left)
                predictor = left if dl <= du and dl <= dul else up if du <= dul else upper_left
            pixels[target + col] = (raw[base + 1 + col] + predictor) & 255
    dtype = ">u2" if bytes_per_pixel == 2 else "u1"
    shape = (height, width) if bytes_per_pixel == 2 else (height, width, 4)
    return np.frombuffer(pixels, dtype=dtype).reshape(shape)


@dataclass(frozen=True)
class Tile:
    address: tuple[int, int]
    offset: tuple[int, int]
    samples: tuple[int, int]
    origin: tuple[float, float]
    files: dict


@dataclass
class WorldArchive:
    manifest: dict
    project: dict
    tiles: list[Tile]
    heights: np.ndarray
    images: dict[str, bytes]
    total_vertices: int
    source: str

    @classmethod
    def read(cls, path, *, max_vertices=MAX_VERTICES, max_expanded_bytes=MAX_EXPANDED_BYTES):
        _integer(max_vertices, "Vertex budget", 4, MAX_VERTICES)
        _integer(max_expanded_bytes, "Expanded archive budget", 1024, MAX_EXPANDED_BYTES)
        try:
            with Path(path).open("rb") as file:
                _check_directory(file)
                with zipfile.ZipFile(file) as archive:
                    return cls._read(archive, str(Path(path).resolve()), max_vertices, max_expanded_bytes)
        except WorldImportError:
            raise
        except (OSError, zipfile.BadZipFile, zlib.error, RuntimeError, OverflowError) as error:
            raise WorldImportError(f"The World archive could not be read: {error}") from error

    @classmethod
    def _read(cls, archive, source, max_vertices, max_expanded_bytes):
        members, expanded = {}, 0
        for info in archive.infolist():
            path = _path(info.filename)
            mode = info.external_attr >> 16
            if (path in members or info.is_dir() or stat.S_ISLNK(mode) or
                    (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or
                    info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or
                    not 0 <= info.file_size <= MAX_ENTRY_BYTES):
                raise WorldImportError("The archive contains duplicate, encrypted, unsupported, or oversized members.")
            members[path] = info
            expanded += info.file_size
        if len(members) > MAX_ENTRIES or expanded > max_expanded_bytes:
            raise WorldImportError("The archive exceeds the admitted expanded-data budget. Export a smaller region or fewer maps.")
        required = {"manifest.json", "project.nhterrain.json", "README.txt"}
        if not required.issubset(members) or members["manifest.json"].file_size > MAX_MANIFEST_BYTES or members["project.nhterrain.json"].file_size > 32 * 1024 * 1024:
            raise WorldImportError("The bounded World manifest, portable project, or README is missing.")
        manifest = _object(_json(_read_member(archive, members["manifest.json"]), "World manifest"), "World manifest")
        project = _object(_json(_read_member(archive, members["project.nhterrain.json"]), "Project"), "Project")
        _read_member(archive, members["README.txt"])
        if (manifest.get("application") != "Normal Height World Engine" or manifest.get("manifestVersion") != 1 or
                manifest.get("worldSchemaVersion") != 1 or manifest.get("projectSchemaVersion") != 2 or
                project.get("version") != 2 or project.get("world") != manifest.get("world") or
                project.get("seed") != manifest.get("projectSeed")):
            raise WorldImportError("Unsupported World schema or mismatched embedded project.")
        genesis_channels = {}
        if manifest.get("genesis") is not None:
            genesis = _object(manifest["genesis"], "Genesis provenance")
            settings = _object(project.get("world", {}).get("genesis"), "Genesis settings")
            if (genesis.get("schemaVersion") != 1 or genesis.get("algorithm") != "world-genesis-1" or
                    genesis.get("fieldStage") != "before-world-transport" or
                    settings.get("version") != 1 or settings.get("enabled") is not True or
                    genesis.get("settings") != settings):
                raise WorldImportError("Genesis provenance disagrees with the authored project.")
            genesis_channels = _object(genesis.get("channels"), "Genesis channels")
            for name, raw_channel in genesis_channels.items():
                channel = _object(raw_channel, "Genesis channel")
                if (name not in GENESIS_FIELDS or channel.get("units") != GENESIS_FIELDS[name] or
                        channel.get("algorithm") != "world-genesis-1" or channel.get("components") != 1 or
                        channel.get("storage") != ("raw8" if name == "lithology" else "raw32")):
                    raise WorldImportError("Unsupported Genesis channel units or encoding.")
        axes = _object(manifest.get("axes"), "World axes")
        if axes.get("x") != "East/right" or axes.get("z") != "South/down" or not str(axes.get("rowOrder", "")).startswith("North first;"):
            raise WorldImportError("Unsupported World coordinate convention.")
        dimensions = _object(manifest.get("dimensions"), "World dimensions")
        nx, nz = _pair(dimensions.get("samples"), "Sample dimensions", lambda x, label: _integer(x, label, 2, 8193))
        if dimensions.get("intervals") != [nx - 1, nz - 1] or nx * nz > max_vertices:
            raise WorldImportError("World samples exceed the vertex budget or disagree with interval counts. Export a smaller region or lower-resolution World.")
        dx, dz = _pair(dimensions.get("sampleSpacingMeters"), "Sample spacing", lambda x, label: _number(x, label, 1e-8, 1e9))
        ox, oz = _pair(dimensions.get("originMeters"), "World origin", _number)
        width = _number(dimensions.get("widthMeters"), "World width", 1e-8, 1e9)
        depth = _number(dimensions.get("depthMeters"), "World depth", 1e-8, 1e9)
        if not _close(width, (nx - 1) * dx) or not _close(depth, (nz - 1) * dz):
            raise WorldImportError("World extents and sample spacing disagree.")
        encoding = _object(manifest.get("encoding"), "Height encoding")
        format_ = encoding.get("heightFormat")
        minimum = _number(encoding.get("elevationMinMeters"), "Minimum elevation")
        maximum = _number(encoding.get("elevationMaxMeters"), "Maximum elevation")
        if minimum > maximum or format_ not in ("raw16", "raw32", "png16") or encoding.get("heightUnits") != "Metres" or encoding.get("rawByteOrder") != "Little endian":
            raise WorldImportError("Unsupported height encoding or common elevation range.")
        raw_tiles = manifest.get("tiles")
        if not isinstance(raw_tiles, list) or not 1 <= len(raw_tiles) <= MAX_ENTRIES:
            raise WorldImportError("The World tile list is invalid.")
        heights = np.full((nz, nx), np.nan, dtype=np.float64)
        coverage = np.zeros((nz - 1, nx - 1), dtype=np.bool_)
        tiles, images, addresses, expected, vertices = [], {}, set(), set(required), 0
        for raw_tile in raw_tiles:
            tile = _object(raw_tile, "Tile")
            address = (_integer(tile.get("x"), "Tile column", 0, 8192), _integer(tile.get("z"), "Tile row", 0, 8192))
            if address in addresses:
                raise WorldImportError("The World contains duplicate tile addresses.")
            addresses.add(address)
            tw, th = _pair(tile.get("samples"), "Tile samples", lambda x, label: _integer(x, label, 2, 513))
            x0, z0 = _pair(tile.get("sampleOffset"), "Tile sample offset", lambda x, label: _integer(x, label, 0, 8192))
            tx, tz = _pair(tile.get("originMeters"), "Tile origin", _number)
            if x0 + tw > nx or z0 + th > nz or not _close(tx, ox + x0 * dx) or not _close(tz, oz + z0 * dz):
                raise WorldImportError("A tile's physical origin or sample bounds disagree with the World lattice.")
            cells = coverage[z0:z0 + th - 1, x0:x0 + tw - 1]
            if np.any(cells):
                raise WorldImportError("World tiles overlap by more than their shared border samples.")
            cells[:] = True
            vertices += tw * th
            if vertices > max_vertices:
                raise WorldImportError("Tile vertices, including shared border copies, exceed the import budget. Export a smaller region or use larger tiles.")
            files = tile.get("files")
            if not isinstance(files, list) or not 1 <= len(files) <= 64:
                raise WorldImportError("A tile has an invalid map list.")
            by_map = {}
            for raw_record in files:
                record = _object(raw_record, "Map record")
                path = _path(record.get("path"))
                map_ = record.get("map")
                if not isinstance(map_, str) or not 1 <= len(map_) <= 160 or map_ in by_map or path in expected or path not in members:
                    raise WorldImportError("A map is missing, duplicated, or referenced more than once.")
                info = members[path]
                crc = record.get("crc32")
                if type(record.get("bytes")) is not int or record["bytes"] != info.file_size or not isinstance(crc, str) or not re.fullmatch(r"[a-f0-9]{8}", crc) or int(crc, 16) != info.CRC:
                    raise WorldImportError(f"Manifest size or CRC32 disagrees with the ZIP member: {path}.")
                expected.add(path)
                by_map[map_] = record
                data = _read_member(archive, info)
                declared_format = record.get("format")
                map_format = "rgba8" if declared_format in ("RGBA8 PNG (sRGB)", "RGBA8 PNG (linear/non-color)") else declared_format
                if map_format == "raw32":
                    if len(data) != tw * th * 4:
                        raise WorldImportError("Float32 map byte count disagrees with its sample dimensions.")
                    pixels = np.frombuffer(data, dtype="<f4").reshape(th, tw)
                    if not np.all(np.isfinite(pixels)):
                        raise WorldImportError("A Float32 map contains non-finite values.")
                elif map_format == "raw8":
                    if map_ != "lithology" or map_ not in genesis_channels or len(data) != tw * th:
                        raise WorldImportError("Genesis lithology RAW8 dimensions or provenance are invalid.")
                    pixels = np.frombuffer(data, dtype=np.uint8).reshape(th, tw)
                    if np.any(pixels > 3):
                        raise WorldImportError("A Genesis lithology map contains an unknown rock ID.")
                elif map_format == "raw16":
                    if len(data) != tw * th * 2:
                        raise WorldImportError("RAW16 map byte count disagrees with its sample dimensions.")
                    pixels = np.frombuffer(data, dtype="<u2").reshape(th, tw)
                elif map_format in ("png16", "rgba8"):
                    pixels = decode_png(data, tw, th, 16 if map_format == "png16" else 8, 0 if map_format == "png16" else 6)
                else:
                    raise WorldImportError(f"Unsupported raster format: {map_format}.")
                if map_ in GENESIS_FIELDS:
                    descriptor = genesis_channels.get(map_)
                    if descriptor is None or descriptor.get("storage") != map_format:
                        raise WorldImportError("Genesis map encoding disagrees with its descriptor.")
                    if map_ in ("hardness", "channel") and (np.any(pixels < 0) or np.any(pixels > 1)):
                        raise WorldImportError("A Genesis weight map is outside its 0–1 range.")
                    if map_ in ("incision", "drainageArea") and np.any(pixels < 0):
                        raise WorldImportError("A physical Genesis map contains negative values.")
                if map_ == "height":
                    if map_format != format_:
                        raise WorldImportError("A tile's height encoding disagrees with the common height format.")
                    decoded = pixels.astype(np.float64)
                    if format_ != "raw32":
                        decoded = minimum + decoded / 65535.0 * (maximum - minimum)
                    tolerance = max(1e-6, abs(minimum) * 3e-7, abs(maximum) * 3e-7)
                    if np.min(decoded) < minimum - tolerance or np.max(decoded) > maximum + tolerance:
                        raise WorldImportError("A height map lies outside the declared common elevation range.")
                    target = heights[z0:z0 + th, x0:x0 + tw]
                    shared = np.isfinite(target)
                    if np.any(target[shared] != decoded[shared]):
                        raise WorldImportError("Neighboring tiles disagree at a shared height sample.")
                    target[:] = decoded
                elif map_ in ("basecolor", "orm", "detailNormalGL"):
                    expected_format = "RGBA8 PNG (sRGB)" if map_ == "basecolor" else "RGBA8 PNG (linear/non-color)"
                    if map_format != "rgba8" or declared_format != expected_format:
                        raise WorldImportError(f"The {map_} material channel must be RGBA8.")
                    images[path] = data
            if any(name not in by_map for name in genesis_channels):
                raise WorldImportError("A tile is missing a declared Genesis map.")
            if "height" not in by_map:
                raise WorldImportError("A tile has no height map.")
            tiles.append(Tile(address, (x0, z0), (tw, th), (tx, tz), by_map))
        if expected != set(members) or not np.all(coverage) or not np.all(np.isfinite(heights)):
            raise WorldImportError("World tile coverage has holes or the archive contains undeclared members.")
        return cls(manifest, project, tiles, heights, images, vertices, source)
