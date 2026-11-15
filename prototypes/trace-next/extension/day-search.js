/* Search only the pages already loaded for the selected local day. */
(() => {
  'use strict';

  const fold = text => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const words = text => text.trim().split(/\s+/u).filter(Boolean);
  const batchSize = 80;

  function create({getPages, siteIcon, locate, formatTime}) {
    const dialog = document.getElementById('day-search-dialog');
    const trigger = document.getElementById('day-search-open');
    const query = document.getElementById('day-search-query');
    const sites = document.getElementById('day-search-sites');
    const inlineSites = document.getElementById('day-search-inline-sites');
    const drop = dialog.querySelector('.day-search-drop');
    const sheet = drop.querySelector('.day-search-site-sheet');
    const noSites = drop.querySelector('.day-search-no-sites');
    const browse = document.getElementById('day-search-browse');
    const scopeButton = document.getElementById('day-search-scope');
    const results = document.getElementById('day-search-results');
    const matchesPanel = dialog.querySelector('.day-search-matches');
    const empty = document.getElementById('day-search-empty');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let scope = '', view = 'idle', limit = batchSize;
    let activeRow = null;
    let finishDock = null;

    function selectRow(row, scroll = false) {
      if (row !== activeRow) {
        activeRow?.setAttribute('aria-selected', 'false');
        activeRow = row;
        if (row) {
          row.setAttribute('aria-selected', 'true');
          query.setAttribute('aria-activedescendant', row.id);
        } else {
          query.removeAttribute('aria-activedescendant');
        }
      }
      if (row && scroll) row.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }

    function chooseSite(site) {
      const dock = view === 'sites' && !reducedMotion.matches;
      let outgoing, startHeight, scrollTop, startTransform;
      if (dock) {
        startHeight = sheet.offsetHeight;
        startTransform = getComputedStyle(sheet).transform;
        scrollTop = sites.scrollTop;
        outgoing = document.createElement('div');
        outgoing.className = 'day-search-outgoing-sites';
        outgoing.inert = true;
        outgoing.setAttribute('aria-hidden', 'true');
        outgoing.style.height = sites.offsetHeight + 'px';
        // Retain the actual chips and icons for the handoff, including their scroll position.
        while (sites.firstChild) outgoing.append(sites.firstChild);
      }
      scope = site.domain;
      query.value = words(query.value).filter(word => !site.names.includes(fold(word))).join(' ');
      restart();
      query.focus({preventScroll: true});
      if (!dock) return;

      const endHeight = sheet.offsetHeight;
      sheet.append(outgoing);
      outgoing.scrollTop = scrollTop;
      const timing = {duration: 410, easing: 'cubic-bezier(.28,.72,.24,1)'};
      const resize = sheet.animate([
        {height: startHeight + 'px'}, {height: startHeight + 'px', offset: .24}, {height: endHeight + 'px'}
      ], timing);
      const animations = [
        resize,
        outgoing.animate([{opacity: 1}, {opacity: 0, transform: 'translateY(-5px)'}],
          {duration: 155, easing: 'ease-in', fill: 'forwards'}),
        matchesPanel.animate([{opacity: 0, transform: 'translateY(6px)'}, {opacity: 1, transform: 'none'}],
          {duration: 240, delay: 120, easing: 'ease-out', fill: 'backwards'}),
        scopeButton.animate([{opacity: 0, transform: 'translateY(4px)'}, {opacity: 1, transform: 'none'}],
          {duration: 160, easing: 'ease-out'})
      ];
      if (startTransform !== 'none') {
        animations.push(sheet.animate([{transform: startTransform}, {transform: 'none'}], {duration: 175, easing: 'ease-out'}));
      }
      finishDock = () => {
        resize.onfinish = null;
        outgoing.remove();
        for (const animation of animations) animation.cancel();
        finishDock = null;
      };
      resize.onfinish = finishDock;
    }

    function renderSites(allSites, terms, showSites) {
      const active = allSites.get(scope);
      scopeButton.hidden = !active;
      if (active) {
        scopeButton.replaceChildren(siteIcon(active.host, active.url), active.name, ' ×');
        scopeButton.setAttribute('aria-label', '清除网站筛选：' + active.name);
      }
      const chips = document.createDocumentFragment();
      if (showSites) {
        for (const site of allSites.values()) {
          if (terms.length && !terms.some(term => site.names.includes(term))) continue;
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'search-site';
          chip.dataset.domain = site.domain;
          chip.title = site.domain;
          chip.setAttribute('aria-label', '在 ' + site.name + ' 中查找');
          chip.append(siteIcon(site.host, site.url), site.name);
          chip.onclick = () => chooseSite(site);
          chips.append(chip);
        }
      }
      sites.hidden = !chips.childElementCount;
      sites.replaceChildren(chips);
    }

    function resultRow({page, visit, title, showPath}, index) {
      const row = document.createElement('div');
      row.className = 'search-result';
      row.id = 'day-search-result-' + index;
      row.setAttribute('role', 'row');
      row.setAttribute('aria-selected', 'false');
      const link = document.createElement('a');
      link.className = 'search-title';
      link.href = page.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const name = document.createElement('span');
      name.className = 'search-title-text';
      name.textContent = title;
      link.title = title;
      const copy = document.createElement('span');
      copy.className = 'search-result-copy';
      copy.append(name);
      const host = page.host === scope || page.host === 'www.' + scope ? '' : page.host;
      if (host || showPath) {
        const address = document.createElement('span');
        address.className = 'search-domain';
        address.textContent = showPath ? host + new URL(page.url).pathname : host;
        address.title = address.textContent;
        copy.append(address);
      }
      link.append(siteIcon(page.host, page.url), copy);
      const time = document.createElement('button');
      time.type = 'button';
      time.className = 'search-time';
      time.dataset.session = visit.id;
      time.textContent = formatTime(visit.a);
      time.setAttribute('aria-label', '在时间轴上查看 ' + time.textContent + ' 的访问');
      time.title = '在时间轴上查看';
      time.onclick = () => {
        close();
        locate(page, visit);
      };
      const pageCell = document.createElement('div');
      pageCell.className = 'search-page-cell';
      pageCell.setAttribute('role', 'gridcell');
      pageCell.append(link);
      const timeCell = document.createElement('div');
      timeCell.className = 'search-time-cell';
      timeCell.setAttribute('role', 'gridcell');
      timeCell.append(time);
      row.append(pageCell, timeCell);
      return row;
    }

    function refresh() {
      if (!dialog.open) return;
      const focused = document.activeElement;
      const activeUrl = activeRow?.querySelector('.search-title').href;
      const pages = getPages();
      const catalog = new Map();
      const matches = [];
      const firstByTitle = new Map();
      const terms = words(fold(query.value));
      const showResults = view !== 'sites' && (scope || terms.length || view === 'recent');
      dialog.dataset.view = view === 'sites' ? 'sites' : showResults ? 'results' : 'idle';
      drop.inert = dialog.dataset.view === 'idle';
      browse.setAttribute('aria-pressed', String(view === 'sites'));
      browse.setAttribute('aria-expanded', String(view === 'sites'));
      if (dialog.dataset.view === 'idle') {
        selectRow(null);
        // Keep the detached sheet painted until its closing transition finishes.
        if (sites.parentNode === inlineSites) {
          sites.replaceChildren();
          sites.hidden = true;
        }
        results.replaceChildren();
        scopeButton.hidden = results.hidden = empty.hidden = true;
        query.setAttribute('aria-expanded', 'false');
        return;
      }
      for (const page of pages) {
        const names = fold(page.name + ' ' + page.domain + ' ' + page.host);
        let site = catalog.get(page.domain);
        if (!site) {
          site = {domain: page.domain, name: page.name, host: page.host, url: page.url, hosts: new Set(), names: fold(page.name + ' ' + page.domain)};
          catalog.set(page.domain, site);
        }
        if (!site.hosts.has(page.host)) {
          site.hosts.add(page.host);
          site.names += ' ' + fold(page.host);
        }
        if (!showResults || (scope && scope !== page.domain)) continue;
        const titleTerms = terms.filter(term => !names.includes(term));
        // The dashboard groups by URL and keeps each page's visits in chronological order.
        for (let i = page.items.length - 1; i >= 0; i--) {
          const visit = page.items[i];
          if (titleTerms.length) {
            const title = fold(visit.title);
            if (!titleTerms.every(term => title.includes(term))) continue;
          }
          const title = visit.title.trim() || page.host;
          const match = {page, visit, title, showPath: false};
          const key = page.host + '\n' + fold(title);
          const first = firstByTitle.get(key);
          if (first) {
            first.showPath = true;
            match.showPath = true;
          } else {
            firstByTitle.set(key, match);
          }
          matches.push(match);
          break;
        }
      }
      if (scope && !catalog.has(scope)) {
        scope = '';
        refresh();
        return;
      }
      const siteContainer = view === 'sites' ? sheet : inlineSites;
      if (sites.parentNode !== siteContainer) siteContainer.prepend(sites);
      renderSites(catalog, view === 'sites' ? [] : terms, view === 'sites' || (!scope && terms.length > 0));
      noSites.hidden = view !== 'sites' || catalog.size > 0;
      matches.sort((a, b) => b.visit.a - a.visit.a || a.page.url.localeCompare(b.page.url));
      const rows = document.createDocumentFragment();
      matches.slice(0, limit).forEach((match, index) => rows.append(resultRow(match, index)));
      if (matches.length > limit) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'search-more';
        more.textContent = '再显示 ' + Math.min(batchSize, matches.length - limit) + ' 个网页';
        more.onclick = () => {
          const start = limit;
          limit += batchSize;
          refresh();
          results.children[start]?.querySelector('.search-title')?.focus();
        };
        const cell = document.createElement('div');
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-colspan', '2');
        cell.append(more);
        const moreRow = document.createElement('div');
        moreRow.setAttribute('role', 'row');
        moreRow.append(cell);
        rows.append(moreRow);
      }
      results.replaceChildren(rows);
      results.hidden = !matches.length;
      const links = [...results.querySelectorAll('.search-title')];
      const activeLink = links.find(link => link.href === activeUrl) || links[0];
      selectRow(activeLink?.closest('.search-result') || null);
      query.setAttribute('aria-expanded', String(matches.length > 0));
      empty.hidden = view === 'sites' || !!matches.length;
      empty.textContent = pages.length ? '没有找到匹配的网页' : '当天没有网页记录';

      // A fresh recorder snapshot can arrive while a link or time button has keyboard focus.
      if (focused && !focused.isConnected && dialog.open) {
        let replacement;
        if (focused.classList.contains('search-site')) {
          replacement = [...sites.children].find(node => node.dataset.domain === focused.dataset.domain);
        } else if (focused.classList.contains('search-title')) {
          replacement = [...results.querySelectorAll('a')].find(node => node.href === focused.href);
        } else if (focused.classList.contains('search-time')) {
          replacement = [...results.querySelectorAll('.search-time')].find(node => node.dataset.session === focused.dataset.session);
        } else if (focused.classList.contains('search-more')) {
          replacement = results.querySelector('.search-more');
        }
        (replacement || query).focus({preventScroll: true});
      }
    }

    function restart(nextView = 'idle') {
      finishDock?.();
      view = nextView;
      limit = batchSize;
      selectRow(null);
      refresh();
      results.scrollTop = 0;
    }

    function open(domain = '', entry = 'keyboard') {
      if (document.querySelector('dialog[open]') && !dialog.open) return;
      scope = domain;
      query.value = '';
      if (!dialog.open) {
        dialog.dataset.entry = entry;
        dialog.showModal();
      }
      trigger.setAttribute('aria-expanded', 'true');
      restart();
      query.focus();
    }

    function close() {
      finishDock?.();
      if (!dialog.open) return;
      dialog.close();
      if (dialog.contains(document.activeElement)) trigger.focus({preventScroll: true});
    }

    trigger.onclick = event => open('', event.detail > 0 ? 'pointer' : 'keyboard');
    reducedMotion.addEventListener('change', event => { if (event.matches) finishDock?.(); });
    browse.onclick = () => {
      restart(view === 'sites' ? 'idle' : 'sites');
      query.focus();
    };
    scopeButton.onclick = () => {
      scope = '';
      restart();
      query.focus();
    };
    query.addEventListener('input', () => restart());
    results.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch') return;
      const row = event.target.closest('.search-result');
      if (row) selectRow(row);
    });
    results.addEventListener('focusin', event => {
      const row = event.target.closest('.search-result');
      if (row) selectRow(row);
    });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      finishDock?.();
      trigger.setAttribute('aria-expanded', 'false');
      query.setAttribute('aria-expanded', 'false');
      selectRow(null);
      sites.replaceChildren();
      sites.hidden = noSites.hidden = true;
      results.replaceChildren();
      scopeButton.replaceChildren();
      query.value = '';
      if (document.activeElement === document.body) trigger.focus({preventScroll: true});
    });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.target !== query || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!activeRow && event.key === 'ArrowDown' && !scope && !query.value.trim() && view !== 'recent') {
        event.preventDefault();
        restart('recent');
        return;
      }
      if (!activeRow) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!event.repeat) activeRow.querySelector('.search-title').click();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const down = event.key === 'ArrowDown';
        let next = down ? activeRow.nextElementSibling : activeRow.previousElementSibling;
        if (down && next?.querySelector('.search-more')) {
          limit += batchSize;
          refresh();
          next = activeRow.nextElementSibling;
        }
        if (next?.matches('.search-result')) selectRow(next, true);
      }
    });
    dialog.addEventListener('click', event => {
      event.stopPropagation();
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== '/' || event.isComposing || event.defaultPrevented || event.repeat ||
          event.ctrlKey || event.altKey || event.metaKey || event.target.isContentEditable ||
          event.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      event.stopPropagation();
      open();
    }, true);
    return {open, refresh, close};
  }

  window.TraceDaySearch = {create};
})();
