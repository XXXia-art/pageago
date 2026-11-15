// Offline preview renderer input. The original sessions and their intervals stay intact.
function createSiteTimeGroups(pages, start, end, width) {
  const minute = 60_000;
  const span = end - start;
  if (!(span > 0 && width > 0)) return [];

  // Bring the grouping radius smoothly to zero as the viewport approaches two hours.
  const groupingScale = Math.max(0, Math.min(1, (span - 120 * minute) / (180 * minute)));
  const radius = 40 * span / width * groupingScale;
  const maxSpan = Math.min(30 * minute, radius);
  const maxGap = Math.min(12 * minute, radius);
  const bySite = new Map();
  for (const page of pages) {
    let runs = bySite.get(page.domain);
    if (!runs) {
      runs = [];
      bySite.set(page.domain, runs);
    }
    let previous = null;
    // derive() supplies each page's intervals in start-time order.
    for (const session of page.items) {
      if (session.a >= end) break;
      if (session.b <= start) continue;
      // Repeated changes of focus on one URL can generate several intervals
      // within a minute. Keep a local representative even at high zoom.
      if (previous && session.a - previous.end <= 90_000 &&
          session.a - previous.first <= 3 * minute) {
        previous.end = Math.max(previous.end, session.b);
        previous.last = session.a;
      } else {
        previous = {
          member: {page, at: Math.max(start, session.a), sessionId: session.id},
          first: session.a, last: session.a, end: session.b,
        };
        runs.push(previous);
      }
    }
  }

  const groups = [];
  for (const [domain, runs] of bySite) {
    runs.sort((a, b) => a.first - b.first || a.member.sessionId.localeCompare(b.member.sessionId));
    let group, first, last, urls;
    for (const run of runs) {
      // Use actual starts for proximity. Clipping several long intervals to
      // the left edge should not make distant visits look simultaneous.
      if (!group || maxSpan === 0 || run.last - first > maxSpan || run.first - last > maxGap) {
        group = {
          key: JSON.stringify([domain, run.member.sessionId]),
          domain, at: run.member.at, lastAt: run.member.at, members: [],
        };
        groups.push(group);
        first = run.first;
        last = run.last;
        urls = new Set();
      }
      last = Math.max(last, run.last);
      group.lastAt = Math.max(group.lastAt, last);
      if (!urls.has(run.member.page.url)) {
        urls.add(run.member.page.url);
        group.members.push(run.member);
      }
    }
  }
  return groups.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
