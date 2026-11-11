/* Detekcja impulsów diod LED licznika + obliczenia mocy.
   Moduł bez zależności - działa w przeglądarce (window.LicznikDet) i w Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LicznikDet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Statystyki obszaru (RGBA). mode: 'luma' (jasność) albo 'red' (kanał czerwony).
     inner = {x0,y0,x1,y1} w pikselach - liczymy tylko środek okna (reszta służy do śledzenia). */
  function roiStats(data, w, h, mode, inner) {
    var x0 = inner ? inner.x0 : 0, y0 = inner ? inner.y0 : 0;
    var x1 = inner ? inner.x1 : w, y1 = inner ? inner.y1 : h;
    var sum = 0, max = 0, n = 0;
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var i = (y * w + x) * 4;
        var l = mode === 'red' ? data[i] : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += l; if (l > max) max = l; n++;
      }
    }
    return { mean: n ? sum / n : 0, max: max };
  }

  /* Środek ciężkości najjaśniejszych pikseli okna (0..1). Do śledzenia ROI. */
  function brightCentroid(data, w, h) {
    var max = 0, i, l, x, y;
    var lum = new Float32Array(w * h);
    for (i = 0; i < w * h; i++) {
      l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      lum[i] = l; if (l > max) max = l;
    }
    if (max < 120) return null;
    var thr = max * 0.85, sx = 0, sy = 0, sw = 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      l = lum[y * w + x];
      if (l >= thr) { var wt = l - thr + 1; sx += (x + 0.5) * wt; sy += (y + 0.5) * wt; sw += wt; }
    }
    if (!sw) return null;
    return { x: sx / sw / w, y: sy / sw / h };
  }

  var DEF = {
    sens: 0.5,          // czułość 0..1 (więcej = czulej)
    minIntervalMs: 60,  // minimalny odstęp między impulsami (debounce)
    maxPulseMs: 300,    // dłuższe "świecenie" = zmiana sceny, nie impuls
    minDelta: 12,       // minimalny skok jasności nad tło (0..255)
    tauBaseMs: 1500,    // stała czasowa adaptacji tła (w górę)
    tauDownMs: 120,     // stała czasowa adaptacji tła w dół
    warmupMs: 500       // czas na nauczenie tła po starcie
  };

  function Channel(opts) { this.o = {}; this.set(opts); this.reset(); }
  Channel.prototype.set = function (opts) {
    for (var k in DEF) this.o[k] = (opts && opts[k] != null) ? opts[k] : (this.o[k] != null ? this.o[k] : DEF[k]);
  };
  Channel.prototype.reset = function () {
    this.base = null; this.noise = 1; this.amp = null; this.high = false;
    this.t0 = null; this.lastT = null; this.lastV = null; this.lastPulse = -Infinity;
    this.edgeT = 0; this.peak = 0; this.peakOther = 0;
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
  Channel.prototype.update = function (t, v, otherEx, xtalk) {
    var o = this.o, res = null;
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
        this.peak = v - this.base; this.peakOther = otherEx || 0;
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
      if (ex > this.peak) { this.peak = ex; this.peakOther = otherEx || 0; }
      var dur = t - this.edgeT;
      if (v < th.off || ex < 0.4 * this.peak) { // spadek poniżej progu lub o 60% od szczytu
        this.high = false;
        var okX = !(xtalk > 0) || this.peak >= xtalk * this.peakOther;
        if (okX && dur <= o.maxPulseMs) {
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
  }
  MeterDetector.prototype.process = function (t, values) {
    var ex0 = this.ch[0].excess(values[0]), ex1 = this.ch[1].excess(values[1]);
    var useX = this.enabled[0] && this.enabled[1] ? this.xtalk : 0;
    var out = [];
    if (this.enabled[0]) { var p0 = this.ch[0].update(t, values[0], ex1, useX); if (p0) { p0.ch = 0; out.push(p0); } }
    if (this.enabled[1]) { var p1 = this.ch[1].update(t, values[1], ex0, useX); if (p1) { p1.ch = 1; out.push(p1); } }
    return out;
  };
  MeterDetector.prototype.reset = function () { this.ch[0].reset(); this.ch[1].reset(); };

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

  return { roiStats: roiStats, brightCentroid: brightCentroid, Channel: Channel, MeterDetector: MeterDetector,
           PowerCalc: PowerCalc, powerFromT: powerFromT, cosPhi: cosPhi, DEFAULTS: DEF };
});
