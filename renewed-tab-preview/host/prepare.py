"""Stage a verified copy of the official Renewed Tab web build for local preview."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEFAULT_SITE = ROOT / "output/private/renewed-tab/site"
# Public production build 6f5c6793117a2bbea572 from web.renewedtab.com.
ASSETS = {
    "main.js": "ab02c686daa3ce53e21c0cf32e5322e9a0f2c57636ec9211447b7e3789d464a9",
    "main.css": "70700e7a306b93f3fc7a40a40094ad109d892889f5cdfbce88ee716ab5af6b84",
    "locale.js": "7c8b41aaad215c02884ef52e38a4a26019fc24c88b27fc76d35fe0c2005d4565",
    "posthog.js": "0f1a10b9aecba539dc9d9ad98b5d521cc0c3b55c4ecb5ed3ef7ff23af067e753",
    "icon.svg": "84a2249fafac73791842067903569f3be063ef46ad2f021327ededefaf6e4179",
    "main.js.LICENSE.txt": "eb5ebe5e439082575ca0966059273161a3c08aa0bf312eb25a9915c0e75f6c43",
    "a8d6ac03c7b96b7acb62.ttf": "319cff6e7a31f0f2a41c475dca42890aa5d19fe16017e2290f8c1d4e14f76481",
    "beb7fe13e61b9e683c37.ttf": "8aaf23ac2ee9b3ef1b61c2390b3e6e02c0aa6a409d591c7fd7f3d4d7cf51e00b",
    "75371f53f06181df75f1.ttf": "baf44ce81636cc927fc27768437e5da853bac699e8aaf832d042f0dfed29b4b4",
}

# Public shortcuts from the agreed preview layout. Only use bundled icons.
SHORTCUTS = [
    ("哔哩哔哩", "https://www.bilibili.com/", "bilibili.com"),
    ("YouTube", "https://www.youtube.com/", "youtube.com"),
    ("ChatGPT", "https://chatgpt.com/", "chatgpt.com"),
    ("APIKEY.FAN", "https://apikey.fun/", "apikey.fun"),
    ("GitHub", "https://github.com/", "github.com"),
    ("必应", "https://www.bing.com/", "bing.com"),
]


def stage_distribution(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name, digest in ASSETS.items():
        target = destination / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
            continue
        with urlopen("https://web.renewedtab.com/" + name, timeout=30) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != digest:
            raise RuntimeError(f"Renewed Tab asset {name} differs from the verified build.")
        with tempfile.NamedTemporaryFile(dir=destination, delete=False) as handle:
            handle.write(content)
            temporary = Path(handle.name)
        temporary.replace(target)


def prepare(site: Path = DEFAULT_SITE) -> None:
    site = Path(site)
    stage_distribution(site / "upstream")
    icon_data = (ROOT / "prototypes/trace-next/extension/icons.js").read_text(encoding="utf-8")
    icons = json.loads(icon_data.split("=", 1)[1].strip().rstrip(";"))
    shortcut_dir = site / "shortcut-icons"
    shortcut_dir.mkdir(exist_ok=True)
    links = []
    for name, url, domain in SHORTCUTS:
        media_type, content = icons[domain]["data_url"].split(",", 1)
        extension = {"image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
                     "image/webp": "webp", "image/jpeg": "jpg", "image/svg+xml": "svg"}[media_type[5:].split(";")[0]]
        filename = f"{domain}.{extension}"
        (shortcut_dir / filename).write_bytes(base64.b64decode(content, validate=True))
        links.append({"id": domain, "title": name, "url": url, "icon": f"/shortcut-icons/{filename}"})
    (site / "shortcuts.js").write_text(
        "window.renewedPreviewLinks = " + json.dumps(links, ensure_ascii=False) + ";\n", encoding="utf-8")
    for name in ("index.html", "setup.js", "preview.css"):
        shutil.copyfile(HERE / name, site / name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", type=Path, default=DEFAULT_SITE)
    args = parser.parse_args()
    prepare(args.site)
