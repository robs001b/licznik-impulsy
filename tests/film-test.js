// Test offline na filmie z licznika: ffmpeg -> klatki RGBA -> ten sam kod co w aplikacji.
// 1) "Znajdź diody" na mapach 160 px, 2) detekcja impulsów w znalezionych ROI (sygnał czerwonej diody, pierścień, globalne tło).
// Użycie: node tests/film-test.js [plik.mp4]   (FPS=30 - symulacja wolniejszej kamery, XTALK=0 - bez tłumienia przesłuchu)
const { spawnSync } = require('child_process');
const D = require('../detector.js');
const file = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : __dirname + '/../zrodla/film-licznik.mp4';
const FPS_OUT = Number(process.env.FPS || 0);
const XTALK = process.env.XTALK != null ? Number(process.env.XTALK) : 0.6;
const MODE = process.env.MODE || 'led';
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]).stdout.toString().trim();
const [a, b] = probe.split(/\s|,/)[0].split('/').map(Number); const fps = FPS_OUT || a / (b || 1);
function frames(W, H) {
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', (FPS_OUT ? `fps=${FPS_OUT},` : '') + `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2e9 }).stdout;
  return { raw, n: raw.length / (W * H * 4) };
}
// --- 1) znajdowanie diod
const AW = 160, AH = 284;
const A = frames(AW, AH), maps = [], times = [];
for (let f = 0; f < A.n; f++) { maps.push(D.scoreMap(A.raw.subarray(f * AW * AH * 4, (f + 1) * AW * AH * 4), AW, AH, 'led', 3)); times.push(f * 1000 / fps); }
const t0 = Date.now();
const found = D.findLeds(maps, times, AW, AH);
console.log(`Znajdź diody (${A.n} klatek ${AW}x${AH}, ${Date.now() - t0} ms):`);
for (const c of found.cands) console.log(`  ${c.ok ? 'PRZYJĘTA ' + c.role : 'odrzucona'} x=${c.x.toFixed(3)} y=${c.y.toFixed(3)} błyski=${c.events}/${c.all}${c.reason ? ' - ' + c.reason : ''}`);
if (found.msg) console.log('  ' + found.msg);
// --- 2) detekcja w znalezionych ROI na pełnej rozdzielczości 576x1024
const W = 576, H = 1024, F = frames(W, H);
const roi = found.roi.map((r, i) => r || [{ x: 0.33, y: 0.298, w: 0.031, h: 0.0175 }, { x: 0.446, y: 0.298, w: 0.031, h: 0.0175 }][i]);
function win(f, r) { // okno 2x ROI, jak w aplikacji
  const sw = Math.round(2 * r.w * W), sh = Math.round(2 * r.h * H), sx = Math.round((r.x - r.w) * W), sy = Math.round((r.y - r.h) * H);
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const si = (f * W * H + (sy + y) * W + (sx + x)) * 4, di = (y * sw + x) * 4;
    out[di] = F.raw[si]; out[di + 1] = F.raw[si + 1]; out[di + 2] = F.raw[si + 2]; out[di + 3] = 255;
  }
  return { data: out, w: sw, h: sh, inner: { x0: Math.round(sw / 4), x1: Math.round(sw * 3 / 4), y0: Math.round(sh / 4), y1: Math.round(sh * 3 / 4) } };
}
const det = new D.MeterDetector({ xtalk: XTALK, warmupMs: 200 });
const calc = new D.PowerCalc([1000, 1000], 5);
const names = ['kWh', 'kvarh'];
for (let f = 0; f < F.n; f++) {
  const t = f * 1000 / fps;
  const st = roi.map(r => { const w = win(f, r); return D.roiStats(w.data, w.w, w.h, MODE, w.inner); });
  const g = D.frameMean(A.raw.subarray(f * AW * AH * 4, (f + 1) * AW * AH * 4), AW, AH, MODE);
  for (const p of det.process(t, st.map(s => s.mean), { ring: st.map(s => s.ring), global: g })) {
    const rec = calc.add(p.ch, p.t);
    console.log(`impuls ${names[p.ch]} t=${(p.t / 1000).toFixed(3)} s, błysk ok. ${Math.round(p.dur)} ms, skok ${Math.round(p.peak)}` +
      (rec.T ? `, T=${rec.T.toFixed(3)} s -> ${rec.val.toFixed(2)} ${p.ch ? 'kvar' : 'kW'}` : ''));
  }
}
const n = calc.pulses.map(x => x.length);
const P = calc.pulses[0].length > 1 ? 3600 / (1000 * (calc.pulses[0][1] - calc.pulses[0][0]) / 1000) : NaN;
const kwh = found.cands.find(c => c.role === 'kWh'), kvarh = found.cands.find(c => c.role === 'kvarh');
const rejected = found.cands.filter(c => !c.ok);
const modRej = rejected.some(c => c.x > 0.8);
console.log(`WYNIK: impulsy kWh=${n[0]}, kvarh=${n[1]}, P=${P.toFixed(2)} kW; kWh x=${kwh && kwh.x.toFixed(3)}, kvarh x=${kvarh && kvarh.x.toFixed(3)}, odrzucone ${rejected.length} (moduł po prawej odrzucony: ${modRej})`);
const ok = kwh && kvarh && kwh.x < kvarh.x && Math.abs(kwh.x - 0.33) < 0.03 && Math.abs(kvarh.x - 0.446) < 0.03 && n[0] === 2 && n[1] === 1 && Math.abs(P - 2.24) < 0.1 && !found.cands.some(c => c.ok && c.x > 0.8);
console.log(ok ? 'FILM: OK' : 'FILM: BŁĄD');
process.exitCode = ok ? 0 : 1;
