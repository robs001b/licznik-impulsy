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
    var N = maps.length, n = w * h, i, k, x, y;
    var res = { cands: [], roi: [null, null], msg: '' };
    if (N < 10) { res.msg = 'Za mało klatek do analizy.'; return res; }
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
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1, bad = px.length > n * 0.01 || bw > 5 * bh || bh > 5 * bw;
      // ta sama dioda: blisko innej plamy o poprawnym kształcie (krawędzie i duże plamy nie zasłaniają diod)
      var dup = !bad && cands.some(function (o) { return !o.bad && Math.hypot(o.x - cxw, o.y - cyw) < Math.max(R, 0.035 * w); });
      if (!dup) cands.push({ i: ci, x: cxw, y: cyw, area: px.length, bw: bw, bh: bh, bad: bad, act: p.a, evs: evs, onFrac: on / N });
    });
    // 4) przesłuch: ten sam moment błysku w dwóch miejscach - zostaje silniejszy
    var bigA = n * 0.01;
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
    var dMin = opts.minDur || 20, dMax = opts.maxDur || 350, big = n * 0.01;
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
    // 6) role: kWh = lewa, kvarh = następna na prawo w tym samym rzędzie
    var acc = cands.filter(function (c) { return c.ok; }).sort(function (a1, b1) { return b1.nValid - a1.nValid || (a1.cv - b1.cv) || b1.act - a1.act; });
    if (acc.length) {
      var ref = acc[0], tol = 0.03 * h + 3;
      var inRow = acc.filter(function (c) { return Math.abs(c.y - ref.y) <= tol; }); // już posortowane: najwięcej błysków
      var row = inRow.slice(0, 2).sort(function (a1, b1) { return a1.x - b1.x; });
      acc.forEach(function (c) {
        if (inRow.indexOf(c) < 0) { c.ok = false; c.reason = 'poza rzędem diod'; }
        else if (row.indexOf(c) < 0) { c.ok = false; c.reason = c.nValid < 2 ? 'pojedynczy błysk (refleks?)' : 'trzecia w rzędzie (Alarm?)'; }
      });
      row.forEach(function (c, ri) { c.role = ri === 0 ? 'kWh' : 'kvarh'; });
      var lim = row.length > 1 ? 0.45 * Math.abs(row[1].x - row[0].x) / w : 0.08;
      row.slice(0, 2).forEach(function (c, ri) {
        var d = Math.max(3, 2 * Math.sqrt(c.area / Math.PI)) * 1.2;
        var rw = Math.min(Math.max(d / w, 0.012), 0.08, Math.max(lim, 0.012));
        res.roi[ri] = { x: (c.x + 0.5) / w, y: (c.y + 0.5) / h, w: rw, h: rw * w / h };
      });
      if (row.length === 1) res.msg = 'Znaleziono jedną migającą diodę - przyjęto jako kWh. Jeśli to kvarh, ustaw ręcznie.';
    } else res.msg = 'Nie znaleziono migającej diody. Ustaw telefon bliżej / zwiększ zoom i spróbuj przy większym obciążeniu.';
    res.cands = cands.map(function (c) {
      return { x: (c.x + 0.5) / w, y: (c.y + 0.5) / h, r: Math.sqrt(c.area / Math.PI) / w, ok: c.ok, role: c.role || null, reason: c.reason || '',
               events: c.nValid, all: c.nAll, period: c.period, dur: c.dur };
    });
    return res;
  }

  /* Obliczenia mocy. const = imp/kWh (imp/kvarh). P[kW] = 3600 / (const * T[s]) */
  function powerFromT(Ts, c) { return Ts > 0 ? 3600 / (c * Ts) : NaN; }

  function PowerCalc(consts, N) { this.c = consts || [1000, 1000]; this.N = N || 5; this.reset(); }
  PowerCalc.prototype.reset = function () { this.pulses = [[], []]; this.startT = null; };
  PowerCalc.prototype.add = function (ch, t) {
    if (this.startT == null) this.startT = t;
    var arr = this.pulses[ch];
    var prev = arr.length ? arr[arr.length - 1] : null;
    arr.push(t);
    var rec = { ch: ch, t: t, T: null, val: null, avg: null };
    if (prev != null) { rec.T = (t - prev) / 1000; rec.val = powerFromT(rec.T, this.c[ch]); rec.avg = this.avg(ch); }
    return rec;
  };
  PowerCalc.prototype.avg = function (ch) {
    var arr = this.pulses[ch], n = Math.min(this.N, arr.length - 1);
    if (n < 1) return NaN;
    var span = (arr[arr.length - 1] - arr[arr.length - 1 - n]) / 1000;
    return 3600 * n / (this.c[ch] * span);
  };
  PowerCalc.prototype.stats = function (ch, now) {
    var arr = this.pulses[ch], L = arr.length;
    var s = { count: L, inst: NaN, avg: this.avg(ch), lastT: NaN, since: NaN, maxPossible: NaN, energy: L / this.c[ch], stale: false };
    if (L >= 2) { s.lastT = (arr[L - 1] - arr[L - 2]) / 1000; s.inst = powerFromT(s.lastT, this.c[ch]); }
    if (L >= 1) {
      s.since = (now - arr[L - 1]) / 1000;
      // brak impulsu przez czas t => moc nie większa niż 3600/(c*t)
      s.maxPossible = powerFromT(s.since, this.c[ch]);
      if (L >= 2 ? s.since > 1.5 * s.lastT && s.since > 2 : s.since > 2) s.stale = true;
    }
    return s;
  };
  function cosPhi(P, Q) {
    if (!(P >= 0) || !(Q >= 0)) return NaN;
    var S = Math.sqrt(P * P + Q * Q);
    return S > 0 ? P / S : NaN;
  }

  return { redVal: redVal, scoreMap: scoreMap, roiStats: roiStats, frameMean: frameMean, brightCentroid: brightCentroid, Baseline: Baseline, findLeds: findLeds, Channel: Channel, MeterDetector: MeterDetector,
           PowerCalc: PowerCalc, powerFromT: powerFromT, cosPhi: cosPhi, DEFAULTS: DEF };
});
