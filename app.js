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
  var sc = document.createElement('canvas'); sc.width = 120; sc.height = 80;
  var sctx = sc.getContext('2d', { willReadFrequently: true });
  var SAMPLE_SPAN = 6000;

  function load() {
    var d = { cK: 1000, cQ: 1000, nAvg: 5, minInt: 60, maxPulse: 300, xtalk: 0.6, mode: 'luma', sens: [0.5, 0.5], track: false,
              rois: { cam: null, sim: null }, cam: {} };
    try { var s = JSON.parse(localStorage.getItem(LS) || '{}'); for (var k in s) d[k] = s[k]; } catch (e) {}
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
    var R = rois(), vals = [0, 0], wins = [];
    for (var i = 0; i < 2; i++) {
      var r = R[i];
      var sx = (r.x - r.w) * vw, sy = (r.y - r.h) * vh, sw = 2 * r.w * vw, sh = 2 * r.h * vh; // okno 2x ROI
      var SW = Math.max(8, Math.min(60, Math.round(sw))), SH = Math.max(8, Math.min(80, Math.round(SW * sh / sw)));
      sctx.drawImage(video, sx, sy, sw, sh, i * 60, 0, SW, SH);
      var img = sctx.getImageData(i * 60, 0, SW, SH);
      var inner = { x0: Math.round(SW / 4), x1: Math.round(SW * 3 / 4), y0: Math.round(SH / 4), y1: Math.round(SH * 3 / 4) };
      vals[i] = D.roiStats(img.data, SW, SH, cfg.mode, inner).mean;
      wins.push({ data: img.data, w: SW, h: SH });
    }
    var pulses = det.process(t, vals);
    for (i = 0; i < 2; i++) {
      var ch = det.ch[i], th = ch.thresholds();
      samples[i].push({ t: t, v: vals[i], b: ch.base, on: th.on, off: th.off, hi: ch.high });
      while (samples[i].length && samples[i][0].t < t - SAMPLE_SPAN) samples[i].shift();
      if (ch.high) {
        var ex = vals[i] - ch.base;
        if (cfg.track && ex >= peakEx[i]) { peakEx[i] = ex; peakCentroid[i] = D.brightCentroid(wins[i].data, wins[i].w, wins[i].h); }
      } else peakEx[i] = 0;
    }
    pulses.forEach(function (p) { onPulse(p); });
    frames++;
  }

  function onPulse(p) {
    if (startPerf == null) { startPerf = p.t; startWall = Date.now() - (performance.now() - p.t); }
    var rec = calc.add(p.ch, p.t);
    rec.wall = startWall + (p.t - startPerf); rec.rel = (p.t - startPerf) / 1000; rec.dur = p.dur;
    records.push(rec);
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
    sim.set('shake', $('simShake').checked);
    stream = sim.stream; track = null;
    $('simPanel').hidden = false; $('camCtl').innerHTML = '';
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
    running = false; loopGen++;
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
  }

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
    var p = pos(e), h = hit(p);
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
    drag = null; save();
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
    var now = performance.now(), st = [calc.stats(0, now), calc.stats(1, now)], pre = ['p', 'q'];
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
    }
    var Pv = isFinite(st[0].avg) ? st[0].avg : st[0].inst, Qv = isFinite(st[1].avg) ? st[1].avg : st[1].inst;
    var cphi = D.cosPhi(Pv, Qv);
    $('cos').textContent = fmt(cphi, 3);
    $('sApp').textContent = isFinite(cphi) ? fmtP(Math.sqrt(Pv * Pv + Qv * Qv)) : '-';
    $('tg').textContent = isFinite(cphi) && Pv > 0 ? fmt(Qv / Pv, 3) : '-';
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
  function exportCsv() {
    if (!records.length) { status('Brak impulsów do eksportu.', true); return; }
    var c = function (x, d) { return x == null || !isFinite(x) ? '' : x.toFixed(d).replace('.', ','); };
    var L = ['czas;czas_od_startu_s;typ;T_s;wartosc;jednostka;srednia_N;stala_imp'];
    records.forEach(function (r) {
      L.push([stamp(new Date(r.wall), true), c(r.rel, 3), NAMES[r.ch], c(r.T, 3), c(r.val, 4), UNITS[r.ch], c(r.avg, 4), r.ch ? cfg.cQ : cfg.cK].join(';'));
    });
    L.push(''); L.push('Wygenerował: ' + stamp(new Date(), false));
    var blob = new Blob(['\ufeff' + L.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'), d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = 'impulsy-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

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
    startSim();
  } else if (q.get('cam')) startCam();

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  window.__licznik = { records: function () { return records; }, calc: calc, det: det, rois: rois, fps: function () { return fps; } };
})();
