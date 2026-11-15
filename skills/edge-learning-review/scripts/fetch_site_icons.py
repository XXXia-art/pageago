"""Download a fixed public-site icon catalog; never consumes browsing history.

Icons come only from each site's public root or its declared icon URLs.
Run explicitly to refresh assets/site_icons.json; page generation stays offline.
"""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


SITES = {
    "chatgpt.com": ("ChatGPT", "https://chatgpt.com/"),
    "openai.com": ("OpenAI", "https://openai.com/"),
    "github.com": ("GitHub", "https://github.com/"),
    "arxiv.org": ("arXiv", "https://arxiv.org/"),
    "bing.com": ("Bing", "https://www.bing.com/"),
    "youtube.com": ("YouTube", "https://www.youtube.com/"),
    "bilibili.com": ("哔哩哔哩", "https://www.bilibili.com/"),
    "feishu.cn": ("飞书", "https://www.feishu.cn/"),
    "gitee.com": ("Gitee", "https://gitee.com/"),
    "zhihu.com": ("知乎", "https://www.zhihu.com/"),
    "csdn.net": ("CSDN", "https://www.csdn.net/"),
    "toutiao.com": ("今日头条", "https://www.toutiao.com/"),
    "todesk.com": ("ToDesk", "https://www.todesk.com/"),
    "kyutai.org": ("Kyutai", "https://kyutai.org/"),
    "stripe.com": ("Stripe", "https://stripe.com/"),
    "apikey.fun": ("APIKEY.FAN", "https://apikey.fun/"),
    "aicz.vip": ("AICZ", "https://aicz.vip/"),
    "pingcode.com": ("PingCode", "https://www.pingcode.com/"),
    "codex-docs.com": ("Codex Docs", "https://www.codex-docs.com/"),
}

MAX_ICON = 128 * 1024


class Icons(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        rel = attrs.get("rel", "").lower().split()
        if tag == "link" and any("icon" in part for part in rel) and attrs.get("href"):
            self.links.append(attrs["href"])


def download(url, timeout, limit):
    if urlsplit(url).scheme != "https":
        raise ValueError("Icon URL must use HTTPS")
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 PageAgo-public-icon-catalog/1.0", "Accept": "image/*,text/html;q=0.5,*/*;q=0.1"})
    with urlopen(request, timeout=timeout) as response:
        data = response.read(limit + 1)
        return data, response.geturl()


def mime(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    raise ValueError("Response is not PNG, ICO, JPEG, or WebP")


def fetch_site(domain, name, root, timeout):
    tried, errors = set(), []

    def try_icon(url):
        if url in tried:
            return None
        tried.add(url)
        try:
            data, source = download(url, timeout, MAX_ICON)
            if len(data) > MAX_ICON:
                raise ValueError("Icon exceeds 128 KiB")
            if len(data) < 24:
                raise ValueError("Icon response is too short")
            content_type = mime(data)
            return {"name": name, "source": source, "data_url": "data:" + content_type + ";base64," + base64.b64encode(data).decode("ascii")}
        except Exception as error:
            errors.append(f"{url}: {type(error).__name__}: {error}")
            return None

    # The declared favicon is authoritative. A root /favicon.ico can be stale,
    # unrelated to the current page, or a legacy mascot (as on arxiv.org).
    try:
        body, home = download(root, timeout, 2 * 1024 * 1024)
        parser = Icons()
        parser.feed(body.decode("utf-8", "replace"))
        def priority(href):
            path = urlsplit(href).path.lower()
            if path.endswith(".png") and "favicon" in path:
                return 0 if ("32" in path or "48" in path) else 1
            if path.endswith(".ico"):
                return 2
            if path.endswith(".png"):
                return 3
            return 4
        # These URLs are explicitly declared as icons by the official public site.
        for href in sorted(parser.links[:10], key=priority):
            candidate = urljoin(home, href)
            if candidate.startswith("https://"):
                result = try_icon(candidate)
                if result:
                    return domain, result, []
    except Exception as error:
        errors.append(f"{root}: {type(error).__name__}: {error}")
    # Guess standard root locations only when declared icons are unavailable.
    # Requests never include browsing history, private page paths, or credentials.
    for suffix in ("favicon.ico", "apple-touch-icon.png"):
        result = try_icon(urljoin(root, suffix))
        if result:
            return domain, result, []
    return domain, None, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=6)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "assets/site_icons.json")
    parser.add_argument("--report", type=Path, default=Path(__file__).resolve().parents[1] / "references/site-icon-sources.md")
    args = parser.parse_args()
    icons, failures = {}, {}
    with ThreadPoolExecutor(max_workers=7) as pool:
        futures = [pool.submit(fetch_site, domain, name, root, args.timeout) for domain, (name, root) in SITES.items()]
        for future in as_completed(futures):
            domain, result, errors = future.result()
            if result:
                icons[domain] = result
                print("OK", domain, result["source"], flush=True)
            else:
                failures[domain] = errors
                print("UNAVAILABLE", domain, flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"version": 1, "icons": dict(sorted(icons.items()))}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# Site icon sources", "", "Collected from public official sites on " + datetime.now(timezone.utc).date().isoformat() + ".", "", "No browser history, page titles, query strings, credentials, or private tenant addresses were sent.", "Icons are unmodified website identity assets; site owners retain their respective rights.", "Generated reports embed these image bytes and never request a favicon service or remote image.", "Unknown sites keep a neutral local fallback; no replacement brand mark is invented.", "", "| Site | Official icon source |", "| --- | --- |"]
    for domain, result in sorted(icons.items()):
        lines.append(f"| {domain} | {result['source']} |")
    if failures:
        lines += ["", "## Unavailable icons", "", "These sites use the local generic fallback:", ""]
        for domain, errors in sorted(failures.items()):
            lines.append("- **" + domain + "**: " + "; ".join(errors))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Saved {len(icons)} icons; {len(failures)} unavailable.")


if __name__ == "__main__":
    main()
