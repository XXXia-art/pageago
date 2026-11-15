"""Build PageAgo's offline preview and strict-CSP extension dashboard. No private data read."""
import base64
import json
import shutil
import zipfile
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def room_images_js():
    folder = HERE / "assets" / "daylight"
    images = {}
    for name in ("dawn", "day", "golden", "blue", "night", "curtains", "cat"):
        image = (folder / f"shanghai-{name}.webp").read_bytes()
        images[name] = "data:image/webp;base64," + base64.b64encode(image).decode("ascii")
    return "window.TRACE_DAYLIGHT_IMAGES=" + packed(images) + ";\n"


def demo():
    """Synthetic fixture, explicitly marked. Relative to build date; no personal history."""
    pages = [
        ("github.com", "openai / openai-agents-python", "/openai/openai-agents-python"),
        ("github.com", "shadcn / ui", "/shadcn-ui/ui"),
        ("arxiv.org", "Attention Is All You Need", "/abs/1706.03762"),
        ("chatgpt.com", "界面中的信息层级", "/"),
        ("figma.com", "PageAgo — Interface explorations", "/design/demo"),
        ("linear.app", "Planning the next release", "/features"),
        ("developer.apple.com", "Human Interface Guidelines", "/design/human-interface-guidelines/"),
        ("youtube.com", "Designing fluid interfaces", "/watch?v=example"),
        ("notion.so", "设计笔记", "/"),
        ("arxiv.org", "An Image is Worth 16x16 Words", "/abs/2010.11929"),
    ]
    schedule = [(8,35,22,8),(9,4,34,0),(9,40,17,3),(10,3,44,4),(10,49,9,5),(11,2,33,2),(11,40,16,0),(12,6,22,7),(13,14,19,8),(13,40,48,4),(14,32,29,6),(15,4,21,1),(15,29,24,3),(16,5,26,9),(16,37,31,4),(17,12,14,5),(17,31,23,0),(18,48,32,7),(19,25,18,3),(19,50,21,8),(20,21,35,1),(21,8,20,6),(21,38,16,4),(22,5,10,5)]
    sessions=[]
    for back in range(7):
        d=date.today()-timedelta(days=back)
        for i,(hour,minute,length,p) in enumerate(schedule):
            if back and (i+back)%3==0:
                continue
            host,title,path=pages[p]
            begin=datetime(d.year,d.month,d.day,hour,minute).astimezone()
            finish=begin+timedelta(minutes=length)
            sessions.append(dict(id=f"demo-{back}-{i}",url=f"https://{host}{path}",title=title,host=host,start=begin.astimezone(timezone.utc).isoformat(),end=finish.astimezone(timezone.utc).isoformat()))
    return dict(schema="trace.v1",source="synthetic-demo",sessions=sessions,recording=False,status="paused")


