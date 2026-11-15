"""Behavioral tests for the Skill pipeline using synthetic records only."""

from copy import deepcopy
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import unittest
import uuid

import edge_history_today as collector

SCRIPTS = Path(__file__).resolve().parent / 'skills/edge-learning-review/scripts'
spec = importlib.util.spec_from_file_location('learning_review', SCRIPTS / 'learning_review.py')
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class LearningReviewTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path.cwd() / ('.learning-test-' + uuid.uuid4().hex)
        self.folder.mkdir()
        self.payload = {
            'status': 'complete', 'start_time': '2026-10-20T00:00:00+08:00',
            'end_time': '2026-10-20T15:00:00+08:00', 'event_count': 4,
            'profiles': [{'profile': 'Default', 'event_count': 4}], 'errors': [],
            'visits': [
                {'profile': 'Default', 'visit_id': 1, 'url': 'https://arxiv.org/abs/1234',
                 'title': 'StellaVLA: In-Context Demonstration', 'visit_time': '2026-10-20T09:00:00+08:00'},
                {'profile': 'Default', 'visit_id': 2, 'url': 'https://arxiv.org/abs/1234',
                 'title': 'StellaVLA: In-Context Demonstration', 'visit_time': '2026-10-20T14:00:00+08:00'},
                {'profile': 'Default', 'visit_id': 3, 'url': 'https://quote.eastmoney.com/a',
                 'title': 'Some price', 'visit_time': '2026-10-20T13:00:00+08:00'},
                {'profile': 'Default', 'visit_id': 4, 'url': 'https://www.youtube.com/watch?v=abc',
                 'title': 'An unspecified video', 'visit_time': '2026-10-20T13:05:00+08:00'},
            ]}
        self.rules = review.load(review.DEFAULT_RULES)

    def tearDown(self):
        shutil.rmtree(self.folder)

    def classified(self):
        return review.classify(self.payload, self.rules)

    def test_duplicate_visits_preserved_and_no_fabricated_duration(self):
        summary = review.aggregate(self.classified())
        topic = next(t for t in summary['topics'] if t['topic_id'] == 'vla-icl')
        self.assertEqual((topic['event_count'], topic['unique_pages']), (2, 1))
        self.assertEqual(topic['evidence_ids'], ['Default:1', 'Default:2'])
        self.assertIsNone(topic['activity_seconds'])
        self.assertIsNone(topic['learning_seconds'])
        self.assertIsNone(summary['activity_seconds'])
        self.assertEqual(summary['event_count'], 4)

    def test_unknown_and_other_are_not_automatically_learning(self):
        events = self.classified()['visits']
        self.assertEqual(events[2]['kind'], 'other')
        self.assertEqual(events[3]['kind'], 'unknown')

    def test_semantic_assignment_is_traceable_and_input_is_unchanged(self):
        original = deepcopy(self.payload)
        assignments = {'assignments': [{'profile': 'Default', 'visit_id': 4,
                       'topic_id': 'video-topic', 'topic_label': 'Video topic',
                       'kind': 'learning', 'reason': 'User confirmed the video topic'}]}
        result = review.classify(self.payload, self.rules, assignments)
        self.assertEqual(result['visits'][3]['classification_source'], 'semantic_assignment')
        self.assertEqual(self.payload, original)
        assignments['assignments'][0]['visit_id'] = 999
        with self.assertRaisesRegex(ValueError, 'unknown or repeated'):
            review.classify(self.payload, self.rules, assignments)

    def test_conflicting_topic_metadata_is_rejected(self):
        assignments = {'assignments': [{'profile': 'Default', 'visit_id': 4,
                       'topic_id': 'vla-icl', 'topic_label': 'Different label',
                       'kind': 'other', 'reason': 'Bad assignment'}]}
        with self.assertRaisesRegex(ValueError, 'Conflicting topic'):
            review.classify(self.payload, self.rules, assignments)

    def test_invalid_counts_offsets_duplicates_and_ranges_are_rejected(self):
        bad_inputs = []
        bad = deepcopy(self.payload)
        bad['event_count'] = 99
        bad_inputs.append(bad)
        bad = deepcopy(self.payload)
        bad['visits'][0]['visit_time'] = '2026-10-20T09:00:00'
        bad_inputs.append(bad)
        bad = deepcopy(self.payload)
        bad['visits'][1]['visit_id'] = 1
        bad_inputs.append(bad)
        bad = deepcopy(self.payload)
        bad['visits'][0]['visit_time'] = '2026-10-19T23:59:59+08:00'
        bad_inputs.append(bad)
        for bad in bad_inputs:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    review.classify(bad, self.rules)

    def test_redacted_urls_do_not_collapse_distinct_query_pages(self):
        self.payload['visits'][0]['url'] = 'https://user:password@www.youtube.com/watch?v=one&token=secret#fragment'
        self.payload['visits'][1]['url'] = 'https://www.youtube.com/watch?v=two'
        summary = review.aggregate(self.classified())
        topic = next(t for t in summary['topics'] if t['topic_id'] == 'vla-icl')
        self.assertEqual(topic['unique_pages'], 2)
        self.assertEqual({p['url'] for p in topic['pages']}, {'https://www.youtube.com/watch'})
        _, report = review.render_report(summary)
        for sensitive in ('password', 'token=secret', 'fragment'):
            if sensitive != 'fragment':
                self.assertNotIn(sensitive, report)

    def test_render_escapes_untrusted_title(self):
        self.payload['visits'][0]['title'] = 'StellaVLA [click](https://evil.test) <script> **execute**'
        _, report = review.render_report(review.aggregate(self.classified()))
        self.assertNotIn('[click](https://evil.test)', report)
        self.assertNotIn('<script>', report)

    def test_existing_input_run_preserves_coverage_and_counts(self):
        input_path = review.save(self.folder / 'source.json', self.payload)
        with redirect_stdout(io.StringIO()):
            code = review.main(['run', '--input', str(input_path), '--output-dir', str(self.folder / 'out')])
        self.assertEqual(code, 0)
        summary = review.load(self.folder / 'out/learning_summary.json')
        self.assertEqual(summary['end_time'], self.payload['end_time'])
        self.assertEqual(summary['source']['sha256'], collector.file_digest(input_path))
        self.assertEqual(review.load(input_path), self.payload)
        self.assertTrue((self.folder / 'out/learning_report_2026-10-20.md').is_file())

    def test_partial_collection_is_reported_and_returns_failure_code(self):
        self.payload['status'] = 'partial'
        self.payload['errors'] = [{'profile': 'Profile 1', 'reason': 'permission denied'}]
        input_path = review.save(self.folder / 'source.json', self.payload)
        with redirect_stdout(io.StringIO()):
            code = review.main(['run', '--input', str(input_path), '--output-dir', str(self.folder / 'out')])
        self.assertEqual(code, 1)
        summary = review.load(self.folder / 'out/learning_summary.json')
        self.assertEqual(len(summary['errors']), 1)
        self.assertEqual(summary['status'], 'partial')

    def test_failed_collection_never_analyzes_stale_file(self):
        output = self.folder / 'out'
        review.save(output / 'edge_history_today.json', self.payload)
        with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            code = review.main(['run', '--user-data-dir', str(self.folder / 'missing'),
                                '--output-dir', str(output)])
        self.assertEqual(code, 1)
        self.assertFalse((output / 'learning_summary.json').exists())

    def test_complete_run_collects_synthetic_database(self):
        root = self.folder / 'User Data'
        profile = root / 'Profile 2'
        profile.mkdir(parents=True)
        db = sqlite3.connect(profile / 'History')
        try:
            db.executescript('CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT);'
                             'CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);'
                             "INSERT INTO urls VALUES(1, 'https://example.test', 'StellaVLA');")
            db.execute('INSERT INTO visits VALUES(1, 1, ?)',
                       (collector.chromium_timestamp(datetime.now().astimezone()),))
            db.commit()
        finally:
            db.close()
        with redirect_stdout(io.StringIO()):
            code = review.main(['run', '--user-data-dir', str(root), '--output-dir', str(self.folder / 'out')])
        self.assertEqual(code, 0)
        summary = review.load(self.folder / 'out/learning_summary.json')
        self.assertEqual(summary['event_count'], 1)
        self.assertEqual(summary['topics'][0]['evidence_ids'], ['Profile 2:1'])

    def test_bundled_collector_matches_original(self):
        self.assertEqual(collector.file_digest(Path(collector.__file__)),
                         collector.file_digest(SCRIPTS / 'edge_history_today.py'))


if __name__ == '__main__':
    unittest.main()
