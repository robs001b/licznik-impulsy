/* Porównanie danych z aplikacji (eksport CSV impulsów) z danymi godzinowymi z eLicznika Tauron.
   Bez zależności - przeglądarka (window.LicznikCmp) i Node (require). Czas: Europe/Warsaw (reguły UE dla zmiany czasu). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LicznikCmp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var HOUR = 3600000;

  /* ---------- czas Europe/Warsaw ---------- */
  function lastSunday(y, m) { // m: 1..12, zwraca dzień miesiąca
    var d = new Date(Date.UTC(y, m, 0)); // ostatni dzień miesiąca
    return d.getUTCDate() - d.getUTCDay();
  }
  function isDST(utc) { // czas letni: od ostatniej niedzieli marca 01:00 UTC do ostatniej niedzieli października 01:00 UTC
    var y = new Date(utc).getUTCFullYear();
    return utc >= Date.UTC(y, 2, lastSunday(y, 3), 1) && utc < Date.UTC(y, 9, lastSunday(y, 10), 1);
  }
  function offsetMs(utc) { return isDST(utc) ? 2 * HOUR : HOUR; }
  /* czas lokalny Warszawy -> UTC; godzina niejednoznaczna (jesień) -> pierwsze wystąpienie */
  function localToUtc(y, mo, d, h, mi, s, ms) {
    var naive = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0, ms || 0);
    var u = naive - 2 * HOUR;
    return isDST(u) ? u : naive - HOUR;
  }
  function utcToLocalParts(utc) {
    var d = new Date(utc + offsetMs(utc));
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtLocal(utc, withDate) {
    var p = utcToLocalParts(utc);
    return (withDate ? p.y + '-' + p2(p.mo) + '-' + p2(p.d) + ' ' : '') + p2(p.h) + ':' + p2(p.mi);
  }
  function hourLabel(startUtc) { // "2026-11-11 14:00-15:00" (czas lokalny)
    var a = utcToLocalParts(startUtc), b = utcToLocalParts(startUtc + HOUR);
    return a.y + '-' + p2(a.mo) + '-' + p2(a.d) + ' ' + p2(a.h) + ':00-' + (b.h === 0 ? '24' : p2(b.h)) + ':00' + (isDST(startUtc) !== isDST(startUtc + HOUR - 1) ? '' : '');
  }

  /* ---------- tekst / CSV ---------- */
  function decode(buf) { // ArrayBuffer/Uint8Array -> tekst; UTF-8, a gdy błędny - Windows-1250
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { try { return new TextDecoder('windows-1250').decode(u8); } catch (e2) { return new TextDecoder('latin1').decode(u8); } }
  }
  function lines(text) { return String(text).replace(/^\ufeff/, '').split(/\r\n|\n|\r/); }
  function cells(line) { return line.split(';').map(function (c) { return c.replace(/^\s*"?|"?\s*$/g, '').trim(); }); }
  function num(s) {
    if (s == null) return NaN;
    s = String(s).replace(/\s|\u00a0/g, '');
    if (s === '') return NaN;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    return Number(s);
  }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/\s+/g, ' ').trim(); }

  /* ---------- eLicznik Tauron ----------
     Nagłówek: Data; Strefa; Wartość ;Rodzaj;Status;   data "YYYY-MM-DD H:00" = KONIEC okresu (24:00 = 23-24). */
  function parseTauron(text) {
    var L = lines(text), head = -1, idx = {}, rows = [], errors = [], used = {};
    for (var i = 0; i < L.length && head < 0; i++) {
      var c = cells(L[i]).map(norm);
      if (c.indexOf('data') >= 0 && c.some(function (x) { return x.indexOf('warto') === 0; })) {
        head = i;
        c.forEach(function (x, k) {
          if (x === 'data') idx.date = k; else if (x.indexOf('strefa') === 0) idx.zone = k; else if (x.indexOf('warto') === 0) idx.val = k;
          else if (x.indexOf('rodzaj') === 0) idx.kind = k; else if (x.indexOf('status') === 0) idx.status = k;
        });
      }
    }
    if (head < 0) return { rows: [], kinds: [], errors: ['Nie znaleziono nagłówka "Data; Strefa; Wartość; Rodzaj" - to nie wygląda na plik z eLicznika.'] };
    for (i = head + 1; i < L.length; i++) {
      if (!L[i].trim()) continue;
      var c2 = cells(L[i]);
      var m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})/.exec(c2[idx.date] || '');
      var v = num(c2[idx.val]);
      if (!m || !isFinite(v)) { if (L[i].replace(/[;\s]/g, '')) errors.push('Wiersz ' + (i + 1) + ': pominięty (' + L[i].slice(0, 40) + ')'); continue; }
      var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
      var end = localToUtc(y, mo, d, h, mi); // 24:00 -> Date.UTC przelicza na następny dzień
      var kindRaw = idx.kind != null ? (c2[idx.kind] || '') : 'pobór [kWh]';
      var key = kindRaw + '|' + end;
      if (used[key]) end += HOUR; // jesienna zmiana czasu: druga "ta sama" godzina
      used[kindRaw + '|' + end] = true;
      var unitM = /\[([^\]]+)\]/.exec(kindRaw), unit = unitM ? unitM[1] : 'kWh';
      var mult = /^wh$/i.test(unit) ? 0.001 : /^mwh$/i.test(unit) ? 1000 : 1;
      rows.push({ day: y + '-' + p2(mo) + '-' + p2(d), y: y, mo: mo, d: d, start: end - HOUR, end: end, kwh: v * mult, zone: idx.zone != null ? c2[idx.zone] : '', kind: kindRaw.replace(/\s*\[[^\]]*\]\s*/, '').trim() || kindRaw,
                  kindRaw: kindRaw, status: idx.status != null ? c2[idx.status] : '', label: c2[idx.date] });
    }
    // dni zmiany czasu (23 lub 25 godzin): gdy dzień jest kompletny, godziny przypisujemy kolejno od północy
    var groups = {};
    rows.forEach(function (r) { (groups[r.kindRaw + '|' + r.day] || (groups[r.kindRaw + '|' + r.day] = [])).push(r); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], r0 = g[0];
      var d0 = localToUtc(r0.y, r0.mo, r0.d, 0, 0), d1 = localToUtc(r0.y, r0.mo, r0.d + 1, 0, 0), n = Math.round((d1 - d0) / HOUR);
      if (n !== 24 && g.length === n) g.forEach(function (r, i2) { r.start = d0 + i2 * HOUR; r.end = r.start + HOUR; });
    });
    rows.sort(function (a, b) { return a.start - b.start; });
    var kinds = []; rows.forEach(function (r) { if (kinds.indexOf(r.kind) < 0) kinds.push(r.kind); });
    return { rows: rows, kinds: kinds, errors: errors };
  }

  /* ---------- eksport aplikacji ----------
     czas;czas_od_startu_s;typ;T_s;wartosc;jednostka;srednia_N;stala_imp[;czas_utc]
     typ: kWh / kvarh (impuls), start / koniec (granice pomiaru, nowsze wersje). */
  function parseLocalStamp(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?/.exec(s || '');
    if (!m) return NaN;
    return localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), +((m[7] || '0') + '00').slice(0, 3));
  }
  function parseApp(text) {
    var L = lines(text), head = -1, idx = {}, pulses = [], marks = [], errors = [];
    for (var i = 0; i < L.length && head < 0; i++) {
      var c = cells(L[i]).map(norm);
      if (c[0] === 'czas' && c.indexOf('typ') >= 0) { head = i; c.forEach(function (x, k) { idx[x] = k; }); }
    }
    if (head < 0) return { pulses: [], marks: [], errors: ['Nie znaleziono nagłówka "czas;...;typ" - to nie jest eksport z aplikacji.'] };
    for (i = head + 1; i < L.length; i++) {
      if (!L[i].trim() || /^wygenerowa/i.test(norm(L[i]))) continue;
      var c2 = cells(L[i]);
      var t = idx.czas_utc != null && c2[idx.czas_utc] ? Date.parse(c2[idx.czas_utc]) : NaN;
      if (!isFinite(t)) t = parseLocalStamp(c2[idx.czas]);
      if (!isFinite(t)) { errors.push('Wiersz ' + (i + 1) + ': zły czas'); continue; }
      var typ = norm(c2[idx.typ]);
      if (typ === 'start' || typ === 'koniec') { marks.push({ t: t, typ: typ }); continue; }
      var ch = typ === 'kwh' ? 0 : typ === 'kvarh' ? 1 : -1;
      if (ch < 0) continue;
      var k = num(c2[idx.stala_imp]);
      pulses.push({ t: t, ch: ch, c: isFinite(k) && k > 0 ? k : 1000 });
    }
    pulses.sort(function (a, b) { return a.t - b.t; });
    marks.sort(function (a, b) { return a.t - b.t; });
    return { pulses: pulses, marks: marks, errors: errors };
  }

  /* Agregacja godzinowa jednego kanału. Energia impulsu (1/stała) rozkładana równomiernie na przedział od poprzedniego impulsu
     (tam był pobór). Pokrycie = przedziały między kolejnymi impulsami; przerwa > maxGap = brak pomiaru (aplikacja w tle). */
  function aggregateHourly(pulses, ch, opts) {
    opts = opts || {};
    var maxGap = (opts.maxGapMin || 30) * 60000, P = pulses.filter(function (p) { return p.ch === ch; });
    var hours = {};
    function add(a, b, kwh) { // rozkład energii kwh równomiernie na [a,b)
      var len = b - a;
      for (var h = Math.floor(a / HOUR) * HOUR; h < b; h += HOUR) {
        var ov = Math.min(b, h + HOUR) - Math.max(a, h);
        if (ov <= 0) continue;
        var o = hours[h] || (hours[h] = { start: h, kwh: 0, cov: 0, pulses: 0 });
        o.kwh += kwh * ov / len; o.cov += ov;
      }
    }
    for (var i = 1; i < P.length; i++) {
      var a = P[i - 1].t, b = P[i].t;
      if (b - a > maxGap || b <= a) continue;
      add(a, b, 1 / P[i].c);
      var hb = Math.floor(b / HOUR) * HOUR; if (hours[hb]) hours[hb].pulses++;
    }
    return hours;
  }

  /* Porównanie: dla godzin Taurona (wybrany rodzaj) z pokryciem aplikacji > 0. */
  function compare(tauronRows, appHours, opts) {
    opts = opts || {};
    var kind = opts.kind, full = opts.fullFrac || 0.98, minCov = (opts.minCovMin || 5) * 60000;
    var T = {};
    tauronRows.forEach(function (r) { if (!kind || r.kind === kind) { var o = T[r.start] || (T[r.start] = { kwh: 0, zone: r.zone }); o.kwh += r.kwh; } });
    var out = [];
    Object.keys(T).map(Number).sort(function (a, b) { return a - b; }).forEach(function (h) {
      var a = appHours[h];
      if (!a || a.cov < minCov) return;
      var frac = Math.min(1, a.cov / HOUR), t = T[h].kwh;
      var tRef = t * frac; // dla godziny niepełnej: proporcjonalna część zużycia z Taurona
      var diff = a.kwh - tRef;
      out.push({ start: h, label: hourLabel(h), zone: T[h].zone, tauron: t, app: a.kwh, frac: frac, full: frac >= full,
                 tauronRef: tRef, appScaled: frac > 0 ? a.kwh / frac : NaN, diff: diff, pct: tRef > 0 ? diff / tRef * 100 : NaN });
    });
    var sum = function (arr, k) { return arr.reduce(function (s, r) { return s + r[k]; }, 0); };
    var F = out.filter(function (r) { return r.full; });
    var summary = {
      hours: out.length, fullHours: F.length, partialHours: out.length - F.length,
      tauronFull: sum(F, 'tauron'), appFull: sum(F, 'app'),
      tauronAll: sum(out, 'tauronRef'), appAll: sum(out, 'app'),
      from: out.length ? out[0].start : NaN, to: out.length ? out[out.length - 1].start + HOUR : NaN
    };
    summary.diffFull = summary.appFull - summary.tauronFull;
    summary.pctFull = summary.tauronFull > 0 ? summary.diffFull / summary.tauronFull * 100 : NaN;
    summary.diffAll = summary.appAll - summary.tauronAll;
    summary.pctAll = summary.tauronAll > 0 ? summary.diffAll / summary.tauronAll * 100 : NaN;
    var tr = tauronRows.filter(function (r) { return !kind || r.kind === kind; });
    summary.tauronRange = tr.length ? [tr[0].start, tr[tr.length - 1].end] : null;
    return { rows: out, summary: summary };
  }

  function toCsv(res, now) {
    var c = function (x, d) { return x == null || !isFinite(x) ? '' : x.toFixed(d).replace('.', ','); };
    var L = ['godzina;strefa;tauron_kWh;aplikacja_kWh;pokrycie_%;tauron_proporcjonalnie_kWh;roznica_kWh;roznica_%;pelna_godzina'];
    res.rows.forEach(function (r) {
      L.push([r.label, r.zone, c(r.tauron, 3), c(r.app, 4), c(r.frac * 100, 1), c(r.tauronRef, 4), c(r.diff, 4), c(r.pct, 1), r.full ? 'tak' : 'nie'].join(';'));
    });
    var s = res.summary;
    L.push('');
    L.push('Suma pełnych godzin (' + s.fullHours + ');;' + c(s.tauronFull, 3) + ';' + c(s.appFull, 4) + ';;;' + c(s.diffFull, 4) + ';' + c(s.pctFull, 1) + ';');
    L.push('Suma wszystkich (proporcjonalnie);;;' + c(s.appAll, 4) + ';;' + c(s.tauronAll, 4) + ';' + c(s.diffAll, 4) + ';' + c(s.pctAll, 1) + ';');
    L.push('');
    var d = now || new Date();
    L.push('Wygenerował: ' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()));
    return '\ufeff' + L.join('\r\n');
  }

  return { HOUR: HOUR, isDST: isDST, localToUtc: localToUtc, utcToLocalParts: utcToLocalParts, fmtLocal: fmtLocal, hourLabel: hourLabel,
           decode: decode, num: num, parseTauron: parseTauron, parseApp: parseApp, parseLocalStamp: parseLocalStamp,
           aggregateHourly: aggregateHourly, compare: compare, toCsv: toCsv };
});
