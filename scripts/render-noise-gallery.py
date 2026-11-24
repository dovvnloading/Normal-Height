#!/usr/bin/env python3
"""Render measured sampler buffers, never synthetic/fabricated terrain imagery.

Requires NumPy and Pillow. First run tests/noise-studio-report.test.ts with
NOISE_STUDIO_REPORT=1, then:
  python scripts/render-noise-gallery.py /absolute/report-directory docs/images
The 256² sampled fields are shown at 1:1 pixels on a fixed 0–1 grayscale.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
report = json.loads((source / "report.json").read_text())
destination.mkdir(parents=True, exist_ok=True)


def font(size):
    for name in ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


for group, title in [("presets", "18 artist presets"), ("kernels", "14 base generators")]:
    entries = [g for g in report["gallery"] if g["id"].startswith("preset-") == (group == "presets")]
    columns, size, gutter, margin = 6, 256, 24, 32
    rows = math.ceil(len(entries) / columns)
    width, height = columns * (size + gutter) - gutter + margin * 2, 142 + rows * 326 + 32
    canvas = Image.new("RGB", (width, height), "#171b19")
    draw = ImageDraw.Draw(canvas)
    draw.text((margin, 25), "NORMAL HEIGHT  /  NOISE STUDIO", fill="#b3c8ad", font=font(16))
    draw.text((margin, 55), title, fill="#eef0e9", font=font(30))
    subtitle = f"Seed {report['seed']}   ·   256 × 256 actual samples   ·   Fixed 0–1 grayscale   ·   No image auto-normalization"
    draw.text((margin, 101), subtitle, fill="#a2ada2", font=font(16))
    for index, entry in enumerate(entries):
        x = margin + (index % columns) * (size + gutter)
        y = 148 + (index // columns) * 326
        data = np.fromfile(source / f"{entry['id']}.f32", dtype="<f4").reshape(size, size)
        if not np.isfinite(data).all():
            raise ValueError(f"Invalid samples in {entry['id']}")
        pixels = np.rint(np.clip(data, 0, 1) * 255).astype(np.uint8)
        draw.text((x, y), entry["label"], fill="#eef0e9", font=font(17))
        canvas.paste(Image.fromarray(pixels).convert("RGB"), (x, y + 28))
        draw.text((x, y + 293), f"min {data.min():.3f}   mean {data.mean():.3f}   max {data.max():.3f}", fill="#a2ada2", font=font(12))
    canvas.save(destination / f"noise-studio-{group}.png", optimize=True)
    print(destination / f"noise-studio-{group}.png")
