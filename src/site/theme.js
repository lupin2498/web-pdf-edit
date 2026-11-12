// Runs before the page is painted (a classic blocking script in <head>):
// applies the saved or system colour theme so that the page never flashes in
// the wrong theme, and marks that JavaScript is available.
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var theme = '';
  try {
    theme = (JSON.parse(localStorage.getItem('pdfedit.settings') || '{}') || {}).theme || '';
  } catch (e) {
    theme = '';
  }
  if (theme !== 'dark' && theme !== 'light') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', theme);
})();
