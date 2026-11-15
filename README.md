<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/pageago-wordmark-dark.svg">
    <img src="assets/brand/pageago-wordmark.svg" width="340" alt="PageAgo">
  </picture>
</p>

<p align="center">A local-first timeline of the pages you use in Edge and Chrome.</p>

<p align="center">
  <img src="docs/media/badges/local-first.svg" alt="Local first">
  <img src="docs/media/badges/desktop-browsers.svg" alt="Desktop · Edge / Chrome">
  <img src="docs/media/badges/offline-demo.svg" alt="Offline demo">
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
  &nbsp; · &nbsp; <a href="#get-started">Get started</a>
  &nbsp; · &nbsp; <a href="#your-data-stays-on-your-device">Privacy</a>
</p>

![PageAgo's warm ivory desktop interface, with website labels above a full-day activity timeline and a daylight scene below. All activity is synthetic.](docs/media/pageago-overview.png)

PageAgo records estimated foreground browser activity and puts it on one daily timeline. Revisit a page, find a time, or look through the day without an account or server. The interface currently uses Simplified Chinese.

## Get started

Download or clone this repository:

```sh
git clone https://github.com/XXXia-art/pageago.git
cd pageago
```

### Try the offline demo

Open [`prototypes/trace-next/dist/index.html`](prototypes/trace-next/dist/index.html) from your downloaded copy. On Windows, double-click `Open-PageAgo.cmd` in the repository root. No installation, server, Python, or Node.js is needed to use the prebuilt demo.

The demo supports dates, zoom, page details, search, and JSON import/export. It cannot record other browser tabs; recording requires the extension below.

### Record your own activity

Use **Edge or Chrome 120+ on desktop**. The current interface is designed and tested primarily for Windows PCs.

1. Open `edge://extensions` or `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose [`prototypes/trace-next/extension`](prototypes/trace-next/extension).
3. Pin PageAgo to the toolbar and click its icon to open the local timeline.
4. Open the date menu → **设置** (Settings) → **开始记录** (Start recording).

**Recording is off after installation.** Start/pause is your choice and persists across browser restarts. The same settings panel contains sound, import, export, and clear controls. Clearing requires confirmation and pauses recording.

## Your data stays on your device

PageAgo stores recordings in the browser's local extension storage. It has no account, analytics, cloud sync, or remote backup, and makes no remote requests for recording or displaying the timeline. Icons come from the browser's local favicon cache or bundled assets.

It reads the current page's **URL, title, and activity times**, plus tab, window-focus, and system-idle state. Only the active HTTP(S) tab in a focused, normal browser window is eligible. Incognito windows are excluded. It does not read page content, cookies, passwords, forms, or browser history.

Keep these limits in mind:

- **Foreground time is an estimate.** It does not measure reading, attention, or learning. The idle threshold is 60 seconds; checkpoints run about every 30 seconds. Gaps over 45 seconds are discarded, and a crash may lose the last unsaved interval.
- **Exports contain full URLs**, including query parameters and fragments. URL username/password fields are removed. Imported JSON stays in the current page's memory and is not added to the recorder.
- **At about 8 MiB, recording pauses** instead of deleting older data. Export before clearing or uninstalling; uninstalling removes the extension's local data.

See the [recorder notes](prototypes/trace-next/extension/RECORDER.md) for measurement and recovery details, and the [technical guide](prototypes/trace-next/README.md) for the import format.

## What's next

The current release is a local preview, loaded manually as an unpacked extension. Planned work: simplify installation, add interface languages, and keep refining browser compatibility and keyboard navigation.

Issues and pull requests are welcome. Include browser/OS versions and reproducible steps; use synthetic data when sharing screenshots or exports.
