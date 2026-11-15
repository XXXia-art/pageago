"""Export PageAgo's outlined wordmark and P monogram.

Development-only dependencies: Pillow and fontTools. No network access is used.
The bundled Instrument Serif source and its OFL license live in assets/brand/source.
"""
from html import escape
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "assets/brand"
SOURCE = BRAND / "source/InstrumentSerif-Italic.ttf"
INK = "#302F2B"
PAPER = "#F1EBDC"
TRACKING = -0.015


def layout(text):
    """Outline source glyphs, retaining kerning and optical letter spacing."""
    font = TTFont(SOURCE)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    units = font["head"].unitsPerEm
    metrics = ImageFont.truetype(str(SOURCE), units)
    result = []
    for index, char in enumerate(text):
        x = metrics.getlength(text[:index + 1]) - metrics.getlength(char) + index * units * TRACKING
        glyph = glyphs[cmap[ord(char)]]
        pen = SVGPathPen(glyphs)
        bounds = BoundsPen(glyphs)
        glyph.draw(pen)
        glyph.draw(bounds)
        result.append((char, x, pen.getCommands(), bounds.bounds))
    left = min(x + b[0] for _, x, _, b in result)
    bottom = min(b[1] for _, _, _, b in result)
    right = max(x + b[2] for _, x, _, b in result)
    top = max(b[3] for _, _, _, b in result)
    font.close()
    return result, (left, bottom, right, top), units


def svg(paths, width, height, color, transform, label):
    body = "\n".join(f'    <path transform="translate({x:.3f} 0)" d="{path}"/>' for _, x, path, _ in paths)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.3f}" height="{height:.3f}" '
        f'viewBox="0 0 {width:.3f} {height:.3f}" role="img" aria-label="{escape(label)}">\n'
        f'  <title>{escape(label)}</title>\n'
        '  <!-- Outlined from Instrument Serif Italic; source and OFL license: assets/brand/source. -->\n'
        f'  <g fill="{color}" transform="{transform}">\n{body}\n  </g>\n</svg>\n'
    )


def raster(paths, size, units, transform, color, background=None):
    """Draw source glyphs at high resolution, then downsample for crisp edges."""
    width, height = size
    scale, tx, ty = transform
    oversample = 3
    image = Image.new("RGBA", (round(width * oversample), round(height * oversample)),
                      background if background is not None else (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(SOURCE), round(units * scale * oversample))
    for char, x, _, _ in paths:
        draw.text(((tx + x * scale) * oversample, ty * oversample), char,
                  font=font, fill=color, anchor="ls")
    return image.resize((round(width), round(height)), Image.Resampling.LANCZOS)


def wordmark():
    paths, (left, bottom, right, top), units = layout("PageAgo")
    padding = units * 0.055
    width = right - left + padding * 2
    height = top - bottom + padding * 2
    tx, ty = padding - left, padding + top
    transform = f"translate({tx:.3f} {ty:.3f}) scale(1 -1)"
    for suffix, color in (("", INK), ("-dark", PAPER)):
        (BRAND / f"pageago-wordmark{suffix}.svg").write_text(
            svg(paths, width, height, color, transform, "PageAgo"), encoding="utf-8")
        pixel_width = 1400
        ratio = pixel_width / width
        raster(paths, (pixel_width, height * ratio), units, (ratio, tx * ratio, ty * ratio), color).save(
            BRAND / f"pageago-wordmark{suffix}.png", optimize=True)
    # A presentation render for chat previews; the actual brand assets stay transparent.
    preview = ROOT / "output/pageago-wordmark-preview.png"
    preview.parent.mkdir(exist_ok=True)
    ratio = 800 / width
    preview_tx = (1000 - (right - left) * ratio) / 2 - left * ratio
    preview_ty = (360 - (top - bottom) * ratio) / 2 + top * ratio
    raster(paths, (1000, 360), units, (ratio, preview_tx, preview_ty), INK, "#EFE8DC").save(preview)


def monogram():
    paths, (left, bottom, right, top), units = layout("P")
    ratio = min(88 / (right - left), 94 / (top - bottom))
    tx = (128 - (right - left) * ratio) / 2 - left * ratio
    ty = (128 - (top - bottom) * ratio) / 2 + top * ratio
    # A middle ink tone remains visible on both light and dark browser toolbars.
    color = "#7A7265"
    (BRAND / "pageago-icon.svg").write_text(svg(
        paths, 128, 128, color, f"translate({tx:.3f} {ty:.3f}) scale({ratio:.6f} {-ratio:.6f})", "PageAgo P monogram"
    ), encoding="utf-8")
    raster(paths, (512, 512), units, (ratio * 4, tx * 4, ty * 4), color).save(
        BRAND / "pageago-icon.png", optimize=True)
    app = ROOT / "prototypes/trace-next/assets/pageago"
    app.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        multiplier = size / 128
        raster(paths, (size, size), units, (ratio * multiplier, tx * multiplier, ty * multiplier), color).save(
            app / f"pageago-{size}.png", optimize=True)


def main():
    BRAND.mkdir(parents=True, exist_ok=True)
    wordmark()
    monogram()
    print("Exported PageAgo wordmarks, P monogram, and four extension icon sizes.")


if __name__ == "__main__":
    main()