def main():
    icons=json.loads((ROOT / "skills/edge-learning-review/assets/site_icons.json").read_text(encoding="utf-8"))["icons"]
    icons={h:{"name":item["name"],"data_url":item["data_url"]} for h,item in icons.items() if item.get("data_url")}
    icons.update(json.loads((HERE / "assets/extra-icons.json").read_text(encoding="utf-8")))
    data_js="window.TRACE_DEMO="+packed(demo())+";\n"
    icon_js="window.TRACE_ICONS="+packed(icons)+";\n"
    css="\n".join((HERE / name).read_text(encoding="utf-8") for name in ("dashboard.css","date-control.css","page-highlight.css","day-search.css"))
    js=(HERE / "dashboard.js").read_text(encoding="utf-8")
    audio_js=(HERE / "dial-audio.js").read_text(encoding="utf-8")
    colors_js=(HERE / "site-colors.js").read_text(encoding="utf-8")
    date_js=(HERE / "date-control.js").read_text(encoding="utf-8")
    three_js=(HERE / "vendor/three-0.180.0.min.js").read_text(encoding="utf-8")
    capsule_js=(HERE / "date-capsule-three.js").read_text(encoding="utf-8")
    highlight_js=(HERE / "page-highlight.js").read_text(encoding="utf-8")
    date_motion_js=(HERE / "date-timeline-motion.js").read_text(encoding="utf-8")
    domain_js=(HERE / "vendor/tldts.umd.min.js").read_text(encoding="utf-8")
    domain_license=(HERE / "vendor/tldts.LICENSE").read_text(encoding="utf-8")
    domain_js="/*! Bundled tldts: https://github.com/remusao/tldts\n"+domain_license.replace("*/","* /")+"\n*/\n"+domain_js
    scripts = [
        ("tldts.umd.min.js", domain_js), ("demo.js", data_js), ("icons.js", icon_js),
        ("dial-audio.js", audio_js), ("site-colors.js", colors_js),
        ("three-0.180.0.min.js", three_js), ("date-capsule-three.js", capsule_js),
        ("date-control.js", date_js), ("page-highlight.js", highlight_js),
        ("date-timeline-motion.js", date_motion_js), ("daylight-images.js", room_images_js()),
        ("daylight-cat.js", (HERE / "daylight-cat.js").read_text(encoding="utf-8")),
        ("daylight-room.js", (HERE / "daylight-room.js").read_text(encoding="utf-8")),
        ("hour-dial.js", (HERE / "hour-dial.js").read_text(encoding="utf-8")),
        ("day-search.js", (HERE / "day-search.js").read_text(encoding="utf-8")), ("dashboard.js", js),
    ]
    template=(HERE / "index.template.html").read_text(encoding="utf-8")
    csp="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
    inline_scripts = "\n".join(source for _, source in scripts)
    favicon = base64.b64encode((HERE / "assets/pageago/pageago-32.png").read_bytes()).decode("ascii")
    standalone=template.replace("/* CSP */",csp).replace("<!-- FAVICON -->",f'<link rel="icon" type="image/png" href="data:image/png;base64,{favicon}">').replace("<!-- STYLE -->",f"<style>{css}</style>").replace("<!-- SCRIPTS -->",f"<script>{inline_scripts}</script>")
    output=ROOT / "output";output.mkdir(exist_ok=True)
    (output / "pageago.html").write_text(standalone,encoding="utf-8")
    dist=HERE / "dist";dist.mkdir(exist_ok=True)
    (dist / "index.html").write_text(standalone,encoding="utf-8")
    extension=HERE / "extension";extension.mkdir(exist_ok=True)
    ext_csp=csp.replace("script-src 'unsafe-inline'", "script-src 'self'").replace("style-src 'unsafe-inline'", "style-src 'self' 'unsafe-inline'").replace("img-src data:", "img-src 'self' data:")
    script_tags = "".join(f'<script src="{name}"></script>' for name, _ in scripts)
    extension_html=template.replace("/* CSP */",ext_csp).replace("<!-- FAVICON -->",'<link rel="icon" type="image/png" href="pageago-32.png">').replace("<!-- STYLE -->",'<link rel="stylesheet" href="dashboard.css">').replace("<!-- SCRIPTS -->",script_tags)
    (extension / "dashboard.html").write_text(extension_html,encoding="utf-8")
    (extension / "dashboard.css").write_text(css, encoding="utf-8")
    for name,content in scripts:
        (extension / name).write_text(content,encoding="utf-8")
    (extension / "daylight-dial.js").unlink(missing_ok=True)
    for name in ("tldts.LICENSE","tldts.NOTICE.json","three.LICENSE","three.NOTICE.json"):
        shutil.copyfile(HERE / "vendor" / name,extension / name)
    for size in (16,32,48,128):
        shutil.copyfile(HERE / f"assets/pageago/pageago-{size}.png",extension / f"pageago-{size}.png")
        (extension / f"trace-{size}.png").unlink(missing_ok=True)
    with zipfile.ZipFile(output / "pageago-extension.zip","w",zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(extension.iterdir()):
            if path.is_file():
                archive.write(path,path.name)
    print(f"Built offline preview: {output / 'pageago.html'}")
    print(f"Built unpacked extension: {extension}")


if __name__ == "__main__":
    main()
