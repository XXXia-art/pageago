/* Click-selected website emphasis, sharing the registered-domain identity of site colors. */
(() => {
  'use strict';

  function create({scene}) {
    if (!scene?.ownerDocument) throw new TypeError('A timeline scene is required.');
    const document = scene.ownerDocument;
    let activeSite = null;

    function refresh() {
      // Keep a selection through zoom, pan and live updates, even if its label is offscreen.
      const rows = [...scene.querySelectorAll('.lane[data-site]')];
      if (activeSite && !rows.some(row => row.dataset.site === activeSite)) activeSite = null;
      if (activeSite) scene.dataset.highlightSite = activeSite;
      else delete scene.dataset.highlightSite;
      for (const node of scene.querySelectorAll('.lane[data-site],.event-tag[data-site],.event-link[data-site],.event-anchor[data-site]')) {
        node.classList.toggle('site-highlighted', !!activeSite && node.dataset.site === activeSite);
      }
      for (const button of document.querySelectorAll('.event-tag[data-site],#overflow-list .overflow-item[data-site]')) {
        button.setAttribute('aria-pressed', String(!!activeSite && button.dataset.site === activeSite));
      }
    }

    function select(site) {
      activeSite = site || null;
      refresh();
    }

    function clear() { select(null); }

    // Native button click handlers also cover Enter/Space; hover and focus never select.
    return {select, clear, refresh, snapshot: () => ({site: activeSite}), destroy: clear};
  }

  window.TracePageHighlight = Object.freeze({create});
})();
