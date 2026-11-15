# PageAgo design references and checks

The user selected a light version of a Linear-like Gantt chart, then explicitly
requested search instead of topic filters, their personal homepage's visual
style, no decorative copy, and a timeline that dominates the first screen.
This is a local data tool, so the homepage's biography and marketing-like text
are not part of the interface.

PC is the primary design and review target: prioritize readable content density,
the large timeline, wide/split windows and mouse/keyboard interaction. Mobile
retains basic usability; future iterations should not spend separate design
rounds on detailed mobile layouts or touch-specific features.

## References inspected

| Reference | What it contributes | What PageAgo changes |
| --- | --- | --- |
| [User homepage](https://xxxia-art.github.io/) | Actual CSS: #f5f1e8 paper, #1f2937 ink, #2563eb links, Georgia/Chinese serif, warm fine borders, restrained corner washes | Retain its visual identity in the frame and brand; use clear sans-serif at 16px for dense page labels |
| [Linear Timeline](https://linear.app/docs/timeline) | Continuous time canvas, labels near bars, milestones, compact view controls | Visit diamonds and first/last visit spans instead of project schedules or progress |
| [Frappe Gantt](https://frappe.io/gantt) | Configurable contextual popups and multiple time scales | Read-only bar previews and click-through evidence, retaining anchored zoom |
| [DHTMLX rollup and preview](https://docs.dhtmlx.com/gantt/demos/rollup-tasks/) | Parent summaries with expandable child rows | Expand a single site's original pages in the canvas; the parent keeps its overview span while visit buttons move to the children without duplication |
| [Project Timeline](https://project-timeline.com/) | A usable chart and a small set of immediate controls, portable output | Keep search always visible; import/save local files without an account |
| [Two Minute Timeline](https://www.twominutetimeline.com/) | Direct manipulation of time scale and compact timeline construction | Retain only time range and zoom at the surface; move secondary display options into a menu |

These references inform hierarchy and visual treatment; no competitor code or
assets are copied. Public design pages were inspected without sending browsing
records to them.

## Gap and implemented correction

| Previous gap | Implemented correction |
| --- | --- |
| Sidebar consumes width and makes topic classification the first task | Remove the sidebar, topic buttons and website filter; search titles, URLs and domains directly |
| Heading, totals and hourly histogram push the chart down | Remove the intro and histogram; put the two useful counts inline in the chart toolbar |
| Cool gray application style loses the user's homepage identity | Restore warm paper, dark ink, serif brand/date and fine warm borders |
| Long explanatory copy competes with records | No slogans; a small legend and optional time explanation preserve necessary data meaning |
| Controls have equal emphasis and crowd the view | Primary search in the header; range/zoom on the chart; sort/profile/span in the display menu |
| Page scroll hides the useful portion of the chart | Keep the frame within the viewport; only the full-width canvas scrolls |

Measured in an isolated Chrome window at 1440 × 1040:

| Metric | Before | After |
| --- | ---: | ---: |
| Top of the time canvas | 470px | 142px |
| Canvas width | 1093px | 1382px |
| Canvas height | 610px, extending below the initial viewport | 841px, fully inside the initial viewport |
| Canvas height / viewport height | 59% (partly below the fold) | 81% |

At 390 × 844 the canvas occupies 579px, approximately 69% of the viewport.
Browser QA also checks 375, 768, 1024 and 1440px widths, no page overflow,
minimum text sizes and text contrast, exact marker/bar geometry, search,
keyboard shortcuts, import/save, profile selection and no external requests.
Screenshots in the README use explicitly synthetic data only.

## Repeated-site regression

Short site labels initially hid the difference between separate page rows. A
synthetic demo with one page per site did not expose that hierarchy mismatch.
The site overview uses one row per site. The later content-density review
restores page titles as the default and puts page/site selection on the toolbar.
Each source page and every event ID remain intact. Clicking a site lists the
original page titles, redacted links, timestamps and profile evidence. Search
filters source pages before grouping, so it cannot silently include unrelated
pages on a matching site.

Browser QA runs against both the synthetic demo and the requested local export.
An additional synthetic case covers five visits across five distinct pages and
two sites, with query variants, a subdomain, multiple profiles and a spoofed
suffix. It checks that grouping preserves every event, details retain page
links, profiles still filter correctly, and save/reload retains the full data.
Only explicitly synthetic screenshots are copied into public documentation.

## Local 06:00–24:00 window

The user selected a fixed local window from 06:00 to the end of the same day.
The chart uses the source export date and declared local offset, not the viewer's
clock. Counts, page/site grouping, search, detail evidence and bar endpoints all
use events in [06:00, next midnight). Events outside that window remain in the
embedded source data and saved HTML; existing raw exports and reports keep their
own declared coverage. A snapshot's blank future hours do not imply visits were
collected there.

Boundary checks use 05:59:59.999, exactly 06:00, 23:59:59.999 and next midnight,
including a page with visits on both sides of the lower boundary. They verify
that counts and spans are consistent, only-night data is honestly empty, and
save/reload preserves all original events. Browser QA runs with a UTC viewer
while the fixture declares +08:00, ensuring the displayed local window is stable.
The first/last axis labels remain 06:00 and 24:00, including a visit near midnight.

## Gantt and data constraints

- Default to page titles, with one-row-per-site overview on the toolbar. Only
  fold the view: keep original page identities, all event IDs and profiles.
- Full-width canvas without a fixed website table column. The official site icon
  sits immediately left of the bar, vertically centered. Only the short site name (for example arXiv or GitHub) sits
  above it, with no page-title suffix or descriptive text; omit domain/profile labels, visit counts and endpoint captions from
  rows. Those remain available in the detail drawer. Reserve a 60px left time
  gutter so icons cannot cover the first marker or fall outside the canvas.
- 88px rows, 26px pale bars, subtle dashed vertical guides, diamond visits.
- Every diamond is a real visit; bar ends use exact first/last timestamps with
  no decorative minimum duration. A single visit has no span bar.
- The reference line marks the last actual visit in the displayed records. It
  never pretends a historical report is live.
- Color is deterministic by domain, independent of classification. Theme analysis
  remains in reports and exported metadata, without topic filters in the UI.
- Titles are at least 16px, ticks 18px with medium weight and dark ink, detail metadata 13px on desktop and mobile.
  Long site names truncate. Full page titles remain searchable and appear in the detail drawer; unknown sites retain their domain.
- Embed official public raster icons with domain-boundary matching. Unknown sites
  use neutral initials. No favicon proxies, remote fonts or on-open requests.
- First/last spans are not activity, dwell time or learning duration. These remain
  unknown until a separate source records active intervals.
