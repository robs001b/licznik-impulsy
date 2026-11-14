// Re-akwizycja zgubionej diody na syntetycznych klatkach (bez zdjęć prawdziwego licznika).
// Scena: płyta licznika, szczelina z diodami kWh, kvarh, Alarm (równy rozstaw jak w profilu Sanxing), odblask-przynęta.
const D = require('../detector.js');
let n = 0, bad = 0;
const ok = (c, name, info) => { n++; if (!c) bad++; console.log((c ? 'ok   ' : 'BŁĄD ') + name + (info ? ' - ' + info : '')); };
const W = 320, H = 180, FPS = 30;

function scene(opts) {
  const o = Object.assign({ TK: 1000, TQ: 3000, dur: 100, alarmT: 0, bait: null, offset: () => [0, 0], qOff: null, phaseQ: 450 }, opts);
  const LED = [[0.36, 0.52], [0.50, 0.52], [0.64, 0.52]];
  const buf = new Uint8ClampedArray(W * H * 4);
  function px(x, y, r, g, b, a) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; buf[i] += (r - buf[i]) * a; buf[i + 1] += (g - buf[i + 1]) * a; buf[i + 2] += (b - buf[i + 2]) * a; }
  function disk(cx, cy, rad, col, a) { for (let y = -rad - 1; y <= rad + 1; y++) for (let x = -rad - 1; x <= rad + 1; x++) { const d = Math.hypot(x, y); if (d <= rad) px(cx + x, cy + y, col[0], col[1], col[2], a * Math.min(1, rad + 0.5 - d)); } }
  function led(cx, cy, on) {
    if (on) { disk(cx, cy, 7, [255, 50, 30], 0.45); disk(cx, cy, 4, [255, 70, 50], 0.9); disk(cx, cy, 2, [255, 235, 225], 1); }
    else disk(cx, cy, 3, [70, 25, 25], 1);
  }
  return function frame(t) {
    const [ox, oy] = o.offset(t);
    for (let i = 0; i < W * H; i++) { buf[i * 4] = 168; buf[i * 4 + 1] = 170; buf[i * 4 + 2] = 174; buf[i * 4 + 3] = 255; }
    // LCD i szczelina
    for (let y = 18; y < 62; y++) for (let x = 80; x < 240; x++) px(x + ox, y + oy, 150, 160, 140, 1);
    for (let y = 84; y < 104; y++) for (let x = 86; x < 234; x++) px(x + ox, y + oy, 22, 22, 24, 1);
    const onK = t % o.TK < o.dur, onQ = (o.qOff == null || t < o.qOff) && (t + o.phaseQ) % o.TQ < o.dur;
    const onA = o.alarmT > 0 && (t + 1300) % o.alarmT < o.dur;
    led(LED[0][0] * W + ox, LED[0][1] * H + oy, onK); led(LED[1][0] * W + ox, LED[1][1] * H + oy, onQ); led(LED[2][0] * W + ox, LED[2][1] * H + oy, onA);
    if (o.bait) { // odblask: biała plama z czerwoną obwódką, pojedyncze błyski w nieregularnych chwilach
      const [bx, by, times] = o.bait;
      const lit = times.some(tb => t >= tb && t < tb + 110);
      if (lit) { disk(bx * W + ox, by * H + oy, 5, [255, 60, 40], 0.8); disk(bx * W + ox, by * H + oy, 3, [255, 255, 255], 1); }
    }
    return buf;
  };
}
// skalowanie z uśrednieniem (jak drawImage z wygładzaniem)
function crop(img, x0, y0, x1, y1, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx0 = x0 + (x1 - x0) * x / w, sx1 = x0 + (x1 - x0) * (x + 1) / w, sy0 = y0 + (y1 - y0) * y / h, sy1 = y0 + (y1 - y0) * (y + 1) / h;
    let r = 0, g = 0, b = 0, c = 0;
    for (let yy = Math.floor(sy0); yy < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); yy++) for (let xx = Math.floor(sx0); xx < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); xx++) {
      const X = Math.min(W - 1, Math.max(0, xx)), Y = Math.min(H - 1, Math.max(0, yy)), i = (Y * W + X) * 4; r += img[i]; g += img[i + 1]; b += img[i + 2]; c++;
    }
    const o = (y * w + x) * 4; out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c; out[o + 3] = 255;
  }
  return out;
}
function sampleWin(img, r) {
  const sw = 2 * r.w * W, sh = 2 * r.h * H;
  const SW = Math.max(8, Math.min(60, Math.round(sw))), SH = Math.max(8, Math.min(80, Math.round(SW * sh / sw)));
  const d = crop(img, (r.x - r.w) * W, (r.y - r.h) * H, (r.x + r.w) * W, (r.y + r.h) * H, SW, SH);
  const inner = { x0: Math.round(SW / 4), x1: Math.round(SW * 3 / 4), y0: Math.round(SH / 4), y1: Math.round(SH * 3 / 4) };
  return { st: D.roiStats(d, SW, SH, 'led', inner), win: { data: d, w: SW, h: SH } };
}
function patchOf(win) {
  const out = new Float32Array(64), cnt = new Float32Array(64), d = win.data;
  for (let y = 0; y < win.h; y++) for (let x = 0; x < win.w; x++) { const k = Math.min(7, Math.floor(y * 8 / win.h)) * 8 + Math.min(7, Math.floor(x * 8 / win.w)), o = (y * win.w + x) * 4; out[k] += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; cnt[k]++; }
  for (let i = 0; i < 64; i++) out[i] = cnt[i] ? out[i] / cnt[i] : 0; return out;
}

