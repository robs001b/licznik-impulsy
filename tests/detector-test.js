// Testy logiki detekcji na sztucznych klatkach (sygnał jasności ROI). Uruchom: node tests/detector-test.js
const D = require('../detector.js');
let fail = 0;
function check(name, cond, info) { console.log((cond ? 'OK   ' : 'BŁĄD ') + name + (info ? ' - ' + info : '')); if (!cond) fail++; }
function rnd(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }

// Symulacja kamery: jasność ROI = tło + amplituda * ułamek czasu ekspozycji, w którym dioda świeciła.
function run({ fps = 30, dur = 100, P = 5, Q = 1.5, c = 1000, secs = 60, amp = 180, noise = 2, xt = 0.35, drift = 0, step = null, jitter = 0, seed = 1, xtalk = 0.6 }) {
  const R = rnd(seed), gauss = () => (R() + R() + R() - 1.5) * noise * 1.4;
  const per = [P > 0 ? 3600 / (c * P) * 1000 : Infinity, Q > 0 ? 3600 / (c * Q) * 1000 : Infinity];
  const off = [637, 911]; // pierwsze impulsy po 0,5 s nauki tła
  const lit = (ch, a, b) => { // ułamek przedziału [a,b] z zapaloną diodą
    if (!isFinite(per[ch])) return 0;
    let tot = 0; const k0 = Math.floor((a - off[ch]) / per[ch]) - 1;
    for (let k = Math.max(0, k0); k <= k0 + 3; k++) { const s = off[ch] + k * per[ch]; tot += Math.max(0, Math.min(b, s + dur) - Math.max(a, s)); }
    return tot / (b - a);
  };
  const det = new D.MeterDetector({ xtalk });
  const calc = new D.PowerCalc([c, c], 5);
  const fdt = 1000 / fps;
  for (let t = 0; t < secs * 1000; t += fdt) {
    const tj = t + (R() - 0.5) * jitter;
    const l0 = lit(0, tj - fdt, tj), l1 = lit(1, tj - fdt, tj);
    let bg = 60 + drift * Math.sin(t / 7000) + (step && t > step ? 50 : 0);
    const v0 = Math.min(255, bg + amp * l0 + xt * amp * l1 + gauss());
    const v1 = Math.min(255, bg + 10 + amp * l1 + xt * amp * l0 + gauss());
    for (const p of det.process(tj, [v0, v1])) calc.add(p.ch, p.t);
  }
  const exp = [0, 1].map(ch => isFinite(per[ch]) ? Math.floor((secs * 1000 - off[ch] - dur) / per[ch]) + 1 : 0);
  const avgAll = ch => { const a = calc.pulses[ch]; return a.length > 1 ? 3600 * (a.length - 1) / (c * (a[a.length - 1] - a[0]) / 1000) : NaN; };
  // największy błąd pojedynczego pomiaru
  const maxErr = ch => { const a = calc.pulses[ch], v = ch ? Q : P; let m = 0; for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(3600 / (c * (a[i] - a[i - 1]) / 1000) - v) / v); return m; };
  return { n: calc.pulses.map(a => a.length), exp, P: avgAll(0), Q: avgAll(1), e0: maxErr(0), e1: maxErr(1) };
}
const pct = x => (x * 100).toFixed(1) + '%';
let r;
r = run({});
check('30 fps, błysk 100 ms, P=5 kW, Q=1,5 kvar - liczba impulsów', r.n[0] === r.exp[0] && r.n[1] === r.exp[1], `kWh ${r.n[0]}/${r.exp[0]}, kvarh ${r.n[1]}/${r.exp[1]}`);
check('30 fps - średnia P i Q z dokładnością 0,5%', Math.abs(r.P / 5 - 1) < 0.005 && Math.abs(r.Q / 1.5 - 1) < 0.005, `P=${r.P.toFixed(3)} Q=${r.Q.toFixed(3)}, maks. błąd pojedynczego T: ${pct(r.e0)}`);
r = run({ fps: 60 });
check('60 fps - pojedynczy pomiar P < 2%', r.n[0] === r.exp[0] && r.e0 < 0.02, `maks. błąd ${pct(r.e0)}`);
r = run({ fps: 24, jitter: 6 });
check('24 fps + jitter klatek 6 ms', r.n[0] === r.exp[0] && r.n[1] === r.exp[1], `kWh ${r.n[0]}/${r.exp[0]}, maks. błąd ${pct(r.e0)}`);
r = run({ fps: 30, dur: 20 });
check('błysk 20 ms przy 30 fps (krótszy niż klatka)', r.n[0] === r.exp[0], `kWh ${r.n[0]}/${r.exp[0]}`);
r = run({ fps: 30, dur: 100, P: 20, secs: 30 });
check('P=20 kW (T=0,18 s)', r.n[0] === r.exp[0] && Math.abs(r.P / 20 - 1) < 0.01, `kWh ${r.n[0]}/${r.exp[0]}, P=${r.P.toFixed(2)}`);
r = run({ xt: 0.4, Q: 0 });
check('przesłuch 40% z kWh na kvarh - brak fałszywych kvarh', r.n[1] === 0, `kvarh ${r.n[1]}`);
r = run({ xt: 0.4, Q: 0, xtalk: 0 });
check('kontrola: bez tłumienia przesłuchu fałszywe kvarh się pojawiają', r.n[1] > 0, `kvarh ${r.n[1]}`);
r = run({ drift: 25, noise: 4 });
check('wolny dryf tła ±25 i szum σ≈4', r.n[0] === r.exp[0] && r.n[1] === r.exp[1], `kWh ${r.n[0]}/${r.exp[0]}, kvarh ${r.n[1]}/${r.exp[1]}`);
r = run({ step: 20000, P: 0.5, Q: 0 });
check('skok tła +50 (przesunięcie kadru) - bez fałszywego impulsu', r.n[0] <= r.exp[0] && r.n[0] >= r.exp[0] - 1 && r.n[1] === 0, `kWh ${r.n[0]}/${r.exp[0]}, kvarh ${r.n[1]}`);
r = run({ amp: 40, noise: 2 });
check('słaby błysk (skok 40) - nadal wykrywany', r.n[0] === r.exp[0], `kWh ${r.n[0]}/${r.exp[0]}`);
r = run({ secs: 900, fps: 30, noise: 3, drift: 15, seed: 7 });
check('15 minut ciągłej pracy (stabilność progów)', r.n[0] === r.exp[0] && r.n[1] === r.exp[1], `kWh ${r.n[0]}/${r.exp[0]}, kvarh ${r.n[1]}/${r.exp[1]}`);
// obliczenia
const pc = new D.PowerCalc([1000, 1000], 3);
[0, 720, 1440, 2160].forEach(t => pc.add(0, t));
const s = pc.stats(0, 2160 + 5000);
check('P = 3600/(1000*0,72) = 5 kW', Math.abs(s.inst - 5) < 1e-9 && Math.abs(s.avg - 5) < 1e-9);
check('moc maks. możliwa po 5 s bez impulsu = 0,72 kW', Math.abs(s.maxPossible - 0.72) < 1e-9 && s.stale);
check('energia 4 impulsy = 0,004 kWh', Math.abs(s.energy - 0.004) < 1e-12);
check('cos φ(4, 3) = 0,8', Math.abs(D.cosPhi(4, 3) - 0.8) < 1e-12);
console.log(fail ? `\n${fail} błędów` : '\nWszystkie testy OK');
process.exit(fail ? 1 : 0);
