# Bundled website icons

Icons identify their respective websites. They are stored locally so viewing a
timeline never sends browsing domains to a favicon service.

`extra-icons.json` contains PNG data URLs, decoded and re-encoded from public
official assets on 2026-11-08:

- Figma: https://static.figma.com/app/icon/2/icon-128.png
- Linear: https://linear.app/favicon.ico?v=2
- Notion: https://www.notion.com/front-static/favicon.ico
- Apple Developer: https://developer.apple.com/favicon.ico

Additional GitHub, arXiv, ChatGPT and YouTube assets reuse the workspace's existing
local icon catalogue. Unknown domains use a neutral initial, with no request to
the website. Brand ownership remains with the respective owners.

`pageago/pageago-*.png` are PageAgo's italic **P** monogram, exported at
16, 32, 48 and 128 pixels. The outlined wordmark, monogram and the Instrument
Serif font's OFL license live in [`assets/brand`](../../../assets/brand/).
`scripts/render_brand.py` reproduces the exports with Pillow and fontTools.
