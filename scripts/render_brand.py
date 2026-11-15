"""Export PageAgo's code-drawn mark. Pillow is a development-only dependency."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SCALE = 8
INK = "#39473F"
PAPER = "#F1EBDC"
FOLD = "#C9D0BF"


def render(size):
    image = Image.new("RGBA", (128 * SCALE, 128 * SCALE))
    draw = ImageDraw.Draw(image)

    def box(points):
        return tuple(round(n * SCALE) for n in points)

    def line(points, width=5.5):
        scaled = [(round(x * SCALE), round(y * SCALE)) for x, y in points]
        draw.line(scaled, fill=INK, width=round(width * SCALE), joint="curve")
        radius = width * SCALE / 2
        for x, y in scaled:
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=INK)

    draw.rounded_rectangle(box((0, 0, 128, 128)), radius=29*SCALE, fill=INK)
    draw.rounded_rectangle(box((30, 22, 95, 106)), radius=11*SCALE, fill=PAPER)
    draw.polygon([box((73, 22)), box((95, 22)), box((95, 44))], fill=INK)
    draw.polygon([box((73, 22)), box((73, 44)), box((95, 44))], fill=FOLD)
    # Clock arc, with a return arrow and hands; all coordinates match the SVG.
    draw.arc(box((43, 56, 83, 96)), start=210, end=510, fill=INK, width=round(5.5*SCALE))
    line([(47, 56), (47, 67), (58, 67)])
    line([(65, 65), (65, 78), (73, 83)])
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main():
    brand = ROOT / "assets/brand"
    brand.mkdir(parents=True, exist_ok=True)
    render(512).save(brand / "pageago-icon.png", optimize=True)
    app = ROOT / "prototypes/trace-next/assets/pageago"
    app.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        render(size).save(app / f"pageago-{size}.png", optimize=True)
    print("Exported PageAgo brand mark and extension icons.")


if __name__ == "__main__":
    main()
