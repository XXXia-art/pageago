"""Export one local day of confirmed Edge foreground activity, using stdlib only.

Reads the local ActivityWatch server with GET requests. Web intervals are intersected
with the same machine's Edge window and not-afk intervals. No browser databases,
window titles, remote services, or inferred gaps are used.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import urlopen


UTC = timezone.utc


def utc_iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def parse_zone(value: str) -> timezone:
    match = re.fullmatch(r"([+-])(\d{2}):(\d{2})", value)
    if not match:
        raise ValueError("timezone must be a fixed UTC offset such as +08:00")
    hours, minutes = int(match[2]), int(match[3])
    if hours > 23 or minutes > 59:
        raise ValueError("invalid timezone offset")
    offset = timedelta(hours=hours, minutes=minutes)
    return timezone(offset if match[1] == "+" else -offset)


def interval(event: dict, start: datetime, end: datetime):
    try:
        timestamp = datetime.fromisoformat(str(event["timestamp"]).replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("missing timestamp timezone")
        seconds = Decimal(str(event["duration"]))
        if not seconds.is_finite() or seconds < 0:
            raise ValueError("invalid duration")
        micros = int((seconds * 1_000_000).to_integral_value(rounding=ROUND_HALF_EVEN))
        a = timestamp.astimezone(UTC)
        b = a + timedelta(microseconds=micros)
    except (KeyError, TypeError, ValueError, InvalidOperation, OverflowError) as exc:
        raise ValueError("ActivityWatch returned an invalid event timestamp/duration") from exc
    a, b = max(a, start), min(b, end)
    return (a, b) if b > a else None


def union(intervals):
    result = []
    for a, b in sorted(intervals):
        if result and a <= result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], b))
        else:
            result.append((a, b))
    return result


def intersect(left, right):
    """Intersect two sorted, disjoint interval lists without filling gaps."""
    result, i, j = [], 0, 0
    while i < len(left) and j < len(right):
        a, b = max(left[i][0], right[j][0]), min(left[i][1], right[j][1])
        if b > a:
            result.append((a, b))
        if left[i][1] <= right[j][1]:
            i += 1
        else:
            j += 1
    return result


class ActivityWatch:
    def __init__(self, base_url: str):
        parsed = urlsplit(base_url)
        # There is intentionally no remote-server mode for personal activity data.
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("ActivityWatch URL must be a local HTTP loopback address")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("invalid ActivityWatch base URL")
        self.base = base_url.rstrip("/") + "/api/0"

    def get(self, path: str, params=None):
        target = self.base + path
        if params:
            target += "?" + urlencode(params)
        try:
            with urlopen(target, timeout=15) as response:
                # JSON is parsed without routing browsing metadata into exceptions.
                return json.loads(response.read(), parse_float=Decimal)
        except HTTPError as exc:
            raise RuntimeError(f"local ActivityWatch returned HTTP {exc.code}") from None
        except (URLError, TimeoutError, OSError):
            raise RuntimeError("cannot reach local ActivityWatch on the configured address") from None
        except (ValueError, UnicodeError):
            raise RuntimeError("local ActivityWatch returned invalid JSON") from None

    def events(self, bucket_id: str, start: datetime, end: datetime):
        path = "/buckets/" + quote(bucket_id, safe="") + "/events"
        current = self.get(path, {"start": utc_iso(start), "end": utc_iso(end), "limit": -1})
        # Some versions filter by event start rather than interval intersection.
        # The most recent event before midnight can still extend into this day.
        boundary = self.get(path, {"end": utc_iso(start), "limit": 1})
        if not isinstance(current, list) or not isinstance(boundary, list):
            raise ValueError("ActivityWatch events response must be a list")
        unique = {}
        for event in current + boundary:
            if not isinstance(event, dict) or not isinstance(event.get("data"), dict):
                raise ValueError("ActivityWatch returned an invalid event")
            key = event.get("id")
            if key is None:
                key = json.dumps(event, sort_keys=True, default=str)
            unique[str(key)] = event
        # Retain only events that truly intersect the requested local day.
        return [(event, clipped) for event in unique.values() if (clipped := interval(event, start, end))]


def web_metadata(event):
    data = event["data"]
    if data.get("incognito", False) is not False:
        return None
    value = data.get("url")
    if not isinstance(value, str) or len(value) > 40_000:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return None
        hostname = parsed.hostname
        netloc = f"[{hostname}]" if ":" in hostname else hostname
        if parsed.port is not None:
            netloc += ":" + str(parsed.port)
        url = urlunsplit((parsed.scheme.lower(), netloc, parsed.path, parsed.query, parsed.fragment))
    except ValueError:
        return None
    title = data.get("title", hostname)
    if not isinstance(title, str):
        title = hostname
    return {"url": url, "host": hostname, "title": title[:20_000]}


def convert(client, requested_date: str, zone_string: str):
    day = date.fromisoformat(requested_date)
    zone = parse_zone(zone_string)
    start = datetime.combine(day, time(), zone).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
    buckets = client.get("/buckets/")
    if not isinstance(buckets, dict):
        raise ValueError("ActivityWatch buckets response must be an object")
    web_buckets = [(key, value) for key, value in buckets.items() if value.get("type") == "web.tab.current"]
    if not web_buckets:
        raise ValueError("no ActivityWatch web.tab.current bucket exists")
    matched, cache, fragments = [], {}, []
    raw_positive = eligible_events = retained_events = 0
    for bucket_id, metadata in web_buckets:
        events = client.events(bucket_id, start, end)
        raw_positive += len(events)
        eligible = [(event, span, item) for event, span in events if (item := web_metadata(event))]
        eligible_events += len(eligible)
        if not eligible:
            continue
        host = metadata.get("hostname")
        if not host or host == "unknown":
            raise ValueError("a populated web bucket has no machine hostname; cannot match foreground evidence")
        if host not in cache:
            companions = {}
            for kind in ("currentwindow", "afkstatus"):
                candidates = [key for key, value in buckets.items() if value.get("type") == kind and value.get("hostname") == host]
                if len(candidates) != 1:
                    raise ValueError(f"populated web bucket needs exactly one same-host {kind} bucket")
                companions[kind] = candidates[0]
            windows = client.events(companions["currentwindow"], start, end)
            afk = client.events(companions["afkstatus"], start, end)
            # Only the application name is inspected; window titles are never used.
            edge_intervals = union([span for event, span in windows if str(event["data"].get("app", "")).replace("\\", "/").rsplit("/", 1)[-1].casefold() == "msedge.exe"])
            active_intervals = union([span for event, span in afk if event["data"].get("status") == "not-afk"])
            cache[host] = intersect(edge_intervals, active_intervals)
        matched.append(bucket_id)
        for event, span, item in eligible:
            pieces = intersect([span], cache[host])
            if pieces:
                retained_events += 1
            for a, b in pieces:
                fragments.append({**item, "a": a, "b": b})
    by_url = defaultdict(list)
    for fragment in fragments:
        by_url[fragment["url"]].append(fragment)
    merged = []
    for pieces in by_url.values():
        current = None
        for piece in sorted(pieces, key=lambda item: (item["a"], item["b"])):
            if current and piece["a"] <= current["b"]:
                current["b"] = max(current["b"], piece["b"])
                if piece["title"]:
                    current["title"] = piece["title"]
            else:
                if current:
                    merged.append(current)
                current = dict(piece)
        if current:
            merged.append(current)
    merged.sort(key=lambda item: (item["a"], item["b"], item["url"]))
    for previous, current in zip(merged, merged[1:]):
        if current["a"] < previous["b"] and current["url"] != previous["url"]:
            raise ValueError("different web pages overlap after foreground filtering; refusing ambiguous attribution")
    sessions = []
    total_us = 0
    for item in merged:
        a, b = utc_iso(item["a"]), utc_iso(item["b"])
        identity = hashlib.sha256((requested_date + "\0" + item["url"] + "\0" + a + "\0" + b).encode()).hexdigest()[:24]
        sessions.append({"id": "aw-" + identity, "url": item["url"], "title": item["title"], "host": item["host"], "start": a, "end": b})
        delta = item["b"] - item["a"]
        total_us += (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds
    summary = {"positive_web_events": raw_positive, "eligible_web_events": eligible_events,
               "retained_web_events": retained_events, "sessions": len(sessions),
               "pages": len({session["url"] for session in sessions}),
               "foreground_seconds": total_us / 1_000_000, "matched_web_buckets": len(matched)}
    payload = {"schema": "trace.v1", "source": "activitywatch-foreground", "date": requested_date,
               "timezone": zone_string, "basis": "web.tab.current ∩ same-host currentwindow(msedge.exe) ∩ afkstatus(not-afk); clipped to local day; no gap filling",
               "summary": summary, "sessions": sessions}
    return payload


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="Local calendar date, YYYY-MM-DD")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timezone", default="+08:00", help="Fixed local UTC offset (default +08:00)")
    parser.add_argument("--base-url", default="http://127.0.0.1:5600", help="Local ActivityWatch HTTP server")
    args = parser.parse_args(argv)
    try:
        payload = convert(ActivityWatch(args.base_url), args.date, args.timezone)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"date": args.date, "timezone": args.timezone, **payload["summary"], "output": str(args.output.resolve())}, ensure_ascii=True))
        return 0
    except (ValueError, RuntimeError, OSError) as exc:
        print("Export failed: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
