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

// 4) zaznaczanie ROI dotykiem
const box = await page.locator('#overlay').boundingBox();
await page.click('.roisel[data-ch="1"]');
await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
const r1 = await page.evaluate(() => window.__licznik.rois()[1]);
check('dotyk przenosi obszar kvarh', Math.abs(r1.x - 0.7) < 0.02 && Math.abs(r1.y - 0.3) < 0.03, `x=${r1.x.toFixed(3)} y=${r1.y.toFixed(3)}`);

// 5) fałszywa kamera z filmu licznika (opcjonalnie)
if (y4m) {
    // Chrome przycina pionowy film 576x1024 do 576x720 (środek): y = (305-152)/720
  await page.goto(base + '?cam=1&track=0&roi0=0.3299,0.2125,0.03125,0.0167&roi1=0.4462,0.2125,0.03125,0.0167');
  await page.waitForTimeout(12500);
  s = await stats();
  check('film (pętla 2,9 s) przez kamerę: wykryte impulsy kWh i P ≈ 2,24 kW', s.s0.count >= 6 && Math.abs(s.s0.avg / 2.24 - 1) < 0.25, `kWh ${s.s0.count}, kvarh ${s.s1.count}, P śr. ${s.s0.avg?.toFixed(2)} kW, fps ${s.fps.toFixed(0)}`);
  await page.screenshot({ path: out + '/06-film-przez-kamere.png' });
}
check('brak błędów JS', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();
console.log(fail ? fail + ' błędów' : 'UI: wszystko OK');
process.exit(fail ? 1 : 0);
