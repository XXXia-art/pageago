"""Offline tests using synthetic History databases, never real browser records."""

import csv
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import shutil
import sqlite3
import unittest
from contextlib import redirect_stderr
import uuid

import edge_history_today as history


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path.cwd() / (".edge-test-" + uuid.uuid4().hex)
        self.folder.mkdir()
        self.root = self.folder / "User Data"
        self.root.mkdir()
        self.start = datetime(2026, 10, 20, tzinfo=timezone(timedelta(hours=8)))
        self.end = self.start + timedelta(hours=12)

    def tearDown(self):
        shutil.rmtree(self.folder)

    def fixture(self, profile="Default", stamps=None):
        folder = self.root / profile
        folder.mkdir()
        path = folder / "History"
        connection = sqlite3.connect(path)
        try:
            connection.executescript(
                "CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER);"
                "CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);"
            )
            connection.execute("INSERT INTO urls VALUES (1, ?, ?, 0)",
                               ('https://example.test/a?q=1,2', '\u4e2d\u6587 "title"\nsecond line'))
            if stamps is None:
                stamps = [self.start - timedelta(microseconds=1), self.start,
                          self.start + timedelta(hours=1), self.end,
                          self.end + timedelta(microseconds=1)]
            connection.executemany("INSERT INTO visits VALUES (?, 1, ?)",
                                   [(i + 1, history.chromium_timestamp(stamp))
                                    for i, stamp in enumerate(stamps)])
            connection.commit()
        finally:
            connection.close()
        return path

    def collect(self, copy=False):
        with redirect_stderr(io.StringIO()):
            return history.collect(self.root, self.start, self.end,
                                   copy_if_locked=copy, scratch_parent=self.folder)

    def test_timestamp_epoch_and_microseconds(self):
        self.assertEqual(history.chromium_timestamp(history.CHROMIUM_EPOCH), 0)
        self.assertEqual(history.chromium_timestamp(datetime(1970, 1, 1, tzinfo=timezone.utc)),
                         11644473600000000)
        stamp = self.start + timedelta(microseconds=123456)
        restored = datetime.fromisoformat(history.local_visit_time(history.chromium_timestamp(stamp)))
        self.assertEqual(restored, stamp)
        self.assertEqual(restored.utcoffset(), stamp.astimezone().utcoffset())
        with self.assertRaises(ValueError):
            history.chromium_timestamp(datetime(2026, 10, 20))

    def test_local_midnight_window(self):
        start, end = history.today_window()
        self.assertEqual((start.hour, start.minute, start.second, start.microsecond), (0, 0, 0, 0))
        self.assertEqual(start.date(), end.date())
        self.assertLessEqual(start, end)
        self.assertIsNotNone(start.utcoffset())

    def test_each_visit_inclusive_boundaries_and_source_unchanged(self):
        path = self.fixture()
        before = history.fingerprints(path)
        events, profiles, errors = self.collect()
        self.assertEqual([row['visit_id'] for row in events], [2, 3, 4])
        self.assertEqual(len({row['url'] for row in events}), 1)
        self.assertEqual(profiles[0]['event_count'], 3)
        self.assertEqual(errors, [])
        self.assertEqual(history.fingerprints(path), before)

    def test_multiple_profiles_merged_without_deduplication(self):
        for profile in ('Profile 2', 'Default', 'Profile 1'):
            self.fixture(profile)
        (self.root / 'Not a profile').mkdir()
        events, profiles, errors = self.collect()
        self.assertEqual(len(events), 9)
        self.assertEqual({row['profile'] for row in events}, {'Default', 'Profile 1', 'Profile 2'})
        self.assertEqual(len(profiles), 3)
        self.assertEqual(errors, [])
        instants = [datetime.fromisoformat(row['visit_time']) for row in events]
        self.assertEqual(instants, sorted(instants))

    def test_locked_database_reports_error_without_implicit_copy(self):
        path = self.fixture()
        lock = sqlite3.connect(path)
        try:
            lock.execute('BEGIN EXCLUSIVE')
            events, profiles, errors = self.collect()
            self.assertEqual(events, [])
            self.assertEqual(profiles, [])
            self.assertIn('--copy-if-locked', errors[0]['reason'])
            self.assertEqual(list(self.folder.glob('.edge-history-*')), [])
        finally:
            lock.close()

    def test_locked_database_can_use_verified_copy(self):
        path = self.fixture()
        before = history.fingerprints(path)
        lock = sqlite3.connect(path)
        try:
            lock.execute('BEGIN EXCLUSIVE')
            events, profiles, errors = self.collect(copy=True)
            self.assertEqual(len(events), 3)
            self.assertEqual(profiles[0]['method'], 'validated_local_copy_read_only')
            self.assertEqual(errors, [])
        finally:
            lock.close()
        self.assertEqual(history.fingerprints(path), before)
        self.assertEqual(list(self.folder.glob('.edge-history-*')), [])

    def test_wal_events_included_and_original_files_unchanged(self):
        path = self.fixture(stamps=[])
        writer = sqlite3.connect(path)
        try:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('PRAGMA wal_autocheckpoint=0')
            writer.execute('INSERT INTO visits VALUES (10, 1, ?)',
                           (history.chromium_timestamp(self.start),))
            writer.commit()
            before = history.fingerprints(path)
            events, profiles, errors = self.collect(copy=True)
            self.assertEqual([row['visit_id'] for row in events], [10])
            self.assertEqual(errors, [])
            self.assertEqual(history.fingerprints(path), before)
            self.assertEqual(profiles[0]['method'], 'validated_local_copy_read_only')
        finally:
            writer.close()

    def test_bad_schema_reports_partial_failure(self):
        self.fixture()
        bad = self.root / 'Profile 1'
        bad.mkdir()
        sqlite3.connect(bad / 'History').close()
        events, profiles, errors = self.collect()
        self.assertEqual(len(events), 3)
        self.assertEqual(len(profiles), 1)
        self.assertEqual(len(errors), 1)
        self.assertIn('missing columns', errors[0]['reason'])
        paths = history.export(self.folder / 'output', events, profiles, errors, self.start, self.end)
        self.assertEqual(json.loads(paths[0].read_text(encoding='utf-8'))['status'], 'partial')

    def test_csv_json_roundtrip_and_empty_csv_header(self):
        self.fixture()
        events, profiles, errors = self.collect()
        json_path, csv_path = history.export(self.folder / 'output', events, profiles, errors,
                                            self.start, self.end)
        payload = json.loads(json_path.read_text(encoding='utf-8'))
        self.assertEqual(payload['visits'], events)
        self.assertEqual(payload['event_count'], 3)
        self.assertEqual(payload['status'], 'complete')
        with csv_path.open(encoding='utf-8-sig', newline='') as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(rows[0]['title'], events[0]['title'])
        self.assertEqual(rows[0]['url'], events[0]['url'])
        self.assertEqual(len(rows), 3)
        _, empty_csv = history.export(self.folder / 'empty', [], profiles, [], self.start, self.end)
        with empty_csv.open(encoding='utf-8-sig', newline='') as stream:
            self.assertEqual(list(csv.reader(stream)), [list(history.FIELDS)])

    def test_orphan_visit_is_preserved(self):
        path = self.fixture(stamps=[])
        connection = sqlite3.connect(path)
        try:
            connection.execute('INSERT INTO visits VALUES (42, 999, ?)',
                               (history.chromium_timestamp(self.start),))
            connection.commit()
        finally:
            connection.close()
        events, _, errors = self.collect()
        self.assertEqual(errors, [])
        self.assertEqual(events[0]['visit_id'], 42)
        self.assertIsNone(events[0]['url'])

    def test_no_history_is_a_clear_error(self):
        with self.assertRaisesRegex(history.HistoryError, 'No profile History'):
            self.collect()
        with self.assertRaisesRegex(history.HistoryError, 'does not exist'):
            history.discover_profiles(self.folder / 'missing')


if __name__ == '__main__':
    unittest.main()
