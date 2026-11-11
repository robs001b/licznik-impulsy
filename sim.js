/* Wirtualny licznik: canvas -> MediaStream, ten sam tor co kamera. */
(function () {
  'use strict';
  function Sim(getConsts) {
    var W = 640, H = 360;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    var st = { P: 5, Q: 1.5, dur: 100, shake: false, glare: false };
    var next = [0, 0], period = [0, 0], running = true, t0 = performance.now();
    var LED = [{ x: 0.36, y: 0.52 }, { x: 0.5, y: 0.52 }, { x: 0.64, y: 0.52 }];
    var MOD = { x: 0.9, y: 0.62 };
    function per(i) {
      var c = getConsts()[i], v = i ? st.Q : st.P;
      return v > 0.001 ? 3600 / (c * v) * 1000 : Infinity;
    }
    function resched(now) {
      for (var i = 0; i < 2; i++) {
        var p = per(i);
        if (p !== period[i]) {
          var last = next[i] - period[i];
          period[i] = p;
          next[i] = isFinite(p) ? (isFinite(last) && last > 0 ? Math.max(now, last + p) : now + p * (0.3 + 0.4 * i)) : Infinity;
        }
      }
    }
    var lastStart = [-1e9, -1e9];
    function draw() {
      if (!running) return;
      var now = performance.now();
      resched(now);
      for (var i = 0; i < 2; i++) while (now >= next[i]) { lastStart[i] = next[i]; next[i] += period[i]; }
      var on = [now - lastStart[0] < st.dur, now - lastStart[1] < st.dur];
      var dx = 0, dy = 0;
      if (st.shake) { var s = (now - t0) / 1000; dx = 6 * Math.sin(s * 1.7) + 2 * Math.sin(s * 7.3); dy = 4 * Math.sin(s * 1.3 + 1) + 1.5 * Math.sin(s * 9.1); }
      g.setTransform(1, 0, 0, 1, dx, dy);
      g.fillStyle = '#c9ccd0'; g.fillRect(-20, -20, W + 40, H + 40);
      // wyświetlacz
      g.fillStyle = '#9aa38f'; g.fillRect(W * 0.25, H * 0.12, W * 0.5, H * 0.24);
      g.fillStyle = '#2a2e2a'; g.font = 'bold 38px monospace'; g.fillText('000123', W * 0.3, H * 0.3);
      g.fillStyle = '#e8eaec'; g.fillRect(W * 0.55, H * 0.13, W * 0.15, H * 0.2); // odblask
      g.fillStyle = '#444'; g.font = '14px sans-serif';
      ['PM', '[A]!', 'OL', 'OS', 'OM'].forEach(function (s, k) { g.fillText(s, W * (0.3 + k * 0.08), H * 0.44); });
      // szczelina
      g.fillStyle = '#121212'; g.beginPath(); g.roundRect ? g.roundRect(W * 0.27, H * 0.48, W * 0.46, H * 0.08, 10) : g.rect(W * 0.27, H * 0.48, W * 0.46, H * 0.08); g.fill();
      for (var k = 0; k < 3; k++) {
        var lx = LED[k].x * W, ly = LED[k].y * H, lit = k < 2 && on[k];
        if (lit) {
          var gr = g.createRadialGradient(lx, ly, 2, lx, ly, W * 0.16);
          gr.addColorStop(0, 'rgba(255,60,40,0.75)'); gr.addColorStop(1, 'rgba(255,0,0,0)');
          g.fillStyle = gr; g.fillRect(W * 0.27, H * 0.47, W * 0.46, H * 0.1); // poświata w szczelinie (przesłuch)
          g.fillStyle = '#fff4f0'; g.beginPath(); g.arc(lx, ly, 7, 0, 7); g.fill();
        } else { g.fillStyle = '#2a1414'; g.beginPath(); g.arc(lx, ly, 5, 0, 7); g.fill(); }
      }
      g.fillStyle = '#333'; g.font = '15px sans-serif';
      g.fillText('kWh', LED[0].x * W - 16, H * 0.64); g.fillText('kvarh', LED[1].x * W - 20, H * 0.64); g.fillText('Alarm', LED[2].x * W - 20, H * 0.64);
      // moduł z szybką diodą (fałszywe impulsy, poza ROI)
      g.fillStyle = '#d6d0d0'; g.fillRect(W * 0.84, H * 0.45, W * 0.12, H * 0.35);
      var mOn = Math.floor((now - t0) / 60) % 2 === 0;
      g.fillStyle = mOn ? '#ff2020' : '#401010'; g.beginPath(); g.arc(MOD.x * W, MOD.y * H, 6, 0, 7); g.fill();
      if (st.glare) {
        var ts = (now - t0) / 1000;
        // stały biały odblask lampy obok diody kWh i ruchomy refleks przesuwający się wzdłuż szczeliny
        g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(LED[0].x * W + 10, LED[0].y * H - 6, 9, 5, 0, 0, 7); g.fill();
        var rx = W * 0.2 + ((ts * 60) % (W * 0.6));
        g.beginPath(); g.ellipse(rx, H * 0.52, 12, 7, 0, 0, 7); g.fill();
      }
      // szum
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (st.glare) { // migotanie lampy 100 Hz (aliasing z klatkami aparatu)
        var fl = Math.sin(2 * Math.PI * 100 * (now / 1000) + Math.random() * 0.5);
        g.fillStyle = fl > 0 ? 'rgba(255,255,255,' + (0.12 * fl).toFixed(3) + ')' : 'rgba(0,0,0,' + (-0.12 * fl).toFixed(3) + ')';
        g.fillRect(0, 0, W, H);
      }
      g.fillStyle = 'rgba(' + (Math.random() < 0.5 ? '0,0,0' : '255,255,255') + ',' + (Math.random() * 0.03).toFixed(3) + ')';
      g.fillRect(0, 0, W, H);
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    this.stream = cv.captureStream(60);
    this.canvas = cv;
    this.set = function (k, v) { st[k] = v; };
    this.rois = function () { return [{ x: LED[0].x, y: LED[0].y, w: 0.05, h: 0.06 }, { x: LED[1].x, y: LED[1].y, w: 0.05, h: 0.06 }]; };
    this.stop = function () { running = false; this.stream.getTracks().forEach(function (t) { t.stop(); }); };
  }
  window.LicznikSim = Sim;
})();
