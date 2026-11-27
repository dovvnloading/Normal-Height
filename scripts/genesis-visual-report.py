#!/usr/bin/env python3
"""Render exact benchmark fields into an analytical comparison (NumPy/Matplotlib).

Example:
  python scripts/genesis-visual-report.py test-results/alpine-fields \
    --title 'Alpine uplift · 512 reference samples' --out test-results/alpine.png

The source and result share elevation colors, lighting and physical scale.
This is a data visualization, not a material render or an AI-created image.
"""
import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LightSource, ListedColormap, LogNorm, Normalize
from matplotlib.patches import Patch
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fields", type=Path)
    parser.add_argument("--title", default="World Genesis · numerical visual audit")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    metadata = json.loads((args.fields / "fields.json").read_text())
    shape = (metadata["height"], metadata["width"])

    def field(name):
        descriptor = metadata["files"][name]
        raw = (args.fields / descriptor["filename"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != descriptor["sha256"]:
            raise ValueError(f"Checksum mismatch for {name}")
        data = np.frombuffer(raw, dtype="u1" if descriptor["format"] == "uint8" else "<f4")
        if data.size != shape[0] * shape[1] or not np.isfinite(data).all():
            raise ValueError(f"Invalid dimensions or non-finite values in {name}")
        return data.reshape(shape).astype("float64")

    before = metadata["datum"] + field("before") * metadata["heightScale"]
    after = metadata["datum"] + field("after") * metadata["heightScale"]
    incision, area = field("incision"), field("drainageArea")
    lithology, hardness = field("lithology"), field("hardness")
    sx, sz = metadata["spacingX"], metadata["spacingZ"]
    extent = [0, (shape[1] - 1) * sx / 1000, (shape[0] - 1) * sz / 1000, 0]
    low, high = min(before.min(), after.min()), max(before.max(), after.max())
    normalizer = Normalize(low, high)
    light = LightSource(azdeg=315, altdeg=40)
    elevation = plt.get_cmap("gist_earth")
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                         "text.color": "#dedfd8", "axes.labelcolor": "#9daea9",
                         "xtick.color": "#9daea9", "ytick.color": "#9daea9",
                         "axes.edgecolor": "#374743", "axes.titleweight": "bold"})
    fig, axes = plt.subplots(2, 3, figsize=(17, 10), facecolor="#101a18")
    fig.subplots_adjust(top=0.86, bottom=0.14, left=0.05, right=0.93, hspace=0.34, wspace=0.46)
    for axis in axes.flat:
        axis.set_facecolor("#172421")
        axis.set_xlabel("East (km)")
        axis.set_ylabel("South (km)")

    for axis, heights, title in zip(axes[0, :2], [before, after], ["01  Authored terrain", "02  After Genesis"]):
        colors = elevation(normalizer(heights))[..., :3]
        shaded = light.shade_rgb(colors, heights, dx=sx, dy=sz, vert_exag=3, blend_mode="soft")
        axis.imshow(shaded, extent=extent, origin="upper", interpolation="nearest")
        axis.set_title(title, loc="left", pad=10)
    elevationbar = fig.colorbar(plt.cm.ScalarMappable(norm=normalizer, cmap=elevation),
                               ax=axes[0, :2], fraction=0.03, pad=0.025, shrink=0.75)
    elevationbar.set_label("Elevation (m); shared scale")

    image = axes[0, 2].imshow(incision, extent=extent, origin="upper", cmap="magma", vmin=0,
                              vmax=max(1, float(np.percentile(incision, 99.5))))
    axes[0, 2].set_title("03  Cumulative incision", loc="left", pad=10)
    fig.colorbar(image, ax=axes[0, 2], fraction=0.035, pad=0.025).set_label("Rock removed (m)")

    rock_colors = ["#7e7160", "#9b8265", "#c69e69", "#c6c4ad"]
    rock_names = ["Mudstone", "Siltstone", "Sandstone", "Limestone"]
    axes[1, 0].imshow(lithology, extent=extent, origin="upper", interpolation="nearest",
                      cmap=ListedColormap(rock_colors), vmin=-0.5, vmax=3.5)
    axes[1, 0].set_title("04  Exposed beds", loc="left", pad=10)
    axes[1, 0].legend(handles=[Patch(color=c, label=n) for c, n in zip(rock_colors, rock_names)],
                       loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2, frameon=False, fontsize=8)

    image = axes[1, 1].imshow(hardness, extent=extent, origin="upper", cmap="cividis", vmin=0, vmax=1)
    axes[1, 1].set_title("05  Rock competence", loc="left", pad=10)
    fig.colorbar(image, ax=axes[1, 1], fraction=0.035, pad=0.025).set_label("Soft → resistant (0–1)")

    image = axes[1, 2].imshow(area / 1e6, extent=extent, origin="upper", cmap="viridis",
                              norm=LogNorm(vmin=max(area.min() / 1e6, 1e-12), vmax=area.max() / 1e6))
    axes[1, 2].set_title("06  Weighted contributing area", loc="left", pad=10)
    fig.colorbar(image, ax=axes[1, 2], fraction=0.035, pad=0.025).set_label("Contributing area (km², log)")
    fig.text(0.05, 0.956, args.title, size=19, weight="bold", color="#e9e2c9")
    fig.text(0.05, 0.917,
             "Measured terrain fields · identical lighting and elevation scale · shading exaggeration 3×\n"
             "Reference-grid incision is reconstructed; categorical geology is sampled at physical coordinates.",
             size=10.5, color="#a9bbb4", linespacing=1.5)
    fig.text(0.05, 0.025,
             "Stylized geology, not calibrated geophysics. Incised rock is not a simulated sediment export. "
             "These are analytical maps, not final PBR assets.", size=9, color="#8d9f99")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.out, dpi=160, facecolor=fig.get_facecolor(), bbox_inches="tight", pad_inches=0.2)
    print(args.out)


if __name__ == "__main__":
    main()
