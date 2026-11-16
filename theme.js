// Motyw wyglądu: różowy (domyślny), Tauron, klasyczny ciemny. Wybór w Ustawieniach, zapamiętany w localStorage.
// Ładowany zaraz po <body>, żeby motyw był nałożony przed pierwszym rysowaniem (bez mignięcia).
(function () {
  var KEY = 'licznik-impulsy-motyw', DEF = 'roz';
  var THEMES = {
    roz: { name: 'Różowy (domyślny)', cls: ['app-home', 'theme-roz'], color: '#291c35' },
    tauron: { name: 'Tauron', cls: ['app-home', 'theme-tauron'], color: '#291c35' },
    klasyczny: { name: 'Klasyczny ciemny', cls: ['theme-klasyczny'], color: '#0e1116' }
  };
  function get() { var t = null; try { t = localStorage.getItem(KEY); } catch (e) {} return THEMES[t] ? t : DEF; }
  function apply(t) {
    var b = document.body, all = ['app-home', 'theme-roz', 'theme-tauron', 'theme-klasyczny'];
    for (var i = 0; i < all.length; i++) b.classList.remove(all[i]);
    for (var j = 0; j < THEMES[t].cls.length; j++) b.classList.add(THEMES[t].cls[j]);
    b.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', THEMES[t].color);
  }
  function set(t) { if (!THEMES[t]) t = DEF; try { localStorage.setItem(KEY, t); } catch (e) {} apply(t); }
  apply(get());
  function wire() {
    var s = document.getElementById('theme'); if (!s) return;
    s.innerHTML = '';
    for (var k in THEMES) { var o = document.createElement('option'); o.value = k; o.textContent = THEMES[k].name; s.appendChild(o); }
    s.value = get();
    s.addEventListener('change', function () { set(s.value); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  window.__motyw = { get: get, set: set, themes: Object.keys(THEMES), def: DEF };
})();
