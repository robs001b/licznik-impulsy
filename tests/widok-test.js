// Mapowanie współrzędnych podglądu w trybie cover (przycięcie + object-position) <-> klatka analizowana. node tests/widok-test.js
const W = require('../widok.js');
let n = 0, bad = 0;
const ok = (c, m) => { n++; console.log((c ? 'ok   ' : 'BŁĄD ') + m); if (!c) bad++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// 1) pionowy strumień 720x1280 w ramce 4:3 (336x252): pełna szerokość, przycięta góra/dół po równo
let v = W.cover(336, 252, 720, 1280, 0.5, 0.5);
ok(near(v.dw, 336) && near(v.dh, 1280 * 336 / 720) && near(v.ox, 0) && near(v.oy, (252 - v.dh) / 2), 'cover 720x1280 -> 336x252: szerokość pełna, oy = ' + v.oy.toFixed(2));
let g = W.visible(v);
ok(near(g.x0, 0) && near(g.x1, 1) && near(g.y0 + g.y1, 1) && near(g.y1 - g.y0, 252 / v.dh), 'widoczny fragment: x 0..1, y ' + g.y0.toFixed(3) + '..' + g.y1.toFixed(3));
let p = W.toVideo(v, 168, 126);
ok(near(p.x, 0.5) && near(p.y, 0.5), 'środek ramki = środek klatki');
p = W.toVideo(v, 0, 0);
ok(near(p.x, 0) && near(p.y, g.y0), 'lewy górny róg ramki = początek widocznego fragmentu (offset przycięcia)');
// piksel klatki (500, 900) -> ekran -> klatka
let q = W.toBox(v, 500 / 720, 900 / 1280), r = W.toVideo(v, q.x, q.y);
ok(near(r.x * 720, 500, 1e-6) && near(r.y * 1280, 900, 1e-6), 'piksel (500,900): ekran (' + q.x.toFixed(1) + ',' + q.y.toFixed(1) + ') i z powrotem');
// stara (błędna) formuła bez przycięcia dałaby inny wynik
ok(Math.abs(q.y / 252 - 900 / 1280) > 0.05, 'bez uwzględnienia przycięcia byłby błąd ' + ((q.y / 252 - 900 / 1280) * 1280).toFixed(0) + ' px klatki');

// 2) przesunięcie kadru (object-position) - punkt (0,5; 0,7) na środek ramki
let pn = W.panFor(336, 252, 720, 1280, 0.5, 0.7);
v = W.cover(336, 252, 720, 1280, pn.px, pn.py);
let c = W.toBox(v, 0.5, 0.7);
ok(near(pn.px, 0.5) && near(c.x, 168, 1e-6) && near(c.y, 126, 1e-6), 'panFor: dioda przy dole klatki na środku ramki, py = ' + pn.py.toFixed(3));
pn = W.panFor(336, 252, 720, 1280, 0.5, 0.99);
ok(near(pn.py, 1), 'panFor: przy samej krawędzi kadr dosunięty do końca (py = 1, bez czarnego pasa)');
v = W.cover(336, 252, 720, 1280, 0, 1);
g = W.visible(v);
ok(near(g.y1, 1) && g.y0 > 0, 'object-position 0% 100%: widoczny dół klatki');
ok(W.fits(v, { x0: 0.4, x1: 0.6, y0: 0.9, y1: 0.95 }, 0.02) && !W.fits(v, { x0: 0.4, x1: 0.6, y0: 0.1, y1: 0.2 }, 0.02), 'fits: obszar w / poza widocznym fragmentem');

// 3) poziomy strumień 1280x720 w ramce 16:9 - bez przycięcia (jak dawniej)
v = W.cover(400, 225, 1280, 720, 0.5, 0.5);
ok(near(v.ox, 0) && near(v.oy, 0) && near(v.dw, 400) && near(v.dh, 225), 'poziomy 16:9 w ramce 16:9: bez przycięcia');
// 4) poziomy telefon: ramka szersza niż obraz 4:3 -> przycięcie lewo/prawo
v = W.cover(500, 250, 640, 480, 0.5, 0.5);
p = W.toVideo(v, 0, 125);
ok(near(v.dw, 500) && v.dh > 250 && near(p.x, 0), 'ramka 2:1, obraz 4:3: pełna szerokość, przycięcie góra/dół');
v = W.cover(300, 300, 1280, 720, 0.5, 0.5);
g = W.visible(v);
ok(near(g.y0, 0) && near(g.y1, 1) && near(g.x0 + g.x1, 1) && g.x0 > 0, 'ramka 1:1, obraz 16:9: przycięcie lewo/prawo');
q = W.toBox(v, 0.6, 0.4); r = W.toVideo(v, q.x, q.y);
ok(near(r.x, 0.6) && near(r.y, 0.4), 'ramka 1:1: tam i z powrotem');
// 5) brak wymiarów klatki (przed startem) - tożsamość
v = W.cover(300, 200, 0, 0);
p = W.toVideo(v, 150, 50);
ok(near(p.x, 0.5) && near(p.y, 0.25), 'bez obrazu: mapowanie 1:1');

console.log(bad ? 'WIDOK: BŁĘDY ' + bad + '/' + n : 'WIDOK: OK (' + n + ' testów)');
process.exit(bad ? 1 : 0);
