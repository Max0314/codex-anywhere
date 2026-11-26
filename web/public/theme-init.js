(function () {
  var mode = 'system';
  try { mode = localStorage.getItem('bridge.theme') || mode; } catch (_) {}
  var dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  var color = document.querySelector('meta[name="theme-color"]');
  if (color) color.setAttribute('content', dark ? '#212121' : '#ffffff');
  var scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute('content', dark ? 'dark' : 'light');
})();
