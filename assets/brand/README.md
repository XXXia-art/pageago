# PageAgo wordmark

PageAgo uses a single italic serif wordmark, with slightly tightened spacing,
on a transparent background. There is no separate pictorial badge.

- `pageago-wordmark.svg` / `.png`: warm charcoal lettering for light surfaces.
- `pageago-wordmark-dark.svg` / `.png`: ivory lettering for dark surfaces.
- `pageago-icon.svg` / `.png`: the same typeface's **P**, for small browser icons.

The SVGs contain outlined paths, so they render without installed fonts,
external font requests, or CSS. The PNG wordmarks are 1,400 pixels wide.

The typeface is [Instrument Serif Italic](https://github.com/Instrument/instrument-serif).
Its unmodified source font, SIL Open Font License 1.1, and pinned download
provenance are in [`source/`](source/). The typeface belongs to its respective
authors; the project name remains PageAgo.

To reproduce the exports, install the development-only Pillow and fontTools
packages, then run `python scripts/render_brand.py` from the repository root.
The script reads bundled files and does not access the network.
