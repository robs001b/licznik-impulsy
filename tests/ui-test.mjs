// Test UI w Chrome (widok telefonu): symulacja + fałszywa kamera z filmu. node tests/ui-test.mjs <baseUrl> <outDir> [y4m]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [, , base = 'http://localhost:8765/', out = '../zrzuty', y4m] = process.argv;
fs.mkdirSync(out, { recursive: true });
let fail = 0;
const check = (n, c, i) => { console.log((c ? 'OK   ' : 'BŁĄD ') + n + (i ? ' - ' + i : '')); if (!c) fail++; };
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
if (y4m) args.push('--use-file-for-fake-video-capture=' + y4m);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args });
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'], acceptDownloads: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
async function camShot(pg, path) { // podgląd + panel kamery (dwa sąsiednie bloki)
  const a = await pg.evaluate(() => { const s = document.getElementById('stick').getBoundingClientRect(), c = document.querySelector('.camwrap').getBoundingClientRect(); return { x: s.left, y: s.top + scrollY, w: s.width, h: c.bottom - s.top }; });
  await pg.screenshot({ path, fullPage: true, clip: { x: a.x, y: a.y, width: a.w, height: a.h } });
}
const stats = () => page.evaluate(() => { const L = window.__licznik, n = performance.now(); return { s0: L.calc.stats(0, n), s1: L.calc.stats(1, n), fps: L.fps(), rec: L.records().length }; });

// 1) symulacja P=5 kW, Q=1,5 kvar
await page.goto(base + '?sim=1&P=5&Q=1.5&dur=100');
await page.waitForTimeout(16000);
let s = await stats();
check('symulacja: P średnie ≈ 5 kW (±3%)', Math.abs(s.s0.avg / 5 - 1) < 0.03, `P=${s.s0.avg?.toFixed(3)} kW, impulsy ${s.s0.count}, fps ${s.fps.toFixed(0)}`);
check('symulacja: Q średnie ≈ 1,5 kvar (±3%)', Math.abs(s.s1.avg / 1.5 - 1) < 0.03, `Q=${s.s1.avg?.toFixed(3)} kvar, impulsy ${s.s1.count}`);
await page.screenshot({ path: out + '/01-symulacja-gora.png' });
await page.screenshot({ path: out + '/02-symulacja-cala-strona.png', fullPage: true });
await page.locator('.panel').nth(0).screenshot({ path: out + '/03-sygnal-diod.png' });
await page.locator('.panel').nth(1).screenshot({ path: out + '/04-wykres-mocy.png' });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnCsv')]);
const csvPath = out + '/../tests/out-eksport.csv'; await dl.saveAs(csvPath);
const csv = fs.readFileSync(csvPath, 'utf8');
check('CSV: nagłówek, wiersze, stopka bez autora', csv.includes('czas;czas_od_startu_s;typ;T_s') && /Wygenerował: \d{4}-/.test(csv) && !/Kołodziejczyk/.test(csv), csv.split('\n').length + ' linii');
const html = await page.content();
check('stopka "Autor: Robert Kołodziejczyk" dokładnie raz', (html.match(/Autor: Robert Kołodziejczyk/g) || []).length === 1);
check('brak długiego myślnika w treści', !(await page.evaluate(() => document.body.innerText)).includes('\u2014'));

// 2) brak impulsu -> moc maksymalna możliwa
await page.fill('#simP', '0'); await page.dispatchEvent('#simP', 'input');
await page.waitForTimeout(6000);
const maxTxt = await page.textContent('#pMax');
check('brak impulsów kWh -> komunikat o mocy maks. możliwej', /maks\. możliwa/.test(maxTxt), maxTxt);
await page.locator('.cards').screenshot({ path: out + '/05-brak-impulsu-moc-maks.png' });

// 3) drgania ręki + śledzenie
await page.goto(base + '?sim=1&P=8&Q=2&shake=1&track=1');
await page.waitForTimeout(15000);
s = await stats();
check('symulacja z drganiami + śledzenie: P ≈ 8 kW (±5%)', Math.abs(s.s0.avg / 8 - 1) < 0.05, `P=${s.s0.avg?.toFixed(3)}, Q=${s.s1.avg?.toFixed(3)}`);

// 3b) odblask lampy + ruchomy refleks + migotanie
await page.goto(base + '?sim=1&P=6&Q=2&glare=1&track=0');
await page.waitForTimeout(15000);
s = await stats();
check('symulacja z odblaskiem, refleksem i migotaniem: P ≈ 6 kW, Q ≈ 2 kvar (±5%)', Math.abs(s.s0.avg / 6 - 1) < 0.05 && Math.abs(s.s1.avg / 2 - 1) < 0.05, `P=${s.s0.avg?.toFixed(3)}, Q=${s.s1.avg?.toFixed(3)}, kWh ${s.s0.count}, kvarh ${s.s1.count}`);
await page.screenshot({ path: out + '/09-symulacja-odblaski.png' });

