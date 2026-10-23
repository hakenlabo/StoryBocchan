/*
 * AP.Vconte：Vコンテ再生プレビュー。タイムラインの順・尺どおりに絵を出す。
 * renderFrame() は画面表示とMP4書き出し（ステップ5）の両方で使う。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let section, stage, canvas, ctx, bar, segsEl, playhead, timeEl, cutEl, playBtn, loopBtn, emptyEl;
  let cuts = [];            // [{ card, start, end }]（start以上end未満のコマ）
  let total = 0;
  let frame = 0;
  let playing = false;
  let loop = true;
  let startT = 0, startFrame = 0, raf = 0;
  let scrubbing = null;

  // 絵の層（透明）を作り置きする。カットや大きさが変わったときだけ描き直す
  const layer = document.createElement('canvas');
  const layerCtx = layer.getContext('2d');
  let layerKey = null;

  function rebuild() {
    cuts = [];
    let t = 0;
    Store.timelineCards().forEach(function (c) {
      cuts.push({ card: c, start: t, end: t + c.duration });
      t += c.duration;
    });
    total = t;
    frame = total ? U.clamp(frame, 0, total - 1) : 0;
    layerKey = null;
  }

  function cutIndexAt(f) {
    for (let i = 0; i < cuts.length; i++) if (f < cuts[i].end) return i;
    return cuts.length - 1;
  }

  // ------------------------------------------------------------
  // 1コマ分を描く（W×H は実ピクセル）
  // ------------------------------------------------------------
  function renderFrame(c2d, W, H, f) {
    const st = Store.settings();
    c2d.setTransform(1, 0, 0, 1, 0, 0);
    c2d.globalCompositeOperation = 'source-over';
    c2d.fillStyle = '#ffffff';
    c2d.fillRect(0, 0, W, H);
    const i = cutIndexAt(f);
    if (i < 0) return;
    const cut = cuts[i];
    const card = Store.source(cut.card); // 連動カットは元のカードの絵と文字

    const key = cut.card.id + '|' + W + 'x' + H;
    if (layerKey !== key || layer._strokes !== card.strokes) {
      layer.width = W;
      layer.height = H;
      layerCtx.clearRect(0, 0, W, H);
      AP.Draw.drawStrokes(layerCtx, card.strokes, W / C.DRAW_BASE_W);
      layerKey = key;
      layer._strokes = card.strokes;
    }
    c2d.drawImage(layer, 0, 0);

    const fs = Math.max(10, Math.round(H * C.VC_FONT_RATIO));
    c2d.font = 'bold ' + fs + 'px -apple-system, "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif';
    c2d.textBaseline = 'middle';
    if (st.vcShowCutNo) {
      const label = 'C' + (i + 1) + '  ' + U.framesToLabel(f - cut.start, st.fps) + ' / ' + U.framesToLabel(cut.card.duration, st.fps);
      const pad = fs * 0.4;
      const w = c2d.measureText(label).width + pad * 2;
      c2d.fillStyle = 'rgba(0,0,0,.55)';
      c2d.fillRect(pad, pad, w, fs * 1.5);
      c2d.fillStyle = '#fff';
      c2d.textAlign = 'left';
      c2d.fillText(label, pad * 2, pad + fs * 0.75);
    }
    if (st.vcShowText && card.text) {
      const line = card.text.replace(/\s*\n\s*/g, '　');
      const bandH = fs * 1.8;
      c2d.fillStyle = 'rgba(0,0,0,.55)';
      c2d.fillRect(0, H - bandH, W, bandH);
      c2d.fillStyle = '#fff';
      c2d.textAlign = 'center';
      c2d.fillText(line, W / 2, H - bandH / 2, W - fs * 2);
    }
  }

  // ------------------------------------------------------------
  // 画面
  // ------------------------------------------------------------
  function layout() {
    if (!isVisible()) return;
    const ratio = U.aspectRatio(Store.settings().aspect);
    const r = stage.getBoundingClientRect();
    const pad = 16;
    let w = r.width - pad * 2;
    let h = w / ratio;
    if (h > r.height - pad * 2) { h = r.height - pad * 2; w = h * ratio; }
    w = Math.max(50, Math.floor(w));
    h = Math.max(30, Math.floor(h));
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    draw();
  }

  function buildBar() {
    segsEl.innerHTML = '';
    cuts.forEach(function (cut, i) {
      const s = document.createElement('div');
      s.className = 'vc-seg';
      s.style.flexGrow = cut.card.duration;
      s.title = '#' + (i + 1) + ' ' + (Store.source(cut.card).text || '（無題）');
      s.textContent = i + 1;
      segsEl.appendChild(s);
    });
  }

  function draw() {
    const fps = Store.settings().fps;
    emptyEl.hidden = total > 0;
    playBtn.disabled = total === 0;
    renderFrame(ctx, canvas.width, canvas.height, frame);
    playhead.style.left = (total ? (frame / total) * 100 : 0) + '%';
    timeEl.textContent = U.framesToLabel(frame, fps) + ' / ' + U.framesToLabel(total, fps) +
      '　（' + (total ? frame + 1 : 0) + ' / ' + total + 'コマ）';
    const i = cutIndexAt(frame);
    cutEl.textContent = i >= 0 ? '#' + (i + 1) + '  ' + (Store.source(cuts[i].card).text || '（無題）') : '';
    segsEl.querySelectorAll('.vc-seg').forEach(function (el, k) { el.classList.toggle('current', k === i); });
    playBtn.textContent = playing ? '❚❚ 一時停止' : '▶ 再生';
  }

  function tick(now) {
    if (!playing) return;
    const fps = Store.settings().fps;
    let f = startFrame + Math.floor((now - startT) / 1000 * fps);
    if (f >= total) {
      if (loop && total) {
        startFrame = 0;
        startT = now;
        f = 0;
      } else {
        frame = Math.max(0, total - 1);
        pause();
        return;
      }
    }
    if (f !== frame) { frame = f; draw(); }
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!total || playing) return;
    if (frame >= total - 1) frame = 0;
    playing = true;
    startFrame = frame;
    startT = performance.now();
    draw();
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    draw();
  }

  function seek(f) {
    if (!total) return;
    frame = U.clamp(Math.round(f), 0, total - 1);
    if (playing) { startFrame = frame; startT = performance.now(); }
    draw();
  }

  function seekCut(delta) {
    const i = cutIndexAt(frame);
    // 戻るとき、カットの途中なら頭へ。頭にいたら前のカットへ
    if (delta < 0 && frame > cuts[i].start) return seek(cuts[i].start);
    const j = U.clamp(i + delta, 0, cuts.length - 1);
    seek(cuts[j].start);
  }

  function frameAtClient(cx) {
    const r = bar.getBoundingClientRect();
    return Math.floor(U.clamp((cx - r.left) / r.width, 0, 0.9999) * total);
  }

  function isVisible() { return document.body.dataset.view === 'vconte'; }

  function show() {
    rebuild();
    buildBar();
    layout();
  }

  function onKey(e) {
    if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); e.shiftKey ? seekCut(-1) : seek(frame - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); e.shiftKey ? seekCut(1) : seek(frame + 1); }
    else if (e.key === 'Home') { e.preventDefault(); seek(0); }
    else if (e.key === 'End') { e.preventDefault(); seek(total - 1); }
  }

  function init() {
    section = document.getElementById('vconte');
    stage = document.getElementById('vc-stage');
    canvas = document.getElementById('vc-canvas');
    ctx = canvas.getContext('2d');
    bar = document.getElementById('vc-bar');
    segsEl = document.getElementById('vc-segs');
    playhead = document.getElementById('vc-playhead');
    timeEl = document.getElementById('vc-time');
    cutEl = document.getElementById('vc-cut');
    playBtn = document.getElementById('vc-play');
    loopBtn = document.getElementById('vc-loop');
    emptyEl = document.getElementById('vc-empty');

    playBtn.addEventListener('click', function () { playing ? pause() : play(); });
    document.getElementById('vc-start').addEventListener('click', function () { seek(0); });
    document.getElementById('vc-prev').addEventListener('click', function () { seekCut(-1); });
    document.getElementById('vc-next').addEventListener('click', function () { seekCut(1); });
    document.getElementById('vc-draw').addEventListener('click', function () {
      const i = cutIndexAt(frame);
      if (i >= 0) { pause(); AP.Draw.open(cuts[i].card.id); }
    });
    loopBtn.classList.toggle('active', loop);
    loopBtn.addEventListener('click', function () { loop = !loop; loopBtn.classList.toggle('active', loop); });

    const cutNo = document.getElementById('vc-show-cutno');
    const text = document.getElementById('vc-show-text');
    cutNo.checked = !!Store.settings().vcShowCutNo;
    text.checked = !!Store.settings().vcShowText;
    cutNo.addEventListener('change', function () { Store.setSetting('vcShowCutNo', cutNo.checked); });
    text.addEventListener('change', function () { Store.setSetting('vcShowText', text.checked); });

    // シークバー：タップした位置へ、ドラッグで送り
    bar.addEventListener('pointerdown', function (e) {
      if (!total) return;
      scrubbing = { pointerId: e.pointerId, wasPlaying: playing };
      if (playing) pause();
      bar.setPointerCapture(e.pointerId);
      seek(frameAtClient(e.clientX));
    });
    bar.addEventListener('pointermove', function (e) {
      if (scrubbing && e.pointerId === scrubbing.pointerId) seek(frameAtClient(e.clientX));
    });
    const endScrub = function (e) {
      if (!scrubbing || e.pointerId !== scrubbing.pointerId) return;
      const resume = scrubbing.wasPlaying;
      scrubbing = null;
      if (resume) play();
    };
    bar.addEventListener('pointerup', endScrub);
    bar.addEventListener('pointercancel', endScrub);

    window.addEventListener('resize', layout);
    Store.subscribe(function (reason) {
      if (!isVisible() || reason === 'move') return;
      rebuild();
      buildBar();
      if (reason === 'settings') layout(); else draw();
    });
  }

  AP.Vconte = {
    init: init,
    show: show,
    hide: pause,
    onKey: onKey,
    renderFrame: renderFrame,
    rebuild: rebuild,
    totalFrames: function () { return total; },
    // テスト・デバッグ用
    state: function () { return { frame: frame, total: total, playing: playing, cut: cutIndexAt(frame) }; },
  };
})();
