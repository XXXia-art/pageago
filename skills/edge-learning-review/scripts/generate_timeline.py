"""Build an offline, self-contained Edge visit timeline using the standard library."""

import argparse
import base64
from datetime import date, datetime
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit, urlunsplit


TEMPLATE = Path(__file__).resolve().parents[1] / 'assets' / 'edge_history_timeline.template.html'
THEME = TEMPLATE.with_name('timeline_theme.css')
ICONS = TEMPLATE.with_name('site_icons.json')


def icon_catalog():
    """Read bundled public icons only; never make network requests for history URLs."""
    catalog = json.loads(ICONS.read_text(encoding='utf-8'))
    if catalog.get('version') != 1 or not isinstance(catalog.get('icons'), dict):
        raise ValueError('Invalid bundled site icon catalog')
    for domain, entry in catalog['icons'].items():
        if not re.fullmatch(r'[a-z0-9.-]+\.[a-z]{2,}', domain):
            raise ValueError('Invalid icon domain')
        address = entry.get('data_url', '')
        match = re.fullmatch(r'data:image/(png|x-icon|vnd.microsoft.icon|jpeg|webp);base64,([A-Za-z0-9+/=]+)', address)
        if not match:
            raise ValueError('Site icons must be embedded raster images')
        raw = base64.b64decode(match[2], validate=True)
        if not 4 <= len(raw) <= 128 * 1024:
            raise ValueError('Site icon exceeds the size limit')
        if not (raw.startswith(b'\x89PNG\r\n\x1a\n') or raw.startswith(b'\x00\x00\x01\x00')
                or raw.startswith(b'\xff\xd8\xff') or (raw.startswith(b'RIFF') and raw[8:12] == b'WEBP')):
            raise ValueError('Invalid raster icon signature')
    return catalog


def aware(value):
    result = datetime.fromisoformat(value)
    if result.utcoffset() is None:
        raise ValueError('Visit and coverage timestamps must include a UTC offset')
    return result


def public_url(value):
    """No credentials, search parameters, fragments or executable URL schemes."""
    try:
        parts = urlsplit(value or '')
        if parts.scheme not in ('http', 'https') or not parts.hostname:
            return '', '本地或内部页面'
        host = parts.hostname
        authority = f'[{host}]' if ':' in host else host
        if parts.port is not None:
            authority += f':{parts.port}'
        return urlunsplit((parts.scheme, authority, parts.path, '', '')), host
    except ValueError:
        return '', '无法识别的地址'


def prepare(payload):
    if payload['status'] not in ('complete', 'partial'):
        raise ValueError('Cannot visualize a failed collection as valid data')
    start, end = aware(payload['start_time']), aware(payload['end_time'])
    if start > end or payload['event_count'] != len(payload['visits']):
        raise ValueError('Invalid coverage or event count')
    if bool(payload.get('errors')) != (payload['status'] == 'partial'):
        raise ValueError('Collection status and errors disagree')
    events, seen, topics = [], set(), {}
    for event in payload['visits']:
        profile, visit_id = event['profile'], event['visit_id']
        if not isinstance(profile, str) or not profile or type(visit_id) is not int:
            raise ValueError('Invalid profile/visit ID')
        identity = (profile, visit_id)
        if identity in seen:
            raise ValueError(f'Duplicate visit: {identity}')
        seen.add(identity)
        timestamp = aware(event['visit_time'])
        if not start <= timestamp <= end:
            raise ValueError(f'Visit outside coverage: {identity}')
        url, title = event['url'], event['title']
        if any(v is not None and not isinstance(v, str) for v in (url, title)):
            raise ValueError('URL/title must be text or null')
        safe_url, domain = public_url(url)
        topic_id = event.get('topic_id', 'unclassified')
        label = event.get('topic_label', '未分类网页')
        kind = event.get('kind', 'unknown')
        if not isinstance(topic_id, str) or not isinstance(label, str) or kind not in ('learning', 'other', 'unknown'):
            raise ValueError('Invalid topic metadata')
        if topic_id in topics and topics[topic_id] != (label, kind):
            raise ValueError('Conflicting topic metadata')
        topics[topic_id] = (label, kind)
        # Keep query-distinct pages distinct even though displayed URLs omit parameters.
        page_identity = (url or f'{profile}:{visit_id}').split('#', 1)[0]
        page_key = hashlib.sha256(page_identity.encode('utf-8')).hexdigest()
        events.append({'id': f'{profile}:{visit_id}', 'profile': profile, 'visit_id': visit_id,
                       'time': event['visit_time'], 'title': title or '（无标题）',
                       'url': safe_url, 'domain': domain, 'page_key': page_key,
                       'topic_id': topic_id, 'topic_label': label, 'kind': kind})
    return {'schema_version': 1, 'dataset_kind': 'demo' if payload.get('dataset_kind') == 'demo' else 'personal',
            'status': payload['status'], 'start_time': payload['start_time'],
            'end_time': payload['end_time'], 'event_count': len(events),
            'failed_profiles': len(payload.get('errors', [])), 'events': events}


