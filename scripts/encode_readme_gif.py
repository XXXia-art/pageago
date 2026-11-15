"""Encode screenshots captured by capture_readme_media.mjs (optional Pillow tool)."""
import json
import sys
from pathlib import Path

from PIL import Image


def main():
    folder = Path(sys.argv[1]).resolve()
    spec = json.loads((folder / "capture.json").read_text(encoding="utf-8"))
    if spec["source"] != "synthetic-demo":
        raise ValueError("README media must use the synthetic demo")
    target = Path(__file__).resolve().parents[1] / "docs/media/pageago-interactions.gif"
    images = []
    palette = None
    for frame in spec["frames"]:
        image = Image.open(folder / "frames" / frame["file"]).convert("RGB")
        image.thumbnail((1200, 750), Image.Resampling.LANCZOS)
        if palette is None:
            palette = image.quantize(colors=160, method=Image.Quantize.MEDIANCUT)
        images.append(image.quantize(palette=palette, dither=Image.Dither.NONE))
    images[0].save(
        target,
        save_all=True,
        append_images=images[1:],
        duration=[frame["duration"] for frame in spec["frames"]],
        loop=0,
        optimize=True,
        disposal=1,
    )
    print(f"Saved {target} ({target.stat().st_size / 1024 / 1024:.2f} MiB)")


if __name__ == "__main__":
    main()