// 3c) Znajdź diody w symulacji (ROI startowo w złym miejscu)
await page.goto(base + '?sim=1&P=8&Q=3&track=0&roi0=0.2,0.3,0.04,0.07&roi1=0.8,0.3,0.04,0.07&find=1000');
await page.waitForTimeout(13000);
let fr = await page.evaluate(() => window.__find());
let rk = await page.evaluate(() => window.__licznik.rois());
check('Znajdź diody (symulacja): kWh ≈ 0,36, kvarh ≈ 0,50, ROI przestawione', fr && Math.abs(rk[0].x - 0.36) < 0.02 && Math.abs(rk[1].x - 0.5) < 0.02,
  fr ? fr.cands.map(c => (c.role || 'X') + '@' + c.x.toFixed(2) + ',' + c.y.toFixed(2) + (c.reason ? '(' + c.reason + ')' : '')).join(' ') : 'brak wyniku');

// 3d) układ telefonu 412x900: podgląd + wyniki bez przewijania, przypięte przy przewijaniu
await page.setViewportSize({ width: 412, height: 900 });
await page.goto(base + '?sim=1&P=5&Q=1.5&track=0');
await page.waitForTimeout(9000);
let lay = await page.evaluate(() => { const c = document.getElementById('cam').getBoundingClientRect(), r = document.getElementById('resbar').getBoundingClientRect(); return { camTop: c.top, camH: c.height, resBottom: r.bottom, p: document.getElementById('bpInst').textContent, q: document.getElementById('bqInst').textContent, cos: document.getElementById('bCos').textContent }; });
check('412x900: kamera i pasek wyników widoczne bez przewijania (symulacja)', lay.resBottom <= 900 && lay.camH > 150 && lay.p !== '-' && lay.q !== '-' && lay.cos !== '-', JSON.stringify(lay));
await page.screenshot({ path: out + '/10-uklad-telefon.png' });
await page.evaluate(() => window.scrollTo(0, 1600));
await page.waitForTimeout(400);
lay = await page.evaluate(() => { const r = document.getElementById('resbar').getBoundingClientRect(), c = document.getElementById('cam').getBoundingClientRect(); return { camTop: c.top, resBottom: r.bottom }; });
check('przewinięcie: podgląd i wyniki przyklejone u góry', lay.camTop >= -1 && lay.camTop < 20 && lay.resBottom < 900, JSON.stringify(lay));
await page.screenshot({ path: out + '/11-przewiniete-przypiete.png' });
await page.evaluate(() => window.scrollTo(0, 0));
await page.setViewportSize({ width: 412, height: 915 });

// 4) zaznaczanie ROI dotykiem
const box = await page.locator('#overlay').boundingBox();
await page.click('.roisel[data-ch="1"]');
await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
const r1 = await page.evaluate(() => window.__licznik.rois()[1]);
check('dotyk przenosi obszar kvarh', Math.abs(r1.x - 0.7) < 0.02 && Math.abs(r1.y - 0.3) < 0.03, `x=${r1.x.toFixed(3)} y=${r1.y.toFixed(3)}`);