def build(input_path, output_path):
    payload = json.loads(input_path.read_text(encoding='utf-8-sig'))
    data = prepare(payload)
    embedded = json.dumps(data, ensure_ascii=False).replace('&', '\\u0026').replace('<', '\\u003c').replace('>', '\\u003e')
    embedded = embedded.replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    template = TEMPLATE.read_text(encoding='utf-8')
    # The source document is also a usable offline importer. Replace its valid
    # preview data and embedded fallback theme without leaving build placeholders.
    for pattern, replacement in (
        (r'(<style id="timeline-theme">)[\s\S]*?(</style>)', THEME.read_text(encoding='utf-8')),
        (r'(<script id="timeline-data" type="application/json">)[\s\S]*?(</script>)', embedded),
        (r'(<script id="site-icons" type="application/json">)[\s\S]*?(</script>)',
         json.dumps(icon_catalog(), ensure_ascii=True).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')),
    ):
        if len(re.findall(pattern, template)) != 1:
            raise ValueError('Template must have exactly one theme and one data block')
        template = re.sub(pattern, lambda match: match[1] + replacement + match[2], template)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(template, encoding='utf-8')
    return data


def default_input(root=Path('output')):
    """Find known exports in output and its immediate calendar-date folders."""
    def calendar_date(name):
        try:
            return len(name) == 10 and date.fromisoformat(name).isoformat() == name
        except ValueError:
            return False

    folders = [root]
    if root.is_dir():
        resolved_root = root.resolve()
        folders.extend(folder for folder in sorted(root.iterdir())
                       if calendar_date(folder.name) and folder.is_dir()
                       and folder.resolve().parent == resolved_root)
    choices = []
    for folder in folders:
        dated = [path for path in sorted(folder.glob('edge_history_????-??-??.json'))
                 if calendar_date(path.stem[len('edge_history_'):])]
        choices.extend(path for path in (folder/'learning_classified.json',
                                        folder/'edge_history_today.json', *dated)
                       if path.is_file())
    if not choices:
        return None

    def priority(path):
        try:
            cutoff = aware(json.loads(path.read_text(encoding='utf-8-sig'))['end_time'])
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ValueError(f'Cannot read export coverage in {path}: '
                             f'{type(error).__name__}: {error}') from error
        return cutoff, path.name == 'learning_classified.json', path.stat().st_mtime_ns, str(path)

    return max(choices, key=priority)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, default=Path('output/edge_history_timeline.html'))
    args = parser.parse_args(argv)
    source = args.input
    try:
        if source is None:
            source = default_input()
            if source is None:
                parser.error('No export found; supply --input')
        data = build(source, args.output)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'ERROR: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    print(f'Source export: {source.resolve()}')
    print(f"Visit events: {data['event_count']}; coverage: {data['start_time']} to {data['end_time']}")
    print(args.output.resolve())
    return 0


if __name__ == '__main__':
    sys.exit(main())