// ten sam tor co app.js: dwa okna ROI + tło kadru -> MeterDetector, impulsy -> Reacquirer, przejęcie ROI po potwierdzeniu
function run(name, sc, durS, opts) {
  opts = opts || {};
  const rois = [{ x: 0.36, y: 0.52, w: 0.04, h: 0.04 * W / H }, { x: 0.50, y: 0.52, w: 0.04, h: 0.04 * W / H }];
  const det = new D.MeterDetector({ xtalk: 0.6, minIntervalMs: 60 });
  const RQ = new D.Reacquirer(); RQ.profile = D.PROFILES[opts.profile || 'sanxing-s34u28']; RQ.chOpts = { minIntervalMs: 60, maxPulseMs: 300, sens: 0.5 };
  RQ.setVector(rois);
  const pulses = [[], []], ev = [], lastCounted = [-1e9, -1e9], roiLog = [];
  let wins = [null, null];
  const count = (p) => { if (p.t - lastCounted[p.ch] < 60) return; if (!p.reacq && RQ.suppress(p.ch)) { RQ.pulse(p.ch, p.t, rois, patchOf(wins[p.ch]), true); return; } lastCounted[p.ch] = p.t; pulses[p.ch].push(p.t); RQ.pulse(p.ch, p.t, rois, patchOf(wins[p.ch])); };
  for (let k = 0; k < durS * FPS; k++) {
    const t = k * 1000 / FPS, img = sc(t);
    if (opts.at) opts.at(t, rois);
    const s0 = sampleWin(img, rois[0]), s1 = sampleWin(img, rois[1]); wins = [s0.win, s1.win];
    const glob = D.frameMean(crop(img, 0, 0, W, H, 48, 27), 48, 27, 'led');
    const vals = [s0.st.mean, s1.st.mean];
    det.process(t, vals, { ring: [s0.st.ring, s1.st.ring], global: glob }).forEach(count);
    const io = { rois, aspect: W / H, glob, xtalk: 0.6, otherEx: i => det.ch[1 - i].excess(vals[1 - i]), patch: i => patchOf(wins[i]),
      mapRegion: g => Uint8ClampedArray.from(D.scoreMap(crop(img, g.x0 * W, g.y0 * H, g.x1 * W, g.y1 * H, g.W, g.H), g.W, g.H, 'led', 3)),
      sampleRoi: r => sampleWin(img, r).st };
    RQ.frame(t, io).forEach(e => {
      ev.push(Object.assign({ t }, e));
      if (e.type === 'found') { rois[e.ch].x = e.roi.x; rois[e.ch].y = e.roi.y; det.ch[e.ch].reset(); det.rb[e.ch] = new D.Baseline(); count({ t: e.pulse.t, ch: e.ch, reacq: true }); }
    });
    if (k % FPS === 0) roiLog.push([t, rois[0].x, rois[0].y, rois[1].x, rois[1].y]);
  }
  const desc = ev.map(e => (e.t / 1000).toFixed(1) + 's ' + e.type + '[' + ['kWh', 'kvarh'][e.ch] + (e.level != null ? ' L' + e.level : '') + (e.roi ? ' ' + e.roi.x.toFixed(3) + ',' + e.roi.y.toFixed(3) : '') + ']').join(' ');
  return { rois, pulses, ev, desc, roiLog };
}
const minGap = arr => arr.slice(1).reduce((m, t, i) => Math.min(m, t - arr[i]), Infinity);
const near = (r, x, y, tol) => Math.hypot(r.x - x, (r.y - y) * H / W) < tol;

