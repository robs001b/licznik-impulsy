/* Podgląd kamery w trybie object-fit: cover - przeliczanie współrzędnych między ramką podglądu (piksele ekranu)
   a klatką analizowaną (0..1 szerokości i wysokości obrazu z kamery), z uwzględnieniem przycięcia i przesunięcia (object-position). */
(function (root) {
  'use strict';
  // bw, bh - rozmiar ramki; vw, vh - rozmiar klatki; px, py - object-position 0..1 (0,5 = środek)
  function cover(bw, bh, vw, vh, px, py) {
    if (!(vw > 0 && vh > 0)) { vw = bw; vh = bh; }
    var s = Math.max(bw / vw, bh / vh), dw = vw * s, dh = vh * s;
    if (px == null) px = 0.5; if (py == null) py = 0.5;
    return { s: s, dw: dw, dh: dh, ox: (bw - dw) * px, oy: (bh - dh) * py, bw: bw, bh: bh, px: px, py: py };
  }
  function toVideo(v, x, y) { return { x: (x - v.ox) / v.dw, y: (y - v.oy) / v.dh }; }
  function toBox(v, u, w) { return { x: v.ox + u * v.dw, y: v.oy + w * v.dh }; }
  // widoczny fragment klatki (0..1)
  function visible(v) { return { x0: -v.ox / v.dw, y0: -v.oy / v.dh, x1: (v.bw - v.ox) / v.dw, y1: (v.bh - v.oy) / v.dh }; }
  // object-position (0..1), które ustawia punkt klatki (fx, fy) możliwie na środku ramki
  function panFor(bw, bh, vw, vh, fx, fy) {
    var v = cover(bw, bh, vw, vh, 0.5, 0.5), clamp = function (a) { return Math.max(0, Math.min(1, a)); };
    var px = v.dw - bw > 0.5 ? clamp((bw / 2 - fx * v.dw) / (bw - v.dw)) : 0.5;
    var py = v.dh - bh > 0.5 ? clamp((bh / 2 - fy * v.dh) / (bh - v.dh)) : 0.5;
    return { px: px, py: py };
  }
  // czy prostokąt (0..1) mieści się w widocznym fragmencie z marginesem m (ułamek widocznego wymiaru)
  function fits(v, b, m) {
    var g = visible(v), mx = (g.x1 - g.x0) * m, my = (g.y1 - g.y0) * m;
    return b.x0 >= g.x0 + mx && b.x1 <= g.x1 - mx && b.y0 >= g.y0 + my && b.y1 <= g.y1 - my;
  }
  var api = { cover: cover, toVideo: toVideo, toBox: toBox, visible: visible, panFor: panFor, fits: fits };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LicznikWidok = api;
})(typeof window !== 'undefined' ? window : this);
