// Podgląd "cover" w przeglądarce: pionowa kamera 720x1280 (atrapa), ramka 4:3 na całą szerokość, przycięcie góra/dół.
// Sprawdza, że obraz na ekranie, nakładka obszarów i dotyk zgadzają się z pikselami analizowanej klatki.
// node tests/cover-test.mjs [baseUrl] [outDir]
import { chromium } from 'playwright-core';
const [, , base = 'http://localhost:8765/', out = '/tmp'] = process.argv;
let fail = 0;
const check = (n, c, i) => { console.log((c ? 'OK   ' : 'BŁĄD ') + n + (i ? ' - ' + i : '')); if (!c) fail++; };
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });

// atrapa kamery: klatka VWxVH, ciemne tło, czerwony znacznik w (MX, MY) px klatki
async function open(vw, vh, mx, my, w, h, qs = '') {
  const c = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await c.addInitScript(([vw, vh, mx, my]) => {
    localStorage.setItem('licznik-impulsy-sekcje-v2', JSON.stringify({ secSig: false, secHist: false }));
    navigator.mediaDevices.getUserMedia = async () => {
      const cv = document.createElement('canvas'); cv.width = vw; cv.height = vh; const g = cv.getContext('2d');
      const draw = () => { g.fillStyle = '#202020'; g.fillRect(0, 0, vw, vh); g.fillStyle = '#ff0000'; g.fillRect(mx - 14, my - 14, 28, 28); requestAnimationFrame(draw); };
      draw(); return cv.captureStream(30);
    };
  }, [vw, vh, mx, my]);
  const p = await c.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message));
  await p.goto(base + '?cam=1' + qs); await p.waitForTimeout(2500);
  return p;
}
// środek czerwonej plamy na zrzucie ekranu ramki podglądu (w px CSS względem ramki)
async function redCentroid(p) {
  const r = await p.evaluate(() => { const o = document.getElementById('overlay').getBoundingClientRect(); return { x: o.left, y: o.top, width: o.width, height: o.height }; });
  const png = (await p.screenshot({ clip: r })).toString('base64');
  return p.evaluate(async ([png, r]) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + png; await im.decode();
    const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data; let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) { const i = (y * cv.width + x) * 4; if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) { sx += x; sy += y; n++; } }
    const k = cv.width / r.width; return n ? { x: sx / n / k, y: sy / n / k, n } : null;
  }, [png, r]);
}
async function scenario(name, vw, vh, mx, my, w, h, qs, shot) {
  const p = await open(vw, vh, mx, my, w, h, qs);
  const info = await p.evaluate(() => { const L = window.__licznik, v = L.view(), cam = document.getElementById('cam').getBoundingClientRect(), st = document.getElementById('stick'), cs = getComputedStyle(st);
    return { v, pan: L.pan(), camW: cam.width, camH: cam.height, inner: st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), vw: document.getElementById('video').videoWidth, vh: document.getElementById('video').videoHeight, sw: document.documentElement.scrollWidth }; });
  check(name + ': klatka ' + info.vw + 'x' + info.vh, info.vw === vw && info.vh === vh);
  check(name + ': bez przewijania w poziomie', info.sw <= w, 'scrollWidth ' + info.sw);
  // gdzie znacznik powinien być wg mapowania
  const exp = { x: info.v.ox + mx / vw * info.v.dw, y: info.v.oy + my / vh * info.v.dh };
  const got = await redCentroid(p);
  check(name + ': obraz na ekranie zgodny z mapowaniem (±2 px)', got && Math.abs(got.x - exp.x) < 2 && Math.abs(got.y - exp.y) < 2, `oczekiwane ${exp.x.toFixed(1)},${exp.y.toFixed(1)}, jest ${got ? got.x.toFixed(1) + ',' + got.y.toFixed(1) : 'brak'}`);
  // dotknięcie znacznika ustawia obszar kvarh na pikselu klatki
  await p.evaluate(() => document.querySelector('.roisel[data-ch="1"]').click());
  await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(200);
  const g2 = await redCentroid(p);
  const ob = await p.locator('#overlay').boundingBox();
  const hitEl = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.id || e.className); }, [ob.x + g2.x, ob.y + g2.y]);
  await p.mouse.click(ob.x + g2.x, ob.y + g2.y); await p.waitForTimeout(300);
  if (hitEl !== 'overlay') console.log('     element w punkcie dotyku:', hitEl);
  const r1 = await p.evaluate(() => window.__licznik.rois()[1]);
  check(name + ': dotyk -> obszar kvarh w pikselu klatki (±4 px)', Math.abs(r1.x * vw - mx) < 4 && Math.abs(r1.y * vh - my) < 4, `obszar ${(r1.x * vw).toFixed(1)},${(r1.y * vh).toFixed(1)} px, znacznik ${mx},${my}`);
  // nakładka: ramka obszaru kvarh rysowana tam, gdzie znacznik (piksel ramki w kolorze kvarh)
  await p.waitForTimeout(300);
  const ov = await p.evaluate(([vw, vh, MX, MY]) => { const L = window.__licznik, v = L.view(), r = L.rois()[1], o = document.getElementById('overlay'), k = o.width / o.getBoundingClientRect().width;
    const x = Math.round((v.ox + (MX / vw - r.w / 2) * v.dw) * k), y = Math.round((v.oy + MY / vh * v.dh) * k), d = o.getContext('2d').getImageData(x - 3, y - 1, 7, 3).data;
    let hit = false; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 120 && d[i + 1] < 210 && d[i + 2] < 90 && d[i + 3] > 150) hit = true; return hit; }, [vw, vh, mx, my]);
  check(name + ': nakładka obszaru kvarh w miejscu znacznika', ov);
  if (shot) await p.screenshot({ path: shot });
  check(name + ': brak błędów JS', p.errs.length === 0, p.errs.join(' | '));
  await p.context().close();
  return info;
}
let i = await scenario('412x915, pionowa kamera 720x1280', 720, 1280, 500, 700, 412, 915, '', out + '/licznik-roz-podglad-cover-412.png');
check('412: ramka 4:3 na całą szerokość karty', Math.abs(i.camW / i.camH - 4 / 3) < 0.01 && Math.abs(i.camW - i.inner) < 1.5, `ramka ${i.camW.toFixed(0)}x${i.camH.toFixed(0)}, wnętrze karty ${i.inner.toFixed(0)}`);
check('412: przycięcie góra/dół po równo', i.v.ox === 0 && i.v.oy < 0 && Math.abs(i.pan.py - 0.5) < 1e-9, `oy ${i.v.oy.toFixed(1)}`);
i = await scenario('390x844, diody przy dole klatki (kadr przesunięty)', 720, 1280, 360, 1150, 390, 844, '&roi0=0.4,0.9,0.03,0.02&roi1=0.6,0.9,0.03,0.02', out + '/licznik-roz-podglad-cover-390-przesuniety.png');
check('390: kadr przesunięty w dół do obszarów (py > 0,5)', i.pan.py > 0.5, 'py ' + i.pan.py.toFixed(3));
i = await scenario('360x800 (Z Flip 6), pionowa kamera', 720, 1280, 200, 640, 360, 800, '');
i = await scenario('844x390 poziomo, kamera 1280x720', 1280, 720, 900, 300, 844, 390, '', out + '/licznik-roz-podglad-poziomo.png');
check('poziomo: obraz 16:9 bez przycięcia', Math.abs(i.v.ox) < 0.5 && Math.abs(i.v.oy) < 0.5, `ramka ${i.camW.toFixed(0)}x${i.camH.toFixed(0)}`);
await b.close();
console.log(fail ? 'COVER: BŁĘDY ' + fail : 'COVER: OK');
process.exit(fail ? 1 : 0);
