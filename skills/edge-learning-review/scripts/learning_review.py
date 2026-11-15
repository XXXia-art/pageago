"""Local, standard-library-only collect/classify/aggregate/review pipeline."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import urlsplit, urlunsplit

import edge_history_today as collector
import generate_timeline as timeline


DEFAULT_RULES = Path(__file__).resolve().parents[1] / 'references' / 'topic_rules.json'
KINDS = {'learning', 'other', 'unknown'}


def load(path):
    with Path(path).open(encoding='utf-8-sig') as stream:
        return json.load(stream)


def save(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return path.resolve()


def aware(value):
    instant = datetime.fromisoformat(value)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError('Time values must include a UTC offset')
    return instant


def validate(payload):
    if payload['status'] not in ('complete', 'partial'):
        raise ValueError('History collection failed; no analysis will be generated')
    start, end = aware(payload['start_time']), aware(payload['end_time'])
    if start > end:
        raise ValueError('start_time is after end_time')
    visits = payload['visits']
    if not isinstance(visits, list) or payload['event_count'] != len(visits):
        raise ValueError('event_count does not match visits')
    if not isinstance(payload['profiles'], list) or not isinstance(payload['errors'], list):
        raise ValueError('profiles/errors must be lists')
    if (payload['status'] == 'complete') != (not payload['errors']):
        raise ValueError('Collection status and errors disagree')
    profile_counts = {}
    for profile in payload['profiles']:
        name = profile['profile']
        if name in profile_counts:
            raise ValueError('Repeated profile metadata')
        profile_counts[name] = profile['event_count']
    seen, actual = set(), Counter()
    for event in visits:
        if not isinstance(event['profile'], str) or not event['profile']:
            raise ValueError('Invalid profile')
        if type(event['visit_id']) is not int:
            raise ValueError('Invalid visit_id')
        identity = (event['profile'], event['visit_id'])
        if identity in seen:
            raise ValueError(f'Duplicate visit identity: {identity}')
        seen.add(identity)
        actual[event['profile']] += 1
        if not start <= aware(event['visit_time']) <= end:
            raise ValueError(f'Visit outside declared coverage: {identity}')
        for field in ('url', 'title'):
            if event[field] is not None and not isinstance(event[field], str):
                raise ValueError(f'{field} must be a string or null')
    if set(actual) - set(profile_counts) or any(actual[k] != v for k, v in profile_counts.items()):
        raise ValueError('Profile event counts disagree with visits')


def topic_identity(item):
    topic_id, label, kind = item['topic_id'], item['topic_label'], item['kind']
    if not isinstance(topic_id, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', topic_id):
        raise ValueError('Topic IDs must use lowercase letters, digits and hyphens')
    if not isinstance(label, str) or not label.strip() or kind not in KINDS:
        raise ValueError('Invalid topic label/kind')
    return topic_id, label, kind


def classify(payload, rules, assignments=None):
    validate(payload)
    compiled = []
    for rule in rules['rules']:
        topic = {'topic_id': rule['id'], 'topic_label': rule['label'], 'kind': rule['kind']}
        topic_identity(topic)
        compiled.append((re.compile(rule['pattern'], re.IGNORECASE), topic))
    identities = {(e['profile'], e['visit_id']) for e in payload['visits']}
    overrides = {}
    for item in (assignments or {}).get('assignments', []):
        key = (item['profile'], item['visit_id'])
        if key not in identities or key in overrides:
            raise ValueError(f'Assignment references unknown or repeated event: {key}')
        topic_identity(item)
        if not isinstance(item['reason'], str) or not item['reason'].strip():
            raise ValueError('Assignment requires an evidence-based reason')
        overrides[key] = item
    events, topics = [], {}
    for event in payload['visits']:
        key = (event['profile'], event['visit_id'])
        match = overrides.get(key)
        if match:
            classified = {k: match[k] for k in ('topic_id', 'topic_label', 'kind')}
            reason, source = match['reason'], 'semantic_assignment'
        else:
            classified = {'topic_id': 'unclassified', 'topic_label': '待确认的其他浏览', 'kind': 'unknown'}
            reason, source = '标题与 URL 不足以确定具体学习主题', 'unclassified'
            text = (event['title'] or '') + '\n' + (event['url'] or '')
            for pattern, topic in compiled:
                if pattern.search(text):
                    classified = dict(topic)
                    reason, source = f"标题或 URL 匹配候选规则 {topic['topic_id']}；仅证明访问", 'rule'
                    break
        topic_id, label, kind = topic_identity(classified)
        if topic_id in topics and topics[topic_id] != (label, kind):
            raise ValueError(f'Conflicting topic label/kind: {topic_id}')
        topics[topic_id] = (label, kind)
        events.append({**event, **classified, 'classification_reason': reason,
                       'classification_source': source})
    return {**payload, 'schema_version': 1, 'stage': 'classify', 'visits': events}


def clean_text(text):
    return ''.join(c for c in (text or '') if unicodedata.category(c) != 'Cf')


def display_url(url):
    try:
        parts = urlsplit(url or '')
        if parts.scheme.lower() not in ('http', 'https') or not parts.hostname:
            return ''
        host = parts.hostname
        if ':' in host:
            host = f'[{host}]'
        if parts.port is not None:
            host += f':{parts.port}'
        return urlunsplit((parts.scheme, host, parts.path, '', ''))
    except ValueError:
        return ''


def aggregate(payload):
    validate(payload)
    groups = {}
    for event in payload['visits']:
        topic_id, label, kind = topic_identity(event)
        if topic_id not in groups:
            groups[topic_id] = {'topic_id': topic_id, 'topic_label': label, 'kind': kind,
                                'event_count': 0, 'pages': {}, 'evidence_ids': [],
                                'first_visit': event['visit_time'], 'last_visit': event['visit_time'],
                                'activity_seconds': None, 'learning_seconds': None}
        group = groups[topic_id]
        if (group['topic_label'], group['kind']) != (label, kind):
            raise ValueError(f'Conflicting topic metadata: {topic_id}')
        group['event_count'] += 1
        evidence_id = f"{event['profile']}:{event['visit_id']}"
        group['evidence_ids'].append(evidence_id)
        if aware(event['visit_time']) < aware(group['first_visit']):
            group['first_visit'] = event['visit_time']
        if aware(event['visit_time']) > aware(group['last_visit']):
            group['last_visit'] = event['visit_time']
        identity = (event['url'] or evidence_id).split('#', 1)[0]
        page_key = hashlib.sha256(identity.encode('utf-8')).hexdigest()
        if page_key not in group['pages']:
            group['pages'][page_key] = {'page_key': page_key, 'url': display_url(event['url']),
                                       'title': clean_text(event['title']) or '（无标题）',
                                       'event_count': 0, 'evidence_ids': []}
        page = group['pages'][page_key]
        page['event_count'] += 1
        page['evidence_ids'].append(evidence_id)
    topics = []
    for group in groups.values():
        group['unique_pages'] = len(group['pages'])
        group['pages'] = sorted(group['pages'].values(), key=lambda p: (-p['event_count'], p['page_key']))
        topics.append(group)
    topics.sort(key=lambda t: ({'learning': 0, 'unknown': 1, 'other': 2}[t['kind']], -t['event_count'], t['topic_id']))
    return {'schema_version': 1, 'stage': 'aggregate',
            **{k: payload[k] for k in ('status', 'start_time', 'end_time', 'event_count', 'profiles', 'errors')},
            'source': payload.get('source'), 'duration_basis': 'unavailable_history_only',
            'activity_seconds': None, 'learning_seconds': None, 'topics': topics}


def md(text):
    text = clean_text(str(text)).replace('\n', ' ').replace('\r', ' ')
    for char in ('\\', '`', '*', '_', '[', ']', '<', '>', '|'):
        text = text.replace(char, '\\' + char)
    return text


def render_report(summary):
    if summary['stage'] != 'aggregate' or summary['duration_basis'] != 'unavailable_history_only':
        raise ValueError('Unsupported summary stage/duration basis')
    if sum(t['event_count'] for t in summary['topics']) != summary['event_count']:
        raise ValueError('Topic counts disagree with total')
    if summary['activity_seconds'] is not None or summary['learning_seconds'] is not None:
        raise ValueError('History-only data cannot establish duration')
    date = aware(summary['start_time']).date().isoformat()
    lines = [f'# {date} 学习复盘', '',
             f"数据覆盖：{summary['start_time']} 至 {summary['end_time']}。",
             f"实际访问事件 **{summary['event_count']}** 条；成功配置文件 {len(summary['profiles'])} 个；"
             f"失败配置文件 {len(summary['errors'])} 个；状态：{summary['status']}。", '',
             '以下主题根据页面标题和 URL 推断，只能确认访问，不能确认读完或掌握。',
             '页面活动时长：**未知**；真实学习时长：**未知**。访问间隔、首次与末次访问跨度均不作为时长。', '',
             '| 主题 | 类型 | 访问事件 | 不同页面 | 页面活动时长 |',
             '| --- | --- | ---: | ---: | --- |']
    kind_names = {'learning': '学习候选', 'other': '其他浏览', 'unknown': '待确认'}
    for topic in summary['topics']:
        lines.append(f"| {md(topic['topic_label'])} | {kind_names[topic['kind']]} | {topic['event_count']} | "
                     f"{topic['unique_pages']} | 未知 |")
    lines += ['', '## 学习主题的访问证据', '']
    learning = [t for t in summary['topics'] if t['kind'] == 'learning']
    if not learning:
        lines += ['当前记录不足以识别明确的学习主题。', '']
    for topic in learning:
        lines += [f"### {md(topic['topic_label'])}", '',
                  f"{topic['event_count']} 次访问，{topic['unique_pages']} 个页面。"
                  f"首次：{topic['first_visit']}；末次：{topic['last_visit']}。", '']
        for page in topic['pages'][:6]:
            # Plain escaped URLs avoid interpreting imported URLs as Markdown instructions.
            link = f" — {md(page['url'])}" if page['url'] else ''
            lines.append(f"- {md(page['title'])}{link}（{page['event_count']} 次；"
                         f"证据：{md(', '.join(page['evidence_ids']))}）")
        if len(topic['pages']) > 6:
            lines.append('- 更多页面与全部证据见 learning_summary.json。')
        lines.append('')
    lines += ['## 待确认与后续建议', '',
              '访问记录没有学习笔记、完成状态或用户问题记录，因此无法确认今天实际解决了哪些问题、还有哪些问题未解决。', '']
    for topic in learning:
        lines.append(f"- 建议：为“{md(topic['topic_label'])}”补一条收获或疑问，确认是否实际阅读、运行或复现；此建议不代表已经遇到该问题。")
    unknown_count = sum(t['event_count'] for t in summary['topics'] if t['kind'] == 'unknown')
    if unknown_count:
        lines.append(f'- 有 {unknown_count} 次访问主题待确认，可用 assignments 修订，避免仅凭站点归类。')
    if summary['errors']:
        lines += ['', '部分配置文件读取失败，统计仅代表成功读取部分；具体原因见 learning_summary.json 的 errors。']
    lines += ['', '报告仅使用本地历史记录。URL 展示移除了凭据、查询参数和 fragment；未读取网页正文。', '']
    return date, '\n'.join(lines)


def write_report(summary, output):
    date, report = render_report(summary)
    path = output / f'learning_report_{date}.md'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report, encoding='utf-8')
    return path.resolve()


def collection(args):
    root = args.user_data_dir
    if root is None:
        local = os.environ.get('LOCALAPPDATA')
        if not local:
            raise ValueError('LOCALAPPDATA is unset; supply --user-data-dir')
        root = Path(local) / 'Microsoft' / 'Edge' / 'User Data'
    start, end = collector.today_window()
    events, profiles, errors = collector.collect(root, start, end,
                                                 copy_if_locked=args.copy_if_locked,
                                                 scratch_parent=Path.cwd())
    if not profiles:
        raise ValueError('All profiles failed; refusing to analyze stale output from an earlier run')
    paths = collector.export(args.output_dir, events, profiles, errors, start, end)
    print(f'Events collected: {len(events)}; successful profiles: {len(profiles)}; failed: {len(errors)}')
    for path in paths:
        print(path)
    return int(bool(errors))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=('collect', 'classify', 'aggregate', 'review', 'run'))
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output-dir', type=Path, default=Path.cwd() / 'output')
    parser.add_argument('--user-data-dir', type=Path)
    parser.add_argument('--copy-if-locked', action='store_true')
    parser.add_argument('--rules', type=Path, default=DEFAULT_RULES)
    parser.add_argument('--assignments', type=Path)
    args = parser.parse_args(argv)
    try:
        code = 0
        if args.stage == 'collect' or (args.stage == 'run' and args.input is None):
            code = collection(args)
            if args.stage == 'collect':
                return code
            args.input = args.output_dir / 'edge_history_today.json'
        if args.input is None:
            parser.error('--input is required for classify/aggregate/review')
        payload = load(args.input)
        if args.stage in ('classify', 'run'):
            payload = classify(payload, load(args.rules), load(args.assignments) if args.assignments else None)
            payload['source'] = {'path': str(args.input.resolve()), 'sha256': collector.file_digest(args.input)}
            print(save(args.output_dir / 'learning_classified.json', payload))
            if args.stage == 'classify':
                return int(payload['status'] != 'complete')
        if args.stage in ('aggregate', 'run'):
            payload = aggregate(payload)
            print(save(args.output_dir / 'learning_summary.json', payload))
            if args.stage == 'aggregate':
                return int(payload['status'] != 'complete')
        print(write_report(payload, args.output_dir))
        # A summary intentionally omits individual event timestamps; use the classified
        # source only after verifying that it belongs to this exact summary.
        classified_path = args.output_dir / 'learning_classified.json'
        if classified_path.is_file():
            classified = load(classified_path)
            matching = all(classified.get(key) == payload.get(key)
                           for key in ('start_time', 'end_time', 'event_count', 'source'))
            if matching:
                matching = aggregate(classified)['topics'] == payload['topics']
            if matching:
                html_path = args.output_dir / 'edge_history_timeline.html'
                timeline.build(classified_path, html_path)
                print(html_path.resolve())
        print(f"Events: {payload['event_count']}; topics: {len(payload['topics'])}; durations: unknown")
        return code or int(payload['status'] != 'complete')
    except (OSError, ValueError, KeyError, TypeError, collector.HistoryError, re.error) as error:
        print(f'ERROR: {type(error).__name__}: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
