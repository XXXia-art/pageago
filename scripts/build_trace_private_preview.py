"""Bundle an explicit local PageAgo export into a separate offline preview."""
import argparse
import json
from pathlib import Path


GROUPED_ROOT = '<html lang="zh-CN" data-label-layout="split" data-site-groups="true">'


def add_grouped_layout(html, experiments):
    root_tag = '<html lang="zh-CN">'
    start_tag = '  function renderTags(){'
    end_tag = '  function positionBlock(block){'
    if any(html.count(tag) != 1 for tag in (root_tag, start_tag, end_tag, '</style>')):
        raise ValueError('Unsupported PageAgo preview template for grouped labels.')
    start, end = html.index(start_tag), html.index(end_tag)
    if start >= end or '  function layoutTags(){' not in html[start:end]:
        raise ValueError('Cannot locate the PageAgo label renderer.')
    scripts = '\n'.join((experiments / name).read_text(encoding='utf-8')
                        for name in ('site-time-groups.js', 'grouped-labels.js'))
    css = (experiments / 'grouped-labels.css').read_text(encoding='utf-8')
    html = html[:start] + scripts + '\n' + html[end:]
    return html.replace(root_tag, GROUPED_ROOT, 1).replace('</style>', css + '\n</style>', 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    layout = parser.add_mutually_exclusive_group()
    layout.add_argument('--split-labels', action='store_true', help='Place crowded page labels on both sides of the timeline.')
    layout.add_argument('--grouped-labels', action='store_true', help='Group nearby pages by site and separate them when zoomed in.')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    template = root / 'output/pageago.html'
    if args.output.resolve() in {template.resolve(), args.input.resolve()}:
        parser.error('Use a separate private output file.')
    if args.grouped_labels and args.output.exists():
        with args.output.open('rb') as existing:
            existing.readline(128)
            if existing.readline(256).strip() != GROUPED_ROOT.encode():
                parser.error('Choose a separate output file for the grouped preview.')
    payload = json.loads(args.input.read_text(encoding='utf-8'))
    if payload.get('schema') != 'trace.v1' or not isinstance(payload.get('sessions'), list):
        parser.error('Input must be a trace.v1 export.')
    if payload.get('source') == 'synthetic-demo':
        parser.error('This builder requires an actual local export.')
    html = template.read_text(encoding='utf-8')
    if args.grouped_labels:
        try:
            html = add_grouped_layout(html, root / 'prototypes/trace-next/experiments')
        except (OSError, ValueError) as exc:
            parser.error(str(exc))
    elif args.split_labels:
        html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-label-layout="split">', 1)
    marker = 'window.TRACE_DEMO='
    if html.count(marker) != 1 or 'validate(window.TRACE_LOCAL_DATA||window.TRACE_DEMO)' not in html:
        parser.error('Rebuild the current PageAgo preview first.')
    packed = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    packed = packed.replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    html = html.replace(marker, 'window.TRACE_LOCAL_DATA=' + packed + ';\n' + marker, 1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html, encoding='utf-8')
    print(json.dumps({'output': str(args.output.resolve()), 'sessions': len(payload['sessions']),
                     'pages': len({s['url'] for s in payload['sessions']}),
                     'source': payload.get('source')}, ensure_ascii=True))


if __name__ == '__main__':
    main()
