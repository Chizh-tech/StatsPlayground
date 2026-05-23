#!/usr/bin/env python3
"""
Generate the StatsPlayground app icon from ``app-icon.svg``.

Reads the SVG at the repo root, recolours its path to the brand navy, drops
it onto an Apple-style squircle background (with proper safe-area padding),
and rasterises a 1024x1024 source PNG that ``@tauri-apps/cli icon`` consumes
to derive every platform variant (macOS .icns, Windows .ico, Win11 tiles,
Android, iOS, etc.) via:

    npx @tauri-apps/cli icon src-tauri/icons/icon-source.png

Requirements (one-time):

    pip install --user cairosvg pillow

On macOS, ``cairosvg`` also needs the native ``libcairo`` library:

    brew install cairo
    # then run this script with libcairo on the loader path:
    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib python3 scripts/gen_icon.py
"""

from __future__ import annotations

from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw

# ---------- Configuration ----------
SIZE = 1024                       # master canvas (square)
# macOS Big Sur+ icon grid: the squircle occupies ~824/1024 of the canvas,
# leaving ~100px of transparent margin per side so the icon visually matches
# the size of system / first-party apps.
SQUIRCLE_SIZE = 824
SAFE_MARGIN = (SIZE - SQUIRCLE_SIZE) // 2       # 100
CORNER_RADIUS = 185                              # ~22.5% of SQUIRCLE_SIZE
# Inset INSIDE the squircle. The Font Awesome bullseye-spiral path leaves
# noticeable transparent space inside its 640x640 viewBox, so the rendered
# glyph reads smaller than the padding number alone suggests. Keep this
# value low enough that the artwork visually fills the squircle.
PADDING = 70                                     # ~8.5% of SQUIRCLE_SIZE

BG = (248, 249, 251, 255)         # near-white, faint cool tint
FG_HEX = "#081036"                # very deep navy blue
RING_RGBA = (0, 0, 0, 28)         # subtle 1px inner ring

ROOT = Path(__file__).resolve().parent.parent
SVG_SOURCE = ROOT / "app-icon.svg"
OUT_DIR = ROOT / "src-tauri" / "icons"
OUT_SOURCE = OUT_DIR / "icon-source.png"

# The source SVG uses viewBox="0 0 640 640" — extracted once so we can scale
# the artwork into the squircle's inner safe area.
SOURCE_VIEWBOX = 640


def build_wrapped_svg(path_data: str) -> bytes:
    """Wrap the raw FA path inside a 1024x1024 SVG with squircle bg + padding."""
    inner = SQUIRCLE_SIZE - 2 * PADDING                  # 554
    translate = SAFE_MARGIN + PADDING                    # 235
    scale = inner / SOURCE_VIEWBOX                       # 0.865625
    bg_hex = "#{:02x}{:02x}{:02x}".format(*BG[:3])

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}"
     viewBox="0 0 {SIZE} {SIZE}">
  <defs>
    <clipPath id="squircle">
      <rect x="{SAFE_MARGIN}" y="{SAFE_MARGIN}"
            width="{SQUIRCLE_SIZE}" height="{SQUIRCLE_SIZE}"
            rx="{CORNER_RADIUS}" ry="{CORNER_RADIUS}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#squircle)">
    <rect x="{SAFE_MARGIN}" y="{SAFE_MARGIN}"
          width="{SQUIRCLE_SIZE}" height="{SQUIRCLE_SIZE}"
          rx="{CORNER_RADIUS}" ry="{CORNER_RADIUS}" fill="{bg_hex}"/>
    <g transform="translate({translate} {translate}) scale({scale})"
       fill="{FG_HEX}">
      <path d="{path_data}"/>
    </g>
  </g>
</svg>""".encode("utf-8")


def extract_path_d(svg_text: str) -> str:
    """Pull the single ``d="..."`` attribute out of app-icon.svg."""
    marker = ' d="'
    start = svg_text.find(marker)
    if start < 0:
        raise SystemExit("app-icon.svg: no <path d=\"...\"> attribute found")
    start += len(marker)
    end = svg_text.find('"', start)
    if end < 0:
        raise SystemExit("app-icon.svg: unterminated d=\"...\" attribute")
    return svg_text[start:end]


def add_inner_ring(img: Image.Image) -> Image.Image:
    """Overlay a subtle 1px inner ring along the squircle edge."""
    ring = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle(
        (SAFE_MARGIN + 1, SAFE_MARGIN + 1,
         SAFE_MARGIN + SQUIRCLE_SIZE - 2,
         SAFE_MARGIN + SQUIRCLE_SIZE - 2),
        radius=CORNER_RADIUS - 1,
        outline=RING_RGBA,
        width=1,
    )
    img.alpha_composite(ring)
    return img


def main() -> None:
    if not SVG_SOURCE.exists():
        raise SystemExit(f"missing source SVG: {SVG_SOURCE}")

    path_d = extract_path_d(SVG_SOURCE.read_text(encoding="utf-8"))
    wrapped = build_wrapped_svg(path_d)

    png_bytes = cairosvg.svg2png(
        bytestring=wrapped,
        output_width=SIZE,
        output_height=SIZE,
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    from io import BytesIO
    img = Image.open(BytesIO(png_bytes)).convert("RGBA")
    img = add_inner_ring(img)
    img.save(OUT_SOURCE, format="PNG", optimize=True)
    print(f"Wrote {OUT_SOURCE} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()

