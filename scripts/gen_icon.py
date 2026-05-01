#!/usr/bin/env python3
"""
Generate a minimalist app icon inspired by the pulsar (CP 1919) pulse-profile
waterfall plot from Joy Division's "Unknown Pleasures" album cover.

Outputs a 1024x1024 source PNG that the Tauri CLI can use to derive every
platform variant (macOS .icns, Windows .ico, Win11 Square*Logo tiles, Android,
iOS, etc.) via:  npx @tauri-apps/cli icon <source>.png
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# ---------- Configuration ----------
SIZE = 1024                       # master canvas (square)
# macOS Big Sur+ icon grid: the squircle should occupy ~824/1024 of the
# canvas, leaving ~100px of transparent margin on each side. This keeps the
# app icon visually the same size as system / first-party apps.
SQUIRCLE_SIZE = 824
SAFE_MARGIN = (SIZE - SQUIRCLE_SIZE) // 2     # 100
BG = (248, 249, 251, 255)         # near-white, faint cool tint
FG = (8, 16, 54, 255)             # very deep navy blue
CORNER_RADIUS = 185               # ~22.5% of SQUIRCLE_SIZE (Apple grid)
PADDING = 135                     # padding INSIDE the squircle (master px)
LINE_COUNT = 36                   # stacked pulse rows (kept low so the
                                  #   silhouette remains readable at 32px)
LINE_WIDTH = 5                    # stroke width in px @ 1024 master
SAMPLES = 768                     # samples per row
SEED = 19671128                   # CP 1919 discovery date (1967-11-28)

OUT_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
OUT_SOURCE = OUT_DIR / "icon-source.png"


def gauss(x: float, mu: float, sigma: float) -> float:
    return math.exp(-((x - mu) ** 2) / (2 * sigma * sigma))


def build_row_profile(rng: random.Random, width: int) -> list[float]:
    """Return pulse profile values in [0,1] for one row, length=width."""
    # Base low-amplitude noise (interstellar / receiver noise)
    base_noise = [rng.uniform(0.02, 0.08) for _ in range(width)]

    # 1-3 Gaussian peaks near the center (the pulsar pulse + occasional
    # interpulse). Their amplitude varies row-to-row to mimic the famous
    # rolling, organic look.
    peaks: list[tuple[float, float, float]] = []
    main_amp = rng.uniform(0.35, 1.0)
    main_mu = width * rng.uniform(0.46, 0.54)
    main_sigma = width * rng.uniform(0.025, 0.055)
    peaks.append((main_amp, main_mu, main_sigma))

    if rng.random() < 0.55:
        amp = main_amp * rng.uniform(0.25, 0.6)
        mu = main_mu + width * rng.uniform(-0.08, 0.08)
        sigma = width * rng.uniform(0.015, 0.04)
        peaks.append((amp, mu, sigma))

    if rng.random() < 0.2:
        amp = main_amp * rng.uniform(0.15, 0.35)
        mu = main_mu + width * rng.choice([-1, 1]) * rng.uniform(0.10, 0.18)
        sigma = width * rng.uniform(0.01, 0.025)
        peaks.append((amp, mu, sigma))

    profile = []
    for x in range(width):
        v = base_noise[x]
        for amp, mu, sigma in peaks:
            v += amp * gauss(x, mu, sigma)
        profile.append(v)

    # Smooth with a tiny moving average for cleaner curves.
    k = 5
    smoothed = []
    for i in range(width):
        a = max(0, i - k)
        b = min(width, i + k + 1)
        smoothed.append(sum(profile[a:b]) / (b - a))
    return smoothed


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def render_icon() -> Image.Image:
    rng = random.Random(SEED)

    # Render at 2x for supersampling, then downscale for crisp anti-aliasing.
    scale = 2
    S = SIZE * scale
    sq = SQUIRCLE_SIZE * scale
    margin = SAFE_MARGIN * scale
    pad = PADDING * scale
    radius = CORNER_RADIUS * scale
    line_w = max(1, LINE_WIDTH * scale)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # Background squircle (inset to Apple icon-grid safe area)
    bg_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(bg_layer).rounded_rectangle(
        (margin, margin, margin + sq - 1, margin + sq - 1),
        radius=radius,
        fill=BG,
    )
    img.alpha_composite(bg_layer)

    # Plot region (inset within the squircle)
    plot_left = margin + pad
    plot_right = margin + sq - pad
    plot_top = margin + int(pad * 1.25)
    plot_bottom = margin + sq - int(pad * 1.25)
    plot_w = plot_right - plot_left
    plot_h = plot_bottom - plot_top

    # Vertical spacing per row; rows can overshoot upward into previous rows
    # (that's what creates the iconic mountain-range look).
    row_step = plot_h / (LINE_COUNT - 1)
    max_amp = row_step * 4.0  # peaks reach ~4 row-heights tall

    # Pre-generate all rows
    rows = [build_row_profile(rng, SAMPLES) for _ in range(LINE_COUNT)]

    # Apply a gentle vertical envelope so middle rows have slightly taller
    # peaks than edge rows (purely aesthetic).
    envelope = [
        0.55 + 0.45 * math.sin(math.pi * (i / (LINE_COUNT - 1)))
        for i in range(LINE_COUNT)
    ]

    # Draw rows from BACK (top) to FRONT (bottom). Each row fills with the
    # background color below its curve so it occludes rows behind it
    # ("hidden line removal" effect).
    for i, profile in enumerate(rows):
        baseline_y = plot_top + i * row_step
        amp = max_amp * envelope[i]

        pts: list[tuple[float, float]] = []
        for j, v in enumerate(profile):
            x = plot_left + (j / (SAMPLES - 1)) * plot_w
            y = baseline_y - v * amp
            pts.append((x, y))

        # Filled polygon (occluder) — uses BG color so it hides curves behind.
        fill_poly = pts + [(plot_right, baseline_y + line_w),
                           (plot_left, baseline_y + line_w)]
        ImageDraw.Draw(img).polygon(fill_poly, fill=BG)

        # Stroked curve on top.
        ImageDraw.Draw(img).line(pts, fill=FG, width=line_w, joint="curve")

    # Re-apply rounded mask (inset to the safe-area squircle) so any peaks
    # that overshoot the squircle are clipped cleanly.
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (margin, margin, margin + sq - 1, margin + sq - 1),
        radius=radius,
        fill=255,
    )
    masked = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    masked.paste(img, (0, 0), mask)

    # Subtle inner highlight: 1px ring along the squircle edge.
    ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle(
        (margin + 1, margin + 1, margin + sq - 2, margin + sq - 2),
        radius=radius - 1,
        outline=(0, 0, 0, 28),
        width=max(1, scale),
    )
    masked.alpha_composite(ring)

    # Downscale with high-quality filter for anti-aliasing.
    final = masked.resize((SIZE, SIZE), Image.LANCZOS)
    return final


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    icon = render_icon()
    icon.save(OUT_SOURCE, format="PNG", optimize=True)
    print(f"Wrote {OUT_SOURCE} ({icon.size[0]}x{icon.size[1]})")


if __name__ == "__main__":
    main()