// 0) kontrola: stabilny obraz - brak szukania, liczba impulsów zgodna
let R = run('stabilnie', scene({ alarmT: 0 }), 30);
ok(!R.ev.length, 'stabilny obraz: brak re-akwizycji', R.desc || 'brak zdarzeń');
ok(Math.abs(R.pulses[0].length - 30) <= 1 && Math.abs(R.pulses[1].length - 10) <= 1, 'stabilny obraz: impulsy kWh ≈ 30, kvarh ≈ 10', R.pulses[0].length + ' / ' + R.pulses[1].length);

// A) "uciekła" tylko dioda kvarh (błąd śledzenia: ROI przesunięte o 3 szerokości ROI), kWh nietknięta
R = run('A', scene({ bait: [0.47, 0.66, [14100, 21700]] }), 40, { at: (t, rois) => { if (t >= 6000 && !run.a) { run.a = 1; rois[1].x = 0.40; rois[1].y = 0.62; } } });
run.a = 0;
const fA = R.ev.find(e => e.type === 'found' && e.ch === 1);
ok(fA && near(R.rois[1], 0.5, 0.52, 0.012), 'A: kvarh odnaleziona we właściwym miejscu (nie na odblasku)', R.desc);
ok(R.roiLog.every(l => Math.abs(l[1] - 0.36) < 1e-9 && Math.abs(l[2] - 0.52) < 1e-9), 'A: ROI kWh nieruszone przez cały czas');
ok(!R.ev.some(e => e.ch === 0), 'A: brak re-akwizycji kWh');
ok(minGap(R.pulses[1]) > 2500 && minGap(R.pulses[0]) > 900, 'A: brak zdublowanych impulsów (min. odstęp kvarh ' + (minGap(R.pulses[1]) / 1000).toFixed(2) + ' s)');
const lostA = fA ? Math.round((fA.t - 6000) / 1000) : NaN;
ok(fA && fA.t - 6000 < 20000, 'A: czas odnalezienia < 20 s', lostA + ' s; impulsy kvarh ' + R.pulses[1].length);
ok(Math.abs(R.pulses[0].length - 40) <= 1, 'A: impulsy kWh bez strat (' + R.pulses[0].length + ')');

// B) skok całego licznika (ręka): obie diody poza oknami; odblask-przynęta blisko przewidywanego miejsca
const jump = t => t >= 8000 ? [0.15 * W, 0.12 * H] : [0, 0];
R = run('B', scene({ offset: jump, bait: [0.50, 0.62, [10500, 12800, 17300]] }), 45);
ok(near(R.rois[0], 0.51, 0.64, 0.012) && near(R.rois[1], 0.65, 0.64, 0.012), 'B: obie diody odnalezione po skoku (kWh i kvarh na nowych miejscach)', R.desc);
ok(!R.ev.some(e => e.type === 'found' && near(e.roi, 0.65, 0.74, 0.03)), 'B: przynęta (odblask) nie przejęta');
ok(minGap(R.pulses[0]) > 900 && minGap(R.pulses[1]) > 2500, 'B: brak zdublowanych impulsów');

// C) dioda Alarm miga (jak impuls) obok kvarh; ROI kvarh uciekło w stronę Alarmu - nie wolno przejąć Alarmu
R = run('C', scene({ alarmT: 2900 }), 45, { at: (t, rois) => { if (t >= 6000 && !run.c) { run.c = 1; rois[1].x = 0.60; rois[1].y = 0.60; } } });
run.c = 0;
ok(near(R.rois[1], 0.5, 0.52, 0.012), 'C: kvarh odnaleziona, Alarm odrzucony (profil Sanxing)', R.desc);
ok(!R.ev.some(e => e.type === 'found' && near(e.roi, 0.64, 0.52, 0.03)), 'C: brak przejęcia diody Alarm');
const phaseOk = t => { const m = (t + 450) % 3000; return m < 120 || m > 2880; };
const wrongC = R.pulses[1].filter(t => !phaseOk(t));
ok(wrongC.length <= 1, 'C: błyski Alarmu nie liczone jako kvarh (najwyżej 1 przed wykryciem)', 'obce: ' + wrongC.map(t => (t / 1000).toFixed(2)).join(', ') + '; kvarh ' + R.pulses[1].length);

