# PageAgo design iteration

This pass keeps the user's paper palette, large Gantt canvas, short site names,
embedded official icons, search and local 06:00–24:00 window. No account,
analytics, hosted service or external data request was introduced.

## Public references

| Reference inspected | Observation or useful approach | Applied to PageAgo |
| --- | --- | --- |
| [Meng To's AI design workflow on YouTube](https://www.youtube.com/watch?v=oLu32YpiIJw) and [creator interview](https://creatoreconomy.so/p/use-ai-to-create-beautiful-designs-meng-to) | The public descriptions emphasize concrete references and a coherent visual direction across iterations. The video was located; this is not a claim to have watched the full recording. | Preserve the user's homepage palette and chart layout; iterate using actual screenshots and interaction tasks. |
| [Aura Operations Dashboard](https://www.aura.build/s/operations-dashboard-7) | The official preview image shows a quiet application frame, fine borders and restrained accent colors. | Clear tool hierarchy, thin dividers, local hover detail and stronger chart contrast. Its sidebar and metric cards would compete with this user's chart and were excluded. |
| [Aura layout guide](https://www.aura.build/learn/prompt-for-layout) | Explicit structure, spacing and responsive behavior rather than an unspecified aesthetic request. | Keep the chart at 81% of the desktop viewport; preserve type sizes on small screens. |
| [Lovable community gallery](https://madewithlovable.com/) and [Glowcase listing](https://madewithlovable.com/projects/glowcase-build-interactive-product-demos-with-ai) | The gallery identifies real Lovable builds; Glowcase describes contextual hotspots in interactive product demos. This is a feature description, not a claim about its unauthenticated application screens. | Put record evidence next to the interaction: a transient visit preview, with the full evidence list available on demand. |
| [Linear Timeline](https://linear.app/docs/timeline) | Continuous time canvas, milestones, multiple resolutions and secondary display options. | Two-level local-time ruler, exact visit positions, anchored zoom and a compact display menu. |
| [User homepage](https://xxxia-art.github.io/) | Warm #f5f1e8 paper, ink text, serif identity and fine warm borders, inspected in earlier iterations. | Remains the visual source of truth. No new gradients, hero messages or decorative copy. |

The application decisions above are our interpretation of the references, not
claims that the reference authors prescribe these exact controls. No competitor
code or images were incorporated into the product. Design-reference requests
used only public URLs and never included private browsing data.

## Three review rounds

| Round and reading task | Finding | Change and validation |
| --- | --- | --- |
| 1 — Scan the day, then inspect a visit | The ruler had little time hierarchy, rows used space inefficiently, and dense diamonds relied on native browser titles. | Add restrained morning/afternoon/evening bands, hourly minor guides, 88px rows and 36% bar fill. Add a local preview of actual titles and seconds. Every event and exact bar endpoint remains intact. |
| 2 — Zoom, pan and search as a reader | Zoom shifted the time being read; on a small screen site identities left the viewport. Screenshot review then exposed early name truncation caused by repeated width measurement. | Preserve center/pointer time when zooming, constrain only names to the viewport, retain a stable natural name width and add an explicit search clear button. Check anchoring within one pixel and that short names stay visible and untruncated. |
| 3 — Inspect 12 tightly overlapping visits and reopen saved output | Dense visits need individual keyboard access. A preview time badge initially collided with major ticks. The headless test also needed foreground-focus emulation for actual keyboard events after navigation. | Arrow keys and Home/End select each original event; Enter opens its evidence. Place the hover time on the upper ruler tier, leaving the 18px main ticks readable. Keep the close control visible when the detail list scrolls. Test mouse hover, keyboard selection, escaped hostile text, export/reload, reduced motion and mobile layouts. |

These are local task-based reviews and browser checks, not a usability study
with outside participants. Aesthetic quality still needs feedback from people
using the tool; no GitHub popularity outcome is implied.

## Measured result

- At 1440 × 1040, the canvas is 1382 × 841px and begins at y=142px: 81% of
  viewport height. At 390 × 844 it occupies 579px, about 69%.
- The denser rows expose more of the day without reducing the 16px names,
  18px major ticks or 28px official icon artwork.
- Local-export checks preserve every source event and page/profile identity
  across the selected time window and site grouping. No new collection was
  needed for this design pass.
- Automated checks cover 375, 390, 768, 1024 and 1440px layouts; exact time
  geometry, midnight boundaries, search/grouping, preview and anchored zoom,
  keyboard evidence, safe import and standalone save/reload. Generated pages
  make no external network requests.

Public images and demos use only the explicitly synthetic 27-event dataset.
Private snapshots remain under the ignored `output/` directory. The installed
Skill receives the same tested template and theme so future exports keep the
refinements.

## Follow-up: many pages under one website

The site row prevents the main canvas from becoming hundreds of repeated brand
names, but its former drawer still repeated the full page title for every visit.
This made finding distinct pages unnecessarily slow. Following the distinction
between grouping and visibility in [Linear's display options](https://linear.app/docs/display-options),
the drawer now offers a page outline and a chronological visit view.

- Clicking a site name starts with the page outline. Each source page/profile
  has a collapsed group showing its full title and visit count. Expanding it
  reveals the safe URL, timestamps and original event evidence.
- Clicking a diamond opens the chronological view at that precise visit.
  The main canvas, source data, time window and exact coordinates are unchanged.
- Grouping follows active search/profile/window filters and never merges pages
  by title or redacted URL. Two query variants with the same displayed URL remain
  different groups. Hidden panel links and collapsed links are excluded from
  the modal focus loop.
- Browser QA checks the four-page, cross-profile, query-variant fixture;
  expand/collapse, tab keyboard navigation, focus wrapping, filtered outlines,
  direct visit selection and mobile drawer width. All original source events
  survive import and saved HTML reload.
- The synthetic demo now includes distinct pages under arXiv and GitHub as well
  as repeat visits, so this hierarchy can be reviewed without private records.
- Screenshot review also caught a pre-existing clock formatting error: ISO
  values without fractional seconds showed part of the offset (for example
  `09:05:00+08:`). All visit clocks now format the parsed instant in the export
  timezone; tests include a UTC event inside a +08:00 export.

## Follow-up: a whole day on a phone

The previous 900px minimum canvas showed only the morning on a 390px phone.
Although the heading said 06:00–24:00, readers had to discover horizontal
scrolling to find the evening. This undermined the main task of seeing a day.

At 1× the canvas now fits the viewport, so the entire window is visible before
any zooming. Mobile ticks stay at 18px, use wider time intervals, and align to
their grid lines. Minor guides thin out at narrow widths. Endpoint labels have
priority over intermediate labels or the last-visit badge. Icons and titles
retain their existing sizes; all visit coordinates remain proportional to time.

The + button reveals a detailed, scrollable timeline; the multiplier resets it
to the overview. Browser checks cover 320, 375, 390, 768, 1024 and 1440px,
including full-day endpoints, no overlapping visible labels, every original
event ID, zoom/reset and the existing import, grouping and offline guarantees.
Desktop layout and the local collection window are unchanged.
Screenshot review of the demo additionally showed its 17:56 badge displacing
the 12:00/18:00 labels. In the narrow overview that secondary badge is now
hidden; the last-visit line and every real visit remain. It returns when zooming
provides sufficient space, while event inspection always supplies exact times.

## Follow-up: search from a zoomed time window

A synthetic regression reproduced this reading failure: pan an 8× chart to the
evening, then search for a morning page. Counts and the pinned site name changed,
but every matching visit stayed offscreen, leaving a nearly blank result row.

Search now pans only when the first result row has no visible visit. It reveals
the closest real event without changing scale, selecting an event, opening a
drawer or taking focus from typing. The clear button, Escape and deleting the
query restore the original reading position. The origin is stored as a time
fraction, so restoration also works when zoom changes during the search.
Importing another dataset discards the old origin. This changes navigation,
not the source records, matching rules or fixed day window.

The browser regression failed on the previous version and passes with the fix.
It checks all three dismissal paths, visible real markers, preserved focus and
scale, complete event counts and restoration after a scale change.

## Follow-up: many-page responsiveness

An optional synthetic scale case adds 1,200 distinct pages, 4,800 visits and two
profiles across 12 sites. It verifies the compact 12-row default, expansion to
1,200 page rows, exact preservation of every visit ID, a four-visit page search,
search clearing and a site's 100-page/400-visit outline. No private records are
used and no additional browser history is collected.

The expanded view exposed avoidable repeated layout work: each label's position
was written immediately before reading its size. Sizes and natural name widths
are now measured together, followed by the position writes. This preserves the
visible layout and all actual time coordinates.

| Operation, one local before/after run | Before | After |
| --- | ---: | ---: |
| Switch to 1,200 page rows | 418ms | 200ms |
| Clear a search back to 1,200 rows | 395ms | 175ms |

These are illustrative local measurements, not a cross-device guarantee. Other
short operations varied between runs; there is no claim that every interaction
became faster. The optional QA flag is `TIMELINE_TEST_STRESS=1`; detailed timings
stay in ignored `output/*_stress.json`. Assertions check correctness, not
hardware-dependent timing limits.

## Follow-up: distinguish uncovered hours

A source snapshot ending at 18:00 previously left 18:00–24:00 visually identical
to a covered interval with no visits. A faint paper-colored hatch now identifies
time outside the export's declared bounds, with a conditional “未覆盖” legend.
The 06:00–24:00 axis, source data and actual visit coordinates stay intact.
No per-row labels, extra controls or panels are added.

Coverage uses `start_time/end_time`, never the last visit, search result or
viewer's clock. Full-day sources have no visible hatch. The empty importer has
no coverage claim, including after resize; a real zero-event export still has
its declared bounds. Backgrounds cannot intercept visit clicks.

Synthetic browser checks cover snapshots ending at noon, an 08:00–12:00 export,
zero events, full-day coverage and the direct template. The public demo ends at
18:00 with its final visit at 17:56, making the distinction visible. Desktop and
320/390px screenshots were inspected; all 32 Python checks and the offline
browser suite passed. No new browsing records were collected.

## Follow-up: Chinese search composition

Reviewing the search as a Chinese reader exposed an input problem: unfinished
pinyin was immediately applied as a query, blanking the current result before
the user chose a character. Escape during composition also cleared the search
instead of leaving the candidate interaction to the input method.

Search now waits for composition to commit. Candidates and cancellation retain
the current result; the confirmed characters filter the original page titles.
An identical final input event does not redraw the result a second time. There
are no new controls, copy or visual changes to the main chart.

A synthetic browser regression failed with an empty row set before the fix and
passes afterward. It dispatches composition/input events to check candidate
text, Escape, Chinese commit, cancellation, retained input focus and subsequent
ordinary typing. This exercises browser event handling, not a physical IME
installation. All 32 Python checks and the offline browser suite passed. No
new browser records were read or sent externally.

## Follow-up: keep the reading position on resize

An 8× chart panned to the morning moved to another time when its window became
narrower: the old 900px scroll position stayed at 900px when the same time now
needed approximately 654px. Replacing the chart also discarded its focused
visit, and a drawer's return target could refer to an old detached button.

Resize now retains the center time and zoom using the last stable layout.
It restores the closest position allowed by the browser's actual scroll limits,
including widening a mobile view from the right edge. The focused visit or
site control survives reconstruction; an open drawer keeps focus and returns
to its corresponding new button when closed. The 1× view still fits the day.
There are no additional controls or changes to the chart's visual hierarchy.

The time-position regression failed before the fix. Browser checks now cover
1440→1024→390→1440 widths, the right boundary, visit focus/preview, drawer focus
and return, unchanged zoom and exact event IDs. All 32 Python checks pass.
Tests use local exports and synthetic input without collecting new history.

## Follow-up: search a site and remembered topic together

Readers often remember a site and a subject rather than an exact page title.
Searching `中文 github` previously returned no result for the synthetic page
“GitHub docs · 中文文档”, although both words were present in its metadata.
The complete query had to occur as one contiguous substring.

Search now matches every whitespace-separated term within the same source page,
in any order and across the existing title, site, domain and URL fields.
Filtering still precedes site grouping: `docs readme` cannot combine a docs page
and a separate readme page into a false match. Matching pages keep all of their
actual visit evidence. No extra filters or controls are introduced.

The regression failed before the change and passes with Chinese/Latin terms,
reversed order, full-width and repeated spaces, URL path terms, non-matches and
site/page grouping. The offline browser suite, its optional 1,200-page/4,800-visit
synthetic case and all 32 Python checks pass. No new history was collected.

## Follow-up: locate matches inside long page titles

Multiword search found the correct pages, but readers still had to scan long
titles to see why each page matched. Previews and the detail drawer now use a
faint warm highlight for the matching words, including page-group titles,
chronological visits and redacted links. The main Gantt keeps its short names
and original color hierarchy, with no additional labels or controls.

Highlights retain the exact original text and inherited font/color, without
changing link destinations or event evidence. Construction uses text nodes and
escaped literal terms; query characters such as `C++` and title text such as
`<img` cannot become expressions or HTML. Clearing search removes highlights
when the content is opened again.

Browser checks cover Chinese/Latin terms, literal punctuation, hostile-looking
text, page/visit views, preview, clearing and mobile layout. Desktop and 390px
screenshots were inspected. All 32 Python checks and the offline browser suite,
including the 1,200-page synthetic case, pass. No new history was collected.

## Follow-up: the default entry must open the latest available day

The documented default command searched only two files directly in `output/`.
It could keep selecting an older export even though a newer export was
already present in a date folder. The UI showed the correct historical date,
but the default entry led readers to an older day than expected.

Discovery now includes immediate valid calendar-date folders and known raw or
classified export names. Selection uses declared coverage, with classified
records preferred on a tie. It prints the source path; explicit input always
takes precedence. Arbitrary JSON and unrelated nested folders are excluded.
Invalid candidate metadata reports its path without overwriting the report.

The stale-root regression failed before the fix. Four added isolated checks
cover date discovery, classification ties, invalid metadata and explicit input.
All 36 Python checks pass. The regenerated default HTML preserves the selected
export and its time-window filtering. This reuses local exports and does not
collect new history.

## Follow-up: scan a site's pages by first visit

The folded page list repeated the same profile name on every card while
providing no immediate time cue. Similar page titles were hard to distinguish
without expanding their visit lists.

Each card now shows its first local visit and count, for example
“首次 09:05 · 2 次访问”. A single profile is already identified in the drawer
header, so its repeated labels are omitted; a site's multi-profile list still
labels each card. Page identities and expanded evidence remain separate.
The main chart receives no extra text or controls.

Clocks use the filtered 06:00–24:00 window and retain the original precise
timestamp in the time element. Browser checks cover the viewer/export timezone
difference, single/multiple profiles and a page spanning the 06:00 boundary.
Desktop and 390px screenshots were inspected. The offline suite, its optional
1,200-page case and all 36 Python checks pass. Only synthetic screenshots are
used in public documentation; no new browser history was collected.

## Follow-up: readable search in a split window

At 768px wide the header fitted inside the screen, but its inline brand, date
and demo badge left only 88px for actual query text after input padding.
The old overflow checks passed while the search placeholder was visibly cut.

Between 761 and 900px the status badge now wraps beneath the brand/date within
the existing 72px header. This releases search width while preserving text
sizes and the chart's position and area. All header controls stay visible.
Other responsive layouts retain their existing structure.

The new readability assertion failed on the prior version. It now verifies at
least 160px for query text and no overlapping/clipped header elements across
320, 375, 761, 768, 900, 901, 1024 and 1440px widths. The 768px before/after
screenshots were inspected. All 36 Python checks and the offline browser suite
pass. No new browser history was collected.

## Follow-up: put the site's pages before visit statistics

The mobile site drawer placed its first page card around 617px down the screen.
Its URL, visit summary and explanation appeared before the page/visit tabs, so
the 844px screen showed only two short page cards even when the site had many
pages. Finding a page should be the immediate task after opening a site.

The tabs now follow the site heading and profile context. The URL, statistics
and visit-time explanation live inside the visit panel; page links remain in
their expandable cards. The first card now starts around 251px on a 390px phone.
Switching tabs keeps their position stable. Single-page details retain their
URL and statistics, and clicking a diamond still opens the selected evidence.
Main-chart geometry, typography and all source events are unchanged.

The new priority check failed before the markup change. Desktop/mobile checks
now verify immediate page access without smaller titles, retained visit context,
stable tabs and focus behavior. A synthetic 1,200-page case includes a 100-page
site with at least six fully visible cards at 390 × 844. The offline browser
suite and all 36 Python checks pass. Public screenshots use synthetic data;
existing local exports were regenerated without collecting new history.

## Reference combination: overview, context and page hierarchy

This implements the user's selected combination: Linear's timeline hierarchy,
Frappe's contextual interaction and DHTMLX's expandable parent/child overview,
within the existing warm paper theme. Reference features are adapted for
read-only browsing evidence; no scheduling library or remote asset was added.

- A small disclosure beside sites with multiple pages expands just that site
  in the canvas. Its parent keeps the exact first/last overview span; visit
  buttons appear on the original page rows, once per event. Explicitly opened
  children show page titles at 16px, inherit their site's color and use 76px
  rows. Collapsed sites retain short names and 88px rows.
- Bars are accessible buttons. Hover or keyboard focus shows the first and last
  actual visit clocks at 18px, the visit count and a concise span limitation.
  Activation opens existing evidence. Point previews retain individual visits;
  time text there is now at least 13px.
- Hovering the ruler reads the export-local time at the pointer and draws a
  guide without adding an event. Existing center/pointer-anchored zoom stays
  available. Expand/collapse retains the reading position and control focus.

Checks cover unique IDs and exact coordinates across expansion, unchanged site
counts, search/profile filtering, query variants, hostile-looking title text,
parent/child color, keyboard disclosure, mobile bounds, span hover/activation,
focus return, ruler mapping at 1× and 8×, import and saved output.
Both the synthetic demo and local-export checks pass the browser suite; all
36 Python checks and Skill validation pass. The 1,200-page/4,800-visit synthetic
case also expands one 100-page site while retaining all visit IDs. Public
screenshots come only from the marked synthetic demo. Source event identities
and time-window filtering remain intact.

## Content density: show what was visited when opening the report

The site overview could compress many page/profile identities into a small
number of site labels and hide page titles behind expansion or a drawer.
The fixed 18-hour scale also spreads sparse events across a large canvas.
Root `index.html` is a separate 27-visit synthetic demonstration.

Reports now open in page view with actual titles directly above each page's
icon and visits. Rows are 76px instead of 88px, preserving 16px titles, 28px
icons and 18px time ticks. The page/site selector moves from Display to the
toolbar. Site overview, its expandable page hierarchy and short site names
remain available. On phones the redundant range caption leaves room for the
selector; the axis still displays the full 06:00–24:00 window.

No events or durations were manufactured. Both generated and imported reports,
including saved HTML, start with page titles visible. Browser checks cover
actual source titles (ignoring invisible direction characters), row identities,
phone layout, native selection, page evidence and the existing overview flows.
The actual export and synthetic demo pass; the 1,200-page case, 36 Python checks
and Skill validation pass as well. Additional toolbar bounds and overlap checks
include 421, 480 and 600px alongside the existing phone and desktop sizes.
