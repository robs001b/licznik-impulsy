// Testy parsera eLicznika Tauron, eksportu aplikacji, zmiany czasu i porównania godzinowego.
const C = require('../compare.js'), fs = require('fs'), path = require('path');
let n = 0, bad = 0;
function ok(cond, name) { n++; if (!cond) { bad++; console.log('BŁĄD:', name); } else console.log('ok -', name); }
const near = (a, b, e) => Math.abs(a - b) <= e;
const iso = t => new Date(t).toISOString();

// 1. czas Warszawy i DST
ok(iso(C.localToUtc(2026, 1, 15, 12, 0)) === '2026-01-15T11:00:00.000Z', 'zima UTC+1');
ok(iso(C.localToUtc(2026, 7, 15, 12, 0)) === '2026-07-15T10:00:00.000Z', 'lato UTC+2');
ok(iso(C.localToUtc(2026, 3, 29, 3, 0)) === '2026-03-29T01:00:00.000Z', 'wiosna: 3:00 CEST');
ok(iso(C.localToUtc(2026, 10, 25, 2, 30)) === '2026-10-25T00:30:00.000Z', 'jesień: 2:30 pierwsze wystąpienie');
ok(iso(C.localToUtc(2026, 11, 11, 24, 0)) === '2026-11-11T23:00:00.000Z', '24:00 = północ następnego dnia');

// 2. podstawowy plik Tauron: BOM, CRLF, spacje, ';' na końcu, przecinek, 24:00, inne rodzaje
const tau = '\ufeffData; Strefa; Wartość ;Rodzaj;Status;\r\n' +
  '2026-11-10 1:00; T2 ; 0,280 ;pobór [kWh];Rzeczywista;\r\n' +
  '2026-11-10 24:00;T2;1,234;pobór [kWh];Rzeczywista;\r\n' +
  '2026-11-10 1:00;T2;0,050;oddanie [kWh];Rzeczywista;\r\n\r\n';
const T = C.parseTauron(tau);
ok(T.rows.length === 3 && !T.errors.length, 'Tauron: 3 wiersze, bez błędów');
ok(T.kinds.join() === 'pobór,oddanie', 'Tauron: rodzaje pobór/oddanie');
const r1 = T.rows.find(r => r.kind === 'pobór' && r.kwh === 0.28);
ok(r1 && iso(r1.start) === '2026-11-09T23:00:00.000Z' && r1.zone === 'T2', 'Tauron: 1:00 = 0:00-1:00, strefa');
const r24 = T.rows.find(r => near(r.kwh, 1.234, 1e-9));
ok(r24 && iso(r24.start) === '2026-11-10T22:00:00.000Z', 'Tauron: 24:00 = 23:00-24:00');

// 3. Windows-1250 i tylko LF, bez ';' na końcu
const w1250 = Buffer.from('Data;Strefa;Warto\x9c\xe6;Rodzaj;Status\n2026-11-10 5:00;T1;0,5;pob\xf3r [kWh];Rzeczywista\n', 'latin1');
const T2 = C.parseTauron(C.decode(new Uint8Array(w1250)));
ok(T2.rows.length === 1 && T2.rows[0].kind === 'pobór' && T2.rows[0].kwh === 0.5, 'Tauron: Windows-1250');
const T3 = C.parseTauron('Data;Strefa;Wartość;Rodzaj;Status\n2026-11-10 5:00;T1;500;pobór [Wh];\n');
ok(T3.rows.length === 1 && near(T3.rows[0].kwh, 0.5, 1e-9), 'Tauron: jednostka Wh');
ok(C.parseTauron('a;b;c\n1;2;3').errors.length === 1, 'Tauron: zły plik -> komunikat');

// 4. dni zmiany czasu
let spring = 'Data;Strefa;Wartość;Rodzaj;Status;\n';
[1, 2, 4, 5].concat(Array.from({ length: 19 }, (_, i) => i + 6)).forEach(h => { spring += `2026-03-29 ${h}:00;T1;1,0;pobór [kWh];;\n`; });
const S = C.parseTauron(spring), sp = S.rows.map(r => r.start);
ok(S.rows.length === 23 && sp.every((t, i) => i === 0 || t - sp[i - 1] === C.HOUR), 'DST wiosna: 23 kolejne godziny bez dziury');
let autumn = 'Data;Strefa;Wartość;Rodzaj;Status;\n';
[1, 2, 3, 3].concat(Array.from({ length: 21 }, (_, i) => i + 4)).forEach((h, i) => { autumn += `2026-10-25 ${h}:00;T1;${i + 1};pobór [kWh];;\n`; });
const A = C.parseTauron(autumn), ap = A.rows.map(r => r.start);
ok(A.rows.length === 25 && ap.every((t, i) => i === 0 || t - ap[i - 1] === C.HOUR), 'DST jesień: 25 kolejnych godzin');
ok(iso(ap[0]) === '2026-10-24T22:00:00.000Z' && iso(ap[24]) === '2026-10-25T22:00:00.000Z', 'DST jesień: od północy CEST do 24:00 CET');

