/* Detekcja impulsów diod LED licznika + obliczenia mocy.
   Moduł bez zależności - działa w przeglądarce (window.LicznikDet) i w Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LicznikDet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- Sygnał "czerwonej diody" ----------
     Wynik piksela (0..255):
     - piksel czerwony (chromatyczność R wyraźnie ponad G i B): 0,6 * R * waga nasycenia,
     - piksel prześwietlony biały (miękko: min(R,G,B) 170..230) liczy się jako rdzeń diody (do 255) TYLKO gdy
       obok jest czerwona poświata (bramka) - biały odblask lampy / refleks bez czerwieni = 0,
     - szary / biały / niebieskawy = 0 (globalne zmiany światła lampy prawie nie zmieniają wyniku). */
  function redVal(r, g, b) {
    var mx = g > b ? g : b, chroma = r > 0 ? (r - mx) / r : 0;
    var k = (chroma - 0.15) / 0.35; if (k <= 0) return 0; if (k > 1) k = 1;
    return r * k;
  }
  // "białość" 0..1 (prześwietlenie); miękka, żeby migotanie lampy nie przełączało piksela 0/255
  function whiteness(r, g, b) {
    if (r < 200) return 0;
    var mn = g < b ? g : b; if (r < mn) mn = r;
    var k = (mn - 170) / 60; return k <= 0 ? 0 : k > 1 ? 1 : k;
  }
  function gateOf(maxRed) { var k = (maxRed - 130) / 70; return k < 0 ? 0 : k > 1 ? 1 : k; }

  /* Mapa wyniku dla obrazu RGBA. gateR >= 0: bramka z lokalnego maksimum czerwieni w promieniu gateR;
     gateR < 0: jedna bramka dla całego okna. mode 'luma' = zwykła jasność (stary tryb). */
  function scoreMap(data, w, h, mode, gateR) {
    var n = w * h, out = new Float32Array(n), i, x, y;
    if (mode === 'luma') {
      for (i = 0; i < n; i++) out[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      return out;
    }
    var red = new Float32Array(n), wh = new Float32Array(n), anyW = false, maxRed = 0;
    for (i = 0; i < n; i++) {
      var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      red[i] = redVal(r, g, b); if (red[i] > maxRed) maxRed = red[i];
      var wv = whiteness(r, g, b); if (wv > 0) { wh[i] = wv; anyW = true; }
    }
    var loc = null;
    if (anyW && gateR >= 0) { // lokalne maksimum czerwieni (filtr max, rozdzielny)
      var tmp = new Float32Array(n); loc = new Float32Array(n);
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        var m = 0; for (var dx = -gateR; dx <= gateR; dx++) { var xx = x + dx; if (xx >= 0 && xx < w && red[y * w + xx] > m) m = red[y * w + xx]; }
        tmp[y * w + x] = m;
      }
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        var m2 = 0; for (var dy = -gateR; dy <= gateR; dy++) { var yy = y + dy; if (yy >= 0 && yy < h && tmp[yy * w + x] > m2) m2 = tmp[yy * w + x]; }
        loc[y * w + x] = m2;
      }
    }
    var gW = gateOf(maxRed);
    for (i = 0; i < n; i++) {
      var rv = 0.6 * red[i];
      if (wh[i]) { var wv2 = 255 * wh[i] * (loc ? gateOf(loc[i]) : gW); if (wv2 > rv) rv = wv2; }
      out[i] = rv;
    }
    return out;
  }

  /* Statystyki okna (RGBA): mean = środek (ROI), ring = pierścień wokół (reszta okna), white = udział białego rdzenia. */
  function roiStats(data, w, h, mode, inner) {
    var sm = scoreMap(data, w, h, mode === 'red' ? 'led' : mode, -1);
    var x0 = inner ? inner.x0 : 0, y0 = inner ? inner.y0 : 0, x1 = inner ? inner.x1 : w, y1 = inner ? inner.y1 : h;
    var si = 0, ni = 0, so = 0, no = 0, max = 0, wcnt = 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var v = sm[y * w + x];
      if (x >= x0 && x < x1 && y >= y0 && y < y1) { si += v; ni++; if (v > max) max = v; if (v >= 250) wcnt++; }
      else { so += v; no++; }
    }
    return { mean: ni ? si / ni : 0, ring: no ? so / no : 0, max: max, white: ni ? wcnt / ni : 0 };
  }
  function frameMean(data, w, h, mode) {
    var sm = scoreMap(data, w, h, mode === 'red' ? 'led' : mode, 2), s = 0;
    for (var i = 0; i < sm.length; i++) s += sm[i];
    return s / sm.length;
  }

  /* Środek ciężkości najsilniejszych pikseli okna (0..1). Do śledzenia ROI. */
  function brightCentroid(data, w, h, mode) {
    var sm = scoreMap(data, w, h, mode || 'led', -1), max = 0, i, x, y, l;
    for (i = 0; i < sm.length; i++) if (sm[i] > max) max = sm[i];
    if (max < 100) return null;
    var thr = max * 0.85, sx = 0, sy = 0, sw = 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      l = sm[y * w + x];
      if (l >= thr) { var wt = l - thr + 1; sx += (x + 0.5) * wt; sy += (y + 0.5) * wt; sw += wt; }
    }
    if (!sw) return null;
    return { x: sx / sw / w, y: sy / sw / h };
  }

  /* Tło pomocnicze (pierścień, cały kadr): dolna obwiednia jak w kanale. */
  function Baseline() { this.b = null; this.t = null; }
  Baseline.prototype.update = function (t, v) {
    if (this.b == null) { this.b = v; this.t = t; return 0; }
    var dt = Math.max(1, t - this.t); this.t = t;
    var a = 1 - Math.exp(-dt / (v < this.b ? 120 : 1500));
    var ex = Math.max(0, v - this.b);
    this.b += a * (v - this.b);
    return ex;
  };

  var DEF = {
    sens: 0.5,          // czułość 0..1 (więcej = czulej)
    minIntervalMs: 60,  // minimalny odstęp między impulsami (debounce)
    maxPulseMs: 300,    // dłuższe "świecenie" = zmiana sceny, nie impuls
    minDelta: 12,       // minimalny skok jasności nad tło (0..255)
    tauBaseMs: 1500,    // stała czasowa adaptacji tła (w górę)
    tauDownMs: 120,     // stała czasowa adaptacji tła w dół
    warmupMs: 500,      // czas na nauczenie tła po starcie
    shapeK: 0.7,        // kształt: skok w ROI >= shapeK * skok w pierścieniu wokół (mała zwarta plama)
    globalK: 0.35       // skok całego kadru > globalK * skok w ROI = zmiana oświetlenia, nie impuls
  };

  function Channel(opts) { this.o = {}; this.set(opts); this.reset(); }
  Channel.prototype.set = function (opts) {
    for (var k in DEF) this.o[k] = (opts && opts[k] != null) ? opts[k] : (this.o[k] != null ? this.o[k] : DEF[k]);
  };
  Channel.prototype.reset = function () {
    this.base = null; this.noise = 1; this.amp = null; this.high = false;
    this.t0 = null; this.lastT = null; this.lastV = null; this.lastPulse = -Infinity;
    this.edgeT = 0; this.peak = 0; this.peakOther = 0; this.peakRing = 0; this.peakGlob = 0;
    this.rejected = { xtalk: 0, shape: 0, global: 0, long: 0 };
  };
  Channel.prototype.thresholds = function () {
    if (this.base == null) return { on: 255, off: 255 };
    var s = Math.min(1, Math.max(0, this.o.sens));
    var frac = 0.75 - 0.6 * s;                 // s=0,5 -> 45% amplitudy
    var ampEst = this.amp != null ? this.amp : 80;
    var d = Math.max(this.o.minDelta * (1.5 - s), Math.min(5 * this.noise, 0.5 * ampEst), frac * ampEst);
    var on = this.base + d;
    return { on: on, off: this.base + 0.5 * d };
  };
  Channel.prototype.excess = function (v) { return this.base == null ? 0 : Math.max(0, v - this.base); };

  /* t [ms], v - sygnał, otherEx - nadwyżka nad tło w sąsiednim ROI, xtalk - tłumienie przesłuchu (0 = wył.)
     Zwraca obiekt impulsu {t, peak} po potwierdzeniu (na zboczu opadającym), czas = zbocze narastające. */
  Channel.prototype.update = function (t, v, otherEx, xtalk, ringEx, globEx) {
    var o = this.o, res = null;
    ringEx = ringEx || 0; globEx = globEx || 0;
    if (this.base == null) { this.base = v; this.t0 = t; this.lastT = t; this.lastV = v; return null; }
    var dt = Math.max(1, t - this.lastT);
    var a = 1 - Math.exp(-dt / o.tauBaseMs);
    var th = this.thresholds();
    var warm = (t - this.t0) >= o.warmupMs;

    if (!this.high) {
      if (warm && v >= th.on && (t - this.lastPulse) >= o.minIntervalMs) {
        this.high = true;
        // interpolacja przejścia przez próg między klatkami (dokładność poniżej 1 klatki)
        var pv = this.lastV, f = (v - pv) > 0 ? (th.on - pv) / (v - pv) : 1;
        f = Math.min(1, Math.max(0, f));
        this.edgeT = this.lastT + f * (t - this.lastT);
        this.peak = v - this.base; this.peakOther = otherEx || 0; this.peakRing = ringEx; this.peakGlob = globEx;
      } else if (v < th.on || !warm) {
        // tło = dolna obwiednia: szybko w dół, wolno w górę (impulsy są tylko dodatnie)
        var aDown = 1 - Math.exp(-dt / o.tauDownMs);
        this.base += (v < this.base ? aDown : a) * (v - this.base);
        var dev = Math.min(Math.abs(v - this.lastV), o.minDelta); // szum z różnic klatek, odporny na skoki
        this.noise += a * (dev - this.noise);
        if (this.noise < 0.5) this.noise = 0.5;
      } else {
        this.base += 0.3 * a * (v - this.base); // jasno, ale bez impulsu (debounce / start) - wolna adaptacja
      }
    } else {
      var ex = v - this.base;
      if (ex > this.peak) { this.peak = ex; this.peakOther = otherEx || 0; this.peakRing = ringEx; this.peakGlob = globEx; }
      var dur = t - this.edgeT;
      if (v < th.off || ex < 0.4 * this.peak) { // spadek poniżej progu lub o 60% od szczytu
        this.high = false;
        var okX = !(xtalk > 0) || this.peak >= xtalk * this.peakOther;
        var okS = !(o.shapeK > 0) || this.peak >= o.shapeK * this.peakRing;
        var okG = !(o.globalK > 0) || this.peakGlob <= o.globalK * this.peak;
        if (!okX) this.rejected.xtalk++; else if (!okS) this.rejected.shape++; else if (!okG) this.rejected.global++; else if (dur > o.maxPulseMs) this.rejected.long++;
        if (okX && okS && okG && dur <= o.maxPulseMs) {
          res = { t: this.edgeT, peak: this.peak, dur: dur };
          this.lastPulse = this.edgeT;
          this.amp = this.amp == null ? this.peak : this.amp * 0.7 + this.peak * 0.3;
        }
      } else if (dur > o.maxPulseMs) {
        // za długo jasno - zmiana sceny/odblask: przejmij nowe tło
        this.high = false; this.base = v;
      }
    }
    this.lastT = t; this.lastV = v;
    return res;
  };

  /* Dwa kanały (0 = kWh, 1 = kvarh) z wzajemnym tłumieniem przesłuchu. */
  function MeterDetector(opts) {
    this.xtalk = opts && opts.xtalk != null ? opts.xtalk : 0.6;
    this.ch = [new Channel(opts), new Channel(opts)];
    this.enabled = [true, true];
    this.reset();
  }
  /* values = [kWh, kvarh]; aux (opcjonalnie) = { ring: [r0, r1], global: g } */
  MeterDetector.prototype.process = function (t, values, aux) {
    var ex0 = this.ch[0].excess(values[0]), ex1 = this.ch[1].excess(values[1]);
    var rEx = [0, 0], gEx = 0;
    if (aux) {
      if (aux.ring) { rEx[0] = this.rb[0].update(t, aux.ring[0]); rEx[1] = this.rb[1].update(t, aux.ring[1]); }
      if (aux.global != null) gEx = this.gb.update(t, aux.global);
    }
    var useX = this.enabled[0] && this.enabled[1] ? this.xtalk : 0;
    var out = [];
    if (this.enabled[0]) { var p0 = this.ch[0].update(t, values[0], ex1, useX, rEx[0], gEx); if (p0) { p0.ch = 0; out.push(p0); } }
    if (this.enabled[1]) { var p1 = this.ch[1].update(t, values[1], ex0, useX, rEx[1], gEx); if (p1) { p1.ch = 1; out.push(p1); } }
    return out;
  };
  MeterDetector.prototype.reset = function () {
    this.ch[0].reset(); this.ch[1].reset();
    this.rb = [new Baseline(), new Baseline()]; this.gb = new Baseline();
  };


  /* ---------- Automatyczne znajdowanie diod ----------
     maps: tablica map wyniku (scoreMap) kolejnych klatek, times: czasy [ms], w x h: rozmiar map.
     Zwraca kandydatów (przyjęte i odrzucone z powodem) oraz ROI dla kWh (lewa) i kvarh (na prawo w tym samym rzędzie). */
  function findLeds(maps, times, w, h, opts) {
    opts = opts || {};
    var res = { cands: [], roi: [null, null], msg: '' };
    if (maps.length < 10) { res.msg = 'Za mało klatek do analizy.'; return res; }
    var cands = ledCandidates(maps, times, w, h, opts), k;
    assignRoles(cands, res, w, h, opts.profile);
    res.cands = cands.map(function (c) {
      return { x: (c.x + 0.5) / w, y: (c.y + 0.5) / h, r: Math.sqrt(c.area / Math.PI) / w, ok: c.ok, role: c.role || null, reason: c.reason || '',
               events: c.nValid, all: c.nAll, period: c.period, dur: c.dur };
    });
    return res;
  }

  /* Kandydaci na diody (kroki 1-5 "Znajdź diody"): plamy migające, z klasyfikacją (c.ok / c.reason). Współrzędne w pikselach mapy. */
  function ledCandidates(maps, times, w, h, opts) {
    opts = opts || {};
    var N = maps.length, n = w * h, i, k, x, y;
    var bigArea = Math.max(n * 0.01, opts.maxArea || 0); // "duża plama" (odblask); przy małych mapach szukania - wg rozmiaru ROI
    // 1) aktywność piksela = maksimum - 25. percentyl w czasie (miga = duża aktywność)
    //    ważona liczbą zapaleń: rdzeń diody zapala się przy każdym błysku, ślad refleksu - raz
    var act = new Float32Array(n), col = new Float32Array(N), srt = new Float32Array(N), q = Math.floor(N * 0.25);
    for (i = 0; i < n; i++) {
      var mx = 0;
      for (k = 0; k < N; k++) { var v = maps[k][i]; col[k] = v; if (v > mx) mx = v; }
      if (mx < 40) { act[i] = 0; continue; }
      srt.set(col); srt.sort();
      var lo = srt[q], thrP = lo + 0.5 * (mx - lo), rises = 0;
      for (k = 1; k < N; k++) if (col[k - 1] < thrP && col[k] >= thrP) rises++;
      act[i] = (mx - lo) * Math.sqrt(Math.min(rises, 6) / 6);
    }
    var sm = new Float32Array(n); // wygładzenie 3x3
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var s = 0, c = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += act[yy * w + xx]; c++; }
      }
      sm[y * w + x] = s / c;
    }
    // 2) maksima lokalne + tłumienie niemaksymalnych
    var R = Math.max(2, Math.round(0.015 * w)), actMin = opts.actMin || 40, peaks = [];
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      var a = sm[y * w + x]; if (a < actMin) continue;
      var isMax = true;
      for (dy = -1; dy <= 1 && isMax; dy++) for (dx = -1; dx <= 1; dx++) if ((dx || dy) && sm[(y + dy) * w + x + dx] > a) { isMax = false; break; }
      if (isMax) peaks.push({ x: x, y: y, a: a });
    }
    peaks.sort(function (p, q2) { return q2.a - p.a; });
    var sel = [];
    for (k = 0; k < peaks.length && sel.length < 80; k++) {
      var p = peaks[k], ok = true;
      for (var j = 0; j < sel.length; j++) if (Math.hypot(sel[j].x - p.x, sel[j].y - p.y) < R) { ok = false; break; }
      if (ok) sel.push(p);
    }
    // 3) każdy kandydat: plama (flood fill), przebieg w czasie, impulsy
    var taken = new Int16Array(n).fill(-1);
    var cands = [];
    sel.forEach(function (p) {
      if (taken[p.y * w + p.x] >= 0 || cands.length >= 20) return; // szczyt należy już do wcześniejszej plamy
      var ci = cands.length;
      var thr = 0.75 * p.a, stack = [p.y * w + p.x], px = [], cap = Math.max(400, n * 0.02);
      var sx = 0, sy = 0, sw = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      taken[stack[0]] = ci;
      while (stack.length && px.length < cap) {
        var id = stack.pop(), cx = id % w, cy = (id - cx) / w; px.push(id);
        var wt = sm[id]; sx += cx * wt; sy += cy * wt; sw += wt;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        [id - 1, id + 1, id - w, id + w].forEach(function (nb) {
          if (nb < 0 || nb >= n || taken[nb] === ci) return;
          if (Math.abs((nb % w) - cx) > 1) return;
          if (sm[nb] >= thr && sm[nb] <= p.a * 1.05) { taken[nb] = ci; stack.push(nb); } // bez wspinania się na silniejszą plamę
        });
      }
      var cxw = sx / sw, cyw = sy / sw;
      // środek liczony z "płaskowyżu" (>= 90% szczytu) - poświata i ślady nie przesuwają środka
      var px2 = 0, py2 = 0, pw2 = 0;
      px.forEach(function (id) { var a2 = sm[id]; if (a2 >= 0.9 * p.a) { var c2 = id % w; px2 += c2 * a2; py2 += ((id - c2) / w) * a2; pw2 += a2; } });
      if (pw2) { cxw = px2 / pw2; cyw = py2 / pw2; }
      // przebieg: średnia z najaktywniejszych pikseli plamy
      var core = px.slice().sort(function (a1, b1) { return sm[b1] - sm[a1]; }).slice(0, 40);
      var series = new Float32Array(N);
      for (k = 0; k < N; k++) { var ss = 0; for (j = 0; j < core.length; j++) ss += maps[k][core[j]]; series[k] = ss / core.length; }
      var ch = new Channel({ minDelta: 25, warmupMs: 0, maxPulseMs: 5000, minIntervalMs: 30, sens: 0.5 });
      var evs = [];
      for (k = 0; k < N; k++) { var e = ch.update(times[k], series[k], 0, 0); if (e) evs.push(e); }
      var smin = Infinity, smax = 0; for (k = 0; k < N; k++) { if (series[k] < smin) smin = series[k]; if (series[k] > smax) smax = series[k]; }
      var mid = smin + 0.5 * (smax - smin), on = 0; for (k = 0; k < N; k++) if (series[k] > mid) on++;
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1, bad = px.length > bigArea || bw > 5 * bh || bh > 5 * bw;
      // ta sama dioda: blisko innej plamy o poprawnym kształcie (krawędzie i duże plamy nie zasłaniają diod)
      var dup = !bad && cands.some(function (o) { return !o.bad && Math.hypot(o.x - cxw, o.y - cyw) < Math.max(R, 0.035 * w); });
      if (!dup) cands.push({ i: ci, x: cxw, y: cyw, area: px.length, bw: bw, bh: bh, bad: bad, act: p.a, evs: evs, onFrac: on / N });
    });
    // 4) przesłuch: ten sam moment błysku w dwóch miejscach - zostaje silniejszy
    var bigA = bigArea;
    cands.forEach(function (c) {
      c.shapeBad = c.area > bigA || c.bw > 5 * c.bh || c.bh > 5 * c.bw;
      var iv = []; for (k = 1; k < c.evs.length; k++) iv.push(c.evs[k].t - c.evs[k - 1].t); iv.sort(function (a1, b1) { return a1 - b1; });
      c.fast = iv.length >= 2 && iv[Math.floor(iv.length / 2)] < 300;
    });
    // przesłuch jest lokalny: porównujemy tylko z bliskimi, poprawnymi kształtem, nie-szybko-migającymi plamami
    var good = cands.filter(function (c) { return !c.shapeBad && !c.fast; });
    var near = function (a1, b1) { return Math.hypot(a1.x - b1.x, a1.y - b1.y) < 0.25 * Math.max(w, h); };
    cands.forEach(function (c) {
      c.evs.forEach(function (e) {
        e.xt = good.some(function (o) {
          return o !== c && near(o, c) && o.evs.some(function (f) { return Math.abs(f.t - e.t) < 80 && f.peak > 1.15 * e.peak; });
        });
      });
    });
    // remis siły: zostaje miejsce, które miga regularnie (więcej własnych błysków) - jednorazowy refleks odpada
    cands.forEach(function (c) { c.own = c.evs.filter(function (e) { return !e.xt; }).length; });
    cands.forEach(function (c) {
      c.evs.forEach(function (e) {
        if (e.xt) return;
        e.xt2 = good.some(function (o) {
          return o !== c && near(o, c) && o.own > c.own && o.evs.some(function (f) { return !f.xt && Math.abs(f.t - e.t) < 80; });
        });
      });
    });
    cands.forEach(function (c) { c.evs.forEach(function (e) { if (e.xt2) e.xt = true; }); });
    // 5) klasyfikacja
    var dMin = opts.minDur || 20, dMax = opts.maxDur || 350, big = bigArea;
    cands.forEach(function (c) {
      var own = c.evs.filter(function (e) { return !e.xt; });
      var valid = own.filter(function (e) { return e.dur >= dMin && e.dur <= dMax; });
      var ints = []; for (k = 1; k < own.length; k++) ints.push((own[k].t - own[k - 1].t) / 1000);
      ints.sort(function (a1, b1) { return a1 - b1; });
      c.period = ints.length ? ints[Math.floor(ints.length / 2)] : NaN;
      c.nValid = valid.length; c.nAll = c.evs.length;
      c.dur = valid.length ? valid.reduce(function (s1, e) { return s1 + e.dur; }, 0) / valid.length : NaN;
      // stałość siły błysków: dioda świeci zawsze tak samo, odblask/refleks raz tak, raz inaczej
      var pm = valid.length ? valid.reduce(function (s1, e) { return s1 + e.peak; }, 0) / valid.length : 0;
      c.cv = valid.length > 1 && pm > 0 ? Math.sqrt(valid.reduce(function (s1, e) { return s1 + (e.peak - pm) * (e.peak - pm); }, 0) / valid.length) / pm : 0;
      if (c.area > big) c.reason = 'duża plama (odblask / krawędź)';
      else if (c.bw > 5 * c.bh || c.bh > 5 * c.bw) c.reason = 'wydłużony kształt (krawędź)';
      else if (own.length >= 3 && c.period < 0.3) c.reason = 'szybkie miganie (okres ' + c.period.toFixed(2).replace('.', ',') + ' s) - moduł';
      else if (c.onFrac > 0.6) c.reason = 'świeci prawie stale';
      else if (!own.length && c.evs.length) c.reason = 'poświata sąsiedniej diody';
      else if (!valid.length) c.reason = own.length ? 'błysk poza zakresem 20-350 ms' : 'brak błysków';
      c.ok = !c.reason;
    });
    return cands;
  }

  /* 6) role: kWh = lewa, kvarh = następna na prawo w tym samym rzędzie; z profilem licznika - geometria (Alarm odrzucany) */
  function assignRoles(cands, res, w, h, profile) {
    var acc = cands.filter(function (c) { return c.ok; }).sort(function (a1, b1) { return b1.nValid - a1.nValid || (a1.cv - b1.cv) || b1.act - a1.act; });
    if (acc.length) {
      var ref = acc[0], tol = 0.03 * h + 3;
      var inRow = acc.filter(function (c) { return Math.abs(c.y - ref.y) <= tol; }); // już posortowane: najwięcej błysków
      var row = inRow.slice(0, 2).sort(function (a1, b1) { return a1.x - b1.x; });
      acc.forEach(function (c) {
        if (inRow.indexOf(c) < 0) { c.ok = false; c.reason = 'poza rzędem diod'; }
        else if (row.indexOf(c) < 0) { c.ok = false; c.reason = c.nValid < 2 ? 'pojedynczy błysk (refleks?)' : 'trzecia w rzędzie (Alarm?)'; }
      });
      if (profile && profile.geom && row.length === 2) row = profileRow(cands, row, tol, profile.geom);
      row.forEach(function (c, ri) { c.role = ri === 0 ? 'kWh' : 'kvarh'; c.ok = true; c.reason = ''; });
      var lim = row.length > 1 ? 0.45 * Math.abs(row[1].x - row[0].x) / w : 0.08;
      row.slice(0, 2).forEach(function (c, ri) {
        var d = Math.max(3, 2 * Math.sqrt(c.area / Math.PI)) * 1.2;
        var rw = Math.min(Math.max(d / w, 0.012), 0.08, Math.max(lim, 0.012));
        res.roi[ri] = { x: (c.x + 0.5) / w, y: (c.y + 0.5) / h, w: rw, h: rw * w / h };
      });
      if (row.length === 1) res.msg = 'Znaleziono jedną migającą diodę - przyjęto jako kWh. Jeśli to kvarh, ustaw ręcznie.';
    } else res.msg = 'Nie znaleziono migającej diody. Ustaw telefon bliżej / zwiększ zoom i spróbuj przy większym obciążeniu.';
  }

  /* Profil licznika: diody kWh, kvarh, Alarm w jednym rzędzie co d (geom.kvarh = [1, 0], geom.alarm = [2, 0] w jednostkach d).
     Hipoteza A: para = kWh + kvarh (Alarm ok. d dalej). Hipoteza B: para = kWh + Alarm, kvarh w połowie (kvarh nie migało albo słabsze). */
  function profileRow(cands, row, tol, geom) {
    var L = row[0], R = row[1], d = R.x - L.x;
    if (!(d > 0)) return row;
    var rowAll = cands.filter(function (c) { return !c.shapeBad && Math.abs(c.y - L.y) <= tol && c !== L && c !== R; });
    var near = function (x, y) { return rowAll.filter(function (c) { return Math.abs(c.x - x) < 0.22 * d && Math.abs(c.y - y) < Math.max(tol, 0.2 * d); })[0]; };
    var ax = geom.alarm[0] / geom.kvarh[0]; // 2
    var alarmA = near(L.x + ax * d, L.y);
    var midB = near(L.x + d / ax, L.y);
    var markAlarm = function (c) { if (c) { c.ok = false; c.role = null; c.reason = 'dioda Alarm (profil licznika) - nie jest impulsem'; } };
    if (!alarmA && midB && !midB.fast && midB.nValid >= 1 && !/poświata/.test(midB.reason || '')) { /* środkowa musi mieć własne błyski, nie poświatę */ markAlarm(R); midB.ok = true; midB.reason = ''; return [L, midB]; }
    markAlarm(alarmA);
    return row;
  }

  /* Obliczenia mocy. const = imp/kWh (imp/kvarh). P[kW] = 3600 / (const * T[s]) */
  function powerFromT(Ts, c) { return Ts > 0 ? 3600 / (c * Ts) : NaN; }

  function PowerCalc(consts, N) { this.c = consts || [1000, 1000]; this.N = N || 5; this.reset(); }
  PowerCalc.prototype.reset = function () { this.pulses = [[], []]; this.seg = [0, 0]; this.startT = null; };
  /* przerwa w obserwacji (zgubiona i odnaleziona dioda): impulsy liczą się dalej, ale T i średnia nie obejmują przerwy */
  PowerCalc.prototype.gap = function (ch) { this.seg[ch] = this.pulses[ch].length; };
  PowerCalc.prototype.add = function (ch, t) {
    if (this.startT == null) this.startT = t;
    var arr = this.pulses[ch];
    var prev = arr.length > this.seg[ch] ? arr[arr.length - 1] : null;
    arr.push(t);
    var rec = { ch: ch, t: t, T: null, val: null, avg: null };
    if (prev != null) { rec.T = (t - prev) / 1000; rec.val = powerFromT(rec.T, this.c[ch]); rec.avg = this.avg(ch); }
    return rec;
  };
  PowerCalc.prototype.avg = function (ch) {
    var arr = this.pulses[ch], n = Math.min(this.N, arr.length - 1 - this.seg[ch]);
    if (n < 1) return NaN;
    var span = (arr[arr.length - 1] - arr[arr.length - 1 - n]) / 1000;
    return 3600 * n / (this.c[ch] * span);
  };
  PowerCalc.prototype.stats = function (ch, now) {
    var arr = this.pulses[ch], L = arr.length;
    var s = { count: L, inst: NaN, avg: this.avg(ch), lastT: NaN, since: NaN, maxPossible: NaN, energy: L / this.c[ch], stale: false };
    if (L >= 2 && L - 2 >= this.seg[ch]) { s.lastT = (arr[L - 1] - arr[L - 2]) / 1000; s.inst = powerFromT(s.lastT, this.c[ch]); }
    if (L >= 1) {
      s.since = (now - arr[L - 1]) / 1000;
      // brak impulsu przez czas t => moc nie większa niż 3600/(c*t)
      s.maxPossible = powerFromT(s.since, this.c[ch]);
      if (isFinite(s.lastT) ? s.since > 1.5 * s.lastT && s.since > 2 : s.since > 2) s.stale = true;
    }
    return s;
  };
  function cosPhi(P, Q) {
    if (!(P >= 0) || !(Q >= 0)) return NaN;
    var S = Math.sqrt(P * P + Q * Q);
    return S > 0 ? P / S : NaN;
  }


  /* ---------- Profile liczników ----------
     geom: położenia w jednostkach d = wektor kWh -> kvarh (oś x wzdłuż rzędu diod, y w dół). Orientacyjnie, z tolerancją. */
  var PROFILES = {
    'sanxing-s34u28': {
      name: 'Sanxing S34U28-PL-T10', cK: 1000, cQ: 1000,
      geom: { kwh: [0, 0], kvarh: [1, 0], alarm: [2, 0], tol: 0.4, indicators: [-0.3, -0.55], lcd: [1, -1.6], lcdSize: [3.6, 1.6] },
      ignore: ['Alarm'],
      desc: 'Pod wyświetlaczem LCD pasek wskaźników PM, [A]!, OL, OS, OM; niżej rząd trzech czerwonych diod nad strzałkami kWh, kvarh, Alarm (równy rozstaw). Alarm nie jest impulsem.'
    },
    generic: { name: 'Inny / ogólny', cK: null, cQ: null, geom: null, ignore: [], desc: 'Bez założeń o układzie diod: lewa migająca = kWh, następna w rzędzie = kvarh.' }
  };

  /* ---------- Re-akwizycja zgubionej diody (osobno dla każdego kanału) ----------
     track -> search (brak impulsu > max(kT*T, minLost) albo duża zmiana obrazu w oknie + brak impulsu > max(1,5*T, 3 s))
     search: rosnący obszar wokół przewidywanej pozycji (2x -> 4x okno -> pół kadru -> cały kadr), kryteria jak "Znajdź diody",
     bez obszaru drugiej diody i (z profilem) bez miejsca diody Alarm; kandydat musi pasować geometrią do drugiej diody.
     confirm: kandydat obserwowany jak zwykły kanał - przejęcie dopiero po potwierdzonym impulsie (1 błysk w analizie + 1 na żywo).
     Główne ROI nie zmienia się do potwierdzenia; drugi kanał nie jest ruszany. */
  function Reacquirer(opts) {
    this.o = { minLostMs: 20000, kT: 3, maxLostMs: 600000, fastMinMs: 3000, nccMin: 0.5, nccHoldMs: 1500, levels: [2, 4, 0.25, 0.5],
               minLevelMs: 6000, maxBufMs: 15000, mapEveryMs: 40, analyzeEveryMs: 1000, pxPerRoi: 8, maxMapW: 128, minDur: 20, maxDur: 350 };
    for (var k in (opts || {})) this.o[k] = opts[k];
    this.profile = null; this.v = null; this.chOpts = {};
    this.reset();
  }
  Reacquirer.prototype.reset = function () {
    var mk = function () { return { mode: 'track', lastPulse: null, T: NaN, good: null, otherAtGood: null, tpl: null, changedSince: null, lastNcc: 0,
      level: 0, levelT0: 0, maps: [], times: [], region: null, lastMap: -1e9, lastAn: -1e9, cand: null, black: [], msg: '', msgT: -1e9, lostSince: null, found: 0 }; };
    this.ch = [mk(), mk()];
  };
  /* wektor kWh -> kvarh: ustawiany przy "Znajdź diody"/ręcznym ustawieniu (force), potem tylko łagodnie (ochrona przed przeskokiem jednej z diod) */
  Reacquirer.prototype.setVector = function (rois, force) {
    var v = { x: rois[1].x - rois[0].x, y: rois[1].y - rois[0].y }, L = Math.hypot(v.x, v.y);
    if (L < 0.01) return;
    if (!force && this.v) {
      var o = this.v, Lo = Math.hypot(o.x, o.y);
      if (Math.hypot(v.x - o.x, v.y - o.y) > 0.25 * Lo) return;
      v = { x: 0.8 * o.x + 0.2 * v.x, y: 0.8 * o.y + 0.2 * v.y };
    }
    this.v = v; this.anc = [cp(rois[0]), cp(rois[1])];
  };
  /* która dioda jest "podejrzana" przy niezgodnej geometrii: ta bez świeżych impulsów albo ta, której ROI odjechało dalej od kotwicy */
  Reacquirer.prototype.suspect = function (i, rois, t) {
    if (!this.recent(i, t)) return true;
    if (!this.anc) return false;
    var d = function (k, A) { return Math.hypot(rois[k].x - A[k].x, rois[k].y - A[k].y); };
    return d(i, this.anc) > d(1 - i, this.anc) + 0.5 * rois[i].w;
  };
  /* odchyłka ROI kanału i od położenia wynikającego z drugiej (zdrowej) diody i wektora v, w jednostkach |v| */
  Reacquirer.prototype.geomDev = function (i, rois) {
    var v = this.v; if (!v) return 0;
    var o = rois[1 - i], e = i === 1 ? { x: o.x + v.x, y: o.y + v.y } : { x: o.x - v.x, y: o.y - v.y };
    return Math.hypot(rois[i].x - e.x, rois[i].y - e.y) / Math.hypot(v.x, v.y);
  };
  Reacquirer.prototype.recent = function (i, t) { var s = this.ch[i]; return s.mode === 'track' && s.lastPulse != null && t - s.lastPulse < Math.max(2500, isFinite(s.T) ? 1.6 * s.T : 4000); };
  /* impulsy z kanału, który według geometrii stoi na złej diodzie (np. Alarm, odblask), nie są liczone */
  Reacquirer.prototype.suppress = function (i) { var s = this.ch[i]; return s.mode !== 'track' && s.why === 'geom'; };
  Reacquirer.prototype.healthy = function (i, t) {
    var s = this.ch[i]; return s.mode === 'track' && s.lastPulse != null && t - s.lastPulse < this.lostMs(i);
  };
  Reacquirer.prototype.lostMs = function (i) {
    var s = this.ch[i], o = this.o;
    return Math.min(o.maxLostMs, Math.max(o.minLostMs, isFinite(s.T) ? o.kT * s.T : o.minLostMs * 1.5));
  };
  /* impuls zaliczony w kanale i (czas t, aktualne ROI, łatka obrazu okna 8x8) */
  Reacquirer.prototype.pulse = function (i, t, rois, patch, suppressed) {
    var s = this.ch[i];
    if (s.lastPulse != null && t - s.lastPulse > 30) {
      var T = t - s.lastPulse;
      if (s.mode === 'track' && !s.found) s.T = isFinite(s.T) ? 0.6 * s.T + 0.4 * T : T; else s.T = isFinite(s.T) ? s.T : T;
    }
    s.found = 0;
    var tol = (this.profile && this.profile.geom && this.profile.geom.tol) || 0.4;
    var viol = this.v && this.recent(1 - i, t) && this.geomDev(i, rois) > tol && this.suspect(i, rois, t);
    if (suppressed && !(this.v && this.geomDev(i, rois) <= tol)) viol = true; // pominięty impuls nie kończy szukania, dopóki geometria się nie zgadza
    if (viol) { s.lastPulse = t; return; } // impuls z miejsca niezgodnego z geometrią - nie przerywa szukania, nie jest "dobrą pozycją"
    if (s.mode !== 'track') { s.mode = 'track'; s.cand = null; s.maps = []; s.times = []; s.msg = ''; s.why = ''; }
    s.lastPulse = t; s.good = cp(rois[i]); s.otherAtGood = cp(rois[1 - i]); s.tpl = patch || null; s.changedSince = null; s.lostSince = null; s.geomSince = null;
    if (this.recent(1 - i, t)) this.setVector(rois);
  };
  function cp(r) { return { x: r.x, y: r.y, w: r.w, h: r.h }; }
  function ncc(a, b) {
    var n = a.length, ma = 0, mb = 0, i; for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0; for (i = 0; i < n; i++) { var x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    if (saa / n < 16) return null; // jednolite tło - nie da się ocenić
    return sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  }
  Reacquirer.prototype.predict = function (i, rois) {
    var s = this.ch[i], o = rois[1 - i];
    return { x: s.good.x + (o.x - s.otherAtGood.x), y: s.good.y + (o.y - s.otherAtGood.y) };
  };
  Reacquirer.prototype.regionFor = function (i, rois, aspect) {
    var s = this.ch[i], L = this.o.levels[Math.min(s.level, this.o.levels.length - 1)], c = this.predict(i, rois);
    var hx = s.level < 2 ? L * s.good.w : L, hy = s.level < 2 ? hx * aspect : L;
    if (s.level >= 3) { c = { x: 0.5, y: 0.5 }; hx = hy = 0.5; }
    var x0 = Math.max(0, c.x - hx), x1 = Math.min(1, c.x + hx), y0 = Math.max(0, c.y - hy), y1 = Math.min(1, c.y + hy);
    var W = Math.round(Math.min(this.o.maxMapW, Math.max(24, (x1 - x0) / s.good.w * this.o.pxPerRoi)));
    var H = Math.round(Math.min(this.o.maxMapW, Math.max(16, W * (y1 - y0) / (x1 - x0) / aspect)));
    return { x0: x0, y0: y0, x1: x1, y1: y1, W: W, H: H, level: s.level, cx: c.x, cy: c.y };
  };
  /* geometria kandydata względem drugiej diody (wektor kWh -> kvarh) i miejsca diody Alarm */
  Reacquirer.prototype.geomOk = function (i, p, rois, t) {
    var v = this.v, other = rois[1 - i], s = this.ch[i];
    var dv = v ? Math.hypot(v.x, v.y) : 0;
    var excl = Math.max(1.5 * other.w, 0.45 * dv);
    if (Math.hypot(p.x - other.x, p.y - other.y) < excl) return 'obszar drugiej diody';
    for (var b = 0; b < s.black.length; b++) if (Math.hypot(p.x - s.black[b].x, p.y - s.black[b].y) < Math.max(s.good.w, 0.15 * dv)) return 'odrzucone wcześniej (brak potwierdzenia)';
    if (!v) return '';
    var g = this.profile && this.profile.geom, tol = (g && g.tol) || 0.4;
    if (g) { // dioda Alarm: kWh + 2d
      var k0 = i === 0 ? null : other, ax = g.alarm[0];
      var alarm = k0 ? { x: k0.x + ax * v.x, y: k0.y + ax * v.y } : { x: other.x + (ax - 1) * v.x, y: other.y + (ax - 1) * v.y };
      if (Math.hypot(p.x - alarm.x, p.y - alarm.y) < 0.35 * dv) return 'miejsce diody Alarm';
    }
    if (this.healthy(1 - i, t)) {
      var e = i === 1 ? { x: other.x + v.x, y: other.y + v.y } : { x: other.x - v.x, y: other.y - v.y };
      if (Math.hypot(p.x - e.x, p.y - e.y) > tol * dv) return 'niezgodna geometria z drugą diodą';
    }
    return '';
  };
  /* io: { rois, aspect, glob, xtalk, otherEx(i), patch(i), mapRegion(region) -> Uint8Array scoreMap W*H, sampleRoi(roi) -> {mean, ring} }
     zwraca zdarzenia: {type:'search'|'level'|'cand'|'reject'|'found', ch, ...} */
  Reacquirer.prototype.frame = function (t, io) {
    var ev = [], o = this.o;
    for (var i = 0; i < 2; i++) {
      var s = this.ch[i];
      if (s.lastPulse == null || !s.good) continue;
      var since = t - s.lastPulse;
      if (s.mode === 'track') {
        if (s.tpl && io.patch && t - (s.lastNccT || 0) > 200) {
          s.lastNccT = t; var c = ncc(s.tpl, io.patch(i)); s.lastNcc = c;
          if (c != null && c < o.nccMin) { if (s.changedSince == null) s.changedSince = t; } else s.changedSince = null;
        }
        var fast = s.changedSince != null && t - s.changedSince > o.nccHoldMs && since > Math.max(o.fastMinMs, isFinite(s.T) ? 1.5 * s.T : o.fastMinMs);
        // geometria: ROI tej diody odjechało od miejsca wynikającego z drugiej diody (np. na Alarm albo odblask)
        var tolG = (this.profile && this.profile.geom && this.profile.geom.tol) || 0.4;
        if (this.v && this.recent(1 - i, t) && this.geomDev(i, io.rois) > tolG && this.suspect(i, io.rois, t)) { if (s.geomSince == null) s.geomSince = t; } else s.geomSince = null;
        var geom = s.geomSince != null && t - s.geomSince > 2000;
        if (since > this.lostMs(i) || fast || geom) {
          s.why = geom ? 'geom' : fast ? 'obraz' : 'czas';
          s.mode = 'search'; s.level = fast || geom ? 1 : 0; s.levelT0 = t; s.maps = []; s.times = []; s.black = []; s.lostSince = geom ? t : s.lastPulse;
          if (geom) { var ov = io.rois[1 - i], vv = this.v; s.good = { x: ov.x + (i ? vv.x : -vv.x), y: ov.y + (i ? vv.y : -vv.y), w: s.good.w, h: s.good.h }; s.otherAtGood = cp(ov); }
          s.region = this.regionFor(i, io.rois, io.aspect); s.msg = 'search'; s.msgT = t;
          ev.push({ type: 'search', ch: i, level: s.level, why: s.why, since: since });
        }
        continue;
      }
      var bufMs = Math.min(o.maxBufMs, Math.max(o.minLevelMs, isFinite(s.T) ? 2.2 * s.T : o.minLevelMs));
      if (s.mode === 'search') {
        if (t - s.lastMap >= o.mapEveryMs) {
          s.lastMap = t;
          s.maps.push(io.mapRegion(s.region)); s.times.push(t);
          while (s.times.length && s.times[0] < t - bufMs) { s.times.shift(); s.maps.shift(); }
        }
        // obie diody zgubione: najpierw szuka ta, która miga częściej; druga czeka (potem pewna geometria względem niej)
        var so = this.ch[1 - i], wait = so.mode !== 'track' && so.lastPulse != null && (isFinite(so.T) ? so.T : 1e9) < (isFinite(s.T) ? s.T : 1e9);
        if (wait) s.levelT0 = t;
        if (!wait && t - s.lastAn >= o.analyzeEveryMs && s.maps.length >= 12) {
          s.lastAn = t;
          var R = s.region, cands = ledCandidates(s.maps, s.times, R.W, R.H, { actMin: 30, maxArea: 2.5 * o.pxPerRoi * o.pxPerRoi }), best = null, self = this;
          cands.forEach(function (c) {
            if (!c.ok || c.nValid < 1 || c.fast) return;
            var p = { x: R.x0 + (c.x + 0.5) / R.W * (R.x1 - R.x0), y: R.y0 + (c.y + 0.5) / R.H * (R.y1 - R.y0) };
            var why = self.geomOk(i, p, io.rois, t);
            if (why) { c.why = why; return; }
            var d = Math.hypot(p.x - R.cx, p.y - R.cy), sc = c.nValid * 10 - d / s.good.w;
            if (!best || sc > best.sc) best = { p: p, sc: sc, c: c };
          });
          if (best) {
            s.mode = 'confirm'; s.confirmT0 = t;
            s.cand = { x: best.p.x, y: best.p.y, w: s.good.w, h: s.good.h };
            s.shadow = new Channel(this.chOpts); s.rb = new Baseline(); s.gb = new Baseline();
            ev.push({ type: 'cand', ch: i, roi: cp(s.cand), level: s.level, events: best.c.nValid });
            continue;
          }
        }
        if (t - s.levelT0 > Math.max(bufMs, o.minLevelMs) + 500 && s.level < o.levels.length - 1) {
          s.level = s.level + 1; s.levelT0 = t; s.maps = []; s.times = [];
          s.region = this.regionFor(i, io.rois, io.aspect);
          ev.push({ type: 'level', ch: i, level: s.level });
        }
      } else if (s.mode === 'confirm') {
        var st = io.sampleRoi(s.cand);
        var rEx = s.rb.update(t, st.ring), gEx = s.gb.update(t, io.glob);
        var pz = s.shadow.update(t, st.mean, io.otherEx ? io.otherEx(i) : 0, io.xtalk || 0, rEx, gEx);
        if (pz && pz.dur >= o.minDur && pz.dur <= o.maxDur) {
          var roi = cp(s.cand);
          s.mode = 'track'; s.good = roi; s.otherAtGood = cp(io.rois[1 - i]); s.cand = null; s.maps = []; s.times = [];
          s.msg = 'found'; s.msgT = t; s.found = 1; s.changedSince = null; s.tpl = null;
          ev.push({ type: 'found', ch: i, roi: roi, pulse: { t: pz.t, dur: pz.dur, peak: pz.peak }, lostMs: pz.t - s.lostSince });
          continue;
        }
        if (t - s.confirmT0 > Math.max(8000, isFinite(s.T) ? 2.5 * s.T : 8000)) {
          s.black.push({ x: s.cand.x, y: s.cand.y });
          ev.push({ type: 'reject', ch: i, roi: cp(s.cand) });
          s.mode = 'search'; s.cand = null; s.lastAn = t;
        }
      }
    }
    return ev;
  };
  Reacquirer.prototype.state = function (i) { var s = this.ch[i]; return { mode: s.mode, level: s.level, region: s.region, cand: s.cand, msg: s.msg, msgT: s.msgT, T: s.T, lastPulse: s.lastPulse, ncc: s.lastNcc }; };

  return { PROFILES: PROFILES, Reacquirer: Reacquirer, ledCandidates: ledCandidates, redVal: redVal, scoreMap: scoreMap, roiStats: roiStats, frameMean: frameMean, brightCentroid: brightCentroid, Baseline: Baseline, findLeds: findLeds, Channel: Channel, MeterDetector: MeterDetector,
           PowerCalc: PowerCalc, powerFromT: powerFromT, cosPhi: cosPhi, DEFAULTS: DEF };
});
