# Local recorder

This is an unpacked Manifest V3 extension for Chrome / Edge 120 or newer. The build
places the local dashboard at `dashboard.html`; the toolbar action opens it.
Recording defaults to **off**. Only the dashboard's explicit Start action enables
it. That preference persists across browser restarts. Clearing data also pauses.

## What is measured

Only the active HTTP(S) tab in the focused, normal, non-incognito browser window
is eligible while the OS idle API reports active. Browser-internal pages, the
dashboard, extension pages, popup windows, and discarded tabs are excluded.
The idle threshold is 60 seconds. The preceding threshold window can therefore
be counted; this is estimated foreground browser time, **not attention, reading,
learning, or proof that a person interacted with the page**. A separate window
covering the page, OS focus-event delays, and browser scheduling can affect it.

The extension reads only current tab metadata (URL and title), focus and idle
state. It does not read page bodies, cookies, browser history, or form inputs.
Full URLs include query parameters and fragments, which may themselves contain
sensitive information. URL user/password components are removed. No favicon
requests or remote requests are made. There are no content scripts, host
permissions, external message interfaces, analytics, or sync storage.

## Checkpoints and recovery

An alarm runs approximately every 30 seconds; tab, window and idle events also
reconcile state. One serial queue commits sessions and the current cursor in a
single `chrome.storage.local` value. Each accrued interval is capped at 30 seconds.
Intervals with a gap above 45 seconds are discarded completely. Contiguous
intervals from the same visit are merged; gaps remain separate visits. The
conservative policy can undercount when alarms are delayed. It can overcount
within the bounded interval if a focus/idle transition is not delivered promptly.

`chrome.storage.session` identifies the browser session. Normal worker suspension
can continue from its saved cursor. Browser restart, crash, reload or extension
update invalidates that cursor, so downtime is never extended into a visit.
The final uncheckpointed portion can be lost. Backwards clock changes are clamped
to the latest recorded boundary to prevent overlapping intervals. Persisted
timestamps are UTC ISO instants; the dashboard presents them in local time.

The recorder pauses at an 8 MiB serialized data budget and returns `storage-full`;
it does not silently evict old records. The dashboard can export then clear.
Write failures return `error` and pause the in-memory recorder. A browser/worker
restart may retry the last persisted enabled preference after a write failure.
Browser extension removal deletes its local storage. There is no remote backup.

## Dashboard messages

Only same-extension messages whose sender is the bundled `dashboard.html` are
accepted. Responses use:

```js
{ schema: 'trace.v1', sessions: [{ id, url, title, host, start, end }],
  recording: true, status: 'recording' }
```

- `{type: 'trace:get'}`: checkpoint and read committed sessions.
- `{type: 'trace:set-recording', enabled: boolean}`: start or pause.
- `{type: 'trace:clear-data'}`: clear records and pause; the UI confirms this.

Status is `paused`, `recording`, `idle`, `locked`, `unfocused`, `unsupported`,
`storage-full`, or `error`. A failure may additionally contain an `error` string.
No controls are exposed to arbitrary websites.

Timing tests: `node --test tests/recorder.test.mjs` from the project root.

API references: [worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle),
[alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms),
[storage](https://developer.chrome.com/docs/extensions/reference/api/storage),
[idle](https://developer.chrome.com/docs/extensions/reference/api/idle),
[windows](https://developer.chrome.com/docs/extensions/reference/api/windows).
