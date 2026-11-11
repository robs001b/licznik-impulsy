// Test offline na filmie z licznika: ffmpeg -> klatki RGB -> ten sam detektor co w aplikacji.
// Użycie: node tests/film-test.js [plik.mp4]
const { spawnSync } = require('child_process');
const D = require('../detector.js');
const file = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : __dirname + '/../zrodla/film-licznik.mp4';
const FPS_OUT = Number(process.env.FPS || 0); // np. FPS=30 - symulacja wolniejszej kamery
const XTALK = process.env.XTALK != null ? Number(process.env.XTALK) : 0.6;
const W = 576, H = 1024;
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file]).stdout.toString().trim();
const [a, b] = probe.split(/\s|,/)[0].split('/').map(Number); const fps = FPS_OUT || a / (b || 1);
const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', (FPS_OUT ? `fps=${FPS_OUT},` : '') + `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2e9 }).stdout;
const frames = raw.length / (W * H * 4);
// ROI (piksele w kadrze 576x1024) - ciasne, wyznaczone na podglądzie: kWh lewa, kvarh środkowa dioda
const ROI = [{ cx: 190, cy: 305 }, { cx: 257, cy: 305 }], RW = 18, RH = 12;
function crop(f, r) {
  const out = new Uint8ClampedArray(RW * RH * 4);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    const si = (f * W * H + (r.cy - RH / 2 + y) * W + (r.cx - RW / 2 + x)) * 4, di = (y * RW + x) * 4;
    out[di] = raw[si]; out[di + 1] = raw[si + 1]; out[di + 2] = raw[si + 2]; out[di + 3] = 255;
  }
  return out;
}
const det = new D.MeterDetector({ xtalk: XTALK, warmupMs: 200 });
const calc = new D.PowerCalc([1000, 1000], 5);
const names = ['kWh', 'kvarh'], sig = [[], []];
for (let f = 0; f < frames; f++) {
  const t = f * 1000 / fps;
  const v = ROI.map(r => D.roiStats(crop(f, r), RW, RH, 'luma').mean);
  v.forEach((x, i) => sig[i].push(Math.round(x)));
  for (const p of det.process(t, v)) {
    const rec = calc.add(p.ch, p.t);
    console.log(`impuls ${names[p.ch]} t=${(p.t / 1000).toFixed(3)} s, błysk ok. ${Math.round(p.dur)} ms, skok ${Math.round(p.peak)}` +
      (rec.T ? `, T=${rec.T.toFixed(3)} s -> ${rec.val.toFixed(2)} ${p.ch ? 'kvar' : 'kW'}` : ''));
  }
}
console.log(`klatek ${frames}, ${fps} fps, czas ${(frames / fps).toFixed(2)} s`);
console.log('sygnał kWh  :', sig[0].join(' '));
console.log('sygnał kvarh:', sig[1].join(' '));
const n = calc.pulses.map(x => x.length);
console.log(`WYNIK: impulsy kWh=${n[0]}, kvarh=${n[1]}`);
module.exports = { n };