// 5. eksport aplikacji: nowy (czas_utc, start/koniec) i stary format
const appNew = '\ufeffczas;czas_od_startu_s;typ;T_s;wartosc;jednostka;srednia_N;stala_imp;czas_utc\r\n' +
  '2026-11-10 17:00:00.000;0,000;start;;;;;;2026-11-10T16:00:00.000Z\r\n' +
  '2026-11-10 17:00:01.500;1,500;kWh;;;kW;;1000;2026-11-10T16:00:01.500Z\r\n' +
  '2026-11-10 17:00:02.000;2,000;kvarh;;;kvar;;1000;2026-11-10T16:00:02.000Z\r\n' +
  '2026-11-10 18:00:00.000;3600;koniec;;;;;;2026-11-10T17:00:00.000Z\r\n\r\nWygenerował: 2026-11-10 18:00\r\n';
const P = C.parseApp(appNew);
ok(P.pulses.length === 2 && P.marks.length === 2 && P.pulses[0].ch === 0 && P.pulses[1].ch === 1, 'Aplikacja: impulsy kWh/kvarh i znaczniki');
const old = 'czas;czas_od_startu_s;typ;T_s;wartosc;jednostka;srednia_N;stala_imp\n2026-07-01 12:00:00.250;0;kWh;;;kW;;1000\n';
ok(iso(C.parseApp(old).pulses[0].t) === '2026-07-01T10:00:00.250Z', 'Aplikacja: stary format (czas lokalny, lato)');

// 6. agregacja: 1 kW stałe przez 2,5 h (17:00-19:30 UTC+1), impuls co 3,6 s, rozkład przez granice godzin
const t0 = C.localToUtc(2026, 11, 10, 17, 0, 0) + 1800, pulses = [];
for (let t = t0; t <= t0 + 2.5 * C.HOUR; t += 3600) pulses.push({ t, ch: 0, c: 1000 });
const H = C.aggregateHourly(pulses, 0), h17 = C.localToUtc(2026, 11, 10, 17, 0), h19 = C.localToUtc(2026, 11, 10, 19, 0);
ok(near(H[h17].kwh, 1.0, 0.003) && near(H[h17 + C.HOUR].kwh, 1.0, 0.002), 'Agregacja: pełne godziny = 1 kWh');
ok(near(H[h19].kwh, 0.5, 0.003) && near(H[h19].cov / C.HOUR, 0.5, 0.01), 'Agregacja: pół godziny = 0,5 kWh, pokrycie 50%');
const gap = C.aggregateHourly([{ t: 0, ch: 0, c: 1000 }, { t: 40 * 60000, ch: 0, c: 1000 }], 0);
ok(Object.keys(gap).length === 0, 'Agregacja: przerwa > 30 min nie liczona');

// 7. porównanie, godziny niepełne proporcjonalnie
const trows = [17, 18, 19].map(h => ({ start: C.localToUtc(2026, 11, 10, h, 0), kwh: h === 18 ? 1.05 : 1.0, kind: 'pobór', zone: 'T1' }));
trows.push({ start: h17, kwh: 9, kind: 'oddanie', zone: 'T1' });
const R = C.compare(trows, H, { kind: 'pobór' });
ok(R.rows.length === 3 && R.rows[0].full && R.rows[1].full && !R.rows[2].full, 'Porównanie: 2 pełne + 1 niepełna');
ok(near(R.rows[1].pct, (1 / 1.05 - 1) * 100, 0.3), 'Porównanie: różnica % godziny');
ok(near(R.rows[2].tauronRef, 0.5, 0.01) && near(R.rows[2].pct, 0, 1), 'Porównanie: niepełna proporcjonalnie');
ok(near(R.summary.tauronFull, 2.05, 1e-9) && near(R.summary.appFull, 2.0, 0.005), 'Podsumowanie pełnych godzin (bez innego rodzaju)');
const csv = C.toCsv(R, new Date(2026, 10, 11, 10, 0));
ok(csv.startsWith('\ufeffgodzina;') && /Wygenerował: 2026-11-11 10:00$/.test(csv) && !/Autor|Kołodziejczyk|—/.test(csv) && /0,500/.test(csv), 'CSV porównania: format, bez autora');

// 8. pliki przykładowe z repo
const ex = d => fs.readFileSync(path.join(__dirname, '../przyklad', d));
const ET = C.parseTauron(C.decode(ex('tauron-przyklad.csv'))), EA = C.parseApp(C.decode(ex('aplikacja-przyklad.csv')));
const ER = C.compare(ET.rows, C.aggregateHourly(EA.pulses, 0), { kind: 'pobór' });
ok(ER.rows.length === 5 && ER.summary.fullHours === 3 && Math.abs(ER.summary.pctFull) < 3, 'Przykład: 5 godzin, 3 pełne, różnica < 3%');

// 9. opcjonalnie prawdziwy plik lokalny (nie w repo): tests/fixtures/*.csv
const fx = path.join(__dirname, 'fixtures');
if (fs.existsSync(fx)) fs.readdirSync(fx).filter(f => /tauron.*\.csv$/i.test(f)).forEach(f => {
  const X = C.parseTauron(C.decode(fs.readFileSync(path.join(fx, f))));
  ok(X.rows.length > 0, 'Plik lokalny ' + f + ': ' + X.rows.length + ' wierszy, rodzaje ' + X.kinds.join('/'));
});

console.log(bad ? `COMPARE: ${bad}/${n} BŁĘDÓW` : `COMPARE: OK (${n} testów)`);
process.exit(bad ? 1 : 0);
