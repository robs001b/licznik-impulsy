/* Strona porównania: wczytuje eksport aplikacji i plik z eLicznika, liczy godzinowe porównanie (compare.js). Wszystko lokalnie. */
(function () {
  'use strict';
  var C = window.LicznikCmp, $ = function (id) { return document.getElementById(id); };
  var app = null, tau = null, res = null;
  var f = function (x, d) { return x == null || !isFinite(x) ? '-' : x.toFixed(d).replace('.', ','); };
  var sg = function (x, d) { return !isFinite(x) ? '-' : (x > 0 ? '+' : x < 0 ? '-' : '') + f(Math.abs(x), d); };
  function status(t, err) { $('status').textContent = t; $('status').className = 'status' + (err ? ' err' : ''); }
  function cls(p) { var a = Math.abs(p); return !isFinite(a) ? '' : a < 3 ? 'okc' : a < 10 ? 'pos' : 'neg'; }

  function readFile(file) {
    return new Promise(function (ok, bad) {
      var r = new FileReader();
      r.onload = function () { ok(C.decode(r.result)); };
      r.onerror = function () { bad(r.error); };
      r.readAsArrayBuffer(file);
    });
  }
  function setApp(text, name) {
    app = C.parseApp(text);
    if (!app.pulses.length) { $('sApp').textContent = name + ': ' + (app.errors[0] || 'brak impulsów kWh'); $('sApp').className = 'fstat'; app = null; }
    else {
      var n0 = app.pulses.filter(function (p) { return p.ch === 0; }).length;
      $('sApp').textContent = name + ': ' + n0 + ' impulsów kWh, ' + C.fmtLocal(app.pulses[0].t, true) + ' - ' + C.fmtLocal(app.pulses[app.pulses.length - 1].t, true);
      $('sApp').className = 'fstat ok';
    }
    run();
  }
  function setTau(text, name) {
    tau = C.parseTauron(text);
    if (!tau.rows.length) { $('sTau').textContent = name + ': ' + (tau.errors[0] || 'brak danych'); $('sTau').className = 'fstat'; tau = null; }
    else {
      var sel = $('kind'), prev = sel.value;
      sel.innerHTML = '';
      tau.kinds.forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });
      sel.value = tau.kinds.indexOf(prev) >= 0 ? prev : (tau.kinds.filter(function (k) { return /pob/i.test(k); })[0] || tau.kinds[0]);
      $('sTau').textContent = name + ': ' + tau.rows.length + ' wierszy, ' + C.fmtLocal(tau.rows[0].start, true) + ' - ' + C.fmtLocal(tau.rows[tau.rows.length - 1].end, true) + (tau.errors.length ? ' (pominięto ' + tau.errors.length + ')' : '');
      $('sTau').className = 'fstat ok';
    }
    run();
  }

  function run() {
    $('btnCsvCmp').disabled = true;
    if (!app || !tau) { $('out').hidden = true; status(!app && !tau ? 'Wczytaj oba pliki.' : !app ? 'Wczytaj jeszcze eksport z aplikacji.' : 'Wczytaj jeszcze plik z eLicznika.'); return; }
    res = C.compare(tau.rows, C.aggregateHourly(app.pulses, 0), { kind: $('kind').value });
    if (!res.rows.length) {
      $('out').hidden = true;
      status('Brak wspólnych godzin. Aplikacja: ' + C.fmtLocal(app.pulses[0].t, true) + ' - ' + C.fmtLocal(app.pulses[app.pulses.length - 1].t, true) +
        ', Tauron: ' + C.fmtLocal(tau.rows[0].start, true) + ' - ' + C.fmtLocal(tau.rows[tau.rows.length - 1].end, true) + '. Sprawdź, czy to ten sam dzień.', true);
      return;
    }
    status('Wspólne godziny: ' + res.rows.length + '.');
    $('out').hidden = false; $('btnCsvCmp').disabled = false;
    renderSummary(); renderList(); drawChart();
  }

  function renderSummary() {
    var s = res.summary, h = '';
    h += '<h2>Podsumowanie</h2><p class="hint">Zakres wspólny: ' + C.fmtLocal(s.from, true) + ' - ' + C.fmtLocal(s.to, false) + ' (czas polski). Rodzaj: ' + $('kind').value + '.</p>';
    h += '<div class="sumgrid">';
    if (s.fullHours) {
      h += '<div><span>Tauron, pełne godziny (' + s.fullHours + ')</span><b>' + f(s.tauronFull, 3) + ' kWh</b></div>';
      h += '<div><span>Aplikacja, pełne godziny</span><b>' + f(s.appFull, 3) + ' kWh</b></div>';
      h += '<div><span>Różnica (pełne)</span><b class="' + cls(s.pctFull) + '" id="sumPct">' + sg(s.diffFull, 3) + ' kWh / ' + sg(s.pctFull, 1) + '%</b></div>';
    }
    h += '<div><span>Wszystkie godziny (' + s.hours + '), Tauron proporcjonalnie</span><b>' + f(s.tauronAll, 3) + ' / ' + f(s.appAll, 3) + '</b></div>';
    h += '<div><span>Różnica (wszystkie)</span><b class="' + cls(s.pctAll) + '">' + sg(s.diffAll, 3) + ' kWh / ' + sg(s.pctAll, 1) + '%</b></div>';
    if (s.partialHours) h += '<div><span>Godziny niepełne</span><b>' + s.partialHours + '</b></div>';
    h += '</div><p class="hint">Różnica = aplikacja - Tauron. Licznik w eLiczniku podaje kWh z dokładnością 0,001, aplikacja liczy impulsy (1 imp = 1/stała kWh).</p>';
    $('sumBox').innerHTML = h;
  }

  function renderList() {
    var L = $('list'); L.innerHTML = '';
    res.rows.forEach(function (r) {
      var d = document.createElement('div'); d.className = 'hrow' + (r.full ? '' : ' part');
      d.innerHTML = '<div class="h1"><span>' + r.label + (r.zone ? ' · ' + r.zone : '') + '</span><span>' + (r.full ? 'pełna' : 'pokrycie ' + f(r.frac * 100, 0) + '%') + '</span></div>' +
        '<div class="h2"><span>T: ' + f(r.tauron, 3) + (r.full ? '' : ' (' + f(r.tauronRef, 3) + ')') + '</span><span>A: ' + f(r.app, 3) + (r.full ? '' : ' (~' + f(r.appScaled, 3) + '/h)') + '</span>' +
        '<span class="' + cls(r.pct) + '">' + sg(r.diff, 3) + ' · ' + sg(r.pct, 1) + '%</span></div>';
      L.appendChild(d);
    });
  }

  function drawChart() {
    var cv = $('chart'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 360, H = 220;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    var rows = res.rows, max = 0;
    rows.forEach(function (r) { max = Math.max(max, r.tauron, r.app); });
    max = max > 0 ? max * 1.1 : 1;
    var L = 34, B = 26, T = 8, R = 4, cw = (W - L - R) / rows.length, bw = Math.max(2, Math.min(22, cw * 0.36));
    g.font = '11px system-ui,sans-serif'; g.fillStyle = '#8b98a5'; g.strokeStyle = '#30363d'; g.lineWidth = 1;
    var step = max > 4 ? 1 : max > 2 ? 0.5 : max > 0.8 ? 0.25 : 0.1;
    for (var v = 0; v <= max; v += step) {
      var y = H - B - (H - B - T) * v / max;
      g.beginPath(); g.moveTo(L, y + 0.5); g.lineTo(W - R, y + 0.5); g.stroke();
      g.textAlign = 'right'; g.fillText(f(v, step < 0.25 ? 1 : 2), L - 4, y + 4);
    }
    g.save(); g.translate(10, (H - B) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('kWh', 0, 0); g.restore();
    var pat = (function () { var p = document.createElement('canvas'); p.width = p.height = 6; var c = p.getContext('2d'); c.strokeStyle = '#58a6ff'; c.lineWidth = 2; c.beginPath(); c.moveTo(0, 6); c.lineTo(6, 0); c.stroke(); return g.createPattern(p, 'repeat'); })();
    var every = Math.ceil(rows.length / Math.max(1, Math.floor((W - L) / 34)));
    rows.forEach(function (r, i) {
      var x0 = L + i * cw + cw / 2, hT = (H - B - T) * r.tauron / max, hA = (H - B - T) * r.app / max;
      g.fillStyle = '#58a6ff'; g.globalAlpha = r.full ? 1 : 0.35; g.fillRect(x0 - bw - 1, H - B - hT, bw, hT); g.globalAlpha = 1;
      if (!r.full) { var hr = (H - B - T) * r.tauronRef / max; g.fillStyle = pat; g.fillRect(x0 - bw - 1, H - B - hr, bw, hr); g.strokeStyle = '#58a6ff'; g.strokeRect(x0 - bw - 0.5, H - B - hr + 0.5, bw - 1, hr - 1); }
      g.fillStyle = '#3fb950'; g.fillRect(x0 + 1, H - B - hA, bw, hA);
      if (i % every === 0) { g.fillStyle = '#8b98a5'; g.textAlign = 'center'; g.fillText(r.label.slice(11, 13), x0, H - B + 14); }
    });
    g.fillStyle = '#8b98a5'; g.textAlign = 'right'; g.fillText('godzina (początek)', W - R, H - 2);
  }

  $('fApp').onchange = function () { var fl = this.files[0]; if (fl) readFile(fl).then(function (t) { setApp(t, fl.name); }); };
  $('fTau').onchange = function () { var fl = this.files[0]; if (fl) readFile(fl).then(function (t) { setTau(t, fl.name); }); };
  $('kind').onchange = run;
  $('btnDemo').onclick = function () {
    status('Wczytuję przykład...');
    Promise.all(['przyklad/aplikacja-przyklad.csv', 'przyklad/tauron-przyklad.csv'].map(function (u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u); return r.arrayBuffer(); }); }))
      .then(function (b) { setApp(C.decode(b[0]), 'aplikacja-przyklad.csv (sztuczne dane)'); setTau(C.decode(b[1]), 'tauron-przyklad.csv (sztuczne dane)'); })
      .catch(function (e) { status('Nie udało się wczytać przykładu: ' + e.message, true); });
  };
  $('btnCsvCmp').onclick = function () {
    if (!res) return;
    var blob = new Blob([C.toCsv(res)], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
    var p = C.utcToLocalParts(res.summary.from), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    a.href = URL.createObjectURL(blob); a.download = 'porownanie-' + p.y + p2(p.mo) + p2(p.d) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  };
  // dane ostatniego pomiaru zapisane przez stronę główną (localStorage) - bez wczytywania pliku
  var ses = null;
  try { ses = JSON.parse(localStorage.getItem('licznik-impulsy-sesja') || 'null'); } catch (e) {}
  if (ses && ses.csv) {
    var sd = new Date(ses.start), p2s = function (n) { return (n < 10 ? '0' : '') + n; };
    var hm = function (t) { var d = new Date(t); return p2s(d.getHours()) + ':' + p2s(d.getMinutes()); };
    $('sesTxt').textContent = 'Pomiar z tej przeglądarki: ' + sd.getFullYear() + '-' + p2s(sd.getMonth() + 1) + '-' + p2s(sd.getDate()) + ' ' + hm(ses.start) + '-' + hm(ses.end) + ', ' + ses.nk + ' impulsów kWh.';
    $('sesBox').hidden = false;
    $('btnSes').onclick = function () { setApp(ses.csv, 'dane z tej sesji (' + (ses.name || 'pomiar') + ')'); };
    if (/[?&]sesja=1/.test(location.search)) $('btnSes').click();
  }
  window.addEventListener('resize', function () { if (res && res.rows.length) drawChart(); });
  window.__cmp = function () { return res; };
  if (/[?&]demo=1/.test(location.search)) $('btnDemo').click();
  if (!app) status('Wczytaj oba pliki albo „Wczytaj przykład”.');
})();
