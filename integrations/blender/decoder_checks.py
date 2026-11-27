"""Adversarial decoder checks, executed by the installed-Blender qualification."""

import binascii
import json
from pathlib import Path
import struct
import zipfile
import zlib

import numpy as np

from normal_height_world.archive import WorldArchive, WorldImportError, decode_png


def _chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)


def _png(width, height, depth, color_type, raw):
    packed = zlib.compress(raw)
    middle = len(packed) // 2
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, color_type, 0, 0, 0)) +
            _chunk(b"IDAT", packed[:middle]) + _chunk(b"IDAT", packed[middle:]) + _chunk(b"IEND", b""))


def _filtered(pixels, width, height, stride):
    rows = bytearray()
    for row in range(height):
        method = row % 5
        rows.append(method)
        for column in range(width * stride):
            i = row * width * stride + column
            left = pixels[i - stride] if column >= stride else 0
            above = pixels[i - width * stride] if row else 0
            upper_left = pixels[i - width * stride - stride] if row and column >= stride else 0
            if method == 0:
                predictor = 0
            elif method == 1:
                predictor = left
            elif method == 2:
                predictor = above
            elif method == 3:
                predictor = (left + above) // 2
            else:
                p = left + above - upper_left
                distances = (abs(p - left), abs(p - above), abs(p - upper_left))
                predictor = (left, above, upper_left)[distances.index(min(distances))]
            rows.append((pixels[i] - predictor) & 255)
    return bytes(rows)


def _reject(work, text):
    try:
        work()
    except WorldImportError as error:
        assert text.lower() in str(error).lower(), str(error)
    else:
        raise AssertionError(f"Expected rejection containing {text!r}")


def run_decoder_checks(source, directory):
    checks = []
    for depth, color_type, stride in ((16, 0, 2), (8, 6, 4)):
        pixels = bytes((i * 37 + i // 7) % 256 for i in range(3 * 5 * stride))
        image = _png(3, 5, depth, color_type, _filtered(pixels, 3, 5, stride))
        decoded = decode_png(image, 3, 5, depth, color_type)
        assert decoded.tobytes() == pixels
        damaged = bytearray(image)
        damaged[-1] ^= 1
        _reject(lambda: decode_png(damaged, 3, 5, depth, color_type), "CRC32")
        _reject(lambda: decode_png(image, 4, 5, depth, color_type), "dimensions")
        checks.append(f"all five PNG filters and CRC/dimension checks: {depth}-bit type {color_type}")
    _reject(lambda: decode_png(_png(2, 2, 8, 6, b"\0" * 100000), 2, 2, 8, 6), "decoded sample count")
    checks.append("bounded PNG decompression")
    _reject(lambda: WorldArchive.read(source, max_vertices=100), "vertex budget")
    _reject(lambda: WorldArchive.read(source, max_expanded_bytes=1024), "expanded-data budget")
    checks.append("vertex and expanded-byte admission")
    with zipfile.ZipFile(source) as archive:
        original = {item.filename: archive.read(item.filename) for item in archive.infolist()}

    def malformed(name, change, message):
        entries = dict(original)
        manifest = json.loads(entries["manifest.json"])
        change(entries, manifest)
        entries["manifest.json"] = json.dumps(manifest).encode()
        path = Path(directory) / name
        with zipfile.ZipFile(path, "w") as archive:
            for member, data in entries.items():
                archive.writestr(member, data)
        _reject(lambda: WorldArchive.read(path), message)

    def remove_tile(entries, manifest):
        tile = manifest["tiles"].pop()
        for record in tile["files"]:
            entries.pop(record["path"])

    malformed("missing-tile.zip", remove_tile, "coverage")
    malformed("wrong-origin.zip", lambda _e, m: m["tiles"][0]["originMeters"].__setitem__(0, 121), "physical origin")

    def break_shared_height(entries, manifest):
        record = next(item for item in manifest["tiles"][1]["files"] if item["map"] == "height")
        data = bytearray(entries[record["path"]])
        struct.pack_into("<f", data, 0, struct.unpack_from("<f", data)[0] + 1)
        entries[record["path"]] = bytes(data)
        record["crc32"] = f"{binascii.crc32(data) & 0xFFFFFFFF:08x}"

    malformed("shared-edge-disagreement.zip", break_shared_height, "shared height")
    checks.extend(("missing tile rejection", "physical-origin consistency", "shared-height mismatch despite valid CRC"))
    def break_lithology(entries, manifest):
        record = next(item for item in manifest["tiles"][0]["files"] if item["map"] == "lithology")
        data = bytearray(entries[record["path"]])
        data[0] = 255
        entries[record["path"]] = bytes(data)
        record["crc32"] = f"{binascii.crc32(data) & 0xFFFFFFFF:08x}"

    def truncate_lithology(entries, manifest):
        record = next(item for item in manifest["tiles"][0]["files"] if item["map"] == "lithology")
        data = entries[record["path"]][:-1]
        entries[record["path"]] = data
        record["bytes"] = len(data)
        record["crc32"] = f"{binascii.crc32(data) & 0xFFFFFFFF:08x}"

    malformed("unknown-lithology-id.zip", break_lithology, "rock ID")
    malformed("truncated-lithology.zip", truncate_lithology, "RAW8 dimensions")
    malformed("wrong-genesis-units.zip", lambda _e, m: m["genesis"]["channels"]["drainageArea"].__setitem__("units", "meters"), "Genesis channel units")
    checks.extend(("Genesis categorical IDs despite valid CRC", "Genesis RAW8 exact dimensions", "Genesis physical map units"))
    raw = bytearray(Path(source).read_bytes())
    end = raw.rfind(b"PK\x05\x06")
    struct.pack_into("<HH", raw, end + 8, 8193, 8193)
    oversized = Path(directory) / "oversized-directory.zip"
    oversized.write_bytes(raw)
    _reject(lambda: WorldArchive.read(oversized), "ZIP directory")
    checks.append("central-directory allocation bound")
    compressed = Path(directory) / "corrupt-deflate.zip"
    with zipfile.ZipFile(compressed, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path, data in original.items():
            archive.writestr(path, data)
    with zipfile.ZipFile(compressed) as archive:
        info = archive.getinfo("manifest.json")
        payload = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
    raw = bytearray(compressed.read_bytes())
    raw[payload] = (raw[payload] & 0xF8) | 0x07  # Reserved DEFLATE block type.
    compressed.write_bytes(raw)
    _reject(lambda: WorldArchive.read(compressed), "could not be read")
    checks.append("corrupt ZIP DEFLATE becomes a recoverable import error")
    return checks
