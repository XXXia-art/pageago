(() => {
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  save("sentry_opt_out", true);
  save("posthog_consent", { optedIn: false, consentVersion: 1, answeredAt: null,
    appVersion: null, source: null });
  if (localStorage.getItem("daytrace-layout-v1")) return;

  const row = Math.max(1, Math.round((window.innerHeight * 0.4 - 150) / 60));
  const vector = (x, y) => ({ __type__: "vec2", x, y });
  save("widgets", [
    { id: 1, type: "Search", position: vector(6, row), size: vector(12, 1),
      theme: { showPanelBG: true }, props: { useBrowserEngine: false, enableGlobalSearch: false,
        searchTitle: "必应", searchURL: "https://www.bing.com/search?q={query}" } },
    { id: 2, type: "Links", position: vector(2, row + 1), size: vector(20, 2),
      theme: { showPanelBG: false, listBoxStyle: 2, showText: true },
      props: { title: "", showAddButton: false, useWebsiteIcons: false,
        openInNewTab: true, links: window.renewedPreviewLinks } },
    { id: 3, type: "IFrame", position: vector(1, row + 3), size: vector(22, 7),
      theme: { showPanelBG: false }, props: { url: "/widget/?embed=timeline" } },
  ]);
  save("locale", "zh-cn");
  save("locked", true);
  save("grid_settings", { fullPage: true, columns: 24, spacing: 10 });
  save("onboarding_completed", true);
  save("showBookmarksBar", false);
  save("background", { mode: "ImageUrl", values: { url: "/background.jpg", brightnessDark: 100, blur: 0 } });
  save("theme", { fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' });
  save("daytrace-layout-v1", true);
})();