// D) kvarh przestaje migać (Q = 0) przy obecnym Alarmie i odblasku: szukanie bez przeskoku
R = run('D', scene({ qOff: 5000, alarmT: 2900, bait: [0.55, 0.60, [25000, 31000]] }), 60);
ok(R.ev.some(e => e.type === 'search' && e.ch === 1) && !R.ev.some(e => e.type === 'found' && e.ch === 1) && near(R.rois[1], 0.5, 0.52, 1e-6), 'D: brak impulsów kvarh - szuka, ale ROI zostaje na miejscu', R.desc);
ok(!R.ev.some(e => e.ch === 0), 'D: kWh bez re-akwizycji');

// E) "Znajdź diody" z profilem: trzy migające diody w rzędzie - prawa to Alarm, nie impuls
const scE = scene({ alarmT: 2700 }), maps = [], times = [];
for (let t = 0; t < 10000; t += 33) { const d = crop(scE(t), 0, 0, W, H, 192, 108); maps.push(Uint8ClampedArray.from(D.scoreMap(d, 192, 108, 'led', 3))); times.push(t); }
const fS = D.findLeds(maps, times, 192, 108, { profile: D.PROFILES['sanxing-s34u28'] });
const al = fS.cands.find(c => Math.abs(c.x - 0.64) < 0.02);
ok(fS.roi[0] && Math.abs(fS.roi[0].x - 0.36) < 0.02 && fS.roi[1] && Math.abs(fS.roi[1].x - 0.5) < 0.02, 'E: Znajdź diody (profil): kWh 0,36, kvarh 0,50', fS.cands.map(c => (c.role || 'X') + '@' + c.x.toFixed(2) + '(' + c.reason + ')').join(' '));
ok(al && !al.ok && /Alarm/.test(al.reason), 'E: dioda Alarm odrzucona z powodem "Alarm"', al && al.reason);
// E2) kvarh słabsza niż Alarm (Alarm miga częściej): z profilem kvarh = środkowa
const scE2 = scene({ alarmT: 900, TQ: 4000 }), m2 = [], t2 = [];
for (let t = 0; t < 10000; t += 33) { const d = crop(scE2(t), 0, 0, W, H, 192, 108); m2.push(Uint8ClampedArray.from(D.scoreMap(d, 192, 108, 'led', 3))); t2.push(t); }
const g2 = D.findLeds(m2, t2, 192, 108, { profile: D.PROFILES['sanxing-s34u28'] }), o2 = D.findLeds(m2, t2, 192, 108, { profile: D.PROFILES.generic });
ok(g2.roi[1] && Math.abs(g2.roi[1].x - 0.5) < 0.02, 'E2: profil - kvarh = środkowa mimo częstszego Alarmu', 'profil: ' + (g2.roi[1] && g2.roi[1].x.toFixed(3)) + ', ogólny: ' + (o2.roi[1] && o2.roi[1].x.toFixed(3)));

// F) PowerCalc.gap: T i średnia nie obejmują przerwy, licznik impulsów ciągły
const pc = new D.PowerCalc([1000, 1000], 5);
[0, 1000, 2000].forEach(t => pc.add(0, t)); pc.gap(0); const rg = pc.add(0, 30000); pc.add(0, 31000);
const sg = pc.stats(0, 31500);
ok(rg.T === null && sg.count === 5 && Math.abs(sg.lastT - 1) < 1e-9 && Math.abs(sg.avg - 3.6) < 1e-9, 'PowerCalc.gap: impuls po przerwie bez T, średnia tylko z nowego odcinka', JSON.stringify({ T: rg.T, n: sg.count, lastT: sg.lastT, avg: sg.avg }));

console.log(bad ? `REACQ: ${bad}/${n} BŁĘDÓW` : `REACQ: OK (${n} testów)`);
process.exit(bad ? 1 : 0);
