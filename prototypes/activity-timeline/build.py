"""Build one completely offline HTML; never reads any browser database."""
import base64
import argparse
import json
from pathlib import Path

from demo import make_demo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def script_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def build(input_path=None, output_path=None):
    data = json.loads(Path(input_path).read_text(encoding="utf-8-sig")) if input_path else make_demo()
    icons = json.loads((ROOT / "skills/edge-learning-review/assets/site_icons.json").read_text(encoding="utf-8"))["icons"]
    wanted = ("arxiv.org", "github.com", "chatgpt.com", "bing.com", "bilibili.com", "youtube.com", "zhihu.com", "feishu.cn")
    packed = {domain: {"name": icons[domain]["name"], "data_url": icons[domain]["data_url"]} for domain in wanted}
    hf_icon = HERE / "assets/huggingface.ico"
    if hf_icon.is_file():
        packed["huggingface.co"] = {"name": "Hugging Face", "data_url": "data:image/x-icon;base64," + base64.b64encode(hf_icon.read_bytes()).decode("ascii")}
    replacements = {
        "/* ACTIVITY_CSS */": "\n".join((HERE / name).read_text(encoding="utf-8") for name in ("activity.css", "glass.css", "typography.css", "native.css")),
        "/* ACTIVITY_DATA */": script_json(data),
        "/* ACTIVITY_ICONS */": script_json(packed),
        "/* ACTIVITY_JS */": (HERE / "activity.js").read_text(encoding="utf-8"),
    }
    html = (HERE / "index.template.html").read_text(encoding="utf-8")
    for marker, content in replacements.items():
        if html.count(marker) != 1:
            raise ValueError(f"Missing or duplicated template marker: {marker}")
        html = html.replace(marker, content)
    output = Path(output_path) if output_path else ROOT / "activity.html"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(html, encoding="utf-8")
    if not input_path:
        (ROOT / "examples/demo_activity.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Built {output} ({len(html.encode('utf-8')):,} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    build(args.input, args.output)
