// Loaded with a plain blocking <script> in the head, before anything paints:
// applies the theme the page cached last time, so a themed page never flashes
// the default colours. page.mjs owns everything after this.
(function () {
  try {
    var cache = JSON.parse(localStorage.getItem("canvas:theme-cache") || "null");
    if (!cache) return;
    var mode = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    var t = cache[mode];
    if (!t || !t.vars) return;
    var s = document.documentElement.style;
    for (var k in t.vars) s.setProperty(k, t.vars[k]);
    s.colorScheme = t.mode || mode;
  } catch (e) {}
})();
