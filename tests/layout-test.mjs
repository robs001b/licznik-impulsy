// Układ na telefonach: brak nakładania linii cos φ i przycisków (Znajdź diody, Eksport CSV), przed i po przewinięciu
// (przypięty podgląd), brak przewijania w poziomie. Samodzielnie: node layout-test.mjs <baseUrl> <outDir>
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
// CSS viewport (szer. x widoczna wys.) - dane producentów / WebKit / Chrome
export const DEVICES = [
  ['Telefon 412 (Robert, Opera)', 412, 915, 2.625],
  ['Android 360x800', 360, 800, 3],
  ['iPhone SE', 375, 667, 2],
  ['iPhone 15/16', 393, 852, 3],
  ['iPhone 15/16 Pro Max', 430, 932, 3],
  ['Galaxy Z Flip6 rozłożony', 360, 880, 3],
  ['Galaxy Z Flip6 ekran zewnętrzny', 360, 374, 2],
  ['iPhone Duo zamknięty', 382, 580, 3],
  ['iPhone Duo otwarty', 669, 867, 2.8],
];
const SHOTS = { 'iPhone SE': '20-iphone-se.png', 'Galaxy Z Flip6 rozłożony': '20-flip6-rozlozony.png', 'Galaxy Z Flip6 ekran zewnętrzny': '20-flip6-zewnetrzny.png', 'iPhone Duo otwarty': '20-iphone-duo-otwarty.png' };

export async function layoutChecks(base, out, check, devices = DEVICES) {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  for (const [name, w, h, dpr] of devices) {
    for (const url of ['', '?sim=1&P=5&Q=1.5&track=0']) {
      const c = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
      const p = await c.newPage();
      const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.goto(base + url); await p.waitForTimeout(url ? 3000 : 600);
      const res = [];
      for (const y of [0, 60, 120, 250, 400, 700, 1200]) {
        await p.evaluate(y => window.scrollTo(0, y), y); await p.waitForTimeout(200);
        res.push(await p.evaluate(y => {
          const R = e => e.getBoundingClientRect(), stick = document.getElementById('stick'), foot = document.querySelector('.rbfoot'), sR = R(stick), fR = R(foot);
          const inside = (el, root) => !!el && (el === root || root.contains(el));
          const out = { y, ok: true, why: [], sw: document.documentElement.scrollWidth, gap: Math.round(R(document.getElementById('btnFind')).top - fR.bottom) };
          if (out.sw > innerWidth) { out.ok = false; out.why.push('przewijanie w poziomie ' + out.sw); }
          const fy = (fR.top + fR.bottom) / 2;
          if (fy > 0 && fy < innerHeight && !inside(document.elementFromPoint(fR.left + 30, fy), foot)) { out.ok = false; out.why.push('cos φ zasłonięte'); }
          if (fR.bottom > sR.bottom + 0.5) { out.ok = false; out.why.push('cos φ poza blokiem podglądu'); }
          for (const id of ['btnFind', 'btnCsv']) {
            const bt = document.getElementById(id), bR = R(bt), cx = (bR.left + bR.right) / 2;
            if (bR.right > innerWidth + 0.5) { out.ok = false; out.why.push(id + ' wychodzi poza ekran'); }
            if (y === 0 && bR.top < fR.bottom + 6) { out.ok = false; out.why.push(id + ' za blisko cos φ (' + Math.round(bR.top - fR.bottom) + ' px)'); }
            for (const yy of [bR.top + 3, (bR.top + bR.bottom) / 2, bR.bottom - 3]) {
              if (yy < 0 || yy > innerHeight) continue;
              const hit = document.elementFromPoint(cx, yy);
              if (yy < sR.bottom ? !inside(hit, stick) : !inside(hit, bt)) { out.ok = false; out.why.push(id + ' nakłada się (y=' + Math.round(yy) + ')'); }
            }
          }
          return out;
        }, y));
      }
      const bad = res.filter(r => !r.ok);
      check(`układ ${name} ${w}x${h}${url ? ' (symulacja)' : ' (bez kamery)'}: bez nakładania i poziomego przewijania, przed i po przewinięciu`,
        !bad.length && !errs.length, bad.length ? JSON.stringify(bad.slice(0, 3)) : errs.length ? errs.join(' | ') : 'odstęp ' + res[0].gap + ' px');
      if (!url) {
        await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(150);
        if (name.startsWith('Telefon 412')) await p.screenshot({ path: out + '/19-bez-nakladania.png' });
        if (SHOTS[name]) await p.screenshot({ path: out + '/' + SHOTS[name] });
      }
      await c.close();
    }
  }
  await b.close();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , base = 'http://localhost:8765/', out = '../zrzuty'] = process.argv;
  let fail = 0;
  await layoutChecks(base, out, (n, c, i) => { console.log((c ? 'OK   ' : 'BŁĄD ') + n + (i ? ' - ' + i : '')); if (!c) fail++; });
  console.log(fail ? fail + ' błędów' : 'UKŁAD: wszystko OK'); process.exit(fail ? 1 : 0);
}
