/* Licznik impulsów - aplikacja (UI, kamera, próbkowanie ROI). Logika detekcji: detector.js */
(function () {
  'use strict';
  var D = window.LicznikDet;
  var $ = function (id) { return document.getElementById(id); };
  var video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
  var NAMES = ['kWh', 'kvarh'], UNITS = ['kW', 'kvar'], COLORS = ['#ff5a4f', '#ffb020'];
  var LS = 'licznik-impulsy-v1';
  var cfg = load();
  var stream = null, track = null, sim = null, srcMode = null, running = false, wakeLock = null;
  var active = 0;
  var det = new D.MeterDetector({ xtalk: cfg.xtalk, minIntervalMs: cfg.minInt });
  var calc = new D.PowerCalc([cfg.cK, cfg.cQ], cfg.nAvg);
  var records = [], startWall = null, startPerf = null;
  var samples = [[], []], marks = [[], []];
  var peakCentroid = [null, null], peakEx = [0, 0];
  var frames = 0, fpsT = performance.now(), fps = 0, lastFrameT = 0;
  var sc = document.createElement('canvas'); sc.width = 240; sc.height = 300;
  var sctx = sc.getContext('2d', { willReadFrequently: true });
  var SAMPLE_SPAN = 6000;

  function load() {
    var d = { cK: 1000, cQ: 1000, nAvg: 5, minInt: 60, maxPulse: 300, xtalk: 0.6, mode: 'led', sens: [0.5, 0.5], track: false, focusLock: false, ver: 2,
              rois: { cam: null, sim: null }, cam: {} };
    try { var s = JSON.parse(localStorage.getItem(LS) || '{}'); for (var k in s) d[k] = s[k]; } catch (e) {}
    if (!(d.ver >= 2)) { d.mode = 'led'; d.ver = 2; } // migracja: nowy domyślny sygnał "czerwona dioda"
    if (d.mode === 'red') d.mode = 'led';
    return d;
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) {} }
  function fmt(x, d) { return (x != null && isFinite(x)) ? x.toFixed(d).replace('.', ',') : '-'; }
  function fmtP(x) { return !isFinite(x) ? '-' : fmt(x, x < 10 ? 3 : x < 100 ? 2 : 1); }
  function fmtS(s) { if (!isFinite(s)) return '-'; return s < 60 ? fmt(s, 1) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s'; }
  function status(t, err) { var e = $('status'); e.textContent = t; e.classList.toggle('err', !!err); }

  /* ---------- ROI ---------- */
  function vAspect() { return (video.videoWidth || 4) / (video.videoHeight || 3); }
  function defaultRois() {
    var a = vAspect(), w = 0.045;
    return [{ x: 0.42, y: 0.5, w: w, h: w * a }, { x: 0.58, y: 0.5, w: w, h: w * a }];
  }
  function rois() {
    var r = cfg.rois[srcMode || 'cam'];
    if (!r) { r = srcMode === 'sim' && sim ? sim.rois() : defaultRois(); cfg.rois[srcMode || 'cam'] = r; }
    return r;
  }
  function clampRoi(r) {
    r.w = Math.min(0.3, Math.max(0.008, r.w)); r.h = Math.min(0.3, Math.max(0.008, r.h));
    r.x = Math.min(1 - r.w, Math.max(r.w, r.x)); r.y = Math.min(1 - r.h, Math.max(r.h, r.y));
    return r;
  }
  function parseRoiParams() {
    var q = new URLSearchParams(location.search);
    [0, 1].forEach(function (i) {
      var s = q.get('roi' + i); if (!s) return;
      var a = s.split(',').map(Number); if (a.length === 4 && a.every(isFinite)) rois()[i] = clampRoi({ x: a[0], y: a[1], w: a[2], h: a[3] });
    });
  }

  /* ---------- próbkowanie klatki ---------- */
  function sampleFrame(t) {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    var R = rois(), vals = [0, 0], rings = [0, 0], wins = [];
    for (var i = 0; i < 2; i++) {
      var r = R[i];
      var sx = (r.x - r.w) * vw, sy = (r.y - r.h) * vh, sw = 2 * r.w * vw, sh = 2 * r.h * vh; // okno 2x ROI
      var SW = Math.max(8, Math.min(60, Math.round(sw))), SH = Math.max(8, Math.min(80, Math.round(SW * sh / sw)));
      sctx.drawImage(video, sx, sy, sw, sh, i * 60, 0, SW, SH);
      var img = sctx.getImageData(i * 60, 0, SW, SH);
      var inner = { x0: Math.round(SW / 4), x1: Math.round(SW * 3 / 4), y0: Math.round(SH / 4), y1: Math.round(SH * 3 / 4) };
      var st = D.roiStats(img.data, SW, SH, cfg.mode, inner);
      vals[i] = st.mean; rings[i] = st.ring;
      wins.push({ data: img.data, w: SW, h: SH });
    }
    // globalne tło całego kadru (mała kopia) - zmiana oświetlenia nie może dać impulsu
    var GW = 48, GH = Math.max(8, Math.min(96, Math.round(GW * vh / vw)));
    sctx.drawImage(video, 0, 0, vw, vh, 120, 0, GW, GH);
    var glob = D.frameMean(sctx.getImageData(120, 0, GW, GH).data, GW, GH, cfg.mode);
    var pulses = det.process(t, vals, { ring: rings, global: glob });
    if (finding) findFrame(t, vw, vh);
    for (i = 0; i < 2; i++) {
      var ch = det.ch[i], th = ch.thresholds();
      samples[i].push({ t: t, v: vals[i], b: ch.base, on: th.on, off: th.off, hi: ch.high });
      while (samples[i].length && samples[i][0].t < t - SAMPLE_SPAN) samples[i].shift();
      if (ch.high) {
        var ex = vals[i] - ch.base;
        if (cfg.track && ex >= peakEx[i]) { peakEx[i] = ex; peakCentroid[i] = D.brightCentroid(wins[i].data, wins[i].w, wins[i].h, cfg.mode); }
      } else peakEx[i] = 0;
    }
    pulses.forEach(function (p) { onPulse(p); });
    frames++;
  }

  /* ---------- Znajdź diody ---------- */
  var finding = null, lastFind = null, FIND_MS = 10000;
  var fc = document.createElement('canvas'), fctx = fc.getContext('2d', { willReadFrequently: true });
  function startFind() {
    if (!running) { status('Najpierw uruchom kamerę albo symulację.', true); return; }
    var vw = video.videoWidth, vh = video.videoHeight;
    var AW = vw >= vh ? 192 : 160, AH = Math.round(AW * vh / vw);
    fc.width = AW; fc.height = AH;
    finding = { t0: null, maps: [], times: [], AW: AW, AH: AH };
    lastFind = null; $('findList').innerHTML = '';
    $('btnFind').disabled = true;
    status('Szukam migających czerwonych diod - trzymaj telefon nieruchomo (' + FIND_MS / 1000 + ' s)...');
  }
  function findFrame(t, vw, vh) {
    var F = finding;
    if (F.t0 == null) F.t0 = t;
    // maks. ok. 30 klatek/s i mapy 8-bitowe: 10 s analizy = ok. 6 MB pamięci
    if (!F.times.length || t - F.times[F.times.length - 1] >= 30) {
      fctx.drawImage(video, 0, 0, vw, vh, 0, 0, F.AW, F.AH);
      F.maps.push(Uint8ClampedArray.from(D.scoreMap(fctx.getImageData(0, 0, F.AW, F.AH).data, F.AW, F.AH, 'led', 3)));
      F.times.push(t);
    }
    var left = FIND_MS - (t - F.t0);
    $('btnFind').textContent = left > 0 ? 'Analiza... ' + Math.ceil(left / 1000) + ' s' : 'Analiza...';
    if (left <= 0) { finding = null; setTimeout(function () { finishFind(F); }, 0); }
  }
  function finishFind(F) {
    var res = D.findLeds(F.maps, F.times, F.AW, F.AH);
    $('btnFind').disabled = false; $('btnFind').textContent = 'Znajdź diody';
    lastFind = { res: res, t: performance.now() };
    var R = rois(), set = 0;
    res.roi.forEach(function (r, i) { if (r) { R[i] = clampRoi(r); det.ch[i].reset(); set++; } });
    if (set) save();
    var acc = res.cands.filter(function (c) { return c.ok; }), rej = res.cands.filter(function (c) { return !c.ok && showCand(c); });
    var other = res.cands.length - acc.length - rej.length;
    var li = function (c) {
      var p = isFinite(c.period) ? ', okres ' + fmt(c.period, 2) + ' s' : '';
      return '<li><b>' + (c.role || 'odrzucona') + '</b> - ' + (c.ok ? 'błyski: ' + c.events + p + (isFinite(c.dur) ? ', błysk ok. ' + Math.round(c.dur) + ' ms' : '') : c.reason) + '</li>';
    };
    $('findList').innerHTML = (acc.length ? '<p>Znalezione:</p><ul>' + acc.map(li).join('') + '</ul>' : '') +
      (rej.length ? '<p>Odrzucone (' + rej.length + '):</p><ul>' + rej.slice(0, 6).map(li).join('') + '</ul>' : '') +
      (other > 0 ? '<p>Pominięte: ' + other + ' (poświata sąsiedniej diody / brak błysków)</p>' : '');
    status(set ? 'Ustawiono obszary automatycznie: ' + acc.map(function (c) { return c.role; }).join(', ') + '. ' + (res.msg || 'Sprawdź na podglądzie, w razie potrzeby popraw ręcznie.') : (res.msg || 'Nie znaleziono diod.'), !set);
  }
  function shortReason(r) {
    var m = [[/moduł/, 'szybkie miganie'], [/duża plama/, 'odblask'], [/wydłużony/, 'krawędź'], [/poza rzędem/, 'poza rzędem'], [/stale/, 'świeci stale'],
             [/pojedynczy/, 'refleks?'], [/trzecia/, 'Alarm?'], [/poza zakresem/, 'zły czas błysku']];
    for (var i = 0; i < m.length; i++) if (m[i][0].test(r)) return m[i][1];
    return 'odrzucona';
  }
  function showCand(c) { return c.ok || !/poświata|brak błysków/.test(c.reason); }
  window.__find = function () { return lastFind && lastFind.res; };

  function onPulse(p) {
    if (startPerf == null) { startPerf = p.t; startWall = Date.now() - (performance.now() - p.t); }
    var rec = calc.add(p.ch, p.t);
    rec.wall = startWall + (p.t - startPerf); rec.rel = (p.t - startPerf) / 1000; rec.dur = p.dur;
    records.push(rec);
    if (records.length === 1) $('savedSes').hidden = true;
    marks[p.ch].push(p.t);
    if (cfg.track && peakCentroid[p.ch]) {
      var r = rois()[p.ch], c = peakCentroid[p.ch];
      r.x += (c.x - 0.5) * 2 * r.w * 0.5; r.y += (c.y - 0.5) * 2 * r.h * 0.5; clampRoi(r);
      peakCentroid[p.ch] = null;
    }
  }

  /* ---------- pętla klatek ---------- */
  var hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  var loopGen = 0;
  function onVideoFrame(now, meta) {
    if (!running || this !== loopGen) return;
    var t = (meta && (meta.captureTime || meta.expectedDisplayTime)) || now;
    if (t <= lastFrameT) t = lastFrameT + 0.01;
    lastFrameT = t;
    try { sampleFrame(t); } catch (e) { console.error(e); }
    video.requestVideoFrameCallback(onVideoFrame.bind(loopGen));
  }
  function onRaf(now) {
    if (!running || this !== loopGen) return;
    if (video.readyState >= 2) { try { sampleFrame(now); } catch (e) { console.error(e); } }
    requestAnimationFrame(onRaf.bind(loopGen));
  }

  /* ---------- start / stop ---------- */
  async function startCam() {
    stop();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status('Ta przeglądarka nie daje dostępu do aparatu (wymagane HTTPS).', true); return; }
    status('Uruchamiam aparat...');
    var c1 = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } } };
    try { stream = await navigator.mediaDevices.getUserMedia(c1); }
    catch (e) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } }); }
      catch (e2) { status('Brak dostępu do aparatu: ' + (e2.message || e2.name), true); return; }
    }
    track = stream.getVideoTracks()[0];
    srcMode = 'cam';
    await attach(stream);
    buildCamControls();
    var s = track.getSettings ? track.getSettings() : {};
    status('Aparat: ' + (s.width || video.videoWidth) + 'x' + (s.height || video.videoHeight) + (s.frameRate ? ', ' + Math.round(s.frameRate) + ' fps (deklarowane)' : '') + '. Ustaw obszary na diodach.');
  }
  function startSim() {
    stop();
    srcMode = 'sim';
    sim = new window.LicznikSim(function () { return [cfg.cK, cfg.cQ]; });
    ['P', 'Q', 'Dur'].forEach(function (k) { simInput(k); });
    sim.set('shake', $('simShake').checked); sim.set('glare', $('simGlare').checked);
    stream = sim.stream; track = null;
    $('simPanel').hidden = false; $('camCtl').innerHTML = ''; $('focusCtl').innerHTML = '<p class="hint">Symulacja - ostrość nie dotyczy.</p>';
    attach(stream).then(function () { status('Symulacja: wirtualny licznik, te same obliczenia co z kamery.'); });
  }
  async function attach(s) {
    video.srcObject = s;
    try { await video.play(); } catch (e) {}
    await new Promise(function (res) { if (video.videoWidth) res(); else video.onloadedmetadata = function () { res(); }; setTimeout(res, 3000); });
    $('cam').style.setProperty('--ar', vAspect().toFixed(4));
    $('camHint').style.display = 'none';
    parseRoiParams();
    resetMeasure();
    running = true; lastFrameT = 0;
    $('btnStop').disabled = false;
    loopGen++;
    if (hasRVFC) video.requestVideoFrameCallback(onVideoFrame.bind(loopGen)); else requestAnimationFrame(onRaf.bind(loopGen));
    requestWake();
  }
  function stop() {
    if (running && session && !session.end) session.end = Date.now();
    running = false; loopGen++; finding = null; clearInterval(focusTimer);
    if ($('btnFind')) { $('btnFind').disabled = false; $('btnFind').textContent = 'Znajdź diody'; }
    if (sim) { sim.stop(); sim = null; }
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; track = null;
    video.srcObject = null;
    $('btnStop').disabled = true; $('simPanel').hidden = true;
    $('camHint').style.display = '';
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  async function requestWake() {
    try { if ('wakeLock' in navigator && running) { wakeLock = await navigator.wakeLock.request('screen'); } } catch (e) {}
  }
  video.addEventListener('resize', function () { if (video.videoWidth) $('cam').style.setProperty('--ar', vAspect().toFixed(4)); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && running) requestWake(); });

  function resetMeasure() {
    det.reset(); calc.reset(); records = []; samples = [[], []]; marks = [[], []]; startPerf = null; startWall = null;
    session = { start: Date.now(), end: null }; exportedN = 0; savedN = 0;
  }
  var session = { start: Date.now(), end: null }; // granice pomiaru do eksportu (porównanie z eLicznikiem)

  /* ---------- sterowanie aparatem ---------- */
  function buildCamControls() {
    var box = $('camCtl'); box.innerHTML = '';
    if (!track || !track.getCapabilities) return;
    var caps = track.getCapabilities(), set = track.getSettings();
    function apply(c) { track.applyConstraints({ advanced: [c] }).catch(function (e) { status('Aparat odrzucił ustawienie: ' + e.message, true); }); }
    function range(key, label, unit, fmtD) {
      var c = caps[key]; if (!c || c.max == null || c.max === c.min) return;
      var val = cfg.cam[key] != null ? cfg.cam[key] : set[key];
      var l = document.createElement('label');
      l.innerHTML = label + ' <input type="range" min="' + c.min + '" max="' + c.max + '" step="' + (c.step || (c.max - c.min) / 100) + '" value="' + val + '"><span class="mono"></span>';
      var inp = l.querySelector('input'), sp = l.querySelector('span');
      var show = function () { sp.textContent = fmt(Number(inp.value), fmtD) + unit; };
      inp.addEventListener('input', function () {
        var o = {}; o[key] = Number(inp.value);
        if (key === 'exposureTime') o.exposureMode = 'manual';
        apply(o); cfg.cam[key] = Number(inp.value); save(); show();
      });
      show(); box.appendChild(l);
      if (cfg.cam[key] != null) { var o = {}; o[key] = cfg.cam[key]; if (key === 'exposureTime') o.exposureMode = 'manual'; apply(o); }
    }
    range('zoom', 'Zoom', 'x', 1);
    range('exposureCompensation', 'Kompensacja ekspozycji', ' EV', 1);
    if (caps.exposureMode && caps.exposureMode.indexOf('manual') >= 0) range('exposureTime', 'Czas naświetlania', '', 0);
    if (caps.torch) {
      var l = document.createElement('label'); l.className = 'chk';
      l.innerHTML = '<input type="checkbox"> Latarka (zwykle daje odblaski)';
      l.querySelector('input').addEventListener('change', function (e) { apply({ torch: e.target.checked }); });
      box.appendChild(l);
    }
    if (caps.exposureMode && caps.exposureMode.indexOf('continuous') >= 0 && cfg.cam.exposureTime != null) {
      var b = document.createElement('button'); b.textContent = 'Ekspozycja automatyczna';
      b.onclick = function () { delete cfg.cam.exposureTime; save(); apply({ exposureMode: 'continuous' }); };
      box.appendChild(b);
    }
    if (!box.children.length) box.innerHTML = '<p class="hint">Aparat nie udostępnia zoomu ani ekspozycji w tej przeglądarce.</p>';
    buildFocus(caps);
  }

  /* ---------- ostrość ---------- */
  var focusTimer = null, focusArm = false, focusMark = null;
  function buildFocus(caps) {
    var box = $('focusCtl'); box.innerHTML = '';
    clearInterval(focusTimer);
    var fm = (caps && caps.focusMode) || [];
    var sup = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
    var poi = !!sup.pointsOfInterest;
    if (!fm.length) {
      box.innerHTML = '<p class="hint">Ostrość: przeglądarka nie udostępnia sterowania (brak focusMode) - aparat ustawia ją sam. Dotknij ekranu w aplikacji aparatu albo zmień odległość, jeśli obraz jest nieostry.</p>';
      return;
    }
    var has = function (m) { return fm.indexOf(m) >= 0; };
    box.innerHTML = '<div class="focushead">Ostrość <span id="focusStat" class="mono">-</span></div>' +
      '<div class="bar fbar"><button id="fCont">Auto (ciągła)</button><button id="fTap">Dotknij, by ustawić</button><button id="fLock">Zablokuj</button></div>' +
      '<label class="chk"><input type="checkbox" id="fAuto"> Blokuj ostrość automatycznie po złapaniu (bez "pompowania")</label>' +
      '<p class="hint" id="fInfo"></p>';
    var info = [];
    if (!has('continuous')) info.push('brak trybu ciągłego');
    if (!poi) info.push('brak wyboru punktu ostrości (pointsOfInterest) - dotknięcie wyzwala tylko ponowne ostrzenie');
    if (!(has('manual') && caps.focusDistance) && !has('single-shot')) info.push('blokada ostrości niedostępna');
    $('fInfo').textContent = info.length ? 'Ograniczenia: ' + info.join('; ') + '.' : 'Tryby: ' + fm.join(', ') + (poi ? ', punkt ostrości: tak' : '') + '.';
    $('fCont').disabled = !has('continuous');
    $('fLock').disabled = !(has('manual') && caps.focusDistance) && !has('single-shot');
    $('fCont').onclick = function () { focusApply({ focusMode: 'continuous' }, 'ciągła'); cfg.focusLock = false; save(); };
    $('fLock').onclick = function () { lockFocus(caps); };
    $('fTap').onclick = function () { focusArm = true; status('Dotknij na podglądzie miejsca, które ma być ostre (szczelina z diodami).'); };
    $('fAuto').checked = !!cfg.focusLock;
    $('fAuto').onchange = function (e) { cfg.focusLock = e.target.checked; save(); if (cfg.focusLock) setTimeout(function () { lockFocus(caps); }, 2500); };
    box.dataset.caps = '1';
    if (has('continuous')) focusApply({ focusMode: 'continuous' }, 'ciągła');
    if (cfg.focusLock) setTimeout(function () { lockFocus(caps); }, 3000);
    focusTimer = setInterval(showFocus, 800); showFocus();
    buildFocus.caps = caps; buildFocus.poi = poi;
  }
  function focusApply(c, label) {
    if (!track) return Promise.resolve();
    return track.applyConstraints({ advanced: [c] }).then(function () { showFocus(label); })
      .catch(function (e) { status('Aparat odrzucił ustawienie ostrości: ' + e.message, true); });
  }
  function lockFocus(caps) {
    if (!track) return;
    var st = track.getSettings(), fm = caps.focusMode || [];
    if (fm.indexOf('manual') >= 0 && caps.focusDistance && st.focusDistance != null) focusApply({ focusMode: 'manual', focusDistance: st.focusDistance }, 'zablokowana');
    else if (fm.indexOf('single-shot') >= 0) focusApply({ focusMode: 'single-shot' }, 'zablokowana (single-shot)');
  }
  function focusTap(p) {
    var caps = buildFocus.caps || {}, fm = caps.focusMode || [];
    var c = { focusMode: fm.indexOf('single-shot') >= 0 ? 'single-shot' : 'continuous' };
    if (buildFocus.poi) c.pointsOfInterest = [{ x: p.x, y: p.y }];
    focusMark = { x: p.x, y: p.y, t: performance.now() };
    focusApply(c, 'ostrzenie w punkcie').then(function () {
      status('Ustawiono ostrość w punkcie.' + (cfg.focusLock ? ' Za chwilę blokada.' : ''));
      if (cfg.focusLock) setTimeout(function () { lockFocus(caps); }, 2000);
    });
  }
  function showFocus() {
    var e = $('focusStat'); if (!e || !track) return;
    var st = track.getSettings ? track.getSettings() : {};
    var m = st.focusMode, names = { continuous: 'ciągła (auto)', 'single-shot': 'jednorazowa / zablokowana', manual: 'zablokowana (ręczna)', none: 'brak' };
    e.textContent = (names[m] || m || '?') + (st.focusDistance != null ? ' · odl. ' + fmt(st.focusDistance, 2) + ' m' : '');
  }

  /* ---------- dotyk na podglądzie ---------- */
  var drag = null;
  function pos(e) { var r = overlay.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; }
  function hit(p) {
    var R = rois();
    for (var k = 0; k < 2; k++) { var i = (active + k) % 2, r = R[i]; if (Math.abs(p.x - r.x) <= r.w * 0.8 && Math.abs(p.y - r.y) <= r.h * 0.8) return i; }
    return -1;
  }
  overlay.addEventListener('pointerdown', function (e) {
    if (!running) return;
    overlay.setPointerCapture(e.pointerId);
    var p = pos(e);
    if (focusArm) { focusArm = false; focusTap(p); return; }
    var h = hit(p);
    if (h >= 0) { setActive(h); var r = rois()[h]; drag = { type: 'move', i: h, dx: p.x - r.x, dy: p.y - r.y }; }
    else drag = { type: 'new', i: active, p0: p, p1: p };
  });
  overlay.addEventListener('pointermove', function (e) {
    if (!drag) return; var p = pos(e);
    if (drag.type === 'move') { var r = rois()[drag.i]; r.x = p.x - drag.dx; r.y = p.y - drag.dy; clampRoi(r); }
    else drag.p1 = p;
  });
  function endDrag() {
    if (!drag) return;
    if (drag.type === 'new') {
      var r = rois()[drag.i], a = drag.p0, b = drag.p1;
      var w = Math.abs(b.x - a.x) / 2, h = Math.abs(b.y - a.y) / 2;
      if (w > 0.01 && h > 0.01) { r.x = (a.x + b.x) / 2; r.y = (a.y + b.y) / 2; r.w = w; r.h = h; }
      else { r.x = a.x; r.y = a.y; }
      clampRoi(r);
      det.ch[drag.i].reset();
      if (drag.i === 0) setActive(1);
    } else det.ch[drag.i].reset();
    drag = null; save(); if (lastFind) lastFind.t = -1e9;
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
  function setActive(i) {
    active = i;
    document.querySelectorAll('.roisel').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.ch) === i); });
  }
  document.querySelectorAll('.roisel').forEach(function (b) { b.addEventListener('click', function () { setActive(Number(b.dataset.ch)); }); });
  function resize(f) { var r = rois()[active]; r.w *= f; r.h *= f; clampRoi(r); det.ch[active].reset(); save(); }
  $('roiMinus').onclick = function () { resize(1 / 1.25); };
  $('roiPlus').onclick = function () { resize(1.25); };

  /* ---------- rysowanie ---------- */
  function fitCanvas(c) {
    var dpr = window.devicePixelRatio || 1, w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return dpr;
  }
  function drawOverlay() {
    var dpr = fitCanvas(overlay), W = overlay.width, H = overlay.height;
    octx.clearRect(0, 0, W, H);
    if (!running) return;
    var R = rois();
    for (var i = 0; i < 2; i++) {
      var r = R[i], x = (r.x - r.w / 2) * W, y = (r.y - r.h / 2) * H, w = r.w * W, h = r.h * H;
      octx.lineWidth = 2 * dpr;
      octx.setLineDash([4 * dpr, 4 * dpr]); octx.strokeStyle = 'rgba(255,255,255,0.35)';
      octx.strokeRect((r.x - r.w) * W, (r.y - r.h) * H, 2 * r.w * W, 2 * r.h * H);
      octx.setLineDash([]);
      octx.strokeStyle = COLORS[i]; octx.lineWidth = (i === active ? 3 : 2) * dpr;
      if (det.ch[i].high) { octx.fillStyle = 'rgba(255,255,255,0.35)'; octx.fillRect(x, y, w, h); }
      octx.strokeRect(x, y, w, h);
      octx.font = (12 * dpr) + 'px sans-serif'; octx.fillStyle = COLORS[i];
      octx.fillText(NAMES[i], x, y - 4 * dpr);
    }
    if (lastFind && performance.now() - lastFind.t < 20000) {
      lastFind.res.cands.filter(showCand).forEach(function (c) {
        var cx = c.x * W, cy = c.y * H, rr = Math.max(8 * dpr, c.r * W * 2.2);
        octx.lineWidth = 2 * dpr;
        if (c.ok) { octx.strokeStyle = '#3fb950'; octx.setLineDash([]); }
        else { octx.strokeStyle = 'rgba(200,200,200,0.85)'; octx.setLineDash([3 * dpr, 3 * dpr]); }
        octx.beginPath(); octx.arc(cx, cy, rr, 0, 7); octx.stroke(); octx.setLineDash([]);
        if (!c.ok) { octx.beginPath(); octx.moveTo(cx - rr * 0.6, cy - rr * 0.6); octx.lineTo(cx + rr * 0.6, cy + rr * 0.6); octx.moveTo(cx + rr * 0.6, cy - rr * 0.6); octx.lineTo(cx - rr * 0.6, cy + rr * 0.6); octx.stroke(); }
        octx.font = 'bold ' + (11 * dpr) + 'px sans-serif';
        var txt = c.ok ? c.role : '✕ ' + shortReason(c.reason);
        var tw = octx.measureText(txt).width;
        var tx = Math.min(W - tw - 2 * dpr, Math.max(2 * dpr, cx - tw / 2)), ty = c.ok ? cy + rr + 13 * dpr : cy - rr - 4 * dpr;
        octx.fillStyle = 'rgba(0,0,0,0.6)'; octx.fillRect(tx - 2 * dpr, ty - 11 * dpr, tw + 4 * dpr, 14 * dpr);
        octx.fillStyle = c.ok ? '#3fb950' : '#ddd'; octx.fillText(txt, tx, ty);
      });
    }
    if (focusMark && performance.now() - focusMark.t < 1500) {
      octx.strokeStyle = '#ffd33d'; octx.lineWidth = 2 * dpr; var fx = focusMark.x * W, fy = focusMark.y * H, fs = 22 * dpr;
      octx.strokeRect(fx - fs, fy - fs, 2 * fs, 2 * fs);
    }
    if (drag && drag.type === 'new') {
      octx.strokeStyle = COLORS[drag.i]; octx.setLineDash([6 * dpr, 4 * dpr]);
      octx.strokeRect(drag.p0.x * W, drag.p0.y * H, (drag.p1.x - drag.p0.x) * W, (drag.p1.y - drag.p0.y) * H);
      octx.setLineDash([]);
    }
  }
  function drawSig(i) {
    var c = $('sig' + i), dpr = fitCanvas(c), g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    var S = samples[i]; if (S.length < 2) return;
    var tEnd = S[S.length - 1].t, t0 = tEnd - SAMPLE_SPAN;
    var lo = 255, hi = 0;
    S.forEach(function (s) { lo = Math.min(lo, s.v, s.b); hi = Math.max(hi, s.v, s.on); });
    lo = Math.max(0, lo - 5); hi = Math.min(260, hi + 5); if (hi - lo < 20) hi = lo + 20;
    var X = function (t) { return (t - t0) / SAMPLE_SPAN * W; }, Y = function (v) { return H - (v - lo) / (hi - lo) * H; };
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1 * dpr;
    marks[i].forEach(function (t) { if (t > t0) { g.beginPath(); g.moveTo(X(t), 0); g.lineTo(X(t), H); g.stroke(); } });
    function line(key, dash, col) {
      g.setLineDash(dash); g.strokeStyle = col; g.beginPath();
      S.forEach(function (s, k) { var x = X(s.t), y = Y(s[key]); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
    }
    g.lineWidth = 1 * dpr;
    line('b', [], 'rgba(139,152,165,0.9)');
    line('on', [5 * dpr, 4 * dpr], 'rgba(230,237,243,0.7)');
    line('off', [1 * dpr, 3 * dpr], 'rgba(230,237,243,0.6)');
    g.setLineDash([]); g.lineWidth = 2 * dpr; line('v', [], COLORS[i]);
    var last = S[S.length - 1];
    $('lvl' + i).textContent = 'sygnał ' + Math.round(last.v) + ' / tło ' + Math.round(last.b) + ' / próg ' + Math.round(last.on);
    $('fl' + i).classList.toggle('on', last.hi);
    $('bfl' + i).classList.toggle('on', last.hi);
  }
  function drawChart() {
    var c = $('chart'), dpr = fitCanvas(c), g = c.getContext('2d'), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    var pts = records.filter(function (r) { return r.val != null; });
    var pad = 34 * dpr, padB = 18 * dpr;
    g.fillStyle = '#8b98a5'; g.font = (10 * dpr) + 'px sans-serif';
    if (!pts.length) { g.fillText('Brak danych - wykres pojawi się po 2 impulsach', pad, H / 2); $('chartSpan').textContent = ''; return; }
    var tMax = Math.max(pts[pts.length - 1].rel, 10), tMin = Math.max(0, tMax - 600);
    var vis = pts.filter(function (r) { return r.rel >= tMin; });
    var vMax = 0; vis.forEach(function (r) { vMax = Math.max(vMax, r.val); }); vMax = vMax * 1.15 || 1;
    var X = function (t) { return pad + (t - tMin) / (tMax - tMin) * (W - pad - 6 * dpr); }, Y = function (v) { return H - padB - v / vMax * (H - padB - 8 * dpr); };
    g.strokeStyle = '#30363d'; g.lineWidth = 1;
    for (var k = 0; k <= 4; k++) { var v = vMax * k / 4, y = Y(v); g.beginPath(); g.moveTo(pad, y); g.lineTo(W, y); g.stroke(); g.fillText(fmt(v, vMax < 4 ? 1 : 0), 2 * dpr, y + 3 * dpr); }
    g.fillText(fmt(tMin, 0) + ' s', pad, H - 4 * dpr); g.fillText(fmt(tMax, 0) + ' s', W - 40 * dpr, H - 4 * dpr);
    [0, 1].forEach(function (ch) {
      var p = vis.filter(function (r) { return r.ch === ch; }); if (!p.length) return;
      g.strokeStyle = COLORS[ch]; g.fillStyle = COLORS[ch]; g.lineWidth = 2 * dpr; g.beginPath();
      p.forEach(function (r, k) { var x = X(r.rel), y = Y(r.val); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
      p.forEach(function (r) { g.beginPath(); g.arc(X(r.rel), Y(r.val), 2.5 * dpr, 0, 7); g.fill(); });
    });
    $('chartSpan').textContent = 'ostatnie ' + Math.round(tMax - tMin) + ' s';
  }
  function updateCards() {
    var now = performance.now(), st = [calc.stats(0, now), calc.stats(1, now)], pre = ['p', 'q'], warns = [];
    for (var i = 0; i < 2; i++) {
      var s = st[i], P = pre[i];
      $(P + 'Inst').textContent = fmtP(s.inst);
      $(P + 'Inst').style.opacity = s.stale ? 0.45 : 1;
      $(P + 'Avg').textContent = fmtP(s.avg);
      $(P + 'Cnt').textContent = s.count;
      $(P + 'Since').textContent = fmtS(s.since);
      $(P + 'T').textContent = isFinite(s.lastT) ? fmt(s.lastT, 3) + ' s' : '-';
      $(P + 'E').textContent = fmt(s.energy, 3);
      var w = '';
      if (s.stale) w = 'Brak impulsu od ' + fmtS(s.since) + ' - ' + (i ? 'Q' : 'P') + ' ≤ ' + fmtP(s.maxPossible) + ' ' + UNITS[i] + ' (maks. możliwa)';
      else if (running && !s.count && samples[i].length && samples[i][samples[i].length - 1].t - samples[i][0].t > 4000) w = 'Brak impulsów - sprawdź obszar i czułość';
      $(P + 'Max').textContent = w;
      $('b' + P + 'Inst').textContent = fmtP(s.inst);
      $('b' + P + 'Inst').style.opacity = s.stale ? 0.45 : 1;
      $('b' + P + 'Avg').textContent = fmtP(s.avg);
      $('b' + P + 'T').textContent = isFinite(s.lastT) ? fmt(s.lastT, 2) + ' s' : '-';
      $('b' + P + 'Since').textContent = fmtS(s.since);
      $('b' + P + 'Cnt').textContent = s.count;
      warns.push(s.stale ? (i ? 'Q' : 'P') + ' ≤ ' + fmtP(s.maxPossible) : '');
    }
    $('bWarn').textContent = warns.filter(Boolean).length ? 'brak imp.: ' + warns.filter(Boolean).join(', ') : '';
    var Pv = isFinite(st[0].avg) ? st[0].avg : st[0].inst, Qv = isFinite(st[1].avg) ? st[1].avg : st[1].inst;
    var cphi = D.cosPhi(Pv, Qv);
    $('cos').textContent = fmt(cphi, 3);
    $('sApp').textContent = isFinite(cphi) ? fmtP(Math.sqrt(Pv * Pv + Qv * Qv)) : '-';
    $('tg').textContent = isFinite(cphi) && Pv > 0 ? fmt(Qv / Pv, 3) : '-';
    $('bCos').textContent = fmt(cphi, 3);
    $('bS').textContent = $('sApp').textContent;
    var dt = (now - fpsT) / 1000;
    if (dt >= 1) { fps = frames / dt; frames = 0; fpsT = now; }
    $('fps').textContent = running ? fmt(fps, 0) + ' fps' + (hasRVFC ? '' : ' (rAF)') + (fps && fps < 20 ? ' - za mało na krótkie błyski' : '') : '- fps';
  }
  var lastCards = 0;
  function uiLoop(now) {
    drawOverlay(); drawSig(0); drawSig(1);
    if (now - lastCards > 200) { updateCards(); drawChart(); lastCards = now; }
    requestAnimationFrame(uiLoop);
  }
  requestAnimationFrame(uiLoop);

  /* ---------- CSV ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp(d, ms) {
    var s = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    if (ms) s += '.' + String(d.getMilliseconds()).padStart(3, '0');
    return s;
  }
  function buildCsv() {
    var c = function (x, d) { return x == null || !isFinite(x) ? '' : x.toFixed(d).replace('.', ','); };
    // czas_utc (ISO) - jednoznaczny przy zmianie czasu; wiersze start/koniec - granice pomiaru
    var L = ['czas;czas_od_startu_s;typ;T_s;wartosc;jednostka;srednia_N;stala_imp;czas_utc'];
    var t0 = startWall != null ? startWall : session.start;
    var mark = function (typ, w) { L.push([stamp(new Date(w), true), c((w - t0) / 1000, 3), typ, '', '', '', '', '', new Date(w).toISOString()].join(';')); };
    mark('start', session.start);
    records.forEach(function (r) {
      L.push([stamp(new Date(r.wall), true), c(r.rel, 3), NAMES[r.ch], c(r.T, 3), c(r.val, 4), UNITS[r.ch], c(r.avg, 4), r.ch ? cfg.cQ : cfg.cK, new Date(r.wall).toISOString()].join(';'));
    });
    mark('koniec', session.end || Date.now());
    L.push(''); L.push('Wygenerował: ' + stamp(new Date(), false));
    var d = new Date(session.start);
    return { text: '\ufeff' + L.join('\r\n'), name: 'impulsy-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + '.csv' };
  }
  function download(text, name) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  function exportCsv() {
    if (!records.length) { status('Brak impulsów do eksportu.', true); return; }
    var f = buildCsv(); download(f.text, f.name);
    exportedN = records.length; saveSession(f);
    return f;
  }

  /* ---------- zabezpieczenie danych sesji (localStorage) - powrót ze strony porównania ich nie gubi ---------- */
  var SES = 'licznik-impulsy-sesja', exportedN = 0, savedN = 0, savedAt = 0;
  function saveSession(f) {
    if (!records.length) return false;
    f = f || buildCsv();
    var n0 = records.filter(function (r) { return r.ch === 0; }).length;
    try { localStorage.setItem(SES, JSON.stringify({ csv: f.text, name: f.name, n: records.length, nk: n0, start: session.start, end: session.end || Date.now(), saved: Date.now() })); savedN = records.length; savedAt = Date.now(); return true; }
    catch (e) { return false; }
  }
  function autoSave() { if (records.length && records.length !== savedN && Date.now() - savedAt > 5000) saveSession(); }
  setInterval(autoSave, 5000);
  window.addEventListener('pagehide', function () { if (records.length && records.length !== savedN) saveSession(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && records.length && records.length !== savedN) saveSession(); });
  window.addEventListener('beforeunload', function (e) {
    if (records.length > exportedN && !leaving) { saveSession(); e.preventDefault(); e.returnValue = ''; }
  });
  var leaving = false;
  function hm(t) { var d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function showSaved() {
    var raw = null; try { raw = JSON.parse(localStorage.getItem(SES) || 'null'); } catch (e) {}
    var box = $('savedSes');
    if (!raw || !raw.csv || records.length) { box.hidden = true; return; }
    var d = new Date(raw.start);
    $('savedTxt').textContent = 'Zapisany pomiar: ' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm(raw.start) + '-' + hm(raw.end) + ', ' + raw.nk + ' impulsów kWh.';
    box.hidden = false;
    $('savedDl').onclick = function () { download(raw.csv, raw.name || 'impulsy.csv'); };
    $('savedDel').onclick = function () { try { localStorage.removeItem(SES); } catch (e) {} box.hidden = true; };
  }
  $('lnkCmp').addEventListener('click', function (e) {
    if (!records.length) return; // bez danych - zwykły link
    e.preventDefault();
    if (running) stop();
    var f = records.length > exportedN ? exportCsv() : (saveSession(), null);
    status(f ? 'Zapisano eksport CSV (' + f.name + ') - wczytaj go na stronie porównania. Dane tej sesji są też dostępne tam od razu.' : 'Eksport był już zapisany - dane tej sesji są dostępne na stronie porównania.');
    var t = $('toast'); t.textContent = f ? 'Zapisano eksport CSV - wczytaj go na stronie porównania. Przechodzę...' : 'Przechodzę do porównania...'; t.hidden = false;
    leaving = true;
    var href = 'porownanie.html?sesja=1';
    setTimeout(function () { location.href = href; }, f ? 1500 : 300);
  });

  /* ---------- ustawienia ---------- */
  function bindNum(id, key, after) {
    var e = $(id); e.value = cfg[key];
    e.addEventListener('change', function () { var v = Number(e.value); if (isFinite(v) && v > 0) { cfg[key] = v; save(); after && after(); } else e.value = cfg[key]; });
  }
  function applyCfg() {
    calc.c = [cfg.cK, cfg.cQ]; calc.N = Math.round(cfg.nAvg);
    det.xtalk = cfg.xtalk;
    det.ch.forEach(function (ch, i) { ch.set({ minIntervalMs: cfg.minInt, maxPulseMs: cfg.maxPulse, sens: cfg.sens[i] }); });
    document.querySelectorAll('.nLbl').forEach(function (e) { e.textContent = Math.round(cfg.nAvg); });
  }
  bindNum('cK', 'cK', applyCfg); bindNum('cQ', 'cQ', applyCfg); bindNum('nAvg', 'nAvg', applyCfg); bindNum('minInt', 'minInt', applyCfg); bindNum('maxPulse', 'maxPulse', applyCfg);
  [0, 1].forEach(function (i) {
    var e = $('sens' + i); e.value = cfg.sens[i];
    var show = function () { $('sens' + i + 'v').textContent = fmt(cfg.sens[i], 2); };
    e.addEventListener('input', function () { cfg.sens[i] = Number(e.value); applyCfg(); save(); show(); }); show();
  });
  $('xtalk').value = cfg.xtalk;
  var showX = function () { $('xtalkv').textContent = fmt(cfg.xtalk, 2); };
  $('xtalk').addEventListener('input', function (e) { cfg.xtalk = Number(e.target.value); applyCfg(); save(); showX(); }); showX();
  $('mode').value = cfg.mode;
  $('mode').addEventListener('change', function (e) { cfg.mode = e.target.value; det.reset(); save(); });
  // przypięcie podglądu z wynikami (sticky); domyślnie włączone
  if (cfg.pin == null) cfg.pin = true;
  $('pin').checked = cfg.pin;
  var applyPin = function () { $('stick').classList.toggle('pinned', !!cfg.pin); document.documentElement.style.setProperty('--camh', cfg.pin ? '38vh' : '42vh'); };
  $('pin').addEventListener('change', function (e) { cfg.pin = e.target.checked; save(); applyPin(); }); applyPin();
  $('track').checked = !!cfg.track;
  $('track').addEventListener('change', function (e) { cfg.track = e.target.checked; save(); });
  applyCfg();

  function simInput(k) {
    var e = $('sim' + k), v = Number(e.value);
    $('sim' + k + 'v').textContent = k === 'Dur' ? v + ' ms' : fmt(v, 1) + (k === 'P' ? ' kW' : ' kvar');
    if (sim) sim.set(k === 'Dur' ? 'dur' : k, v);
  }
  ['P', 'Q', 'Dur'].forEach(function (k) { $('sim' + k).addEventListener('input', function () { simInput(k); }); });
  $('simShake').addEventListener('change', function (e) { if (sim) sim.set('shake', e.target.checked); });
  $('simGlare').addEventListener('change', function (e) { if (sim) sim.set('glare', e.target.checked); });

  $('btnFind').onclick = startFind;
  $('btnCam').onclick = startCam;
  $('btnSim').onclick = startSim;
  $('btnStop').onclick = function () { stop(); status('Zatrzymano. Wyniki zostają do eksportu.'); };
  $('btnCsv').onclick = exportCsv;
  $('btnReset').onclick = function () { resetMeasure(); status('Wyzerowano pomiar.'); };

  var q = new URLSearchParams(location.search);
  if (q.has('track')) { cfg.track = q.get('track') === '1'; $('track').checked = cfg.track; }
  if (q.get('sim')) {
    if (q.get('P')) $('simP').value = q.get('P');
    if (q.get('Q')) $('simQ').value = q.get('Q');
    if (q.get('dur')) $('simDur').value = q.get('dur');
    if (q.get('shake')) $('simShake').checked = true;
    if (q.get('glare')) $('simGlare').checked = true;
    startSim();
  } else if (q.get('cam')) startCam();

  if (q.get('find')) setTimeout(function wait() { if (running && video.videoWidth) startFind(); else setTimeout(wait, 200); }, Number(q.get('find')) || 800);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  // zwijane sekcje: domyślnie zwinięte, stan zapamiętany
  (function () {
    var KEY = 'licznik-impulsy-sekcje', st = {};
    try { st = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
    document.querySelectorAll('details.sec').forEach(function (d) {
      d.open = !!st[d.id];
      d.addEventListener('toggle', function () { st[d.id] = d.open; try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} });
    });
  })();
  showSaved();
  window.__licznik = { records: function () { return records; }, calc: calc, det: det, rois: rois, fps: function () { return fps; } };
})();
