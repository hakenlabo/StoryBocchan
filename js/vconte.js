/*
 * AP.Vconte：Vコンテ再生プレビュー。タイムラインの順・尺どおりに絵を出す。
 * renderFrame() は画面表示とMP4書き出し（ステップ5）の両方で使う。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  let section, stage, canvas, ctx, bar, segsEl, playhead, timeEl, cutEl, playBtn, loopBtn, emptyEl, durBtn;
  let cuts = [];            // [{ card, start, end, sceneId, sceneNo, cutNo }]（start以上end未満のコマ）
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
    // シーン構成でオンのシーンを順に
    Store.playlist().forEach(function (p) {
      cuts.push({ card: p.card, start: t, end: t + p.card.duration, sceneId: p.sceneId, sceneNo: p.sceneNo, cutNo: p.cutNo,
        part: p.part, parts: p.parts, cutOffset: p.cutOffset, cutFrames: p.cutFrames });
      t += p.card.duration;
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
    const i = cutIndexAt(f);
    if (i < 0) {
      c2d.setTransform(1, 0, 0, 1, 0, 0);
      c2d.fillStyle = '#ffffff';
      c2d.fillRect(0, 0, W, H);
      return;
    }
    const cut = cuts[i];
    // 同じカットの絵が続くときは、時間もカット全体で数える
    renderCut(c2d, W, H, cut.card, f - cut.start, i, { label: 'S' + cut.sceneNo + ' C' + cut.cutNo,
      cutLocal: cut.cutOffset + f - cut.start, cutDur: cut.cutFrames });
  }

  // 1カットの local コマ目を描く。cutCard はタイムライン上のカード（連動カットならそれ自身。尺とカメラはこちら）
  // opts.overlays === false でカット番号・字幕を描かない（カメラ設定のプレビュー用）
  function renderCut(c2d, W, H, cutCard, local, index, opts) {
    const st = Store.settings();
    const card = Store.source(cutCard); // 絵と文字は元のカード
    const cam = cutCard.camera;
    const duration = cutCard.duration;
    c2d.setTransform(1, 0, 0, 1, 0, 0);
    c2d.globalCompositeOperation = 'source-over';
    c2d.globalAlpha = 1;
    c2d.fillStyle = '#ffffff';
    c2d.fillRect(0, 0, W, H);

    // 絵の層：カメラが動かないなら作り置き、動くなら毎コマ線から描く（拡大してもぼやけない）
    const baseH = C.DRAW_BASE_W / U.aspectRatio(st.aspect);
    const t = AP.Camera.progress(cam, local, duration); // 止め（動き出すまで・止まってから）も入れた進み具合
    const paper = card.paper || { w: 1, h: 1 };
    const v = AP.Camera.view(cam, t, baseH, paper);
    const still = !cam || !cam.move || cam.move === 'none';
    const key = card.id + '|' + W + 'x' + H + '|' + v.z + ',' + v.cx + ',' + v.cy;
    const s = (W / C.DRAW_BASE_W) * v.z;
    const offsets = [[0, 0]];
    if (v.tile) {
      // FOLLOW：窓にかかる分だけ絵を並べる
      offsets.length = 0;
      const span = v.tile === 'x' ? C.DRAW_BASE_W * paper.w : baseH * paper.h;
      const c0 = v.tile === 'x' ? v.cx : v.cy;
      const half = span / v.z / 2;
      for (let k = Math.floor((c0 - half) / span); k <= Math.floor((c0 + half) / span); k++) {
        offsets.push(v.tile === 'x' ? [k * span, 0] : [0, k * span]);
      }
    }
    if (!still || layerKey !== key || layer._strokes !== card.strokes) {
      if (layer.width !== W || layer.height !== H) { layer.width = W; layer.height = H; }
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.clearRect(0, 0, W, H);
      offsets.forEach(function (o) {
        layerCtx.setTransform(1, 0, 0, 1, W / 2 - (v.cx - o[0]) * s, H / 2 - (v.cy - o[1]) * s);
        AP.Draw.drawStrokes(layerCtx, card.strokes, s);
      });
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerKey = still ? key : null;
      layer._strokes = card.strokes;
    }
    // 写真・絵の画像は線の下に（カメラの窓に合わせて毎コマ描く）
    if (card.image) {
      offsets.forEach(function (o) {
        c2d.setTransform(1, 0, 0, 1, W / 2 - (v.cx - o[0]) * s, H / 2 - (v.cy - o[1]) * s);
        AP.Draw.drawImage(c2d, card.image, paper, st.aspect, s);
      });
      c2d.setTransform(1, 0, 0, 1, 0, 0);
    }
    c2d.drawImage(layer, 0, 0);

    // F.I／F.O
    const fd = opts && opts.fade === false ? null : AP.Camera.fade(cam, local, duration);
    if (fd) {
      c2d.globalAlpha = fd.alpha;
      c2d.fillStyle = fd.color;
      c2d.fillRect(0, 0, W, H);
      c2d.globalAlpha = 1;
    }

    if (opts && opts.overlays === false) return;
    const fs = Math.max(10, Math.round(H * C.VC_FONT_RATIO));
    c2d.font = 'bold ' + fs + 'px -apple-system, "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif';
    c2d.textBaseline = 'middle';
    if (st.vcShowCutNo) {
      const camLabel = AP.Camera.label(cam);
      const cl = opts && opts.cutLocal !== undefined ? opts.cutLocal : local;
      const cd = opts && opts.cutDur !== undefined ? opts.cutDur : duration;
      const label = ((opts && opts.label) || 'C' + (index + 1)) + '  ' + U.framesToLabel(cl, st.fps) + ' / ' + U.framesToLabel(cd, st.fps) +
        (camLabel ? '  ' + camLabel : '');
      const pad = fs * 0.4;
      const w = c2d.measureText(label).width + pad * 2;
      c2d.fillStyle = 'rgba(0,0,0,.55)';
      c2d.fillRect(pad, pad, w, fs * 1.5);
      c2d.fillStyle = '#fff';
      c2d.textAlign = 'left';
      c2d.fillText(label, pad * 2, pad + fs * 0.75);
    }
    // 下から：カードの文字（灰色の帯）、その上にセリフ（黄色い字）
    const bandH = fs * 1.8;
    let bottom = H;
    if (st.vcShowText && card.text) {
      c2d.fillStyle = 'rgba(0,0,0,.55)';
      c2d.fillRect(0, bottom - bandH, W, bandH);
      c2d.fillStyle = '#fff';
      c2d.textAlign = 'center';
      c2d.fillText(card.text.replace(/\s*\n\s*/g, '　'), W / 2, bottom - bandH / 2, W - fs * 2);
      bottom -= bandH;
    }
    if (st.vcShowNote && card.note) {
      c2d.fillStyle = 'rgba(0,0,0,.7)';
      c2d.fillRect(0, bottom - bandH, W, bandH);
      c2d.fillStyle = '#ffe066';
      c2d.textAlign = 'center';
      c2d.fillText(card.note.replace(/\s*\n\s*/g, '　'), W / 2, bottom - bandH / 2, W - fs * 2);
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
      const first = i === 0 || cuts[i - 1].sceneId !== cut.sceneId;
      s.className = 'vc-seg' + (first ? ' scene-start' : '') + (cut.sceneNo % 2 ? '' : ' alt') + (cut.part > 1 ? ' cont' : '');
      s.style.flexGrow = cut.card.duration;
      s.title = 'S' + cut.sceneNo + '（' + Store.sceneName(cut.sceneId) + '） C' + cut.cutNo + ' ' + (Store.source(cut.card).text || '（無題）');
      s.textContent = first ? 'S' + cut.sceneNo + ' ' + cut.cutNo : (cut.part > 1 ? '' : cut.cutNo); // 同じカットの続きは番号を出さない
      const col = Store.colorOf(cut.card);
      if (col) s.style.boxShadow = 'inset 0 -5px 0 ' + col.line;
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
    cutEl.textContent = i >= 0 ? 'S' + cuts[i].sceneNo + ' C' + cuts[i].cutNo + '  ' + (Store.source(cuts[i].card).text || '（無題）') : '';
    segsEl.querySelectorAll('.vc-seg').forEach(function (el, k) { el.classList.toggle('current', k === i); });
    if (!durEditing) durBtn.textContent = i >= 0 ? '尺 ' + U.framesToLabel(cuts[i].card.duration, fps) : '尺';
    ['vc-dur', 'vc-dur-minus', 'vc-dur-plus'].forEach(function (id) { document.getElementById(id).disabled = i < 0; });
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
    if (!cuts.length) return;
    const i = cutIndexAt(frame);
    // 戻るとき、カットの途中なら頭へ。頭にいたら前のカットへ
    if (delta < 0 && frame > cuts[i].start) return seek(cuts[i].start);
    const j = U.clamp(i + delta, 0, cuts.length - 1);
    seek(cuts[j].start);
  }

  // ---- 尺を変える（いま表示しているカット） ----
  let durEditing = false;
  let edgeDrag = null;   // バーの境目をドラッグ中 { pointerId, index, startX, orig, perPx }

  // index 番目のカットの尺を frames に。表示位置は同じカットの中に残す
  function setCutDuration(index, frames, keepEnd) {
    const cut = cuts[index];
    if (!cut) return;
    const local = frame - cut.start;
    const f = Math.max(C.MIN_DURATION_FRAMES, Math.round(frames));
    if (f === cut.card.duration) return;
    Store.setDuration(cut.card.id, f);   // ここで作り直される
    rebuild();
    const c2 = cuts[index];
    if (c2) seek(keepEnd ? c2.end - 1 : c2.start + U.clamp(local, 0, c2.card.duration - 1));
  }

  function nudgeDuration(sign, bigStep) {
    const i = cutIndexAt(frame);
    if (i < 0) return;
    pause();
    setCutDuration(i, cuts[i].card.duration + sign * (bigStep ? Store.settings().fps : 1));
  }

  function startDurEdit() {
    const i = cutIndexAt(frame);
    if (i < 0 || durEditing) return;
    pause();
    const fps = Store.settings().fps;
    const card = cuts[i].card;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'vc-dur-input';
    input.value = U.framesToLabel(card.duration, fps);
    input.setAttribute('aria-label', '尺（秒+コマ）');
    durEditing = true;
    durBtn.hidden = true;
    durBtn.after(input);
    let done = false;
    const finish = function (commit) {
      if (done) return;
      done = true;
      durEditing = false;
      const frames = U.labelToFrames(input.value, fps);
      input.remove();
      durBtn.hidden = false;
      if (commit && frames === null) U.toast('「秒+コマ」で入力してください（例 2+12）');
      if (commit && frames !== null) setCutDuration(i, frames);
      draw();
    };
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const cur = U.labelToFrames(input.value, fps);
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? fps : 1);
        input.value = U.framesToLabel(Math.max(C.MIN_DURATION_FRAMES, (cur === null ? card.duration : cur) + d), fps);
      }
    });
    input.addEventListener('blur', function () { finish(true); });
    input.focus();
    input.select();
  }

  // バーの上で、カットの終わりの境目の近くなら、そのカットの番号
  function edgeAt(cx, pointerType) {
    if (!total) return -1;
    const r = bar.getBoundingClientRect();
    const grab = C.VC_EDGE_GRAB_PX * (pointerType === 'touch' ? 2 : 1);
    let best = -1, bestD = grab + 1;
    cuts.forEach(function (cut, i) {
      const d = Math.abs(cx - (r.left + (cut.end / total) * r.width));
      if (d <= grab && d < bestD) { best = i; bestD = d; }
    });
    return best;
  }

  function frameAtClient(cx) {
    const r = bar.getBoundingClientRect();
    return Math.floor(U.clamp((cx - r.left) / r.width, 0, 0.9999) * total);
  }

  function isVisible() { return document.body.dataset.view === 'vconte'; }

  function show() {
    rebuild();
    buildBar();
    renderSequence();
    layout();
  }

  // ---- シーン構成（どのシーンをどの順で流すか） ----
  function renderSequence() {
    const box = document.getElementById('vc-seq-list');
    const fps = Store.settings().fps;
    const seq = Store.sequence();
    box.innerHTML = '';
    if (!seq.length) {
      box.innerHTML = '<p class="vc-seq-empty">タイムラインにカットを並べると、ここにシーンが出ます。マップのツリー1本が1つのシーンです。</p>';
      return;
    }
    let total = 0;
    seq.forEach(function (x, i) {
      const frames = Store.totalFrames(x.id);
      if (x.on) total += frames;
      const row = document.createElement('div');
      row.className = 'vc-seq-row' + (x.on ? '' : ' off');
      row.dataset.id = x.id;
      row.innerHTML =
        '<label class="vc-seq-main"><input type="checkbox"' + (x.on ? ' checked' : '') + '>' +
        '<span class="vc-seq-name"></span></label>' +
        '<span class="vc-seq-meta">' + Store.cutCount(x.id) + 'カット・' + U.framesToLabel(frames, fps) + '</span>' +
        '<button type="button" data-mv="-1" title="前へ"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" data-mv="1" title="後ろへ"' + (i === seq.length - 1 ? ' disabled' : '') + '>↓</button>';
      row.querySelector('.vc-seq-name').textContent = Store.sceneName(x.id);
      row.querySelector('input').addEventListener('change', function (e) {
        const list = Store.sequence();
        list[i].on = e.target.checked;
        Store.setSequence(list);
      });
      row.querySelectorAll('[data-mv]').forEach(function (b) {
        b.addEventListener('click', function () {
          const list = Store.sequence();
          const j = i + Number(b.dataset.mv);
          if (j < 0 || j >= list.length) return;
          const t = list[i]; list[i] = list[j]; list[j] = t;
          Store.setSequence(list);
        });
      });
      box.appendChild(row);
    });
    document.getElementById('vc-seq-total').textContent = '流す尺 ' + U.framesToLabel(total, fps);
  }

  function onKey(e) {
    if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); e.shiftKey ? seekCut(-1) : seek(frame - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); e.shiftKey ? seekCut(1) : seek(frame + 1); }
    else if (e.key === 'Home') { e.preventDefault(); seek(0); }
    else if (e.key === 'End') { e.preventDefault(); seek(total - 1); }
    else if (e.code === 'BracketLeft' || e.code === 'BracketRight') { e.preventDefault(); nudgeDuration(e.code === 'BracketRight' ? 1 : -1, e.shiftKey); }
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
    durBtn = document.getElementById('vc-dur');
    durBtn.addEventListener('click', startDurEdit);
    document.getElementById('vc-dur-minus').addEventListener('click', function (e) { nudgeDuration(-1, e.shiftKey); });
    document.getElementById('vc-dur-plus').addEventListener('click', function (e) { nudgeDuration(1, e.shiftKey); });

    playBtn.addEventListener('click', function () { playing ? pause() : play(); });
    document.getElementById('vc-start').addEventListener('click', function () { seek(0); });
    document.getElementById('vc-prev').addEventListener('click', function () { seekCut(-1); });
    document.getElementById('vc-next').addEventListener('click', function () { seekCut(1); });
    document.getElementById('vc-camera').addEventListener('click', function () {
      const i = cutIndexAt(frame);
      if (i >= 0) { pause(); AP.Camera.open(cuts[i].card.id); }
    });
    // 絵をダブルタップ（ダブルクリック）で、そのカットを描画パネルで開く
    let lastTap = null;
    canvas.addEventListener('pointerup', function (e) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < C.DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < C.DOUBLE_TAP_SLOP_PX) {
        lastTap = null;
        const i = cutIndexAt(frame);
        if (i >= 0) { pause(); AP.Draw.open(cuts[i].card.id); }
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    });
    document.getElementById('vc-draw').addEventListener('click', function () {
      const i = cutIndexAt(frame);
      if (i >= 0) { pause(); AP.Draw.open(cuts[i].card.id); }
    });
    loopBtn.classList.toggle('active', loop);
    loopBtn.addEventListener('click', function () { loop = !loop; loopBtn.classList.toggle('active', loop); });

    const cutNo = document.getElementById('vc-show-cutno');
    const text = document.getElementById('vc-show-text');
    const note = document.getElementById('vc-show-note');
    note.checked = !!Store.settings().vcShowNote;
    note.addEventListener('change', function () { Store.setSetting('vcShowNote', note.checked); });
    cutNo.checked = !!Store.settings().vcShowCutNo;
    text.checked = !!Store.settings().vcShowText;
    cutNo.addEventListener('change', function () { Store.setSetting('vcShowCutNo', cutNo.checked); });
    text.addEventListener('change', function () { Store.setSetting('vcShowText', text.checked); });

    // シークバー：タップした位置へ、ドラッグで送り
    bar.addEventListener('pointerdown', function (e) {
      if (!total) return;
      // カットの境目をつかんだら、そのカットの尺を伸び縮み
      const edge = edgeAt(e.clientX, e.pointerType);
      if (edge >= 0) {
        pause();
        edgeDrag = { pointerId: e.pointerId, index: edge, startX: e.clientX, orig: cuts[edge].card.duration,
          perPx: total / bar.getBoundingClientRect().width };
        Store.checkpoint();
        bar.setPointerCapture(e.pointerId);
        bar.classList.add('resizing');
        seek(cuts[edge].end - 1);
        e.preventDefault();
        return;
      }
      scrubbing = { pointerId: e.pointerId, wasPlaying: playing };
      if (playing) pause();
      bar.setPointerCapture(e.pointerId);
      seek(frameAtClient(e.clientX));
    });
    bar.addEventListener('pointermove', function (e) {
      if (edgeDrag && e.pointerId === edgeDrag.pointerId) {
        // 幅と尺の割合はつかんだときのまま（総尺が変わってもずれないように）
        setCutDuration(edgeDrag.index, edgeDrag.orig + Math.round((e.clientX - edgeDrag.startX) * edgeDrag.perPx), true);
        return;
      }
      if (!scrubbing) bar.classList.toggle('edge', edgeAt(e.clientX, e.pointerType) >= 0);
      if (scrubbing && e.pointerId === scrubbing.pointerId) seek(frameAtClient(e.clientX));
    });
    const endScrub = function (e) {
      if (edgeDrag && e.pointerId === edgeDrag.pointerId) {
        edgeDrag = null;
        bar.classList.remove('resizing');
        Store.checkpoint();
        return;
      }
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
      renderSequence();
      if (reason === 'settings') layout(); else draw();
    });
  }

  AP.Vconte = {
    init: init,
    show: show,
    hide: pause,
    onKey: onKey,
    renderFrame: renderFrame,
    renderCut: renderCut,
    rebuild: rebuild,
    totalFrames: function () { return total; },
    // テスト・デバッグ用
    state: function () { return { frame: frame, total: total, playing: playing, cut: cutIndexAt(frame) }; },
  };
})();