// 5) fałszywa kamera z filmu licznika (opcjonalnie)
if (y4m) {
    // Chrome przycina pionowy film 576x1024 do 576x720 (środek): y = (305-152)/720
  // obszary startowo celowo źle - ustawia je "Znajdź diody"
  await page.goto(base + '?cam=1&track=0&roi0=0.6,0.6,0.03,0.02&roi1=0.7,0.6,0.03,0.02&find=1500');
  await page.waitForTimeout(13500);
  fr = await page.evaluate(() => window.__find());
  rk = await page.evaluate(() => window.__licznik.rois());
  const desc = fr ? fr.cands.map(c => (c.role || 'X') + '@' + c.x.toFixed(3) + ',' + c.y.toFixed(3) + (c.reason ? '(' + c.reason + ')' : '')).join(' ') : 'brak';
  const modOk = fr && !fr.cands.some(c => c.ok && c.x > 0.8);
  const modShown = fr && fr.cands.some(c => !c.ok && c.x > 0.8);
  check('film: Znajdź diody - kWh po lewej (x≈0,33), kvarh środkowa (x≈0,45), moduł nieprzyjęty', fr && Math.abs(rk[0].x - 0.33) < 0.025 && Math.abs(rk[1].x - 0.448) < 0.025 && modOk, desc);
  check('film: dioda modułu pokazana jako odrzucona', modShown, desc);
  await camShot(page, out + '/07-znajdz-diody.png');
  await page.click('#btnReset');
  await page.waitForTimeout(12500);
  s = await stats();
  check('film (pętla 2,9 s) przez kamerę po auto-ROI: impulsy kWh co 1,60 s', s.s0.count >= 6 && Math.abs(s.s0.lastT - 1.6) < 0.05 || Math.abs(s.s0.lastT - 1.37) < 0.05, `kWh ${s.s0.count}, kvarh ${s.s1.count}, ostatni T ${s.s0.lastT?.toFixed(3)} s, P śr. ${s.s0.avg?.toFixed(2)} kW, fps ${s.fps.toFixed(0)}`);
  const recs = await page.evaluate(() => window.__licznik.records().filter(r => r.ch === 0 && r.T).map(r => +r.T.toFixed(3)));
  console.log('     T kWh [s]:', recs.join(' '), '(1,60 = film; 1,37 = skok pętli filmu)');
  await page.screenshot({ path: out + '/06-film-przez-kamere.png' });
  await page.setViewportSize({ width: 412, height: 900 }); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300);
  lay = await page.evaluate(() => { const r = document.getElementById('resbar').getBoundingClientRect(), c = document.getElementById('cam').getBoundingClientRect(); return { camH: Math.round(c.height), camW: Math.round(c.width), resBottom: Math.round(r.bottom) }; });
  check('412x900, pionowy obraz z kamery (film): wyniki bez przewijania', lay.resBottom <= 900 && lay.camH > 200, JSON.stringify(lay));
  await page.screenshot({ path: out + '/12-uklad-telefon-kamera.png' });
}
check('brak błędów JS', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();

// 6) ostrość - atrapa aparatu z Androida (focusMode, focusDistance, pointsOfInterest)
const b2 = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const c2 = await b2.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera'] });
await c2.addInitScript(() => {
  const st = { focusMode: 'continuous', focusDistance: 0.18, zoom: 1, exposureCompensation: 0 };
  window.__applied = [];
  MediaStreamTrack.prototype.getCapabilities = function () { return { focusMode: ['manual', 'single-shot', 'continuous'], focusDistance: { min: 0.05, max: 10, step: 0.01 }, zoom: { min: 1, max: 8, step: 0.1 }, exposureCompensation: { min: -3, max: 3, step: 0.1 }, torch: true, exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 1000, step: 1 } }; };
  const gs = MediaStreamTrack.prototype.getSettings;
  MediaStreamTrack.prototype.getSettings = function () { return Object.assign({}, gs.call(this), st); };
  MediaStreamTrack.prototype.applyConstraints = function (c) { const a = (c && c.advanced && c.advanced[0]) || c || {}; window.__applied.push(a); Object.assign(st, a); if (a.focusMode === 'single-shot') st.focusDistance = 0.16; return Promise.resolve(); };
  const sc = MediaDevices.prototype.getSupportedConstraints;
  MediaDevices.prototype.getSupportedConstraints = function () { return Object.assign({}, sc.call(this), { pointsOfInterest: true, focusMode: true }); };
});
const p2 = await c2.newPage();
const e2 = []; p2.on('pageerror', e => e2.push(e.message));
await p2.goto(base + '?cam=1');
await p2.waitForTimeout(2500);
let ap = await p2.evaluate(() => window.__applied);
check('ostrość: po starcie focusMode continuous', ap.some(a => a.focusMode === 'continuous'));
await p2.click('#fTap');
const ob = await p2.locator('#overlay').boundingBox();
await p2.mouse.click(ob.x + ob.width * 0.4, ob.y + ob.height * 0.55);
await p2.waitForTimeout(600);
ap = await p2.evaluate(() => window.__applied);
const poi = ap.find(a => a.pointsOfInterest);
check('ostrość: dotknięcie wysyła pointsOfInterest + single-shot', poi && Math.abs(poi.pointsOfInterest[0].x - 0.4) < 0.02 && poi.focusMode === 'single-shot', JSON.stringify(poi));
await p2.click('#fLock');
await p2.waitForTimeout(900);
ap = await p2.evaluate(() => window.__applied);
const lk = ap[ap.length - 1];
check('ostrość: Zablokuj -> focusMode manual z bieżącą odległością', lk.focusMode === 'manual' && lk.focusDistance === 0.16, JSON.stringify(lk));
const fst = await p2.textContent('#focusStat');
check('ostrość: status pokazuje blokadę', /zablokowana/.test(fst), fst);
await p2.evaluate(() => document.getElementById('focusCtl').scrollIntoView({ block: 'center' }));
await camShot(p2, out + '/08-fokus.png');
check('ostrość: brak błędów JS', e2.length === 0, e2.join(' | '));
await b2.close();
console.log(fail ? fail + ' błędów' : 'UI: wszystko OK');
process.exit(fail ? 1 : 0);
