// Applies the colour theme before first paint, so the page never flashes the
// wrong theme. It lives in <head>, ahead of the stylesheet, and is deliberately
// tiny and external (no inline script) so it satisfies the strict CSP.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem("beebots-theme");
  } catch (e) {
    // Storage can be unavailable in private mode; fall back to the OS.
  }
  var theme = stored === "light" || stored === "dark" ? stored : null;
  if (!theme) {
    try {
      theme = window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    } catch (e) {
      theme = "dark";
    }
  }
  document.documentElement.dataset.theme = theme;
})();
