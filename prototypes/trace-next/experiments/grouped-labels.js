  // Standalone preview renderer. The underlying activity blocks and camera are shared with PageAgo.
  const groupLayer = $('#event-tags');
  const groupLines = $('#event-links');
  const rowStep = 42;
  const rowCount = 8;
  let previousDate = '';
  let previousSpan = 0;
  let dayLabelWidths = new Map();

  function renderTags(){
    if (previousDate !== date) previousSpan = 0;
    previousDate = date;
    dayLabelWidths = new Map();
    layoutTags();
  }

  function groupDescription(group){
    const page = group.members[0].page;
    const times = time(group.at) === time(group.lastAt) ? time(group.at) : time(group.at) + '–' + time(group.lastAt);
    return page.name + ' · ' + group.members.length + ' 个网页 · ' + times;
  }

  function makeGroupNode(group){
    const page = group.members[0].page;
    const button = el('button', 'event-tag');
    button.type = 'button';
    const label = el('span', 'event-name');
    button.append(siteIcon(page.host, page.url), label);
    const link = document.createElementNS(groupLines.namespaceURI, 'path');
    const anchor = document.createElementNS(groupLines.namespaceURI, 'circle');
    link.classList.add('event-link');
    anchor.classList.add('event-anchor');
    anchor.setAttribute('r', '3');
    for (const node of [button, link, anchor]) {
      node.dataset.site = group.domain;
      node.style.setProperty('--tone', page.color);
    }
    groupLayer.append(button);
    groupLines.append(link, anchor);
    const item = {group, button, label, link, anchor};
    button.onclick = () => {
      const current = item.group;
      if (current.members.length === 1) {
        activatePage(current.members[0].page);
        return;
      }
      const center = (current.at + current.lastAt) / 2;
      const span = Math.max(3600000, (current.lastAt - current.at) * 1.6);
      $('#tooltip').hidden = true;
      $('#timeline-nav').focus({preventScroll: true});
      animateCamera(center - span / 2, center + span / 2);
    };
    const hover = event => {
      const current = item.group;
      if (current.members.length === 1) return showTagTooltip(event, current.members[0].page);
      const tip = $('#tooltip');
      tip.replaceChildren(el('strong', '', groupDescription(current)));
      tip.hidden = false;
      moveTooltip(event);
    };
    button.onmouseenter = hover;
    button.onmousemove = moveTooltip;
    button.onfocus = () => {
      const rect = button.getBoundingClientRect();
      hover({clientX: rect.x, clientY: rect.bottom});
    };
    button.onmouseleave = button.onblur = () => { $('#tooltip').hidden = true; };
    return item;
  }

  function labelRows(groups, width, reserveMore){
    const rows = Array.from({length: rowCount}, () => []);
    const omitted = [];
    const previousBySite = new Map();
    const span = camera.end - camera.start;
    const detail = span <= 2 * 3600000;
    const titleLimit = Math.min(215, 78 + 32 * Math.log2((rangeEnd - rangeStart) / span));
    for (const group of groups) {
      const page = group.members[0].page;
      const count = group.members.length;
      const core = count === 1 ? 32 : 44 + String(count).length * 9;
      const x = (group.at - camera.start) / span * width;
      const left = Math.max(0, Math.min(width - core, x - 16));
      let wanted = core;
      if (count === 1) {
        if (!dayLabelWidths.has(page.url)) {
          dayLabelWidths.set(page.url, Math.ceil(titleMeasure.measureText(page.title || page.host).width) + 1);
        }
        wanted += 6 + Math.min(titleLimit, dayLabelWidths.get(page.url));
      }
      const previous = previousBySite.get(group.domain);
      // Neighboring pages of the same site open onto opposite sides of the same time band.
      const startBelow = detail && previous && group.at - previous.at <= 30 * 60000 && previous.level % 2 === 0;
      const order = startBelow ? [1, 0, 3, 2, 5, 4, 7, 6] : [0, 1, 2, 3, 4, 5, 6, 7];
      const findRow = protectTitle => order.find(index => {
        const last = rows[index].at(-1);
        const end = index === 0 && reserveMore ? width - 76 : width;
        return left + core <= end && (!last || left >= last.left + (protectTitle ? last.wanted : last.core) + 6);
      });
      const level = findRow(true) ?? findRow(false);
      if (level === undefined) { omitted.push(group); continue; }
      rows[level].push({group, x, left, core, wanted});
      previousBySite.set(group.domain, {level, at: group.at});
    }
    return {rows, omitted};
  }

  function layoutTags(){
    const width = $('#lanes').clientWidth;
    if (!width) return;
    const span = camera.end - camera.start;
    const groups = createSiteTimeGroups(pages, camera.start, camera.end, width);
    titleMeasure.font = '500 14px ' + getComputedStyle(groupLayer).fontFamily;
    let layout = labelRows(groups, width, false);
    const reserveMore = layout.omitted.length > 0;
    if (reserveMore) layout = labelRows(groups, width, true);
    const priorGroups = [];
    if (previousSpan > span && !reduced.matches) {
      for (const item of tagMap.values()) {
        if (item.group.members.length > 1) priorGroups.push(item.group);
      }
    }
    previousSpan = span;
    const visible = new Set();
    let highest = 0;
    groupLines.setAttribute('viewBox', '0 0 ' + width + ' 280');
    groupLines.setAttribute('width', width);
    groupLines.setAttribute('height', 280);
    for (const [level, row] of layout.rows.entries()) {
      const below = level % 2 === 1;
      const top = below ? 96 + Math.floor(level / 2) * rowStep : -62 - Math.floor(level / 2) * rowStep;
      for (const [index, entry] of row.entries()) {
        const {group, x, core, wanted, left} = entry;
        const {members} = group;
        const page = members[0].page;
        const isGroup = members.length > 1;
        const key = (isGroup ? 'group:' : 'page:') + group.key;
        visible.add(key);
        const fresh = !tagMap.has(key);
        const item = tagMap.get(key) || makeGroupNode(group);
        tagMap.set(key, item);
        item.group = group;
        const {button, label, link, anchor} = item;
        const previous = row[index - 1], next = row[index + 1];
        const cellStart = previous ? (previous.left + previous.core + left + 6) / 2 : 0;
        const cellEnd = next ? (left + core + next.left - 6) / 2 : width - (level === 0 && reserveMore ? 76 : 0);
        let tagWidth = Math.min(wanted, cellEnd - cellStart);
        if (!isGroup && tagWidth - 38 < Math.min(24, dayLabelWidths.get(page.url))) tagWidth = core;
        const tagLeft = Math.max(cellStart, Math.min(left, cellEnd - tagWidth));
        highest = Math.min(highest, top);
        label.textContent = isGroup ? String(members.length) : page.title || page.host;
        button.classList.toggle('site-group', isGroup);
        button.classList.toggle('icon-only', !isGroup && tagWidth === core);
        button.style.top = top + 'px';
        button.style.left = tagLeft + 'px';
        button.style.setProperty('--tag-width', tagWidth + 'px');
        button.style.setProperty('--title-gap', tagWidth > core ? '6px' : '0px');
        button.style.setProperty('--title-width', Math.max(0, tagWidth - 38) + 'px');
        button.dataset.pageCount = members.length;
        button.dataset.at = group.at;
        button.dataset.lastAt = group.lastAt;
        button.dataset.members = JSON.stringify(members.map(member => member.page.url));
        if (isGroup) delete button.dataset.url;
        else button.dataset.url = page.url;
        button.setAttribute('aria-label', isGroup ? groupDescription(group) + '，放大查看' : label.textContent + '，查看详情');
        anchor.setAttribute('cx', x);
        anchor.setAttribute('cy', below ? 294 : 252);
        link.setAttribute('d', below ? 'M ' + x + ' 294 V 299 M ' + x + ' 344 V ' + (260 + top)
          : 'M ' + x + ' ' + (260 + top + 32) + ' V 252');
        if (fresh && priorGroups.some(old => old.domain === group.domain && old.members.some(a => a.sessionId === members[0].sessionId))) {
          button.animate([
            {opacity: .25, transform: 'translateY(' + (below ? -9 : 9) + 'px) scale(.94)'},
            {opacity: 1, transform: 'none'}
          ], {duration: 170, easing: 'ease-out'});
        }
      }
    }
    for (const [key, item] of tagMap) {
      if (visible.has(key)) continue;
      if (document.activeElement === item.button) $('#timeline-nav').focus({preventScroll: true});
      item.button.remove(); item.link.remove(); item.anchor.remove();
      tagMap.delete(key);
    }
    const missed = new Map();
    for (const group of layout.omitted) for (const {page} of group.members) missed.set(page.url, page);
    hiddenPages = [...missed.values()];
    const more = $('#more-pages');
    more.hidden = !hiddenPages.length;
    more.textContent = '+' + hiddenPages.length;
    more.setAttribute('aria-label', '查看其余 ' + hiddenPages.length + ' 个网页');
    more.style.top = '-62px'; more.style.right = '0';
    $('#canvas').style.setProperty('--tag-space', Math.max(0, 24 - highest) + 'px');
    // A fixed lower reserve keeps the hour dial still while clusters split under the wheel.
    $('#scene').style.setProperty('--lower-space', groups.length ? '180px' : '0px');
    pageHighlight?.refresh();
  }

  // A badge can move from under the pointer partway through a scroll gesture.
  // Include the gaps between labels, so successive notches keep the same time anchor.
  let wheelGesture = null;
  $('#canvas').addEventListener('wheel', event => {
    if (event.defaultPrevented || !filtered.length) return;
    if (!event.target.closest('.event-tag') && !event.target.matches('#canvas, #scene, #axis')) return;
    const rect = $('#lanes').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top - 196 || event.clientY > rect.top + 254) return;
    event.preventDefault();
    const now = performance.now();
    const continuing = wheelGesture && now - wheelGesture.time < 450 &&
      Math.hypot(event.clientX - wheelGesture.x, event.clientY - wheelGesture.y) < 8;
    const badge = event.target.closest('.site-group');
    let offset = continuing ? wheelGesture.offset : 0;
    if (!continuing && badge) {
      const center = (Number(badge.dataset.at) + Number(badge.dataset.lastAt)) / 2;
      offset = rect.left + (center - camera.start) / (camera.end - camera.start) * rect.width - event.clientX;
    }
    wheelGesture = {time: now, x: event.clientX, y: event.clientY, offset};
    $('#timeline-nav').dispatchEvent(new WheelEvent('wheel', {
      cancelable: true, clientX: event.clientX + offset, clientY: event.clientY, deltaX: event.deltaX,
      deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey
    }));
  }, {passive: false});
