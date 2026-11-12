// Generuje SZTUCZNE pliki przykładowe (bez danych osobowych): przyklad/tauron-przyklad.csv i przyklad/aplikacja-przyklad.csv
const fs = require('fs'), path = require('path'), C = require('../compare.js');
const H = 3600000, day = [2026, 11, 10];
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
// profil dobowy [kW średnio w godzinie]
const prof = [0.28,0.25,0.24,0.24,0.25,0.31,0.62,0.85,0.55,0.42,0.40,0.45,0.70,0.52,0.44,0.48,0.66,0.95,1.32,1.18,1.05,0.88,0.61,0.38];
const zone = h => (h >= 13 && h < 15) || h >= 22 || h < 6 ? 'T2' : 'T1';
let T = ['Data; Strefa; Wartość ;Rodzaj;Status;'];
const fmt = x => x.toFixed(3).replace('.', ',');
for (let h = 0; h < 24; h++) T.push(`${day[0]}-${day[1]}-${day[2]} ${h + 1}:00;${zone(h)};${fmt(prof[h])};pobór [kWh];Rzeczywista;`);
for (let h = 0; h < 24; h++) T.push(`${day[0]}-${day[1]}-${day[2]} ${h + 1}:00;${zone(h)};${fmt(0)};oddanie [kWh];Rzeczywista;`);
fs.writeFileSync(path.join(__dirname, '../przyklad/tauron-przyklad.csv'), '\ufeff' + T.join('\r\n') + '\r\n');

// aplikacja: pomiar 17:20-21:40 czasu lokalnego, licznik 1000 imp/kWh, aplikacja liczy ~1,5% mniej (np. zgubione impulsy)
const t0 = C.localToUtc(...day, 17, 20, 0), t1 = C.localToUtc(...day, 21, 40, 0), k = 1000;
const p2 = n => String(n).padStart(2, '0');
const stamp = t => { const p = C.utcToLocalParts(t), ms = String(t % 1000).padStart(3, '0'); return `${p.y}-${p2(p.mo)}-${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}.${ms}`; };
const c = (x, d) => x.toFixed(d).replace('.', ',');
let A = ['czas;czas_od_startu_s;typ;T_s;wartosc;jednostka;srednia_N;stala_imp;czas_utc'];
const row = (t, typ, T_, v, u, avg, st) => A.push([stamp(t), c((t - t0) / 1000, 3), typ, T_, v, u, avg, st, new Date(t).toISOString()].join(';'));
row(t0, 'start', '', '', '', '', '');
let t = t0 + 2000, last = null, acc = 0;
while (t < t1) {
  const h = C.utcToLocalParts(t).h, P = prof[h] * (1 + 0.15 * Math.sin(t / 400000)) * 0.985; // kW
  const T_ = 3.6 / P; // s na impuls (1 Wh)
  t += Math.round(T_ * 1000 * (0.97 + 0.06 * rnd()));
  if (t >= t1) break;
  if (last != null) row(t, 'kWh', c((t - last) / 1000, 3), c(3600 / (k * (t - last) / 1000), 4), 'kW', '', k); else row(t, 'kWh', '', '', 'kW', '', k);
  last = t;
  if (rnd() < 0.25) { const tq = t + 300; row(tq, 'kvarh', '', '', 'kvar', '', k); }
}
row(t1, 'koniec', '', '', '', '', '');
A.push(''); A.push('Wygenerował: 2026-11-10 21:40');
fs.writeFileSync(path.join(__dirname, '../przyklad/aplikacja-przyklad.csv'), '\ufeff' + A.join('\r\n') + '\r\n');
console.log('tauron', T.length, 'aplikacja', A.length);
