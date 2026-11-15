"""Export today's Edge visit events using only the Python standard library.

Normal use: python edge_history_today.py
If Edge locks History, explain the local copy first, then explicitly opt in:
    python edge_history_today.py --copy-if-locked
No browser process is stopped. Only History and its SQLite journals are read.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import csv
from datetime import datetime, time, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import uuid


CHROMIUM_EPOCH = datetime(1601, 1, 1, tzinfo=timezone.utc)
FIELDS = ("profile", "visit_id", "url", "title", "visit_time")
REQUIRED_COLUMNS = {
    "visits": {"id", "url", "visit_time"},
    "urls": {"id", "url", "title"},
}


class HistoryError(Exception):
    """A failure that should be reported without exposing visit contents."""


class SnapshotRequired(HistoryError):
    pass


def chromium_timestamp(value: datetime) -> int:
    """Integer microseconds since 1601-01-01 UTC; never use float rounding."""
    if value.tzinfo is None:
        raise ValueError("An aware datetime is required")
    delta = value.astimezone(timezone.utc) - CHROMIUM_EPOCH
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def local_visit_time(value: int) -> str:
    return (CHROMIUM_EPOCH + timedelta(microseconds=value)).astimezone().isoformat()


def today_window() -> tuple[datetime, datetime]:
    end = datetime.now().astimezone()
    # Resolve midnight independently: its UTC offset can differ from now on DST days.
    start = datetime.combine(end.date(), time.min).astimezone()
    return start, end


def discover_profiles(root: Path) -> list[tuple[str, Path]]:
    if not root.is_dir():
        raise HistoryError(f"Edge User Data directory does not exist: {root}")
    profiles = sorted(
        ((p.name, p / "History") for p in root.iterdir()
         if p.is_dir() and (p / "History").is_file()),
        key=lambda item: (item[0] != "Default", item[0].casefold()),
    )
    if not profiles:
        raise HistoryError(f"No profile History databases found in: {root}")
    return profiles


def error_reason(error: Exception) -> str:
    code = getattr(error, "sqlite_errorname", None)
    return f"{type(error).__name__}: {error}" + (f" [{code}]" if code else "")


def is_locked(error: sqlite3.Error) -> bool:
    code = getattr(error, "sqlite_errorcode", 0) or 0
    return (code & 255) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)


def read_database(path: Path, profile: str, start: int, end: int,
                  *, validate_copy: bool = False) -> list[dict]:
    # mode=ro is enforced by SQLite itself; query_only provides another guard.
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)
    try:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        for table, required in REQUIRED_COLUMNS.items():
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            missing = required - columns
            if missing:
                raise HistoryError(f"{path}: {table} missing columns: {', '.join(sorted(missing))}")
        if validate_copy:
            checks = connection.execute("PRAGMA integrity_check").fetchall()
            if checks != [("ok",)]:
                raise HistoryError(f"Copied database failed integrity_check: {path}")
        rows = connection.execute(
            "SELECT v.id, u.url, u.title, v.visit_time "
            "FROM visits AS v LEFT JOIN urls AS u ON v.url = u.id "
            "WHERE v.visit_time >= ? AND v.visit_time <= ? "
            "ORDER BY v.visit_time, v.id", (start, end),
        )
        # LEFT JOIN also preserves a visit if an inconsistent database lacks its URL row.
        return [dict(zip(FIELDS, (profile, visit_id, url, title, local_visit_time(stamp))))
                for visit_id, url, title, stamp in rows]
    finally:
        connection.close()


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fingerprints(source: Path) -> dict[str, tuple[int, int, str]]:
    result = {}
    for suffix in ("", "-wal", "-journal"):
        path = Path(str(source) + suffix)
        try:
            before = path.stat()
        except FileNotFoundError:
            if not suffix:
                raise
            continue
        digest = file_digest(path)
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise HistoryError("History changed while being read; snapshot rejected")
        result[suffix] = (after.st_size, after.st_mtime_ns, digest)
    return result


@contextmanager
def private_workspace(parent: Path):
    # mkdir uses inherited Windows ACLs; no change to permissions on browser files.
    folder = parent.resolve() / (".edge-history-" + uuid.uuid4().hex)
    folder.mkdir()
    try:
        yield folder
    finally:
        # Delete only the uniquely named directory this invocation created.
        shutil.rmtree(folder)


def read_snapshot(source: Path, profile: str, start: int, end: int,
                  scratch_parent: Path) -> list[dict]:
    last_error = None
    for _ in range(3):
        try:
            with private_workspace(scratch_parent) as folder:
                before = fingerprints(source)
                target = folder / "History"
                for suffix in before:
                    shutil.copyfile(str(source) + suffix, str(target) + suffix)
                after = fingerprints(source)
                if before != after:
                    raise HistoryError("History/journals changed during copying; snapshot rejected")
                for suffix, (size, _, digest) in before.items():
                    copied = Path(str(target) + suffix)
                    if copied.stat().st_size != size or file_digest(copied) != digest:
                        raise HistoryError("Copied History/journal checksum mismatch")
                # Preserve WAL and rollback journals, but regenerate SHM only in the copy.
                # A hot rollback journal needing recovery must fail in read-only mode.
                return read_database(target, profile, start, end, validate_copy=True)
        except (OSError, sqlite3.Error, HistoryError) as error:
            last_error = error
    raise HistoryError(f"Could not obtain a stable read-only snapshot: {error_reason(last_error)}")


def collect(root: Path, start: datetime, end: datetime, *, copy_if_locked: bool,
            scratch_parent: Path) -> tuple[list[dict], list[dict], list[dict]]:
    events, profiles, errors = [], [], []
    lower, upper = chromium_timestamp(start), chromium_timestamp(end)
    for profile, path in discover_profiles(root):
        method = "direct_read_only"
        try:
            try:
                # SQLite WAL readers may create/write SHM even with mode=ro.
                # Use a copy for WAL databases to avoid touching original sidecars.
                if Path(str(path) + "-wal").exists():
                    raise SnapshotRequired("WAL exists; a copy is required to keep original sidecars untouched")
                records = read_database(path, profile, lower, upper)
            except (sqlite3.Error, SnapshotRequired) as error:
                if isinstance(error, sqlite3.Error) and not is_locked(error):
                    raise
                print(f"{profile}: {error_reason(error)}", file=sys.stderr)
                if not copy_if_locked:
                    raise HistoryError(
                        "Read-only access needs a local snapshot. You may close Edge yourself and retry, "
                        "or explicitly use --copy-if-locked to copy History and SQLite journals locally. "
                        "No browser process will be stopped."
                    ) from error
                print(f"{profile}: copying only History and SQLite journals to a temporary local directory; "
                      "the copy will be deleted after reading.", file=sys.stderr)
                method = "validated_local_copy_read_only"
                records = read_snapshot(path, profile, lower, upper, scratch_parent)
            events.extend(records)
            profiles.append({"profile": profile, "database": str(path),
                             "method": method, "event_count": len(records)})
        except (OSError, sqlite3.Error, HistoryError, ValueError, OverflowError) as error:
            reason = error_reason(error)
            errors.append({"profile": profile, "database": str(path), "reason": reason})
            print(f"ERROR {profile}: {path}: {reason}", file=sys.stderr)
    events.sort(key=lambda row: (datetime.fromisoformat(row["visit_time"]).astimezone(timezone.utc),
                                 row["profile"], row["visit_id"]))
    return events, profiles, errors


def export(output: Path, events: list[dict], profiles: list[dict], errors: list[dict],
           start: datetime, end: datetime) -> tuple[Path, Path]:
    output.mkdir(parents=True, exist_ok=True)
    json_path = output / "edge_history_today.json"
    csv_path = output / "edge_history_today.csv"
    payload = {"status": "partial" if errors and profiles else "failed" if errors else "complete",
               "start_time": start.isoformat(), "end_time": end.isoformat(),
               "generated_at": datetime.now().astimezone().isoformat(),
               "event_count": len(events), "profiles": profiles, "errors": errors, "visits": events}
    with json_path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    # BOM makes Chinese titles readable when CSV is opened in Windows Excel.
    with csv_path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(events)
    return json_path.resolve(), csv_path.resolve()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-data-dir", type=Path, help="Override Edge User Data directory")
    parser.add_argument("--output-dir", type=Path, default=Path.cwd() / "output")
    parser.add_argument("--copy-if-locked", action="store_true",
                        help="Explicitly allow temporary local History/journal copies if needed")
    args = parser.parse_args(argv)
    root = args.user_data_dir
    if root is None:
        local_app_data = os.environ.get("LOCALAPPDATA")
        if not local_app_data:
            parser.error("LOCALAPPDATA is unset; supply --user-data-dir")
        root = Path(local_app_data) / "Microsoft" / "Edge" / "User Data"
    try:
        start, end = today_window()
        events, profiles, errors = collect(root, start, end, copy_if_locked=args.copy_if_locked,
                                           scratch_parent=Path.cwd())
        paths = export(args.output_dir, events, profiles, errors, start, end)
    except (OSError, sqlite3.Error, HistoryError) as error:
        print(f"ERROR: {error_reason(error)}", file=sys.stderr)
        return 1
    print(f"Local range: {start.isoformat()} through {end.isoformat()} (inclusive)")
    print(f"Visit events: {len(events)}; profiles read: {len(profiles)}; profiles failed: {len(errors)}")
    for path in paths:
        print(path)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
