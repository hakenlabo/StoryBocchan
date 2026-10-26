/*
 * AP.Draw：描画パネルと、線（strokes）の描画・サムネイル作成。
 *
 * 線のデータ：{ tool: 'pen'|'eraser', color, width, points: [[x, y, 筆圧], ...] }
 *   x, y は「絵の幅 = CONFIG.DRAW_BASE_W」の単位。高さは画面比で決まる（16:9なら 1000×562.5）。
 *   消しゴムも線として記録し、描くときに destination-out で消す（ベクターのまま部分消しができる）。
 */
(function () {
  const C = AP.CONFIG;
  const U = AP.util;
  const Store = AP.Store;

  // ------------------------------------------------------------
  // 線の描画（パネルとサムネイルで共通）
  // ------------------------------------------------------------
  let minLinePx = 0; // サムネイルを作る間だけ、細い線が消えないよう最小の太さを決める

  function lineWidth(s, p, scale) {
    if (s.tool === 'eraser') return s.width * scale;
    const r = C.DRAW_MIN_PRESSURE_RATIO;
    return Math.max(minLinePx, s.width * (r + (1 - r) * p) * scale);
  }

  function prepare(ctx, s) {
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color || '#000';
    ctx.fillStyle = s.color || '#000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  // i 番目の点までの区間を1本描く（点と点の中点を通る2次曲線でなめらかに）
  function drawSegment(ctx, s, i, scale, isLast) {
    const pts = s.points;
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const m0 = i === 1 ? p0 : [(pts[i - 2][0] + p0[0]) / 2, (pts[i - 2][1] + p0[1]) / 2];
    const m1 = isLast ? p1 : [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    ctx.lineWidth = lineWidth(s, (p0[2] + p1[2]) / 2, scale);
    ctx.beginPath();
    ctx.moveTo(m0[0] * scale, m0[1] * scale);
    ctx.quadraticCurveTo(p0[0] * scale, p0[1] * scale, m1[0] * scale, m1[1] * scale);
    ctx.stroke();
  }

  function drawDot(ctx, s, scale) {
    const p = s.points[0];
    ctx.beginPath();
    ctx.arc(p[0] * scale, p[1] * scale, lineWidth(s, p[2], scale) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawStroke(ctx, s, scale) {
    if (!s.points.length) return;
    ctx.save();
    prepare(ctx, s);
    if (s.points.length === 1) drawDot(ctx, s, scale);
    for (let i = 1; i < s.points.length; i++) drawSegment(ctx, s, i, scale, i === s.points.length - 1);
    ctx.restore();
  }

  function drawStrokes(ctx, strokes, scale) {
    (strokes || []).forEach(function (s) { drawStroke(ctx, s, scale); });
  }

  // 透明なキャンバスに絵を描いて返す。白い紙などに直接描くと、消しゴム（destination-out）が
  // 下の紙ごと穴をあけてしまうので、絵の上に重ねるときは必ずこれを使う
  function strokesLayer(strokes, w, h, scale) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(w));
    cv.height = Math.max(1, Math.ceil(h));
    drawStrokes(cv.getContext('2d'), strokes, scale);
    return cv;
  }

  // サムネイル（透明PNGのdata URL）。画面比の枠に用紙全体を収める。strokes配列・画面比・用紙が同じなら作り直さない
  const thumbCache = new WeakMap();
  function thumbURL(strokes, aspect, paper) {
    if (!strokes || !strokes.length) return '';
    paper = paper || { w: 1, h: 1 };
    const tag = aspect + '|' + paper.w + 'x' + paper.h;
    const hit = thumbCache.get(strokes);
    if (hit && hit.tag === tag) return hit.url;
    const w = C.DRAW_THUMB_W;
    const h = Math.round(w / U.aspectRatio(aspect));
    const pw = C.DRAW_BASE_W * paper.w;
    const ph = (C.DRAW_BASE_W / U.aspectRatio(aspect)) * paper.h;
    const s = Math.min(w / pw, h / ph);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c2 = cv.getContext('2d');
    c2.translate((w - pw * s) / 2, (h - ph * s) / 2);
    minLinePx = C.THUMB_MIN_LINE_PX;
    try { drawStrokes(c2, strokes, s); } finally { minLinePx = 0; }
    const url = cv.toDataURL('image/png');
    thumbCache.set(strokes, { tag: tag, url: url });
    return url;
  }

  // ------------------------------------------------------------
  // パネル
  // ------------------------------------------------------------
  let panel, stage, canvas, ctx, titleEl, prevBtn, nextBtn, undoBtn, redoBtn;
  let cardId = null;        // 開いているカット（連動カットならそのid。前後移動の基準）
  let drawId = null;        // 絵を書き込むカード（連動カットなら元のカード）
  let strokes = [];         // 編集中の線（確定のたびに新しい配列にして保存）
  let undoStack = [];
  let redoStack = [];
  let tool = 'pen';
  let color = C.DRAW_COLORS[0].value;
  let size = C.DRAW_SIZES[C.DRAW_DEFAULT_SIZE_INDEX].value;
  let scale = 1;            // 画面px / 絵の単位
  let cur = null;           // 描いている途中の線
  let penSeen = false;
  let lastPointer = null;   // 診断表示（?debug=1）用
  const DEBUG = /[?&]debug=1/.test(location.search);
  function dlog() { if (DEBUG) console.log('[draw] ' + Array.prototype.join.call(arguments, ' ')); }

  function isOpen() { return !!cardId; }

  function open(id) {
    const card = Store.get(id);
    if (!card) return;
    if (AP.MapView.isEditing()) AP.MapView.finishEdit();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // キーボードを閉じてから
    resetScroll();
    dlog('open', id, 'was', cardId);
    cardId = id;
    drawId = Store.source(card).id;
    strokes = Store.get(drawId).strokes || [];
    undoStack = [];
    redoStack = [];
    panel.hidden = false;
    fitPanel();
    document.body.classList.add('drawing');
    AP.MapView.select(drawId);
    updateTitle();
    updatePaperSelect();
    fillNotes();
    layout();
    updateButtons();
  }

  // ---- 内容（カードの文字）・セリフ／メモ ----
  // 連動カットでも元のカード（drawId）に書く（絵と同じく共通）
  function fillNotes() {
    const src = Store.get(drawId);
    document.getElementById('draw-text').value = src.text || '';
    document.getElementById('draw-note').value = src.note || '';
  }

  function paperOf() { return (drawId && Store.get(drawId).paper) || { w: 1, h: 1 }; }

  function updatePaperSelect() {
    const sel = document.getElementById('draw-paper');
    const p = paperOf();
    const i = C.DRAW_PAPERS.findIndex(function (x) { return x.w === p.w && x.h === p.h; });
    sel.value = String(i >= 0 ? i : 0);
  }

  function setPaper(i) {
    const p = C.DRAW_PAPERS[i];
    if (!p || !drawId) return;
    const before = paperOf();
    Store.setPaper(drawId, p);
    layout();
    if (p.w < before.w || p.h < before.h) U.toast('用紙を小さくしました。はみ出た線は消えずに残っています（大きくすると見えます）');
  }

  function close() {
    dlog('close', cardId, new Error().stack.split('\n').slice(1, 4).join(' | '));
    if (!cardId) return;
    endStroke();
    cardId = null;
    panel.hidden = true;
    document.body.classList.remove('drawing');
    resetScroll();
  }

  // iPad Safari：キーボードの出し入れでページが少しずれたまま残り、ペンの位置と線がずれることがあるので、元に戻す
  function resetScroll() {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  // パネルの高さは実際の表示の高さに合わせる（iPad の CSS の画面単位はキーボードやバーで食い違うことがある）
  function fitPanel() {
    panel.style.height = window.innerHeight + 'px';
    panel.style.width = window.innerWidth + 'px';
  }

  function onViewportChange() {
    if (!cardId) return;
    const a = document.activeElement;
    const typing = a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT');
    if (!typing) { resetScroll(); fitPanel(); }
    layout();
  }

  function updateTitle() {
    const card = Store.get(cardId);
    const list = Store.timelineCards(Store.sceneOf(card)); // 前後移動は同じシーンの中で
    const i = list.findIndex(function (c) { return c.id === cardId; });
    titleEl.textContent = (i >= 0 ? '#' + (i + 1) + '  ' : '') + (card.linkOf ? '🔗 ' : '') + (Store.source(card).text || '（無題）');
    prevBtn.disabled = !(i > 0);
    nextBtn.disabled = !(i >= 0 && i < list.length - 1);
    prevBtn.title = nextBtn.title = i >= 0 ? 'タイムラインの前後のカードへ' : 'タイムラインに採用すると前後に移動できます';
  }

  function go(delta) {
    const list = Store.timelineCards(Store.sceneOf(cardId));
    const i = list.findIndex(function (c) { return c.id === cardId; });
    const next = list[i + delta];
    if (i < 0 || !next) return;
    endStroke();
    open(next.id);
  }

  // キャンバスを画面比を保ったまま、置ける範囲いっぱいにする
  function layout() {
    if (!cardId) return;
    const paper = paperOf();
    const ratio = U.aspectRatio(Store.settings().aspect) * paper.w / paper.h; // 用紙の縦横比
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
    scale = w / (C.DRAW_BASE_W * paper.w);
    redraw();
    renderCamFrames();
  }

  // カメラワークの「始め」「終わり」の枠を重ねて見せる（どこが映るか分かるように）
  function renderCamFrames() {
    const box = document.getElementById('draw-camframes');
    box.innerHTML = '';
    const card = cardId && Store.get(cardId);
    const cam = card && card.camera;
    const paper = paperOf();
    const moving = cam && cam.move && cam.move !== 'none';
    // 動きがなくても、長い用紙なら「画面」に映る範囲を出す
    if (!moving && !AP.Camera.isLong(paper)) return;
    const baseH = C.DRAW_BASE_W / U.aspectRatio(Store.settings().aspect);
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const frames = moving ? [['始め', 0, 'from'], ['終わり', 1, 'to']] : [['画面', 0, 'from']];
    frames.forEach(function (f) {
      const r = AP.Camera.rectOf(AP.Camera.view(cam, f[1], baseH, paper), baseH);
      const el = document.createElement('div');
      el.className = 'cam-frame ' + f[2];
      el.style.left = (cr.left - sr.left + r.x * scale) + 'px';
      el.style.top = (cr.top - sr.top + r.y * scale) + 'px';
      el.style.width = (r.w * scale) + 'px';
      el.style.height = (r.h * scale) + 'px';
      el.innerHTML = '<span>' + f[0] + '</span>';
      box.appendChild(el);
    });
    const tag = document.createElement('div');
    tag.className = 'cam-tag';
    tag.textContent = moving ? '🎥 ' + AP.Camera.label(cam) : '用紙 ' + paper.w + '×' + paper.h + '（枠が画面に映る範囲）';
    tag.style.right = (sr.right - cr.right + 6) + 'px';
    tag.style.top = (cr.top - sr.top + 6) + 'px';
    box.appendChild(tag);
  }

  function redraw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStrokes(ctx, strokes, scale);
    if (cur) drawStroke(ctx, cur, scale);
  }

  function commit(next) {
    undoStack.push(strokes);
    if (undoStack.length > C.DRAW_UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    strokes = next;
    Store.setStrokes(drawId, strokes);
    updateButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(strokes);
    strokes = undoStack.pop();
    Store.setStrokes(drawId, strokes);
    redraw();
    updateButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(strokes);
    strokes = redoStack.pop();
    Store.setStrokes(drawId, strokes);
    redraw();
    updateButtons();
  }

  function clearAll() {
    if (!strokes.length) return;
    commit([]);
    redraw();
    U.toast('全部消しました（取り消しで戻せます）');
  }

  function updateButtons() {
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    panel.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === tool); });
    panel.querySelectorAll('[data-color]').forEach(function (b) { b.classList.toggle('active', b.dataset.color === color); });
    panel.querySelectorAll('[data-size]').forEach(function (b) { b.classList.toggle('active', Number(b.dataset.size) === size); });
  }

  // ---- 入力 ----
  function toPoint(e) {
    // いま実際に表示されている大きさから計算する（表示が変わった直後でもペンの位置どおりになるように）
    const r = canvas.getBoundingClientRect();
    const k = r.width / (C.DRAW_BASE_W * paperOf().w) || scale;
    let p = e.pointerType === 'pen' ? e.pressure : C.DRAW_NONPEN_PRESSURE;
    if (e.pointerType === 'pen' && !p) p = 0.5; // 筆圧0で届く端末向け
    lastPointer = { type: e.pointerType, x: Math.round(e.clientX), y: Math.round(e.clientY), p: p,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    return [
      Math.round((e.clientX - r.left) / k * 10) / 10,
      Math.round((e.clientY - r.top) / k * 10) / 10,
      Math.round(p * 100) / 100,
    ];
  }

  function onPointerDown(e) {
    dlog('down', e.pointerId, e.pointerType, 'cur', cur ? cur.pointerId : 'none');
    if (e.pointerType === 'pen') penSeen = true;
    if (cur) return; // 2本目の指などは無視
    if (e.pointerType === 'touch' && penSeen && C.DRAW_PEN_ONLY_AFTER_PEN) return;
    // ペンのサイドボタン（右クリック扱い＝button 2）・消しゴム側（button 5）は、押している間だけ消しゴム。
    // マウスの右ボタン・中ボタンでは描かない
    const penEraser = e.pointerType === 'pen' && (e.button === 2 || e.button === 5 || (e.buttons & 32) || (e.buttons & 2));
    if (e.button > 0 && !penEraser) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const t = penEraser ? 'eraser' : tool;
    cur = {
      tool: t,
      color: t === 'eraser' ? null : color,
      width: t === 'eraser' ? C.ERASER_SIZE : size,
      points: [toPoint(e)],
      pointerId: e.pointerId,
    };
    ctx.save();
    prepare(ctx, cur);
    drawDot(ctx, cur, scale);
    ctx.restore();
  }

  function addPoint(e) {
    const pt = toPoint(e);
    const last = cur.points[cur.points.length - 1];
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < C.DRAW_MIN_POINT_DIST) return;
    cur.points.push(pt);
    if (cur.points.length >= 2) {
      ctx.save();
      prepare(ctx, cur);
      drawSegment(ctx, cur, cur.points.length - 1, scale, false);
      ctx.restore();
    }
  }

  function onPointerMove(e) {
    if (!cur || e.pointerId !== cur.pointerId) return;
    // ペンは間引かれたイベントもまとめて拾う（なめらかさのため）
    // iPad の WebKit は古い位置が後から混ざることがあるので、前の点より新しいものだけを使う（線が折り返さないように）
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const evs = list && list.length ? list : [e];
    evs.forEach(function (ce) {
      if (ce.timeStamp && cur.lastT && ce.timeStamp <= cur.lastT) return;
      cur.lastT = ce.timeStamp || cur.lastT;
      addPoint(ce);
    });
  }

  function endStroke() {
    dlog('endStroke', cur ? cur.points.length + 'pts' : 'none');
    if (!cur) return;
    const s = cur;
    cur = null;
    delete s.pointerId;
    delete s.lastT;
    if (s.tool === 'eraser' && !s.color) delete s.color;
    commit(strokes.concat([s]));
    redraw(); // 最後の区間まできれいに描き直す
  }

  function onPointerUp(e) {
    dlog(e.type, e.pointerId, 'cur', cur ? cur.pointerId + '/' + cur.points.length : 'none', 'card', cardId);
    if (!cur || e.pointerId !== cur.pointerId) return;
    if (e.type === 'pointerup') addPoint(e); // pointercancel の位置は当てにならないので足さない
    endStroke();
  }

  function onKeyDown(e) {
    if (!cardId || AP.Camera.isOpen()) return; // カメラ設定を開いている間はそちらが受ける
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      // 内容・セリフ欄で入力中：ふつうの文字入力。Escだけは欄から抜ける
      if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      e.stopPropagation();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Escape' || (mod && e.key === 'Enter')) { e.preventDefault(); close(); }
    else if (!mod && e.key.toLowerCase() === 'b') { tool = 'pen'; updateButtons(); }
    else if (!mod && e.key.toLowerCase() === 'e') { tool = 'eraser'; updateButtons(); }
    else if (!mod && e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (!mod && e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    e.stopPropagation();
  }

  function buildToolbar() {
    const colors = document.getElementById('draw-colors');
    C.DRAW_COLORS.forEach(function (c) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.color = c.value;
      b.title = c.name;
      b.style.setProperty('--c', c.value);
      b.addEventListener('click', function () { color = c.value; tool = 'pen'; updateButtons(); });
      colors.appendChild(b);
    });
    const sizes = document.getElementById('draw-sizes');
    C.DRAW_SIZES.forEach(function (s) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'size';
      b.dataset.size = s.value;
      b.textContent = s.name;
      b.addEventListener('click', function () { size = s.value; tool = 'pen'; updateButtons(); });
      sizes.appendChild(b);
    });
    panel.querySelectorAll('[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () { tool = b.dataset.tool; updateButtons(); });
    });
  }

  function init() {
    panel = document.getElementById('draw-panel');
    stage = document.getElementById('draw-stage');
    canvas = document.getElementById('draw-canvas');
    ctx = canvas.getContext('2d');
    titleEl = document.getElementById('draw-title');
    prevBtn = document.getElementById('draw-prev');
    nextBtn = document.getElementById('draw-next');
    undoBtn = document.getElementById('draw-undo');
    redoBtn = document.getElementById('draw-redo');

    buildToolbar();
    undoBtn.addEventListener('click', undo);
    redoBtn.addEventListener('click', redo);
    document.getElementById('draw-clear').addEventListener('click', clearAll);
    ['text', 'note'].forEach(function (k) {
      const ta = document.getElementById('draw-' + k);
      ta.addEventListener('input', function () {
        if (!drawId) return;
        const patch = {};
        patch[k] = ta.value;
        Store.updateCard(drawId, patch);
        if (k === 'text') updateTitle();
      });
    });
    document.getElementById('draw-camera').addEventListener('click', function () { if (cardId) AP.Camera.open(cardId); });
    Store.subscribe(function (reason) { if (cardId && (reason === 'camera' || reason === 'settings')) renderCamFrames(); });
    const paperSel = document.getElementById('draw-paper');
    C.DRAW_PAPERS.forEach(function (p, i) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name;
      paperSel.appendChild(o);
    });
    paperSel.addEventListener('change', function () { setPaper(Number(paperSel.value)); });
    document.getElementById('draw-copy').addEventListener('click', function () { AP.Clipboard.copyButton(); });
    document.getElementById('draw-paste').addEventListener('click', function () { AP.Clipboard.pasteButton(); });
    document.getElementById('draw-close').addEventListener('click', close);
    prevBtn.addEventListener('click', function () { go(-1); });
    nextBtn.addEventListener('click', function () { go(1); });

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    // iPad：キャンバスの上では、長押しメニュー・虫めがね・スクリブル（手書き入力）・クリックなどの標準の動きを止めて、描くだけにする。
    // （Pointer Events はそのまま届く）
    ['touchstart', 'touchmove', 'touchend'].forEach(function (t) {
      canvas.addEventListener(t, function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
    });
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('dragstart', function (e) { e.preventDefault(); });
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewportChange);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);
    // 内容・セリフ欄を離れたら（キーボードが閉じたら）ずれを戻して描き直す
    panel.addEventListener('focusout', function () { setTimeout(onViewportChange, 120); });
    updateButtons();
  }

  AP.Draw = {
    init: init,
    currentStrokes: function () { return cardId ? strokes : []; },
    debugInfo: function () {
      if (!cardId) return '';
      const r = canvas.getBoundingClientRect(), pr = panel.getBoundingClientRect();
      return 'draw panel ' + Math.round(pr.width) + 'x' + Math.round(pr.height) + '@' + Math.round(pr.top) +
        '  canvas ' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top) +
        (lastPointer ? '\npointer ' + lastPointer.type + ' ' + lastPointer.x + ',' + lastPointer.y + ' p' + lastPointer.p.toFixed(2) : '') +
        '\nstrokes ' + strokes.length + (cur ? '  drawing#' + cur.pointerId + ' ' + cur.points.length + 'pts' : '') +
        (strokes.length ? '  last ' + strokes[strokes.length - 1].points.length + 'pts' : '');
    },
    // ほかのカードからコピーした絵を重ねる（取り消し可）
    pasteStrokes: function (list) {
      if (!cardId) return;
      commit(strokes.concat(JSON.parse(JSON.stringify(list))));
      redraw();
    },
    open: open,
    close: close,
    isOpen: isOpen,
    drawStrokes: drawStrokes,
    strokesLayer: strokesLayer,
    thumbURL: thumbURL,
  };
})();
